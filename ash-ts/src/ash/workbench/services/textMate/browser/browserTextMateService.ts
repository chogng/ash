import { Disposable } from "../../../../base/common/lifecycle.js";
import { Emitter, type Event } from '../../../../base/common/event.js';
import { type SyntaxWorkerFactory } from '../../../../editor/common/languages.js';
import { type ITextMateService } from "../common/textMateService.js";
import { type TextMateGrammarDefinition } from "../common/textMateGrammarRegistry.js";
import { TextMateScopeThemeModel, type TextMateScopeThemeSource } from "../common/textMateScopeTheme.js";
import { BrowserTextMateGrammarService } from "./browserTextMateGrammarService.js";
import { createTextMateSyntaxWorkerFactory } from "./textMateSyntaxWorkerClient.js";

/** Browser implementation of the Workbench TextMate service. */
export class BrowserTextMateService extends Disposable implements ITextMateService {
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
			this.syntaxWorkerFactory = createTextMateSyntaxWorkerFactory(this.grammars, this.scopeTheme);
			this._register(this.grammars.onDidChangeCatalog(() => this.changeEmitter.fire()));
			this._register(this.scopeTheme.onDidChangeTheme(() => this.changeEmitter.fire()));
			for (const contribution of contributions) this.grammars.registerGrammar(contribution);
		} catch (error) {
			this.dispose();
			throw error;
		}
	}
}

function isThemeSource(value: unknown): value is TextMateScopeThemeSource {
	return typeof value === "object" && value !== null && "currentTheme" in value && typeof (value as TextMateScopeThemeSource).onDidChangeTheme === "function";
}
