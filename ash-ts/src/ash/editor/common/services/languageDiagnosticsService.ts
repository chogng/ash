import { Emitter, type Event } from "../../../base/common/event.js";
import { SyntaxProviderRegistry, type SyntaxRequest } from '../languages/syntax/syntaxProviders.js';
import { SYNTAX_DIAGNOSTIC_LANE, SyntaxProviderWorker, type SyntaxLane, type SyntaxResult } from '../languages/syntax/syntaxService.js';
import { LanguageRequestCoordinator } from '../languages/languageRequestCoordinator.js';
import { createLanguageDiagnosticStore, type LanguageDiagnostic } from "../languages/languageResults.js";
import { Disposable, type IDisposable } from "../../../base/common/lifecycle.js";
import { type URI } from "../../../base/common/uri.js";
import { type TextModel } from "../model/textModel.js";

/** Current diagnostics; revision `0` is reserved for unopened workspace resources. */
export interface LanguageDiagnosticSnapshot {
	readonly resource: URI;
	readonly revision: number;
	readonly diagnostics: readonly LanguageDiagnostic[];
}

/** Read-only diagnostic source consumed by editor presentation. */
export interface LanguageDiagnosticsSource {
	readonly onDidChangeDiagnostics: Event<URI>;
	getDiagnostics(resource: URI): LanguageDiagnosticSnapshot | undefined;
}

/** Enumerable diagnostic source consumed by Workbench-wide presentation. */
export interface LanguageDiagnosticsRepository extends LanguageDiagnosticsSource {
	getAllDiagnostics(): readonly LanguageDiagnosticSnapshot[];
}

/** One editor-owned diagnostic producer registered with the shared repository. */
export interface LanguageDiagnosticsPublisher extends IDisposable {
	update(revision: number, diagnostics: readonly LanguageDiagnostic[]): void;
}

/** Owns open-model synchronization and aggregates every current diagnostic producer. */
export interface ILanguageDiagnosticsService extends LanguageDiagnosticsRepository {
	acquire(resource: URI, languageId: string, model: TextModel): IDisposable;
	createPublisher(resource: URI): LanguageDiagnosticsPublisher;
}

/** Owns diagnostic requests independently of tokenization and its Worker. */
export class ModelLanguageDiagnostics extends Disposable {
	private readonly coordinator: LanguageRequestCoordinator<SyntaxLane, SyntaxRequest, SyntaxResult>;
	private readonly errors = this._register(new Emitter<unknown>());
	readonly onDidEncounterError = this.errors.event;
	readonly results: ReturnType<typeof createLanguageDiagnosticStore>;
	private generation = 0;

	constructor(private readonly model: TextModel, registry?: SyntaxProviderRegistry, onDidChangeConfiguration?: Event<unknown>) {
		super();
		const providers = registry ?? this._register(new SyntaxProviderRegistry());
		this.results = this._register(createLanguageDiagnosticStore(model));
		this.coordinator = this._register(new LanguageRequestCoordinator(model, () => new SyntaxProviderWorker(providers)));
		this._register(model.onDidChangeContent(() => this.schedule()));
		this._register(model.onDidChangeLanguage(() => this.reset()));
		this._register(providers.onDidChange(() => this.reset()));
		if (onDidChangeConfiguration) this._register(onDidChangeConfiguration(() => this.reset()));
		this.schedule();
	}

	private reset(): void {
		this.coordinator.restartWorker();
		this.results.clear();
		this.schedule();
	}

	private schedule(): void {
		const generation = ++this.generation;
		if (this.model.largeFile.tooLargeForTokenization) return;
		queueMicrotask(() => {
			if (this.isDisposed || generation !== this.generation) return;
			void this.coordinator.runLatest(SYNTAX_DIAGNOSTIC_LANE, { languageId: this.model.getLanguageId() }, result => {
				if (result.value.lane !== SYNTAX_DIAGNOSTIC_LANE) throw new TypeError('Expected diagnostic result');
				this.results.accept({ ...result, value: result.value.value });
			}).catch(error => {
				if (!this.isDisposed && generation === this.generation) this.errors.fire(error);
			});
		});
	}
}
