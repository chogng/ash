import { isNonNegativeSafeInteger, isPositiveSafeInteger, isSafeInteger } from '../../../base/common/numbers.js';
import { type LanguageTokenResult, createLanguageTokenSnapshotNormalizer, type LanguageToken } from '../tokens/languageTokens.js';
import * as languages from '../languages.js';
import { type WorkerTextModelCodec, type WorkerTextModelResult, type WorkerTextModelResultStore } from './textModelSync/textModelSync.protocol.js';
import { type TextSnapshot } from '../core/textChange.js';
import { Position } from '../core/position.js';
import { Range } from '../core/range.js';
import { arraysEqual, commonArraySuffixLength, commonPrefixLength } from '../../../base/common/arrays.js';

export interface LanguageTokenResultSplice {
	readonly baseStartItemIndex: number;
	readonly baseDeleteItemCount: number;
	readonly resultStartItemIndex: number;
	readonly resultInsertItemCount: number;
	readonly lineDeltaBefore: number;
	readonly lineDeltaAfter: number;
}

/** Delta metadata accompanying one normalized full token result across a worker boundary. */
export interface LanguageTokenResultDelta {
	readonly baseRequestId: number;
	readonly splices: readonly LanguageTokenResultSplice[];
}

const resultDeltas = new WeakMap<LanguageTokenResult, LanguageTokenResultDelta>();

export function attachLanguageTokenResultDelta(result: LanguageTokenResult, delta: LanguageTokenResultDelta): LanguageTokenResult {
	if (!Object.isFrozen(result) || !Object.isFrozen(result.tokens)) throw new TypeError('Language token delta requires an immutable normalized result');
	resultDeltas.set(result, normalizeLanguageTokenResultDelta(delta, result.tokens.length));
	return result;
}

export function getLanguageTokenResultDelta(result: LanguageTokenResult): LanguageTokenResultDelta | undefined {
	return resultDeltas.get(result);
}

function normalizeLanguageTokenResultDelta(delta: LanguageTokenResultDelta, tokenCount: number): LanguageTokenResultDelta {
	if (typeof delta !== 'object' || delta === null) throw new TypeError('Language token result delta must be an object');
	if (!isPositiveSafeInteger(delta.baseRequestId)) throw new RangeError('Language token delta base request ID must be a positive safe integer');
	if (!Array.isArray(delta.splices)) throw new TypeError('Language token delta splices must be an array');
	let previousBaseEnd = 0;
	let previousResultEnd = 0;
	let previousLineDelta = 0;
	const splices = delta.splices.map(splice => {
		if (typeof splice !== 'object' || splice === null) throw new TypeError('Language token delta splice must be an object');
		assertNonNegativeSafeInteger(splice.baseStartItemIndex, 'Language token delta base start item index');
		assertNonNegativeSafeInteger(splice.baseDeleteItemCount, 'Language token delta base delete item count');
		assertNonNegativeSafeInteger(splice.resultStartItemIndex, 'Language token delta result start item index');
		assertNonNegativeSafeInteger(splice.resultInsertItemCount, 'Language token delta result insert item count');
		assertSafeInteger(splice.lineDeltaBefore, 'Language token delta preceding line shift');
		assertSafeInteger(splice.lineDeltaAfter, 'Language token delta following line shift');
		if (splice.baseStartItemIndex < previousBaseEnd || splice.resultStartItemIndex < previousResultEnd) throw new RangeError('Language token delta splices must be ordered and non-overlapping');
		if (splice.baseStartItemIndex - previousBaseEnd !== splice.resultStartItemIndex - previousResultEnd) throw new RangeError('Language token delta unchanged item spans must preserve their length');
		if (splice.lineDeltaBefore !== previousLineDelta) throw new RangeError('Language token delta line shifts must form one continuous mapping');
		if (splice.resultStartItemIndex + splice.resultInsertItemCount > tokenCount) throw new RangeError('Language token delta inserted items exceed the normalized result');
		previousBaseEnd = splice.baseStartItemIndex + splice.baseDeleteItemCount;
		previousResultEnd = splice.resultStartItemIndex + splice.resultInsertItemCount;
		previousLineDelta = splice.lineDeltaAfter;
		return Object.freeze({
			baseStartItemIndex: splice.baseStartItemIndex,
			baseDeleteItemCount: splice.baseDeleteItemCount,
			resultStartItemIndex: splice.resultStartItemIndex,
			resultInsertItemCount: splice.resultInsertItemCount,
			lineDeltaBefore: splice.lineDeltaBefore,
			lineDeltaAfter: splice.lineDeltaAfter,
		});
	});
	if (tokenCount < previousResultEnd) throw new RangeError('Language token delta result item count is inconsistent');
	return Object.freeze({ baseRequestId: delta.baseRequestId, splices: Object.freeze(splices) });
}

function assertNonNegativeSafeInteger(value: unknown, owner: string): asserts value is number {
	if (!isNonNegativeSafeInteger(value)) throw new RangeError(`${owner} must be a non-negative safe integer`);
}

function assertSafeInteger(value: unknown, owner: string): asserts value is number {
	if (!isSafeInteger(value)) throw new RangeError(`${owner} must be a safe integer`);
}

/** Only accepted syntax results may become the next incremental result baseline. */
function createSyntaxResultStore(): WorkerTextModelResultStore<languages.SyntaxLane, languages.SyntaxResult> {
	const confirmed = new Map<languages.SyntaxLane, WorkerTextModelResult<languages.SyntaxResult>>();
	const staged = new Map<number, { lane: languages.SyntaxLane; state: WorkerTextModelResult<languages.SyntaxResult> }>();
	return {
		get: lane => confirmed.get(lane),
		stage: (lane, state) => {
			if (lane !== languages.SYNTAX_TOKENIZE_LANE) staged.set(state.requestId, { lane, state });
		},
		settle: (requestId, applied) => {
			const entry = staged.get(requestId);
			if (!entry) {
				return;
			}
			staged.delete(requestId);
			if (applied && requestId > (confirmed.get(entry.lane)?.requestId ?? 0)) {
				confirmed.set(entry.lane, entry.state);
			}
		},
		clear: () => {
			confirmed.clear();
			staged.clear();
		},
	};
}

export const syntaxWireCodec: WorkerTextModelCodec<languages.SyntaxLane, languages.SyntaxRequest, languages.SyntaxResult> = Object.freeze({
	lanes: Object.freeze([languages.SYNTAX_TOKEN_LANE, languages.SYNTAX_DIAGNOSTIC_LANE, languages.SYNTAX_TOKENIZE_LANE] as const),
	createResultStore: createSyntaxResultStore,
	encodePayload(lane: languages.SyntaxLane, request: languages.SyntaxRequest) {
		languages.assertSyntaxRequest(request);
		assertTokenizationLane(lane, request);
		return Object.freeze({ languageId: request.languageId, ...(request.tokenize === undefined ? {} : {
			tokenize: Object.freeze({ lineNumber: request.tokenize.lineNumber, lines: Object.freeze([...request.tokenize.lines]) }),
		}) });
	},
	decodePayload(lane: languages.SyntaxLane, value: unknown, snapshot: TextSnapshot) {
		assertRecord(value, "Syntax wire request");
		let tokenize: languages.SyntaxRequest["tokenize"];
		if (value.tokenize !== undefined) {
			assertRecord(value.tokenize, "Syntax wire tokenization");
			if (!Array.isArray(value.tokenize.lines)) throw new TypeError("Syntax wire tokenization requires lines");
			const lineNumber = decodePositiveSafeInteger(value.tokenize.lineNumber, "Syntax wire tokenization start line");
			if (lineNumber > snapshot.lineCount) throw new RangeError("Syntax wire tokenization start line is outside the document");
			tokenize = Object.freeze({ lineNumber, lines: Object.freeze(value.tokenize.lines.map(line => decodeString(line, "Syntax wire tokenization line"))) });
		}
		const request = Object.freeze({ languageId: decodeString(value.languageId, "Syntax wire language ID"), ...(tokenize === undefined ? {} : { tokenize }) });
		languages.assertSyntaxRequest(request);
		assertTokenizationLane(lane, request);
		return request;
	},
	encodeResult: encodeSyntaxWireResult,
	decodeResult: decodeSyntaxWireResult,
});

function encodeSyntaxWireResult(lane: languages.SyntaxLane, result: languages.SyntaxResult, snapshot: TextSnapshot, base: WorkerTextModelResult<languages.SyntaxResult> | undefined): unknown {
	assertResultLane(lane, result);
	if (result.lane === languages.SYNTAX_TOKENIZE_LANE) {
		return Object.freeze({ tokens: result.value === null ? null : Object.freeze(result.value.tokens.map(token => syntaxEncodeItem(languages.SYNTAX_TOKEN_LANE, token))) });
	}
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

function decodeSyntaxWireResult(lane: languages.SyntaxLane, value: unknown, snapshot: TextSnapshot, base: WorkerTextModelResult<languages.SyntaxResult> | undefined): languages.SyntaxResult {
	assertRecord(value, "Syntax wire result");
	if (lane === languages.SYNTAX_TOKENIZE_LANE) {
		if (value.tokens === null) return Object.freeze({ lane, value: null });
		if (!Array.isArray(value.tokens)) throw new TypeError("Syntax tokenization result requires tokens or null");
		return Object.freeze({ lane, value: { tokens: value.tokens.map(token => syntaxDecodeItem(languages.SYNTAX_TOKEN_LANE, token) as LanguageToken) } });
	}
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

function readBaseItems(lane: languages.SyntaxLane, base: WorkerTextModelResult<languages.SyntaxResult> | undefined): readonly SyntaxItem[] | undefined {
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

function assertTokenizationLane(lane: languages.SyntaxLane, request: languages.SyntaxRequest): void {
	if ((lane === languages.SYNTAX_TOKENIZE_LANE) !== (request.tokenize !== undefined)) {
		throw new TypeError("Hypothetical tokenization parameters must match their request lane");
	}
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

function assertRecord(value: unknown, owner: string): asserts value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${owner} must be an object`);
}

function decodeString(value: unknown, owner: string): string {
	if (typeof value !== 'string') throw new TypeError(`${owner} must be a string`);
	return value;
}

function decodeNonNegativeSafeInteger(value: unknown, owner: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new RangeError(`${owner} must be a non-negative safe integer`);
	}
	return value as number;
}
