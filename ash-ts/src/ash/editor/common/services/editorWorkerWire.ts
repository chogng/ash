import { LANGUAGE_COMPLETION_LANE, type LanguageCompletionLane, type LanguageCompletionRequest, type LanguageCompletionResult, normalizeLanguageCompletionSnapshotResult, type LanguageCompletionItem, LanguageCompletionTriggerKind, type LanguageCompletionContext, createLanguageCompletionIncompleteRefreshContext, createLanguageCompletionInvokeContext, createLanguageCompletionTriggerCharacterContext, type IInplaceReplaceSupportResult, type TextEdit } from '../languages.js';
import { type LanguageWorkerWireCodec } from '../languages/languageWorkerWire.js';
import { type TextSnapshot } from '../core/textChange.js';
import { URI } from '../../../base/common/uri.js';
import { Range, type IRange } from '../core/range.js';
import { Position } from '../core/position.js';
import type { LanguageWorker } from '../languages/languageRequestCoordinator.js';
import { type UnicodeHighlight, type UnicodeHighlightKind } from './unicodeTextModelHighlighter.js';

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

export const languageCompletionWireCodec: LanguageWorkerWireCodec<LanguageCompletionLane, LanguageCompletionRequest, LanguageCompletionResult> = Object.freeze({
	lanes: Object.freeze([LANGUAGE_COMPLETION_LANE] as const),
	resultProtocol: "stateless",
	encodePayload(_lane: LanguageCompletionLane, request: LanguageCompletionRequest): unknown {
		return encodeCompletionRequest(request);
	},
	decodePayload(_lane: LanguageCompletionLane, value: unknown, snapshot: TextSnapshot): LanguageCompletionRequest {
		return decodeCompletionRequest(value, snapshot);
	},
	encodeResult(_lane: LanguageCompletionLane, result: LanguageCompletionResult): unknown {
		return encodeCompletionResult(result);
	},
	decodeResult(_lane: LanguageCompletionLane, value: unknown, snapshot: TextSnapshot): LanguageCompletionResult {
		return decodeCompletionResult(value, snapshot);
	},
});

function encodeCompletionRequest(request: LanguageCompletionRequest): unknown {
	return Object.freeze({
		languageId: request.languageId,
		...(request.resource ? { resource: request.resource.toString() } : {}),
		position: encodePosition(request.position),
		context: encodeContext(request.context),
	});
}

function decodeCompletionRequest(value: unknown, snapshot: TextSnapshot): LanguageCompletionRequest {
	assertRecord(value, "Completion wire request");
	if (typeof value.languageId !== "string") {
		throw new TypeError("Completion wire language ID must be a string");
	}
	const position = decodePosition(value.position, "Completion wire request position");
	assertSnapshotPosition(snapshot, position);
	return Object.freeze({
		languageId: value.languageId,
		...(typeof value.resource === "string" ? { resource: URI.parse(value.resource) } : {}),
		position,
		context: decodeContext(value.context),
	});
}

function encodeCompletionResult(result: LanguageCompletionResult): unknown {
	return Object.freeze({
		position: encodePosition(result.position),
		items: Object.freeze(result.items.map(encodeItem)),
		isIncomplete: result.isIncomplete,
	});
}

function decodeCompletionResult(value: unknown, snapshot: TextSnapshot): LanguageCompletionResult {
	assertRecord(value, "Completion wire result");
	if (!Array.isArray(value.items)) {
		throw new TypeError("Completion wire result must contain an items array");
	}
	if (typeof value.isIncomplete !== "boolean") {
		throw new TypeError("Completion wire isIncomplete must be a boolean");
	}
	return normalizeLanguageCompletionSnapshotResult({
		position: decodePosition(value.position, "Completion wire result position"),
		items: value.items.map(decodeItem),
		isIncomplete: value.isIncomplete,
	}, snapshot);
}

function encodeItem(item: LanguageCompletionItem): unknown {
	return Object.freeze({
		providerId: item.providerId,
		id: item.id,
		label: item.label,
		kind: item.kind,
		range: Object.freeze({
			start: encodePosition(item.range.getStartPosition()),
			end: encodePosition(item.range.getEndPosition()),
		}),
		insertText: item.insertText,
		...(item.insertTextFormat === undefined ? {} : { insertTextFormat: item.insertTextFormat }),
		...(item.detail === undefined ? {} : { detail: item.detail }),
		...(item.documentation === undefined ? {} : { documentation: item.documentation }),
		...(item.filterText === undefined ? {} : { filterText: item.filterText }),
		...(item.sortText === undefined ? {} : { sortText: item.sortText }),
		...(item.preselect === undefined ? {} : { preselect: item.preselect }),
		...(item.commitCharacters === undefined ? {} : { commitCharacters: item.commitCharacters }),
		...(item.additionalTextEdits === undefined ? {} : { additionalTextEdits: item.additionalTextEdits.map(edit => Object.freeze({
			range: Object.freeze({ start: encodePosition(edit.range.getStartPosition()), end: encodePosition(edit.range.getEndPosition()) }),
			text: edit.text,
		})) }),
		...(item.hasDeferredDetails === undefined ? {} : { hasDeferredDetails: item.hasDeferredDetails }),
	});
}

function decodeItem(value: unknown): LanguageCompletionItem {
	assertRecord(value, "Completion wire item");
	const range = value.range;
	assertRecord(range, "Completion wire item range");
	const detail = decodeOptionalString(value.detail, "Completion wire item detail");
	const documentation = decodeOptionalString(value.documentation, "Completion wire item documentation");
	const filterText = decodeOptionalString(value.filterText, "Completion wire item filter text");
	const sortText = decodeOptionalString(value.sortText, "Completion wire item sort text");
	const commitCharacters = decodeOptionalCommitCharacters(value.commitCharacters);
	const additionalTextEdits = decodeOptionalAdditionalTextEdits(value.additionalTextEdits);
	if (value.preselect !== undefined && typeof value.preselect !== "boolean") {
		throw new TypeError("Completion wire item preselect must be a boolean");
	}
	if (value.hasDeferredDetails !== undefined && typeof value.hasDeferredDetails !== "boolean") {
		throw new TypeError("Completion wire item hasDeferredDetails must be a boolean");
	}
	return {
		providerId: decodeString(value.providerId, "Completion wire provider ID"),
		id: decodeString(value.id, "Completion wire item ID"),
		label: decodeString(value.label, "Completion wire item label"),
		kind: decodeString(value.kind, "Completion wire item kind") as LanguageCompletionItem["kind"],
		range: Range.fromPositions(
			decodePosition(range.start, "Completion wire item range start"),
			decodePosition(range.end, "Completion wire item range end"),
		),
		insertText: decodeString(value.insertText, "Completion wire item insertion text"),
		...(value.insertTextFormat === undefined ? {} : { insertTextFormat: decodeString(value.insertTextFormat, "Completion wire item insert text format") as LanguageCompletionItem["insertTextFormat"] }),
		...(detail === undefined ? {} : { detail }),
		...(documentation === undefined ? {} : { documentation }),
		...(filterText === undefined ? {} : { filterText }),
		...(sortText === undefined ? {} : { sortText }),
		...(value.preselect === undefined ? {} : { preselect: value.preselect }),
		...(commitCharacters === undefined ? {} : { commitCharacters }),
		...(additionalTextEdits === undefined ? {} : { additionalTextEdits }),
		...(value.hasDeferredDetails === undefined ? {} : { hasDeferredDetails: value.hasDeferredDetails }),
	};
}

function decodeOptionalCommitCharacters(value: unknown): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new TypeError("Completion wire item commit characters must be an array");
	return value.map(character => decodeString(character, "Completion wire item commit character"));
}

function decodeOptionalAdditionalTextEdits(value: unknown): readonly { readonly range: Range; readonly text: string }[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new TypeError("Completion wire item additional text edits must be an array");
	return value.map(edit => {
		assertRecord(edit, "Completion wire additional text edit");
		assertRecord(edit.range, "Completion wire additional text edit range");
		return {
			range: Range.fromPositions(
				decodePosition(edit.range.start, "Completion wire additional text edit range start"),
				decodePosition(edit.range.end, "Completion wire additional text edit range end"),
			),
			text: decodeString(edit.text, "Completion wire additional text edit text"),
		};
	});
}

function encodeContext(context: LanguageCompletionContext): unknown {
	return context.kind === LanguageCompletionTriggerKind.TriggerCharacter
		? Object.freeze({ kind: context.kind, triggerCharacter: context.triggerCharacter })
		: Object.freeze({ kind: context.kind });
}

function decodeContext(value: unknown): LanguageCompletionContext {
	assertRecord(value, "Completion wire context");
	if (value.kind === LanguageCompletionTriggerKind.Invoke) {
		return createLanguageCompletionInvokeContext();
	}
	if (value.kind === LanguageCompletionTriggerKind.IncompleteRefresh) {
		return createLanguageCompletionIncompleteRefreshContext();
	}
	if (value.kind === LanguageCompletionTriggerKind.TriggerCharacter) {
		return createLanguageCompletionTriggerCharacterContext(
			decodeString(value.triggerCharacter, "Completion wire trigger character"),
		);
	}
	throw new TypeError(`Unknown completion wire trigger kind '${String(value.kind)}'`);
}

function encodePosition(position: Position): unknown {
	if (!(position instanceof Position)) {
		throw new TypeError("Completion wire position must be a Position");
	}
	return Object.freeze({
		lineIndex: position.lineNumber - 1,
		columnIndex: position.column - 1,
	});
}

function assertSnapshotPosition(snapshot: TextSnapshot, position: Position): void {
	const lines = snapshot.getText().split("\n");
	if (position.lineNumber < 1 || position.lineNumber > lines.length || position.column < 1 || position.column > lines[position.lineNumber - 1]!.length + 1) {
		throw new RangeError("Completion wire request position is outside its snapshot");
	}
}

function decodeOptionalString(value: unknown, owner: string): string | undefined {
	return value === undefined ? undefined : decodeString(value, owner);
}

function decodeNonNegativeSafeInteger(value: unknown, owner: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new RangeError(`${owner} must be a non-negative safe integer`);
	}
	return value as number;
}
