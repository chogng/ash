import { type IDisposable } from "../../../../base/common/lifecycle.js";
import { type Event } from '../../../../base/common/event.js';
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import { type SyntaxWorkerFactory } from '../../../../editor/common/languages.js';
import { type ITextMateGrammarService } from "./textMateGrammarService.js";
import { type TextMateScopeThemeSource } from "./textMateScopeTheme.js";

/**
 * Workbench-owned TextMate composition used by editor products.
 *
 * The service owns grammar contributions and theme state; callers only receive
 * a factory for dedicated Stanza syntax workers and must not own the shared
 * service itself.
 */
export interface ITextMateService extends IDisposable {
	readonly grammars: ITextMateGrammarService;
	readonly scopeTheme: TextMateScopeThemeSource;
	readonly syntaxWorkerFactory: SyntaxWorkerFactory;
	readonly onDidChange: Event<void>;
}

export const ITextMateService = createServiceIdentifier<ITextMateService>("textMateService");
