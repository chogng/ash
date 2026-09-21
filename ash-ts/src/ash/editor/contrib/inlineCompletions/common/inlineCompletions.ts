import { type Position } from "../../../common/core/position.js";
import { type Range } from "../../../common/core/range.js";

import { type LanguageFeatureRequest, type TextEdit } from "../../../common/languages.js";

export interface LanguageInlineCompletionItem {
	readonly insertText: string;
	/** Repairs missing and unexpected brackets using the document's lexical context. */
	readonly completeBracketPairs?: boolean;
	readonly range?: Range;
	readonly filterText?: string;
	readonly commandId?: string;
	readonly additionalTextEdits?: readonly TextEdit[];
}

export interface LanguageInlineCompletionsRequest extends LanguageFeatureRequest {
	readonly position: Position;
	readonly triggerKind: "automatic" | "explicit";
}

export interface LanguageInlineCompletionsProvider {
	provideInlineCompletions(request: LanguageInlineCompletionsRequest, signal: AbortSignal): readonly LanguageInlineCompletionItem[] | Promise<readonly LanguageInlineCompletionItem[]>;
}
