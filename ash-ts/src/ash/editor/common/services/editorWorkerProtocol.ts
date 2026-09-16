import { type LanguageCompletionRequest } from '../languages/completion/languageCompletionProviders.js';
import { type LanguageCompletionResult } from '../languages/completion/languageCompletions.js';
import { Range } from '../core/range.js';

import { type LanguageWorker } from '../languages/languageRequestCoordinator.js';
import { type IInplaceReplaceSupportResult } from '../languages.js';
import { type UnicodeHighlight } from './unicodeTextModelHighlighter.js';
import { type TextEdit } from '../languages.js';

export const EDITOR_WORKER_TEXTUAL_SUGGEST_LANE = 'textualSuggest';

export const EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE = 'unicodeHighlights';
export const EDITOR_WORKER_MINIMAL_EDITS_LANE = 'minimalEdits';
export const EDITOR_WORKER_NAVIGATE_VALUE_LANE = 'navigateValue';

export type EditorWorkerLane = typeof EDITOR_WORKER_TEXTUAL_SUGGEST_LANE | typeof EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE | typeof EDITOR_WORKER_MINIMAL_EDITS_LANE | typeof EDITOR_WORKER_NAVIGATE_VALUE_LANE;

export interface EditorWorkerUnicodeHighlightsRequest {}

export interface EditorWorkerMinimalEditsRequest {
	readonly edits: readonly TextEdit[];
}

export interface EditorWorkerNavigateValueRequest {
	readonly range: Range;
	readonly up: boolean;
	readonly wordDefinition: RegExp;
}

export type EditorWorkerRequest = LanguageCompletionRequest | EditorWorkerUnicodeHighlightsRequest | EditorWorkerMinimalEditsRequest | EditorWorkerNavigateValueRequest;
export type EditorWorkerResult = LanguageCompletionResult | readonly UnicodeHighlight[] | readonly TextEdit[] | IInplaceReplaceSupportResult | undefined;
export type EditorWorkerImplementation = LanguageWorker<EditorWorkerLane, EditorWorkerRequest, EditorWorkerResult>;
export type EditorWorkerImplementationFactory = () => EditorWorkerImplementation;
