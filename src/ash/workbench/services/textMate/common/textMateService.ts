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
 * The service registers shared line tokenizers and owns their grammar runtime and theme.
 * Its worker factory supports asynchronous syntax consumers; the inspector borrows raw
 * grammars. Callers must not dispose the shared service or its raw grammars.
 */
export interface ITextMateService extends IDisposable {
	readonly grammars: ITextMateGrammarService;
	readonly scopeTheme: TextMateScopeThemeSource;
	readonly syntaxWorkerFactory: SyntaxWorkerFactory;
	readonly onDidChange: Event<void>;
	createTokenizer(languageId: string): Promise<IGrammar | null>;
}

export const ITextMateService = createServiceIdentifier<ITextMateService>("textMateService");
