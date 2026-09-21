import * as languages from '../languages.js';
import { type LanguageWorkerWireCodec, type LanguageWorkerWireResultState } from './languageWorkerWire.js';
import { type TextSnapshot } from '../core/textChange.js';
import { type LanguageTokenResult, createLanguageTokenSnapshotNormalizer, type LanguageToken } from '../tokens/languageTokens.js';
import { attachLanguageTokenResultDelta } from './semanticTokensDto.js';
import { Position } from '../core/position.js';
import { Range, type IRange } from '../core/range.js';
import { arraysEqual, commonArraySuffixLength, commonPrefixLength } from '../../../base/common/arrays.js';
import { URI } from '../../../base/common/uri.js';
import { type LanguageWorker } from '../model/languageRequestCoordinator.js';
import { type UnicodeHighlight, type UnicodeHighlightKind } from './unicodeTextModelHighlighter.js';

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
				return languageCompletionWireCodec.encodePayload('completion', payload as languages.LanguageCompletionRequest);
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
				return languageCompletionWireCodec.encodeResult('completion', result as languages.LanguageCompletionResult, snapshot, undefined);
			case EDITOR_WORKER_UNICODE_HIGHLIGHTS_LANE:
				return Object.freeze((result as readonly UnicodeHighlight[]).map(highlight => Object.freeze({
					range: encodeRange(highlight.range),
					kind: highlight.kind,
					character: highlight.character,
				})));
			case EDITOR_WORKER_MINIMAL_EDITS_LANE:
				return Object.freeze((result as readonly languages.TextEdit[]).map(encodeEdit));
			case EDITOR_WORKER_NAVIGATE_VALUE_LANE: {
				const navigation = result as languages.IInplaceReplaceSupportResult | undefined;
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

function encodeEdit(edit: languages.TextEdit): unknown {
	return Object.freeze({ range: encodeRange(edit.range), text: edit.text, ...(edit.eol === undefined ? {} : { eol: edit.eol }) });
}

function decodeEdit(value: unknown, snapshot: TextSnapshot): languages.TextEdit {
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

export const languageCompletionWireCodec: LanguageWorkerWireCodec<languages.LanguageCompletionLane, languages.LanguageCompletionRequest, languages.LanguageCompletionResult> = Object.freeze({
	lanes: Object.freeze([languages.LANGUAGE_COMPLETION_LANE] as const),
	resultProtocol: "stateless",
	encodePayload(_lane: languages.LanguageCompletionLane, request: languages.LanguageCompletionRequest): unknown {
		return encodeCompletionRequest(request);
	},
	decodePayload(_lane: languages.LanguageCompletionLane, value: unknown, snapshot: TextSnapshot): languages.LanguageCompletionRequest {
		return decodeCompletionRequest(value, snapshot);
	},
	encodeResult(_lane: languages.LanguageCompletionLane, result: languages.LanguageCompletionResult): unknown {
		return encodeCompletionResult(result);
	},
	decodeResult(_lane: languages.LanguageCompletionLane, value: unknown, snapshot: TextSnapshot): languages.LanguageCompletionResult {
		return decodeCompletionResult(value, snapshot);
	},
});

function encodeCompletionRequest(request: languages.LanguageCompletionRequest): unknown {
	return Object.freeze({
		languageId: request.languageId,
		...(request.resource ? { resource: request.resource.toString() } : {}),
		position: encodePosition(request.position),
		context: encodeContext(request.context),
	});
}

function decodeCompletionRequest(value: unknown, snapshot: TextSnapshot): languages.LanguageCompletionRequest {
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

function encodeCompletionResult(result: languages.LanguageCompletionResult): unknown {
	return Object.freeze({
		position: encodePosition(result.position),
		items: Object.freeze(result.items.map(encodeItem)),
		isIncomplete: result.isIncomplete,
	});
}

function decodeCompletionResult(value: unknown, snapshot: TextSnapshot): languages.LanguageCompletionResult {
	assertRecord(value, "Completion wire result");
	if (!Array.isArray(value.items)) {
		throw new TypeError("Completion wire result must contain an items array");
	}
	if (typeof value.isIncomplete !== "boolean") {
		throw new TypeError("Completion wire isIncomplete must be a boolean");
	}
	return languages.normalizeLanguageCompletionSnapshotResult({
		position: decodePosition(value.position, "Completion wire result position"),
		items: value.items.map(decodeItem),
		isIncomplete: value.isIncomplete,
	}, snapshot);
}

function encodeItem(item: languages.LanguageCompletionItem): unknown {
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

function decodeItem(value: unknown): languages.LanguageCompletionItem {
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
		kind: decodeString(value.kind, "Completion wire item kind") as languages.LanguageCompletionItem["kind"],
		range: Range.fromPositions(
			decodePosition(range.start, "Completion wire item range start"),
			decodePosition(range.end, "Completion wire item range end"),
		),
		insertText: decodeString(value.insertText, "Completion wire item insertion text"),
		...(value.insertTextFormat === undefined ? {} : { insertTextFormat: decodeString(value.insertTextFormat, "Completion wire item insert text format") as languages.LanguageCompletionItem["insertTextFormat"] }),
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

function encodeContext(context: languages.LanguageCompletionContext): unknown {
	return context.kind === languages.LanguageCompletionTriggerKind.TriggerCharacter
		? Object.freeze({ kind: context.kind, triggerCharacter: context.triggerCharacter })
		: Object.freeze({ kind: context.kind });
}

function decodeContext(value: unknown): languages.LanguageCompletionContext {
	assertRecord(value, "Completion wire context");
	if (value.kind === languages.LanguageCompletionTriggerKind.Invoke) {
		return languages.createLanguageCompletionInvokeContext();
	}
	if (value.kind === languages.LanguageCompletionTriggerKind.IncompleteRefresh) {
		return languages.createLanguageCompletionIncompleteRefreshContext();
	}
	if (value.kind === languages.LanguageCompletionTriggerKind.TriggerCharacter) {
		return languages.createLanguageCompletionTriggerCharacterContext(
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

export const syntaxWireCodec: LanguageWorkerWireCodec<languages.SyntaxLane, languages.SyntaxRequest, languages.SyntaxResult> = Object.freeze({
	lanes: Object.freeze([languages.SYNTAX_TOKEN_LANE, languages.SYNTAX_DIAGNOSTIC_LANE] as const),
	resultProtocol: "confirmedBase",
	encodePayload(_lane: languages.SyntaxLane, request: languages.SyntaxRequest) {
		languages.assertSyntaxRequest(request);
		return Object.freeze({ languageId: request.languageId });
	},
	decodePayload(_lane: languages.SyntaxLane, value: unknown, _snapshot: TextSnapshot) {
		assertRecord(value, "Syntax wire request");
		const request = Object.freeze({
			languageId: decodeString(value.languageId, "Syntax wire language ID"),
		});
		languages.assertSyntaxRequest(request);
		return request;
	},
	encodeResult: encodeSyntaxWireResult,
	decodeResult: decodeSyntaxWireResult,
});

function encodeSyntaxWireResult(lane: languages.SyntaxLane, result: languages.SyntaxResult, snapshot: TextSnapshot, base: LanguageWorkerWireResultState<languages.SyntaxResult> | undefined): unknown {
	assertResultLane(lane, result);
	const items = lane === languages.SYNTAX_TOKEN_LANE
		? (result.value as LanguageTokenResult).tokens
		: (result.value as languages.LanguageDiagnosticResult).diagnostics;
	const baseItems = readBaseItems(lane, base);
	if (!base || !baseItems) return encodeFull(lane, items);
	const splices = createSyntaxItemSplices(lane, baseItems, items, base.snapshot, snapshot);
	const insertedItemCount = splices.reduce((count, splice) => count + splice.items.length, 0);
	if (insertedItemCount >= items.length) return encodeFull(lane, items);
	return Object.freeze({
		kind: "delta",
		baseRequestId: base.requestId,
		splices: Object.freeze(splices.map(splice => Object.freeze({
			startItemIndex: splice.startItemIndex,
			deleteItemCount: splice.deleteItemCount,
			lineDelta: splice.lineDeltaAfter,
			items: Object.freeze(splice.items.map(item => syntaxEncodeItem(lane, item))),
		}))),
	});
}

function decodeSyntaxWireResult(lane: languages.SyntaxLane, value: unknown, snapshot: TextSnapshot, base: LanguageWorkerWireResultState<languages.SyntaxResult> | undefined): languages.SyntaxResult {
	assertRecord(value, "Syntax wire result");
	if (value.kind === "full") {
		if (!Array.isArray(value.items)) throw new TypeError("Full syntax wire result must contain items");
		return resultFromItems(lane, value.items.map(item => syntaxDecodeItem(lane, item)), snapshot);
	}
	if (value.kind !== "delta") {
		throw new TypeError(`Unknown syntax wire result kind '${String(value.kind)}'`);
	}
	if (!Array.isArray(value.splices)) {
		throw new TypeError("Syntax delta must contain splices");
	}
	const baseRequestId = decodePositiveSafeInteger(value.baseRequestId, "Syntax delta base request ID");
	if (!base || base.requestId !== baseRequestId) {
		throw new Error("Syntax delta base result is unavailable");
	}
	const baseItems = readBaseItems(lane, base);
	if (!baseItems) {
		throw new Error("Syntax delta base lane does not match");
	}
	const items: SyntaxItem[] = [];
	const tokenSplices = [];
	let baseItemIndex = 0;
	let lineDelta = 0;
	for (const encodedSplice of value.splices) {
		assertRecord(encodedSplice, "Syntax delta splice");
		if (!Array.isArray(encodedSplice.items)) {
			throw new TypeError("Syntax delta splice must contain items");
		}
		const startItemIndex = decodeNonNegativeSafeInteger(encodedSplice.startItemIndex, "Syntax delta start item index");
		const deleteItemCount = decodeNonNegativeSafeInteger(encodedSplice.deleteItemCount, "Syntax delta delete item count");
		if (startItemIndex < baseItemIndex || startItemIndex > baseItems.length || deleteItemCount > baseItems.length - startItemIndex) {
			throw new RangeError("Syntax delta splices must be ordered, non-overlapping, and inside their base result");
		}
		for (const item of baseItems.slice(baseItemIndex, startItemIndex)) items.push(shiftItem(lane, item, lineDelta));
		const inserted = encodedSplice.items.map(item => syntaxDecodeItem(lane, item));
		const resultStartItemIndex = items.length;
		items.push(...inserted);
		const nextLineDelta = decodeSafeInteger(encodedSplice.lineDelta, "Syntax delta line shift");
		tokenSplices.push(Object.freeze({
			baseStartItemIndex: startItemIndex,
			baseDeleteItemCount: deleteItemCount,
			resultStartItemIndex,
			resultInsertItemCount: inserted.length,
			lineDeltaBefore: lineDelta,
			lineDeltaAfter: nextLineDelta,
		}));
		baseItemIndex = startItemIndex + deleteItemCount;
		lineDelta = nextLineDelta;
	}
	if (lineDelta !== snapshot.lineCount - base.snapshot.lineCount) {
		throw new Error("Syntax delta final line shift does not match its snapshots");
	}
	for (const item of baseItems.slice(baseItemIndex)) items.push(shiftItem(lane, item, lineDelta));
	const result = resultFromItems(lane, items, snapshot);
	if (result.lane === languages.SYNTAX_TOKEN_LANE) {
		attachLanguageTokenResultDelta(result.value, {
			baseRequestId,
			splices: tokenSplices,
		});
	}
	return result;
}

function encodeFull(lane: languages.SyntaxLane, items: readonly SyntaxItem[]): unknown {
	return Object.freeze({
		kind: "full",
		items: Object.freeze(items.map(item => syntaxEncodeItem(lane, item))),
	});
}

function readBaseItems(lane: languages.SyntaxLane, base: LanguageWorkerWireResultState<languages.SyntaxResult> | undefined): readonly SyntaxItem[] | undefined {
	if (!base || base.result.lane !== lane) return undefined;
	return lane === languages.SYNTAX_TOKEN_LANE
		? (base.result.value as LanguageTokenResult).tokens
		: (base.result.value as languages.LanguageDiagnosticResult).diagnostics;
}

function resultFromItems(lane: languages.SyntaxLane, items: readonly SyntaxItem[], snapshot: TextSnapshot): languages.SyntaxResult {
	return lane === languages.SYNTAX_TOKEN_LANE
		? Object.freeze({
			lane: languages.SYNTAX_TOKEN_LANE,
			value: createLanguageTokenSnapshotNormalizer(snapshot)({ tokens: items as readonly LanguageToken[] }),
		})
		: Object.freeze({
			lane: languages.SYNTAX_DIAGNOSTIC_LANE,
			value: languages.createLanguageDiagnosticSnapshotNormalizer(snapshot)({ diagnostics: items as readonly languages.LanguageDiagnostic[] }),
		});
}

function syntaxEncodeItem(lane: languages.SyntaxLane, item: SyntaxItem): unknown {
	if (lane === languages.SYNTAX_TOKEN_LANE) {
		const token = item as LanguageToken;
		return Object.freeze({
			range: syntaxEncodeRange(token.range, "Language token wire range"),
			tokenType: token.tokenType,
			modifiers: Object.freeze([...token.modifiers]),
			...(token.languageId === undefined ? {} : { languageId: token.languageId }),
			...(token.balancedBrackets === undefined ? {} : { balancedBrackets: token.balancedBrackets }),
			...(token.presentation === undefined ? {} : { presentation: token.presentation }),
		});
	}
	const diagnostic = item as languages.LanguageDiagnostic;
	return Object.freeze({
		range: syntaxEncodeRange(diagnostic.range, "Language diagnostic wire range"),
		severity: diagnostic.severity,
		message: diagnostic.message,
		...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
		...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
	});
}

function syntaxDecodeItem(lane: languages.SyntaxLane, value: unknown): SyntaxItem {
	assertRecord(value, lane === languages.SYNTAX_TOKEN_LANE ? "Language token wire token" : "Language diagnostic wire diagnostic");
	if (lane === languages.SYNTAX_TOKEN_LANE) {
		if (!Array.isArray(value.modifiers)) {
			throw new TypeError("Language token wire modifiers must be an array");
		}
		return {
			range: syntaxDecodeRange(value.range, "Language token wire range"),
			tokenType: decodeString(value.tokenType, "Language token wire type"),
			modifiers: value.modifiers.map(modifier => decodeString(modifier, "Language token wire modifier")),
			...(value.languageId === undefined ? {} : { languageId: decodeString(value.languageId, "Language token wire embedded language ID") }),
			...(value.balancedBrackets === undefined ? {} : { balancedBrackets: decodeExcludedBrackets(value.balancedBrackets) }),
			...(value.presentation === undefined ? {} : { presentation: decodePresentation(value.presentation) }),
		};
	}
	const code = decodeDiagnosticCode(value.code);
	const source = value.source === undefined ? undefined : decodeString(value.source, "Language diagnostic wire source");
	return {
		range: syntaxDecodeRange(value.range, "Language diagnostic wire range"),
		severity: decodeString(value.severity, "Language diagnostic wire severity") as languages.LanguageDiagnostic["severity"],
		message: decodeString(value.message, "Language diagnostic wire message"),
		...(code === undefined ? {} : { code }),
		...(source === undefined ? {} : { source }),
	};
}

function decodeExcludedBrackets(value: unknown): false {
	if (value !== false) throw new TypeError("Language token wire balanced-bracket metadata must be false");
	return false;
}

function decodePresentation(value: unknown): NonNullable<LanguageToken["presentation"]> {
	assertRecord(value, "Language token wire presentation");
	const foreground = value.foreground === undefined ? undefined : decodeString(value.foreground, "Language token wire foreground");
	const background = value.background === undefined ? undefined : decodeString(value.background, "Language token wire background");
	if (value.fontStyle !== undefined && !Array.isArray(value.fontStyle)) throw new TypeError("Language token wire font style must be an array");
	const fontStyle = value.fontStyle === undefined ? undefined : value.fontStyle.map(style => decodeString(style, "Language token wire font style")) as NonNullable<LanguageToken["presentation"]>["fontStyle"];
	return { ...(foreground === undefined ? {} : { foreground }), ...(background === undefined ? {} : { background }), ...(fontStyle === undefined ? {} : { fontStyle }) };
}

function shiftItem(lane: languages.SyntaxLane, item: SyntaxItem, lineDelta: number): SyntaxItem {
	const range = Range.fromPositions(
		new Position(item.range.startLineNumber + lineDelta, item.range.startColumn),
		new Position(item.range.endLineNumber + lineDelta, item.range.endColumn),
	);
	return lane === languages.SYNTAX_TOKEN_LANE
		? { ...(item as LanguageToken), range }
		: { ...(item as languages.LanguageDiagnostic), range };
}

function syntaxEncodeRange(range: Range, owner: string): unknown {
	if (!(range instanceof Range)) throw new TypeError(`${owner} must be a Range`);
	return Object.freeze({
		start: Object.freeze({ lineIndex: range.startLineNumber - 1, columnIndex: range.startColumn - 1 }),
		end: Object.freeze({ lineIndex: range.endLineNumber - 1, columnIndex: range.endColumn - 1 }),
	});
}

function syntaxDecodeRange(value: unknown, owner: string): Range {
	assertRecord(value, owner);
	return Range.fromPositions(syntaxDecodePosition(value.start, `${owner} start`), syntaxDecodePosition(value.end, `${owner} end`));
}

function syntaxDecodePosition(value: unknown, owner: string): Position {
	assertRecord(value, owner);
	return new Position((decodeNonNegativeSafeInteger(value.lineIndex, `${owner} line index`)) + 1, (decodeNonNegativeSafeInteger(value.columnIndex, `${owner} column index`)) + 1);
}

function decodeDiagnosticCode(value: unknown): languages.LanguageDiagnosticCode | undefined {
	if (value === undefined || typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw new TypeError("Language diagnostic wire code must be a finite number or string");
}

function assertResultLane(lane: languages.SyntaxLane, result: languages.SyntaxResult): void {
	if (!result || result.lane !== lane) throw new TypeError(`Syntax wire result does not match lane '${lane}'`);
}

function decodePositiveSafeInteger(value: unknown, owner: string): number {
	const decoded = decodeNonNegativeSafeInteger(value, owner);
	if (decoded === 0) throw new RangeError(`${owner} must be positive`);
	return decoded;
}

function decodeSafeInteger(value: unknown, owner: string): number {
	if (!Number.isSafeInteger(value)) throw new RangeError(`${owner} must be a safe integer`);
	return value as number;
}

type SyntaxItem = LanguageToken | languages.LanguageDiagnostic;

interface SyntaxItemSplice {
	readonly startItemIndex: number;
	readonly deleteItemCount: number;
	readonly items: readonly SyntaxItem[];
	readonly lineDeltaBefore: number;
	readonly lineDeltaAfter: number;
}

interface SyntaxLinePair {
	readonly previousLineIndex: number;
	readonly currentLineIndex: number;
}

interface SyntaxLineRun extends SyntaxLinePair {
	readonly lineCount: number;
}

function createSyntaxItemSplices(lane: languages.SyntaxLane, previous: readonly SyntaxItem[], current: readonly SyntaxItem[], previousSnapshot: TextSnapshot, currentSnapshot: TextSnapshot): readonly SyntaxItemSplice[] {
	const previousLines = previousSnapshot.getText().split("\n");
	const currentLines = currentSnapshot.getText().split("\n");
	const previousBounds = createLineItemBounds(previous, previousLines.length);
	const currentBounds = createLineItemBounds(current, currentLines.length);
	if (!previousBounds || !currentBounds) {
		return Object.freeze([createSingleSplice(lane, previous, current, currentSnapshot.lineCount - previousSnapshot.lineCount)]);
	}
	const runs = createStableLineRuns(lane, previous, current, previousLines, currentLines, previousBounds, currentBounds);
	const splices: SyntaxItemSplice[] = [];
	let previousItemIndex = 0;
	let currentItemIndex = 0;
	let lineDelta = 0;
	for (const run of runs) {
		const previousRunStart = previousBounds[run.previousLineIndex]!;
		const currentRunStart = currentBounds[run.currentLineIndex]!;
		const nextLineDelta = run.currentLineIndex - run.previousLineIndex;
		appendSplice(splices, current, previousItemIndex, previousRunStart, currentItemIndex, currentRunStart, lineDelta, nextLineDelta);
		previousItemIndex = previousBounds[run.previousLineIndex + run.lineCount]!;
		currentItemIndex = currentBounds[run.currentLineIndex + run.lineCount]!;
		lineDelta = nextLineDelta;
	}
	appendSplice(splices, current, previousItemIndex, previous.length, currentItemIndex, current.length, lineDelta, currentSnapshot.lineCount - previousSnapshot.lineCount);
	return Object.freeze(splices);
}

function syntaxItemsEqual(lane: languages.SyntaxLane, current: SyntaxItem, previous: SyntaxItem, lineDelta: number): boolean {
	if (!syntaxRangesEqual(current.range, previous.range, lineDelta)) return false;
	if (lane === languages.SYNTAX_TOKEN_LANE) {
		const currentToken = current as LanguageToken;
		const previousToken = previous as LanguageToken;
		return currentToken.tokenType === previousToken.tokenType &&
			arraysEqual(currentToken.modifiers, previousToken.modifiers) &&
			currentToken.languageId === previousToken.languageId &&
			currentToken.balancedBrackets === previousToken.balancedBrackets &&
			tokenPresentationsEqual(currentToken.presentation, previousToken.presentation);
	}
	const currentDiagnostic = current as languages.LanguageDiagnostic;
	const previousDiagnostic = previous as languages.LanguageDiagnostic;
	return currentDiagnostic.severity === previousDiagnostic.severity &&
		currentDiagnostic.message === previousDiagnostic.message &&
		currentDiagnostic.code === previousDiagnostic.code &&
		currentDiagnostic.source === previousDiagnostic.source;
}

function createStableLineRuns(lane: languages.SyntaxLane, previousItems: readonly SyntaxItem[], currentItems: readonly SyntaxItem[], previousLines: readonly string[], currentLines: readonly string[], previousBounds: readonly number[], currentBounds: readonly number[]): readonly SyntaxLineRun[] {
	const pairs = createStableLinePairs(previousLines, currentLines).filter(pair => lineItemsEqual(
		lane,
		previousItems.slice(previousBounds[pair.previousLineIndex], previousBounds[pair.previousLineIndex + 1]),
		currentItems.slice(currentBounds[pair.currentLineIndex], currentBounds[pair.currentLineIndex + 1]),
		pair.currentLineIndex - pair.previousLineIndex,
	));
	const runs: SyntaxLineRun[] = [];
	for (const pair of pairs) {
		const previous = runs.at(-1);
		if (previous && previous.previousLineIndex + previous.lineCount === pair.previousLineIndex && previous.currentLineIndex + previous.lineCount === pair.currentLineIndex) {
			runs[runs.length - 1] = Object.freeze({ ...previous, lineCount: previous.lineCount + 1 });
		} else {
			runs.push(Object.freeze({ ...pair, lineCount: 1 }));
		}
	}
	return runs;
}

function createStableLinePairs(previous: readonly string[], current: readonly string[]): readonly SyntaxLinePair[] {
	const prefixLength = commonPrefixLength(previous, current);
	const suffixLength = commonArraySuffixLength(previous, current, prefixLength);
	const pairs = new Map<string, SyntaxLinePair>();
	for (let index = 0; index < prefixLength; index += 1) addPair(pairs, index, index);
	const previousInteriorEnd = previous.length - suffixLength;
	const currentInteriorEnd = current.length - suffixLength;
	const previousUnique = uniqueLineIndexes(previous, prefixLength, previousInteriorEnd);
	const currentUnique = uniqueLineIndexes(current, prefixLength, currentInteriorEnd);
	const candidates: SyntaxLinePair[] = [];
	for (const [line, currentLineIndex] of currentUnique) {
		const previousLineIndex = previousUnique.get(line);
		if (previousLineIndex !== undefined) candidates.push({ previousLineIndex, currentLineIndex });
	}
	for (const pair of longestIncreasingPairs(candidates)) addPair(pairs, pair.previousLineIndex, pair.currentLineIndex);
	for (let offset = 0; offset < suffixLength; offset += 1) {
		addPair(pairs, previousInteriorEnd + offset, currentInteriorEnd + offset);
	}
	const anchors = [...pairs.values()].sort(comparePairs);
	const sentinels = [{ previousLineIndex: -1, currentLineIndex: -1 }, ...anchors, {
		previousLineIndex: previous.length,
		currentLineIndex: current.length,
	}];
	for (let index = 1; index < sentinels.length; index += 1) {
		const left = sentinels[index - 1]!;
		const right = sentinels[index]!;
		let previousStart = left.previousLineIndex + 1;
		let currentStart = left.currentLineIndex + 1;
		let previousEnd = right.previousLineIndex;
		let currentEnd = right.currentLineIndex;
		while (previousStart < previousEnd && currentStart < currentEnd && previous[previousStart] === current[currentStart]) {
			addPair(pairs, previousStart++, currentStart++);
		}
		while (previousStart < previousEnd && currentStart < currentEnd && previous[previousEnd - 1] === current[currentEnd - 1]) {
			addPair(pairs, --previousEnd, --currentEnd);
		}
	}
	return Object.freeze([...pairs.values()].sort(comparePairs));
}

function appendSplice(splices: SyntaxItemSplice[], current: readonly SyntaxItem[], previousStart: number, previousEnd: number, currentStart: number, currentEnd: number, lineDeltaBefore: number, lineDeltaAfter: number): void {
	if (previousStart === previousEnd && currentStart === currentEnd && lineDeltaBefore === lineDeltaAfter) return;
	splices.push(Object.freeze({
		startItemIndex: previousStart,
		deleteItemCount: previousEnd - previousStart,
		items: Object.freeze(current.slice(currentStart, currentEnd)),
		lineDeltaBefore,
		lineDeltaAfter,
	}));
}

function createSingleSplice(lane: languages.SyntaxLane, previous: readonly SyntaxItem[], current: readonly SyntaxItem[], lineDelta: number): SyntaxItemSplice {
	const limit = Math.min(previous.length, current.length);
	let prefixLength = 0;
	while (prefixLength < limit && syntaxItemsEqual(lane, current[prefixLength]!, previous[prefixLength]!, 0)) prefixLength += 1;
	let suffixLength = 0;
	while (suffixLength < limit - prefixLength && syntaxItemsEqual(lane, current[current.length - suffixLength - 1]!, previous[previous.length - suffixLength - 1]!, lineDelta)) suffixLength += 1;
	return Object.freeze({
		startItemIndex: prefixLength,
		deleteItemCount: previous.length - prefixLength - suffixLength,
		items: Object.freeze(current.slice(prefixLength, current.length - suffixLength)),
		lineDeltaBefore: 0,
		lineDeltaAfter: lineDelta,
	});
}

function createLineItemBounds(items: readonly SyntaxItem[], lineCount: number): readonly number[] | undefined {
	const bounds = new Array<number>(lineCount + 1);
	let itemIndex = 0;
	for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
		bounds[lineIndex] = itemIndex;
		while (itemIndex < items.length && items[itemIndex]!.range.startLineNumber - 1 === lineIndex) {
			itemIndex += 1;
		}
		if (itemIndex < items.length && items[itemIndex]!.range.startLineNumber - 1 < lineIndex) return undefined;
	}
	bounds[lineCount] = itemIndex;
	return itemIndex === items.length ? Object.freeze(bounds) : undefined;
}

function lineItemsEqual(lane: languages.SyntaxLane, previous: readonly SyntaxItem[], current: readonly SyntaxItem[], lineDelta: number): boolean {
	return previous.length === current.length && previous.every((item, index) => syntaxItemsEqual(lane, current[index]!, item, lineDelta));
}

function uniqueLineIndexes(lines: readonly string[], start: number, end: number): ReadonlyMap<string, number> {
	const indexes = new Map<string, number>();
	const duplicates = new Set<string>();
	for (let index = start; index < end; index += 1) {
		const line = lines[index]!;
		if (indexes.has(line)) {
			indexes.delete(line);
			duplicates.add(line);
		} else if (!duplicates.has(line)) {
			indexes.set(line, index);
		}
	}
	return indexes;
}

function longestIncreasingPairs(pairs: readonly SyntaxLinePair[]): readonly SyntaxLinePair[] {
	if (pairs.length === 0) return [];
	const tails: number[] = [];
	const predecessors = new Array<number>(pairs.length).fill(-1);
	for (let index = 0; index < pairs.length; index += 1) {
		let low = 0;
		let high = tails.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (pairs[tails[middle]!]!.previousLineIndex < pairs[index]!.previousLineIndex) low = middle + 1;
			else high = middle;
		}
		if (low > 0) predecessors[index] = tails[low - 1]!;
		tails[low] = index;
	}
	const result: SyntaxLinePair[] = [];
	for (let index = tails.at(-1)!; index >= 0; index = predecessors[index]!) result.push(pairs[index]!);
	return result.reverse();
}

function addPair(pairs: Map<string, SyntaxLinePair>, previousLineIndex: number, currentLineIndex: number): void {
	pairs.set(`${previousLineIndex}:${currentLineIndex}`, Object.freeze({ previousLineIndex, currentLineIndex }));
}

function comparePairs(left: SyntaxLinePair, right: SyntaxLinePair): number {
	return left.previousLineIndex - right.previousLineIndex || left.currentLineIndex - right.currentLineIndex;
}

function syntaxRangesEqual(current: Range, previous: Range, lineDelta: number): boolean {
	return current.getStartPosition().lineNumber === previous.getStartPosition().lineNumber + lineDelta &&
		current.getStartPosition().column === previous.getStartPosition().column &&
		current.getEndPosition().lineNumber === previous.getEndPosition().lineNumber + lineDelta &&
		current.getEndPosition().column === previous.getEndPosition().column;
}

function tokenPresentationsEqual(current: LanguageToken['presentation'], previous: LanguageToken['presentation']): boolean {
	if (current === previous) {
		return true;
	}
	if (!current || !previous) {
		return false;
	}
	return current.foreground === previous.foreground &&
		current.background === previous.background &&
		(current.fontStyle === previous.fontStyle ||
			(current.fontStyle !== undefined && previous.fontStyle !== undefined && arraysEqual(current.fontStyle, previous.fontStyle)));
}
