import type * as languages from '../languages.js';
import { type Range } from '../core/range.js';
import { type LanguageWorker } from '../model/languageRequestCoordinator.js';
import { type UnicodeHighlight } from './unicodeTextModelHighlighter.js';

export const EDITOR_WORKER_TEXTUAL_SUGGEST_LANE = 'textualSuggest';

export const EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE = 'unicodeHighlights';
export const EDITOR_WORKER_MINIMAL_EDITS_LANE = 'minimalEdits';
export const EDITOR_WORKER_NAVIGATE_VALUE_LANE = 'navigateValue';

export type EditorWorkerLane = typeof EDITOR_WORKER_TEXTUAL_SUGGEST_LANE | typeof EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE | typeof EDITOR_WORKER_MINIMAL_EDITS_LANE | typeof EDITOR_WORKER_NAVIGATE_VALUE_LANE;

export interface EditorWorkerUnicodeHighlightsRequest {}

export interface EditorWorkerMinimalEditsRequest {
	readonly edits: readonly languages.TextEdit[];
}

export interface EditorWorkerNavigateValueRequest {
	readonly range: Range;
	readonly up: boolean;
	readonly wordDefinition: RegExp;
}

export type EditorWorkerRequest = languages.LanguageCompletionRequest | EditorWorkerUnicodeHighlightsRequest | EditorWorkerMinimalEditsRequest | EditorWorkerNavigateValueRequest;
export type EditorWorkerResult = languages.LanguageCompletionResult | readonly UnicodeHighlight[] | readonly languages.TextEdit[] | languages.IInplaceReplaceSupportResult | undefined;
export type EditorWorkerImplementation = LanguageWorker<EditorWorkerLane, EditorWorkerRequest, EditorWorkerResult>;
export type EditorWorkerImplementationFactory = () => EditorWorkerImplementation;

