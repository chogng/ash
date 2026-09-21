import { arraysEqual, commonArraySuffixLength, commonPrefixLength } from '../../../../base/common/arrays.js';
import { assertSyntaxRequest, type SyntaxRequest } from '../../languages.js';
import { SYNTAX_DIAGNOSTIC_LANE, SYNTAX_TOKEN_LANE, type SyntaxLane, type SyntaxResult } from './syntaxService.js';
import { type LanguageWorkerWireCodec, type LanguageWorkerWireResultState } from '../languageWorkerWire.js';
import { createLanguageDiagnosticSnapshotNormalizer, type LanguageDiagnostic, type LanguageDiagnosticCode, type LanguageDiagnosticResult } from '../languageResults.js';
import { attachLanguageTokenResultDelta } from '../../services/semanticTokensDto.js';
import { createLanguageTokenSnapshotNormalizer, type LanguageToken, type LanguageTokenResult } from '../../tokens/languageTokens.js';
import { Position } from '../../core/position.js';
import { Range } from '../../core/range.js';
import { type TextSnapshot } from '../../core/textChange.js';

export const syntaxWireCodec: LanguageWorkerWireCodec<SyntaxLane, SyntaxRequest, SyntaxResult> = Object.freeze({
	lanes: Object.freeze([SYNTAX_TOKEN_LANE, SYNTAX_DIAGNOSTIC_LANE] as const),
	resultProtocol: "confirmedBase",
	encodePayload(_lane: SyntaxLane, request: SyntaxRequest) {
		assertSyntaxRequest(request);
		return Object.freeze({ languageId: request.languageId });
	},
	decodePayload(_lane: SyntaxLane, value: unknown, _snapshot: TextSnapshot) {
		assertRecord(value, "Syntax wire request");
		const request = Object.freeze({
			languageId: decodeString(value.languageId, "Syntax wire language ID"),
		});
		assertSyntaxRequest(request);
		return request;
	},
	encodeResult: encodeSyntaxWireResult,
	decodeResult: decodeSyntaxWireResult,
});

function encodeSyntaxWireResult(lane: SyntaxLane, result: SyntaxResult, snapshot: TextSnapshot, base: LanguageWorkerWireResultState<SyntaxResult> | undefined): unknown {
	assertResultLane(lane, result);
	const items = lane === SYNTAX_TOKEN_LANE
		? (result.value as LanguageTokenResult).tokens
		: (result.value as LanguageDiagnosticResult).diagnostics;
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
			items: Object.freeze(splice.items.map(item => encodeItem(lane, item))),
		}))),
	});
}

function decodeSyntaxWireResult(lane: SyntaxLane, value: unknown, snapshot: TextSnapshot, base: LanguageWorkerWireResultState<SyntaxResult> | undefined): SyntaxResult {
	assertRecord(value, "Syntax wire result");
	if (value.kind === "full") {
		if (!Array.isArray(value.items)) throw new TypeError("Full syntax wire result must contain items");
		return resultFromItems(lane, value.items.map(item => decodeItem(lane, item)), snapshot);
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
		const inserted = encodedSplice.items.map(item => decodeItem(lane, item));
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
	if (result.lane === SYNTAX_TOKEN_LANE) {
		attachLanguageTokenResultDelta(result.value, {
			baseRequestId,
			splices: tokenSplices,
		});
	}
	return result;
}

function encodeFull(lane: SyntaxLane, items: readonly SyntaxItem[]): unknown {
	return Object.freeze({
		kind: "full",
		items: Object.freeze(items.map(item => encodeItem(lane, item))),
	});
}

function readBaseItems(lane: SyntaxLane, base: LanguageWorkerWireResultState<SyntaxResult> | undefined): readonly SyntaxItem[] | undefined {
	if (!base || base.result.lane !== lane) return undefined;
	return lane === SYNTAX_TOKEN_LANE
		? (base.result.value as LanguageTokenResult).tokens
		: (base.result.value as LanguageDiagnosticResult).diagnostics;
}

function resultFromItems(lane: SyntaxLane, items: readonly SyntaxItem[], snapshot: TextSnapshot): SyntaxResult {
	return lane === SYNTAX_TOKEN_LANE
		? Object.freeze({
			lane: SYNTAX_TOKEN_LANE,
			value: createLanguageTokenSnapshotNormalizer(snapshot)({ tokens: items as readonly LanguageToken[] }),
		})
		: Object.freeze({
			lane: SYNTAX_DIAGNOSTIC_LANE,
			value: createLanguageDiagnosticSnapshotNormalizer(snapshot)({ diagnostics: items as readonly LanguageDiagnostic[] }),
		});
}

function encodeItem(lane: SyntaxLane, item: SyntaxItem): unknown {
	if (lane === SYNTAX_TOKEN_LANE) {
		const token = item as LanguageToken;
		return Object.freeze({
			range: encodeRange(token.range, "Language token wire range"),
			tokenType: token.tokenType,
			modifiers: Object.freeze([...token.modifiers]),
			...(token.languageId === undefined ? {} : { languageId: token.languageId }),
			...(token.balancedBrackets === undefined ? {} : { balancedBrackets: token.balancedBrackets }),
			...(token.presentation === undefined ? {} : { presentation: token.presentation }),
		});
	}
	const diagnostic = item as LanguageDiagnostic;
	return Object.freeze({
		range: encodeRange(diagnostic.range, "Language diagnostic wire range"),
		severity: diagnostic.severity,
		message: diagnostic.message,
		...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
		...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
	});
}

function decodeItem(lane: SyntaxLane, value: unknown): SyntaxItem {
	assertRecord(value, lane === SYNTAX_TOKEN_LANE ? "Language token wire token" : "Language diagnostic wire diagnostic");
	if (lane === SYNTAX_TOKEN_LANE) {
		if (!Array.isArray(value.modifiers)) {
			throw new TypeError("Language token wire modifiers must be an array");
		}
		return {
			range: decodeRange(value.range, "Language token wire range"),
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
		range: decodeRange(value.range, "Language diagnostic wire range"),
		severity: decodeString(value.severity, "Language diagnostic wire severity") as LanguageDiagnostic["severity"],
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

function shiftItem(lane: SyntaxLane, item: SyntaxItem, lineDelta: number): SyntaxItem {
	const range = Range.fromPositions(
		new Position(item.range.startLineNumber + lineDelta, item.range.startColumn),
		new Position(item.range.endLineNumber + lineDelta, item.range.endColumn),
	);
	return lane === SYNTAX_TOKEN_LANE
		? { ...(item as LanguageToken), range }
		: { ...(item as LanguageDiagnostic), range };
}

function encodeRange(range: Range, owner: string): unknown {
	if (!(range instanceof Range)) throw new TypeError(`${owner} must be a Range`);
	return Object.freeze({
		start: Object.freeze({ lineIndex: range.startLineNumber - 1, columnIndex: range.startColumn - 1 }),
		end: Object.freeze({ lineIndex: range.endLineNumber - 1, columnIndex: range.endColumn - 1 }),
	});
}

function decodeRange(value: unknown, owner: string): Range {
	assertRecord(value, owner);
	return Range.fromPositions(decodePosition(value.start, `${owner} start`), decodePosition(value.end, `${owner} end`));
}

function decodePosition(value: unknown, owner: string): Position {
	assertRecord(value, owner);
	return new Position((decodeNonNegativeSafeInteger(value.lineIndex, `${owner} line index`)) + 1, (decodeNonNegativeSafeInteger(value.columnIndex, `${owner} column index`)) + 1);
}

function decodeDiagnosticCode(value: unknown): LanguageDiagnosticCode | undefined {
	if (value === undefined || typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw new TypeError("Language diagnostic wire code must be a finite number or string");
}

function assertResultLane(lane: SyntaxLane, result: SyntaxResult): void {
	if (!result || result.lane !== lane) throw new TypeError(`Syntax wire result does not match lane '${lane}'`);
}

function decodeString(value: unknown, owner: string): string {
	if (typeof value !== "string") throw new TypeError(`${owner} must be a string`);
	return value;
}

function decodePositiveSafeInteger(value: unknown, owner: string): number {
	const decoded = decodeNonNegativeSafeInteger(value, owner);
	if (decoded === 0) throw new RangeError(`${owner} must be positive`);
	return decoded;
}

function decodeNonNegativeSafeInteger(value: unknown, owner: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RangeError(`${owner} must be a non-negative safe integer`);
	return value as number;
}

function decodeSafeInteger(value: unknown, owner: string): number {
	if (!Number.isSafeInteger(value)) throw new RangeError(`${owner} must be a safe integer`);
	return value as number;
}

function assertRecord(value: unknown, owner: string): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${owner} must be an object`);
}

type SyntaxItem = LanguageToken | LanguageDiagnostic;

interface SyntaxItemSplice {
	readonly startItemIndex: number;
	readonly deleteItemCount: number;
	readonly items: readonly SyntaxItem[];
	readonly lineDeltaBefore: number;
	readonly lineDeltaAfter: number;
}

interface LinePair {
	readonly previousLineIndex: number;
	readonly currentLineIndex: number;
}

interface LineRun extends LinePair {
	readonly lineCount: number;
}

function createSyntaxItemSplices(lane: SyntaxLane, previous: readonly SyntaxItem[], current: readonly SyntaxItem[], previousSnapshot: TextSnapshot, currentSnapshot: TextSnapshot): readonly SyntaxItemSplice[] {
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

function syntaxItemsEqual(lane: SyntaxLane, current: SyntaxItem, previous: SyntaxItem, lineDelta: number): boolean {
	if (!rangesEqual(current.range, previous.range, lineDelta)) return false;
	if (lane === SYNTAX_TOKEN_LANE) {
		const currentToken = current as LanguageToken;
		const previousToken = previous as LanguageToken;
		return currentToken.tokenType === previousToken.tokenType &&
			arraysEqual(currentToken.modifiers, previousToken.modifiers) &&
			currentToken.languageId === previousToken.languageId &&
			currentToken.balancedBrackets === previousToken.balancedBrackets &&
			tokenPresentationsEqual(currentToken.presentation, previousToken.presentation);
	}
	const currentDiagnostic = current as LanguageDiagnostic;
	const previousDiagnostic = previous as LanguageDiagnostic;
	return currentDiagnostic.severity === previousDiagnostic.severity &&
		currentDiagnostic.message === previousDiagnostic.message &&
		currentDiagnostic.code === previousDiagnostic.code &&
		currentDiagnostic.source === previousDiagnostic.source;
}

function createStableLineRuns(lane: SyntaxLane, previousItems: readonly SyntaxItem[], currentItems: readonly SyntaxItem[], previousLines: readonly string[], currentLines: readonly string[], previousBounds: readonly number[], currentBounds: readonly number[]): readonly LineRun[] {
	const pairs = createStableLinePairs(previousLines, currentLines).filter(pair => lineItemsEqual(
		lane,
		previousItems.slice(previousBounds[pair.previousLineIndex], previousBounds[pair.previousLineIndex + 1]),
		currentItems.slice(currentBounds[pair.currentLineIndex], currentBounds[pair.currentLineIndex + 1]),
		pair.currentLineIndex - pair.previousLineIndex,
	));
	const runs: LineRun[] = [];
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

function createStableLinePairs(previous: readonly string[], current: readonly string[]): readonly LinePair[] {
	const prefixLength = commonPrefixLength(previous, current);
	const suffixLength = commonArraySuffixLength(previous, current, prefixLength);
	const pairs = new Map<string, LinePair>();
	for (let index = 0; index < prefixLength; index += 1) addPair(pairs, index, index);
	const previousInteriorEnd = previous.length - suffixLength;
	const currentInteriorEnd = current.length - suffixLength;
	const previousUnique = uniqueLineIndexes(previous, prefixLength, previousInteriorEnd);
	const currentUnique = uniqueLineIndexes(current, prefixLength, currentInteriorEnd);
	const candidates: LinePair[] = [];
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

function createSingleSplice(lane: SyntaxLane, previous: readonly SyntaxItem[], current: readonly SyntaxItem[], lineDelta: number): SyntaxItemSplice {
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

function lineItemsEqual(lane: SyntaxLane, previous: readonly SyntaxItem[], current: readonly SyntaxItem[], lineDelta: number): boolean {
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

function longestIncreasingPairs(pairs: readonly LinePair[]): readonly LinePair[] {
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
	const result: LinePair[] = [];
	for (let index = tails.at(-1)!; index >= 0; index = predecessors[index]!) result.push(pairs[index]!);
	return result.reverse();
}

function addPair(pairs: Map<string, LinePair>, previousLineIndex: number, currentLineIndex: number): void {
	pairs.set(`${previousLineIndex}:${currentLineIndex}`, Object.freeze({ previousLineIndex, currentLineIndex }));
}

function comparePairs(left: LinePair, right: LinePair): number {
	return left.previousLineIndex - right.previousLineIndex || left.currentLineIndex - right.currentLineIndex;
}

function rangesEqual(current: Range, previous: Range, lineDelta: number): boolean {
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
