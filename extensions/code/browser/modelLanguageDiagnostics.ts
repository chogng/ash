import { SyntaxProviderRegistry } from '../../../src/ash/editor/common/languageFeatureRegistry.js';
import { SyntaxProviderWorker } from '../../../src/ash/editor/common/services/editorWebWorker.js';
import { LanguageRequestCoordinator } from '../../../src/ash/editor/common/model/languageRequestCoordinator.js';
import { createLanguageDiagnosticStore } from '../../../src/ash/editor/common/model/languageResultStore.js';
import { Emitter, type Event } from '../../../src/ash/base/common/event.js';
import { Disposable } from '../../../src/ash/base/common/lifecycle.js';
import { type TextModel } from '../../../src/ash/editor/common/model/textModel.js';
import { SYNTAX_DIAGNOSTIC_LANE, type SyntaxLane, type SyntaxRequest, type SyntaxResult } from '../../../src/ash/editor/common/languages.js';
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
		this.coordinator = this._register(new LanguageRequestCoordinator(model, () => new SyntaxProviderWorker(providers, undefined, undefined, model)));
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
