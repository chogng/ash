import { Disposable, DisposableStore } from "../../../../base/common/lifecycle.js";
import { Emitter, type Event } from '../../../../base/common/event.js';
import { TokenizationRegistry, LazyTokenizationSupport, type SyntaxWorkerFactory } from '../../../../editor/common/languages.js';
import { type ITextMateService } from "../common/textMateService.js";
import { type TextMateGrammarDefinition } from "../common/textMateGrammarRegistry.js";
import { createTextMateScopeThemeResolver, TextMateScopeThemeModel, type TextMateScopeThemeSource } from "../common/textMateScopeTheme.js";
import { BrowserTextMateGrammarService } from "./browserTextMateGrammarService.js";
import { createTextMateSyntaxWorkerFactory } from "./textMateSyntaxWorkerClient.js";
import { TextMateGrammarCatalogStore } from '../common/textMateGrammarCatalogStore.js';
import type { TextMateTokenizationService } from '../common/textMateTokenizationService.js';
import type { TextMateScopeResolver } from '../common/textMateScopeResolver.js';
import type { IGrammar } from 'vscode-textmate';

/** Browser implementation of the Workbench TextMate service. */
export class BrowserTextMateService extends Disposable implements ITextMateService {
	private readonly runtimeGrammars = this._register(new TextMateGrammarCatalogStore());
	private readonly lineSupports = this._register(new DisposableStore());
	private themeResolver: TextMateScopeResolver;
	private runtimeTokens: Promise<TextMateTokenizationService> | undefined;
	private readonly changeEmitter = this._register(new Emitter<void>());
	readonly grammars = this._register(new BrowserTextMateGrammarService());
	readonly scopeTheme: TextMateScopeThemeSource;
	readonly mutableScopeTheme: TextMateScopeThemeModel | undefined;
	readonly syntaxWorkerFactory: SyntaxWorkerFactory;
	readonly onDidChange: Event<void> = this.changeEmitter.event;

	constructor(contributions: readonly TextMateGrammarDefinition[] = [], scopeTheme?: TextMateScopeThemeSource) {
		super();
		if (!Array.isArray(contributions)) {
			this.dispose();
			throw new TypeError("Browser TextMate grammar contributions must be an array");
		}
		try {
			if (scopeTheme !== undefined && !isThemeSource(scopeTheme)) {
				throw new TypeError("Browser TextMate scope theme must be a theme source");
			}
			this.mutableScopeTheme = scopeTheme === undefined ? this._register(new TextMateScopeThemeModel()) : undefined;
			this.scopeTheme = scopeTheme ?? this.mutableScopeTheme!;
			this.themeResolver = createTextMateScopeThemeResolver(this.scopeTheme.currentTheme);
			this.syntaxWorkerFactory = createTextMateSyntaxWorkerFactory(this.grammars, this.scopeTheme);
			this._register(this.grammars.onDidChangeCatalog(catalog => {
				this.runtimeGrammars.replace(catalog);
				this.lineSupports.clear();
				for (const languageId of this.runtimeGrammars.currentSnapshot.languageIds) {
					const factory = this.lineSupports.add(new LazyTokenizationSupport(async () => (await this.getRuntime()).createTokenizationSupport(languageId)));
					this.lineSupports.add(TokenizationRegistry.registerFactory(languageId, factory));
				}
				this.changeEmitter.fire();
			}));
			this._register(this.scopeTheme.onDidChangeTheme(() => {
				this.themeResolver = createTextMateScopeThemeResolver(this.scopeTheme.currentTheme);
				TokenizationRegistry.handleChange([...this.runtimeGrammars.currentSnapshot.languageIds]);
				this.changeEmitter.fire();
			}));
			for (const contribution of contributions) this.grammars.registerGrammar(contribution);
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	public async createTokenizer(languageId: string): Promise<IGrammar | null> {
		this.assertNotDisposed();
		const catalog = await this.grammars.whenReady();
		this.assertNotDisposed();
		if (catalog.revision > this.runtimeGrammars.catalogRevision) this.runtimeGrammars.replace(catalog);
		return (await this.getRuntime()).createTokenizer(languageId);
	}

	private getRuntime(): Promise<TextMateTokenizationService> {
		this.runtimeTokens ??= import('./browserTextMateTokenization.js').then(runtime => {
			this.assertNotDisposed();
			return this._register(runtime.createBrowserTextMateTokenizationService(this.runtimeGrammars, { scopeResolver: scopes => this.themeResolver(scopes) }));
		});
		return this.runtimeTokens;
	}
}

function isThemeSource(value: unknown): value is TextMateScopeThemeSource {
	return typeof value === "object" && value !== null && "currentTheme" in value && typeof (value as TextMateScopeThemeSource).onDidChangeTheme === "function";
}
