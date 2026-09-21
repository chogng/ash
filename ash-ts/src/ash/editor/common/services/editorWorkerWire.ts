import type { LanguageWorker } from '../languages/languageRequestCoordinator.js';
import type { LanguageCompletionResult } from '../languages/completion/languageCompletions.js';
import { languageCompletionWireCodec } from '../languages/completion/languageCompletionWire.js';
import { type LanguageCompletionRequest } from '../languages/completion/languageCompletionProviders.js';
import { Position } from '../core/position.js';
import { type IRange, Range } from '../core/range.js';

import { type TextSnapshot } from '../core/textChange.js';
import { type IInplaceReplaceSupportResult } from '../languages.js';
import { type LanguageWorkerWireCodec } from '../languages/languageWorkerWire.js';
import { type UnicodeHighlight, type UnicodeHighlightKind } from './unicodeTextModelHighlighter.js';
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

export const editorWorkerWireCodec: LanguageWorkerWireCodec<EditorWorkerLane, EditorWorkerRequest, EditorWorkerResult> = Object.freeze({
	lanes: Object.freeze([
		EDITOR_WORKER_TEXTUAL_SUGGEST_LANE,
		EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE,
		EDITOR_WORKER_MINIMAL_EDITS_LANE,
		EDITOR_WORKER_NAVIGATE_VALUE_LANE,
	] as const),
	resultProtocol: 'stateless',
	encodePayload(lane: EditorWorkerLane, payload: EditorWorkerRequest): unknown {
		switch (lane) {
			case EDITOR_WORKER_TEXTUAL_SUGGEST_LANE:
				return languageCompletionWireCodec.encodePayload('completion', payload as LanguageCompletionRequest);
			case EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE:
				return Object.freeze({});
			case EDITOR_WORKER_MINIMAL_EDITS_LANE:
				return Object.freeze({ edits: Object.freeze((payload as EditorWorkerMinimalEditsRequest).edits.map(encodeEdit)) });
			case EDITOR_WORKER_NAVIGATE_VALUE_LANE: {
				const request = payload as EditorWorkerNavigateValueRequest;
				return Object.freeze({
					range: encodeRange(request.range),
					up: request.up,
					wordDefinition: Object.freeze({ source: request.wordDefinition.source, flags: request.wordDefinition.flags }),
				});
			}
		}
	},
	decodePayload(lane: EditorWorkerLane, value: unknown, snapshot: TextSnapshot): EditorWorkerRequest {
		assertRecord(value, 'Editor worker request');
		switch (lane) {
			case EDITOR_WORKER_TEXTUAL_SUGGEST_LANE:
				return languageCompletionWireCodec.decodePayload('completion', value, snapshot);
			case EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE:
				return Object.freeze({});
			case EDITOR_WORKER_MINIMAL_EDITS_LANE:
				if (!Array.isArray(value.edits)) throw new TypeError('Editor worker minimal edits must be an array');
				return Object.freeze({ edits: Object.freeze(value.edits.map(edit => decodeEdit(edit, snapshot))) });
			case EDITOR_WORKER_NAVIGATE_VALUE_LANE: {
				if (typeof value.up !== 'boolean') throw new TypeError('Editor worker navigation direction must be boolean');
				assertRecord(value.wordDefinition, 'Editor worker word definition');
				const source = decodeString(value.wordDefinition.source, 'Editor worker word definition source');
				const flags = decodeString(value.wordDefinition.flags, 'Editor worker word definition flags');
				return Object.freeze({ range: decodeRange(value.range, snapshot), up: value.up, wordDefinition: new RegExp(source, flags) });
			}
		}
	},
	encodeResult(lane: EditorWorkerLane, result: EditorWorkerResult, snapshot: TextSnapshot): unknown {
		switch (lane) {
			case EDITOR_WORKER_TEXTUAL_SUGGEST_LANE:
				return languageCompletionWireCodec.encodeResult('completion', result as LanguageCompletionResult, snapshot, undefined);
			case EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE:
				return Object.freeze((result as readonly UnicodeHighlight[]).map(highlight => Object.freeze({
					range: encodeRange(highlight.range),
					kind: highlight.kind,
					character: highlight.character,
				})));
			case EDITOR_WORKER_MINIMAL_EDITS_LANE:
				return Object.freeze((result as readonly TextEdit[]).map(encodeEdit));
			case EDITOR_WORKER_NAVIGATE_VALUE_LANE: {
				const navigation = result as IInplaceReplaceSupportResult | undefined;
				return navigation ? Object.freeze({ range: encodeRange(navigation.range), value: navigation.value }) : null;
			}
		}
	},
	decodeResult(lane: EditorWorkerLane, value: unknown, snapshot: TextSnapshot): EditorWorkerResult {
		switch (lane) {
			case EDITOR_WORKER_TEXTUAL_SUGGEST_LANE:
				return languageCompletionWireCodec.decodeResult('completion', value, snapshot, undefined);
			case EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE:
				if (!Array.isArray(value)) throw new TypeError('Editor worker Unicode result must be an array');
				return Object.freeze(value.map(item => decodeUnicodeHighlight(item, snapshot)));
			case EDITOR_WORKER_MINIMAL_EDITS_LANE:
				if (!Array.isArray(value)) throw new TypeError('Editor worker minimal edit result must be an array');
				return Object.freeze(value.map(edit => decodeEdit(edit, snapshot)));
			case EDITOR_WORKER_NAVIGATE_VALUE_LANE:
				if (value === null) return undefined;
				assertRecord(value, 'Editor worker navigation result');
				return Object.freeze({ range: decodeRange(value.range, snapshot), value: decodeString(value.value, 'Editor worker navigation value') });
		}
	},
});

function encodeEdit(edit: TextEdit): unknown {
	return Object.freeze({ range: encodeRange(edit.range), text: edit.text, ...(edit.eol === undefined ? {} : { eol: edit.eol }) });
}

function decodeEdit(value: unknown, snapshot: TextSnapshot): TextEdit {
	assertRecord(value, 'Editor worker edit');
	if (value.eol !== undefined && value.eol !== 0 && value.eol !== 1) {
		throw new TypeError('Editor worker edit EOL must be LF or CRLF');
	}
	return Object.freeze({ range: decodeRange(value.range, snapshot), text: decodeString(value.text, 'Editor worker edit text'), ...(value.eol === undefined ? {} : { eol: value.eol }) });
}

function encodeRange(range: IRange): unknown {
	return Object.freeze({
		start: Object.freeze({ lineIndex: range.startLineNumber - 1, columnIndex: range.startColumn - 1 }),
		end: Object.freeze({ lineIndex: range.endLineNumber - 1, columnIndex: range.endColumn - 1 }),
	});
}

function decodeRange(value: unknown, snapshot: TextSnapshot): Range {
	assertRecord(value, 'Editor worker range');
	const start = decodePosition(value.start, 'Editor worker range start');
	const end = decodePosition(value.end, 'Editor worker range end');
	const range = Range.fromPositions(start, end);
	const lines = snapshot.getText().split('\n');
	for (const position of [range.getStartPosition(), range.getEndPosition()]) {
		if (position.lineNumber < 1 || position.lineNumber > lines.length || position.column < 1 || position.column > lines[position.lineNumber - 1]!.length + 1) {
			throw new RangeError('Editor worker range is outside its snapshot');
		}
	}
	return range;
}

function decodePosition(value: unknown, owner: string): Position {
	assertRecord(value, owner);
	return new Position((decodebase(value.lineIndex, `${owner} line index`)) + 1, (decodebase(value.columnIndex, `${owner} column index`)) + 1);
}

function decodeUnicodeHighlight(value: unknown, snapshot: TextSnapshot): UnicodeHighlight {
	assertRecord(value, 'Editor worker Unicode highlight');
	const kind = decodeString(value.kind, 'Editor worker Unicode highlight kind');
	if (!isUnicodeHighlightKind(kind)) throw new TypeError(`Unknown Unicode highlight kind '${kind}'`);
	const character = decodeString(value.character, 'Editor worker Unicode highlight character');
	if ([...character].length !== 1) throw new TypeError('Editor worker Unicode highlight must contain one character');
	return Object.freeze({ range: decodeRange(value.range, snapshot), kind, character });
}

function isUnicodeHighlightKind(value: string): value is UnicodeHighlightKind {
	return value === 'invisible' || value === 'bidi' || value === 'confusable';
}

function decodebase(value: unknown, owner: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RangeError(`${owner} must be a non-negative safe integer`);
	return value as number;
}

function decodeString(value: unknown, owner: string): string {
	if (typeof value !== 'string') throw new TypeError(`${owner} must be a string`);
	return value;
}

function assertRecord(value: unknown, owner: string): asserts value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${owner} must be an object`);
}
