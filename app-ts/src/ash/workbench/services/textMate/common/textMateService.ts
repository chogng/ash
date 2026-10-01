import { type IDisposable } from "../../../../base/common/lifecycle.js";
import { type Event } from '../../../../base/common/event.js';
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import { type SyntaxWorkerFactory } from '../../../../editor/common/languages.js';
import { type ITextMateGrammarService } from "./textMateGrammarService.js";
import { type TextMateScopeThemeSource } from "./textMateScopeTheme.js";
import type { IGrammar } from 'vscode-textmate';

/**
 * Workbench-owned TextMate composition used by editor products.
 *
 * The service owns grammar contributions, runtimes, and theme state. Callers receive
 * a factory for dedicated Stanza syntax workers or a borrowed raw grammar for inspection;
 * they must not dispose the shared service or its raw grammars.
 */
export interface ITextMateService extends IDisposable {
	readonly grammars: ITextMateGrammarService;
	readonly scopeTheme: TextMateScopeThemeSource;
	readonly syntaxWorkerFactory: SyntaxWorkerFactory;
	readonly onDidChange: Event<void>;
	createTokenizer(languageId: string): Promise<IGrammar | null>;
}

export const ITextMateService = createServiceIdentifier<ITextMateService>("textMateService");
