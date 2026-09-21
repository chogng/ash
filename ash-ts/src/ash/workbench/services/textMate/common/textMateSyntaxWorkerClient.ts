import { raceCancellationError } from "../../../../base/common/async.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { syntaxWireCodec } from '../../../../editor/common/services/editorWorkerWire.js';
import { type SyntaxRequest, type SyntaxLane, type SyntaxResult, type SyntaxWorker } from '../../../../editor/common/languages.js';
import { type LanguageWorkerModelSynchronizer, type LanguageWorkerRequest, type LanguageWorkerResultDisposition, type LanguageWorkerResultSettler } from '../../../../editor/common/model/languageRequestCoordinator.js';
import { LanguageWorkerWireClient, type LanguageWorkerWireClientPort } from '../../../../editor/common/services/languageWorkerWire.js';
import { type TextModelChange } from "../../../../editor/common/core/textChange.js";
import { type TextMateGrammarCatalog, type TextMateGrammarCatalogSource } from "./textMateGrammarCatalog.js";
import { TextMateGrammarCatalogWireClient } from "./textMateGrammarCatalogWire.js";
import { type TextMateScopeTheme, type TextMateScopeThemeSource } from "./textMateScopeTheme.js";
import { TextMateScopeThemeWireClient } from "./textMateScopeThemeWire.js";

export interface TextMateSyntaxWorkerClientOptions {
	/** Optional renderer-owned semantic scope theme mirrored into this Worker. */
	readonly scopeTheme?: TextMateScopeThemeSource;
}

/** Syntax Worker client gated by the latest renderer-owned grammar catalog. */
export class TextMateSyntaxWorkerClient extends Disposable implements SyntaxWorker, LanguageWorkerModelSynchronizer, LanguageWorkerResultSettler {
	private readonly worker: LanguageWorkerWireClient<SyntaxLane, SyntaxRequest, SyntaxResult>;
	private readonly catalogClient: TextMateGrammarCatalogWireClient;
	private readonly themeClient: TextMateScopeThemeWireClient | undefined;
	private catalogTail: Promise<void>;
	private themeTail: Promise<void>;

	constructor(
		port: LanguageWorkerWireClientPort,
		catalogs: TextMateGrammarCatalogSource,
		options: TextMateSyntaxWorkerClientOptions = {},
	) {
		super();
		if (!catalogs || typeof catalogs !== "object" || typeof catalogs.onDidChangeCatalog !== "function" || !("currentCatalog" in catalogs)) {
			throw new TypeError("TextMate Syntax Worker client requires a grammar catalog source");
		}
		this.worker = this._register(new LanguageWorkerWireClient(port, syntaxWireCodec));
		this.catalogClient = this._register(new TextMateGrammarCatalogWireClient(port, error => this.worker.invalidate(error)));
		if (options.scopeTheme !== undefined && (!options.scopeTheme || typeof options.scopeTheme !== "object" || typeof options.scopeTheme.onDidChangeTheme !== "function" || !("currentTheme" in options.scopeTheme))) {
			throw new TypeError("TextMate Syntax Worker scope theme must be a theme source");
		}
		this.themeClient = options.scopeTheme === undefined
			? undefined
			: this._register(new TextMateScopeThemeWireClient(port, error => this.worker.invalidate(error)));
		this.catalogTail = this.pushCatalog(catalogs.currentCatalog);
		this.themeTail = options.scopeTheme === undefined ? Promise.resolve() : this.pushTheme(options.scopeTheme.currentTheme);
		this.observeTail();
		this._register(catalogs.onDidChangeCatalog(catalog => {
			this.catalogTail = this.catalogTail.then(() => this.pushCatalog(catalog));
			this.observeTail();
		}));
		if (options.scopeTheme) {
			this._register(options.scopeTheme.onDidChangeTheme(theme => {
				this.themeTail = this.themeTail.then(() => this.pushTheme(theme));
				this.observeTail();
			}));
		}
	}

	async run(request: LanguageWorkerRequest<SyntaxLane, SyntaxRequest>, signal: AbortSignal): Promise<SyntaxResult> {
		await this.waitForCurrentCatalog(signal);
		return this.worker.run(request, signal);
	}

	synchronizeModel(change: TextModelChange): void {
		this.worker.synchronizeModel(change);
	}

	settleResult(requestId: number, disposition: LanguageWorkerResultDisposition): void {
		this.worker.settleResult(requestId, disposition);
	}

	private async waitForCurrentCatalog(signal: AbortSignal): Promise<void> {
		while (true) {
			const catalogTail = this.catalogTail;
			const themeTail = this.themeTail;
			await raceCancellationError(Promise.all([catalogTail, themeTail]).then(() => undefined), signal, "TextMate grammar catalog wait was cancelled");
			if (catalogTail === this.catalogTail && themeTail === this.themeTail) return;
		}
	}

	private pushCatalog(catalog: TextMateGrammarCatalog): Promise<void> {
		return catalog.revision === 0 ? Promise.resolve() : this.catalogClient.replaceCatalog(catalog);
	}

	private pushTheme(theme: TextMateScopeTheme): Promise<void> {
		return theme.revision === 0 ? Promise.resolve() : this.themeClient!.replaceTheme(theme);
	}

	private observeTail(): void {
		void this.catalogTail.catch(() => undefined);
		void this.themeTail.catch(() => undefined);
	}
}
