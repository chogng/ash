import { timeout } from '../../../../base/common/async.js';
import { getTextGraphemeBoundaries } from '../../core/textSegmentation.js';
import { LineRange } from '../../core/ranges/lineRange.js';
import { Range } from '../../core/range.js';
import { LinesDiff, MovedText, type ILinesDiffComputer, type ILinesDiffComputerOptions } from '../linesDiffComputer.js';
import { DetailedLineRangeMapping, LineRangeMapping, RangeMapping } from '../rangeMapping.js';

const identifierTokenPattern = /^[$_\p{ID_Continue}]+$/u;

/** Computes one document diff; the asynchronous entry yields for Worker cancellation. */
export class DefaultLinesDiffComputer implements ILinesDiffComputer {
	public computeDiff(originalLines: string[], modifiedLines: string[], options: ILinesDiffComputerOptions): LinesDiff {
		const computation = diffLines(originalLines, modifiedLines, options);
		const deadline = options.maxComputationTimeMs === 0 ? Infinity : performance.now() + options.maxComputationTimeMs;
		for (;;) {
			const step = computation.next();
			if (step.done) return step.value;
			if (performance.now() >= deadline) return timedOutDiff(originalLines.length, modifiedLines.length);
		}
	}

	public async computeDiffAsync(originalLines: string[], modifiedLines: string[], options: ILinesDiffComputerOptions, signal: AbortSignal): Promise<LinesDiff> {
		signal.throwIfAborted();
		const computation = diffLines(originalLines, modifiedLines, options);
		const deadline = options.maxComputationTimeMs === 0 ? Infinity : performance.now() + options.maxComputationTimeMs;
		let yieldAt = performance.now() + 8;
		for (;;) {
			signal.throwIfAborted();
			const step = computation.next();
			if (step.done) return step.value;
			const now = performance.now();
			if (now >= deadline) return timedOutDiff(originalLines.length, modifiedLines.length);
			if (now >= yieldAt) {
				await timeout(0);
				yieldAt = performance.now() + 8;
			}
		}
	}
}

function* diffLines(original: readonly string[], modified: readonly string[], options: ILinesDiffComputerOptions): Generator<void, LinesDiff> {
	const originalCompared = options.ignoreTrimWhitespace ? original.map(line => line.trim()) : original;
	const modifiedCompared = options.ignoreTrimWhitespace ? modified.map(line => line.trim()) : modified;
	const matches = yield* matchingItems(originalCompared, modifiedCompared);
	matches.push([original.length, modified.length]);
	const spans: Span[] = [];
	let originalIndex = 0;
	let modifiedIndex = 0;
	for (const [originalMatch, modifiedMatch] of matches) {
		if (originalMatch > originalIndex || modifiedMatch > modifiedIndex) {
			spans.push([originalIndex, originalMatch, modifiedIndex, modifiedMatch]);
		}
		originalIndex = originalMatch + 1;
		modifiedIndex = modifiedMatch + 1;
	}
	yield* alignLineChangeBoundaries(original, modified, spans);
	const changes: DetailedLineRangeMapping[] = [];
	for (const [originalStart, originalEnd, modifiedStart, modifiedEnd] of spans) {
		const innerChanges: RangeMapping[] = [];
		const pairs = yield* pairChangedLines(original.slice(originalStart, originalEnd), modified.slice(modifiedStart, modifiedEnd));
		for (const [left, right] of pairs) {
			innerChanges.push(...(yield* diffCharacters(original[originalStart + left]!, modified[modifiedStart + right]!, originalStart + left + 1, modifiedStart + right + 1)));
			yield;
		}
		changes.push(
			new DetailedLineRangeMapping(new LineRange(originalStart + 1, originalEnd + 1), new LineRange(modifiedStart + 1, modifiedEnd + 1), innerChanges.length === 0 ? undefined : innerChanges),
		);
	}
	const moves = options.computeMoves ? yield* findMoves(changes, original, modified, options) : [];
	return new LinesDiff(changes, moves, false);
}

/** Rotate identical edge lines to keep an insertion or deletion out of an indented block's body. */
function* alignLineChangeBoundaries(original: readonly string[], modified: readonly string[], spans: Span[]): Generator<void> {
	let work = 0;
	for (let index = 0; index < spans.length; index++) {
		if (++work % 256 === 0) {
			yield;
		}
		const span = spans[index]!;
		if (span[0] !== span[1] && span[2] !== span[3]) {
			continue;
		}
		const isInsertion = span[0] === span[1];
		const contextSide = isInsertion ? 0 : 2;
		const editedSide = isInsertion ? 2 : 0;
		const context = isInsertion ? original : modified;
		const edited = isInsertion ? modified : original;
		const contextPosition = span[contextSide];
		const start = span[editedSide];
		const end = span[editedSide + 1]!;
		const previous = spans[index - 1];
		const next = spans[index + 1];
		// Retain an unchanged line between hunks; a boundary adjustment must not
		// consume context belonging to an adjacent replacement or another block.
		const minimumContext = (previous?.[contextSide + 1] ?? -1) + 1;
		const minimumEdited = (previous?.[editedSide + 1] ?? -1) + 1;
		const maximumContext = (next?.[contextSide] ?? context.length + 1) - 1;
		const maximumEdited = (next?.[editedSide] ?? edited.length + 1) - 1;
		let bestPosition = contextPosition;
		let bestStart = start;
		const initialCost = lineIndentation(edited[start]!) + lineIndentation(edited[end - 1]!);
		if (initialCost === 0) {
			continue;
		}
		let bestCost = initialCost;
		for (const direction of [-1, 1]) {
			let position = contextPosition;
			let from = start;
			let to = end;
			while (position + direction >= minimumContext && position + direction <= maximumContext && from + direction >= minimumEdited && to + direction <= maximumEdited) {
				const edgeOffset = direction < 0 ? -1 : 0;
				const line = edited[from + edgeOffset]!;
				// Exact equality on both documents keeps ignored whitespace from
				// turning a visual adjustment into a different text edit.
				if (line !== edited[to + edgeOffset] || line !== context[position + edgeOffset]) {
					break;
				}
				position += direction;
				from += direction;
				to += direction;
				const cost = lineIndentation(edited[from]!) + lineIndentation(edited[to - 1]!);
				// Prefer shallower block edges, then the earlier equivalent range
				// so a leading blank separator stays with the inserted block.
				if (cost < bestCost || (cost === bestCost && from < bestStart)) {
					bestPosition = position;
					bestStart = from;
					bestCost = cost;
				}
				if (++work % 256 === 0) {
					yield;
				}
			}
		}
		// Blank-only edits and equally indented repeated lines need no adjustment.
		if (bestCost < initialCost) {
			const bestEnd = bestStart + end - start;
			spans[index] = isInsertion ? [bestPosition, bestPosition, bestStart, bestEnd] : [bestStart, bestEnd, bestPosition, bestPosition];
		}
	}
}

function lineIndentation(line: string): number {
	const indentation = line.search(/\S/u);
	return indentation < 0 ? 0 : indentation;
}

function* diffCharacters(original: string, modified: string, originalLineNumber: number, modifiedLineNumber: number): Generator<void, RangeMapping[]> {
	const originalTokens = diffTokens(original);
	const modifiedTokens = diffTokens(modified);
	const originalContent = tokenContentRange(originalTokens.values);
	const modifiedContent = tokenContentRange(modifiedTokens.values);
	const matches: Match[] = [];
	let matchingWords = 0;
	// Indentation and trailing whitespace belong to the line edges. Otherwise
	// an added trailing space can steal the match for a space between identifiers.
	for (const [leftStart, leftEnd, rightStart, rightEnd] of [
		[0, originalContent[0], 0, modifiedContent[0]],
		[originalContent[0], originalContent[1], modifiedContent[0], modifiedContent[1]],
		[originalContent[1], originalTokens.values.length, modifiedContent[1], modifiedTokens.values.length],
	] as const) {
		const segmentMatches = yield* matchingItems(originalTokens.values.slice(leftStart, leftEnd), modifiedTokens.values.slice(rightStart, rightEnd));
		for (const [left, right] of segmentMatches) {
			matches.push([left + leftStart, right + rightStart]);
			if (identifierTokenPattern.test(originalTokens.values[left + leftStart]!)) {
				matchingWords++;
			}
			if (matches.length % 2048 === 0) {
				yield;
			}
		}
	}
	matches.push([originalTokens.values.length, modifiedTokens.values.length]);
	const changes: RangeMapping[] = [];
	let originalIndex = 0;
	let modifiedIndex = 0;
	for (const [originalMatch, modifiedMatch] of matches) {
		if (originalMatch > originalIndex || modifiedMatch > modifiedIndex) {
			changes.push(
				new RangeMapping(
					new Range(originalLineNumber, originalTokens.boundaries[originalIndex]! + 1, originalLineNumber, originalTokens.boundaries[originalMatch]! + 1),
					new Range(modifiedLineNumber, modifiedTokens.boundaries[modifiedIndex]! + 1, modifiedLineNumber, modifiedTokens.boundaries[modifiedMatch]! + 1),
				),
			);
		}
		originalIndex = originalMatch + 1;
		modifiedIndex = modifiedMatch + 1;
	}
	return coalesceCharacterChanges(original, changes, matchingWords);
}

function coalesceCharacterChanges(original: string, changes: readonly RangeMapping[], matchingWords: number): RangeMapping[] {
	if (matchingWords === 0 && changes.length > 1) {
		// Spaces and delimiters alone do not establish shared code in a rewrite.
		const first = changes[0]!;
		const last = changes.at(-1)!;
		return [new RangeMapping(first.originalRange.plusRange(last.originalRange), first.modifiedRange.plusRange(last.modifiedRange))];
	}
	const result: RangeMapping[] = [];
	for (const change of changes) {
		const previous = result.at(-1);
		if (previous) {
			const gap = original.slice(previous.originalRange.endColumn - 1, change.originalRange.startColumn - 1);
			const beforeLength = Math.max(previous.originalRange.endColumn - previous.originalRange.startColumn, previous.modifiedRange.endColumn - previous.modifiedRange.startColumn);
			const afterLength = Math.max(change.originalRange.endColumn - change.originalRange.startColumn, change.modifiedRange.endColumn - change.modifiedRange.startColumn);
			// Nearby renamed words form one phrase or argument list. Keep unchanged
			// identifiers, operators and call boundaries as meaningful separators.
			if (gap.length <= 4 && /^[\s,.]*$/u.test(gap) && Math.min(beforeLength, afterLength) > gap.length) {
				result[result.length - 1] = new RangeMapping(previous.originalRange.plusRange(change.originalRange), previous.modifiedRange.plusRange(change.modifiedRange));
				continue;
			}
		}
		result.push(change);
	}
	return result;
}

function tokenContentRange(tokens: readonly string[]): readonly [number, number] {
	let start = 0;
	let end = tokens.length;
	while (start < end && /^\s+$/u.test(tokens[start]!)) {
		start++;
	}
	while (end > start && /^\s+$/u.test(tokens[end - 1]!)) {
		end--;
	}
	return [start, end];
}

/** Identifiers are indivisible; punctuation and whitespace retain grapheme-level precision. */
function diffTokens(text: string): { values: string[]; boundaries: number[] } {
	const graphemes = getTextGraphemeBoundaries(text);
	const boundaries = [0];
	let previousIsWord = false;
	for (let index = 1; index < graphemes.length; index++) {
		const start = graphemes[index - 1]!;
		const end = graphemes[index]!;
		const isWord = identifierTokenPattern.test(text.slice(start, end));
		if (isWord && previousIsWord) {
			boundaries[boundaries.length - 1] = end;
		} else {
			boundaries.push(end);
		}
		previousIsWord = isWord;
	}
	return { values: boundaries.slice(1).map((end, index) => text.slice(boundaries[index], end)), boundaries };
}

interface LineWords {
	readonly counts: ReadonlyMap<string, number>;
	readonly weight: number;
}

function lineWords(line: string): LineWords {
	const counts = new Map<string, number>();
	let weight = 0;
	for (const match of line.matchAll(/[$_\p{ID_Continue}]+/gu)) {
		const word = match[0];
		counts.set(word, (counts.get(word) ?? 0) + 1);
		weight += Math.min(word.length, 32);
	}
	return { counts, weight };
}

function lineSimilarity(original: LineWords, modified: LineWords): number {
	let overlap = 0;
	for (const [word, count] of original.counts) {
		overlap += Math.min(count, modified.counts.get(word) ?? 0) * Math.min(word.length, 32);
	}
	// Shared punctuation cannot anchor a pair, and weak word overlap should not
	// consume a line that has a more convincing counterpart later in the hunk.
	return overlap === 0 ? 0 : Math.max(0, (2 * overlap) / (original.weight + modified.weight) - 0.3);
}

/** Weighted ordered alignment with linear memory, yielding for the diff's deadline and cancellation. */
function* similarLinePairs(original: readonly LineWords[], modified: readonly LineWords[]): Generator<void, Match[]> {
	const pending: Span[] = [[0, original.length, 0, modified.length]];
	const matches: Match[] = [];
	while (pending.length) {
		const [leftStart, leftEnd, rightStart, rightEnd] = pending.pop()!;
		if (leftStart === leftEnd || rightStart === rightEnd) {
			continue;
		}
		if (leftEnd - leftStart === 1) {
			let bestScore = 0;
			let bestRight = rightStart;
			for (let right = rightStart; right < rightEnd; right++) {
				const score = lineSimilarity(original[leftStart]!, modified[right]!);
				if (score > bestScore) {
					bestScore = score;
					bestRight = right;
				}
				if ((right - rightStart) % 256 === 0) {
					yield;
				}
			}
			if (bestScore > 0) {
				matches.push([leftStart, bestRight]);
			}
			continue;
		}
		const middle = Math.floor((leftStart + leftEnd) / 2);
		const forward = yield* lineAlignmentScores(original, modified, [leftStart, middle, rightStart, rightEnd], 'forward');
		const backward = yield* lineAlignmentScores(original, modified, [middle, leftEnd, rightStart, rightEnd], 'backward');
		let bestScore = 0;
		let split = rightStart;
		for (let offset = 0; offset <= rightEnd - rightStart; offset++) {
			const score = forward[offset]! + backward[rightEnd - rightStart - offset]!;
			if (score > bestScore) {
				bestScore = score;
				split = rightStart + offset;
			}
		}
		if (bestScore > 0) {
			pending.push([middle, leftEnd, split, rightEnd], [leftStart, middle, rightStart, split]);
		}
		yield;
	}
	return matches;
}

function* lineAlignmentScores(original: readonly LineWords[], modified: readonly LineWords[], span: Span, direction: 'forward' | 'backward'): Generator<void, Float64Array> {
	const [leftStart, leftEnd, rightStart, rightEnd] = span;
	const scores = new Float64Array(rightEnd - rightStart + 1);
	let work = 0;
	for (let left = 0; left < leftEnd - leftStart; left++) {
		const words = original[direction === 'forward' ? leftStart + left : leftEnd - left - 1]!;
		let diagonal = 0;
		for (let right = 1; right < scores.length; right++) {
			const previous = scores[right]!;
			const similarity = lineSimilarity(words, modified[direction === 'forward' ? rightStart + right - 1 : rightEnd - right]!);
			scores[right] = Math.max(previous, scores[right - 1]!, diagonal + similarity);
			diagonal = previous;
			if (++work % 256 === 0) {
				yield;
			}
		}
	}
	return scores;
}

function* pairChangedLines(original: readonly string[], modified: readonly string[]): Generator<void, Match[]> {
	if (original.length === 0 || modified.length === 0) {
		return [];
	}
	const originals: LineWords[] = [];
	const modifications: LineWords[] = [];
	for (const [lines, words] of [
		[original, originals],
		[modified, modifications],
	] as const) {
		for (const line of lines) {
			words.push(lineWords(line));
			if (words.length % 256 === 0) {
				yield;
			}
		}
	}
	const words = new Set<string>();
	let work = 0;
	for (const line of originals) {
		for (const word of line.counts.keys()) {
			words.add(word);
			if (++work % 2048 === 0) {
				yield;
			}
		}
	}
	let hasSharedWords = false;
	for (const line of modifications) {
		for (const word of line.counts.keys()) {
			if (words.has(word)) {
				hasSharedWords = true;
				break;
			}
			if (++work % 2048 === 0) {
				yield;
			}
		}
		if (hasSharedWords) {
			break;
		}
	}
	// A disjoint vocabulary cannot produce anchors; skip the quadratic scoring pass.
	const anchors = hasSharedWords ? yield* similarLinePairs(originals, modifications) : [];
	anchors.push([original.length, modified.length]);
	const pairs: Match[] = [];
	let left = 0;
	let right = 0;
	for (const [originalAnchor, modifiedAnchor] of anchors) {
		// With no content evidence, retain positional replacement behavior inside
		// the gap. Anchors keep those gaps from swallowing inserted setup lines.
		while (left < originalAnchor && right < modifiedAnchor) {
			pairs.push([left++, right++]);
		}
		if (originalAnchor < original.length && modifiedAnchor < modified.length) {
			pairs.push([originalAnchor, modifiedAnchor]);
		}
		left = originalAnchor + 1;
		right = modifiedAnchor + 1;
	}
	return pairs;
}

interface MoveFragment {
	readonly range: LineRange;
	readonly lines: string[];
}

interface MoveSpan extends MoveFragment {
	readonly change: DetailedLineRangeMapping;
	readonly text: string;
	readonly words: ReadonlyMap<string, number>;
	readonly weight: number;
}

/** Match displaced spans by shared content, then compute their edits with the same line algorithm. */
function* findMoves(changes: readonly DetailedLineRangeMapping[], original: readonly string[], modified: readonly string[], options: ILinesDiffComputerOptions): Generator<void, MovedText[]> {
	const sources: MoveSpan[] = [];
	const destinations: MoveSpan[] = [];
	const destinationWords = new Map<string, Set<MoveSpan>>();
	let work = 0;
	for (const [lines, side, spans] of [
		[original, 'original', sources],
		[modified, 'modified', destinations],
	] as const) {
		for (const change of changes) {
			const range = change[side];
			if (range.isEmpty) {
				continue;
			}
			const content = lines.slice(range.startLineNumber - 1, range.endLineNumberExclusive - 1);
			const words = new Map<string, number>();
			let weight = 0;
			for (const line of content) {
				for (const match of line.matchAll(/[\p{L}\p{N}_$]+/gu)) {
					const word = match[0];
					words.set(word, (words.get(word) ?? 0) + 1);
					weight += word.length;
					if (++work % 256 === 0) {
						yield;
					}
				}
				if (++work % 256 === 0) {
					yield;
				}
			}
			const span: MoveSpan = {
				change,
				range,
				lines: content,
				words,
				weight,
				text: (options.ignoreTrimWhitespace ? content.map(line => line.trim()) : content).join('\n'),
			};
			spans.push(span);
			if (side === 'modified') {
				for (const word of words.keys()) {
					let entries = destinationWords.get(word);
					if (!entries) {
						entries = new Set();
						destinationWords.set(word, entries);
					}
					entries.add(span);
				}
			}
		}
	}
	const candidates: MoveCandidate[] = [];
	for (const source of sources) {
		const overlaps = new Map<MoveSpan, { weight: number; words: number }>();
		for (const [word, count] of source.words) {
			for (const destination of destinationWords.get(word) ?? []) {
				if (source.change === destination.change) {
					continue;
				}
				const overlap = overlaps.get(destination) ?? { weight: 0, words: 0 };
				overlap.weight += Math.min(count, destination.words.get(word)!) * word.length;
				overlap.words++;
				overlaps.set(destination, overlap);
				if (++work % 256 === 0) {
					yield;
				}
			}
		}
		for (const [destination, overlap] of overlaps) {
			candidates.push(...(yield* anchoredMoveCandidates(source, destination)));
			// An insertion hunk can contain several separately removed blocks.
			for (let start = 0; start + source.lines.length <= destination.lines.length; start++) {
				let equal = true;
				for (let offset = 0; offset < source.lines.length; offset++) {
					const left = source.lines[offset]!;
					const right = destination.lines[start + offset]!;
					if (++work % 256 === 0) {
						yield;
					}
					if (options.ignoreTrimWhitespace ? left.trim() !== right.trim() : left !== right) {
						equal = false;
						break;
					}
				}
				if (equal) {
					candidates.push({
						source,
						destination: moveFragment(destination, start, start + source.lines.length),
						score: 2,
					});
				}
			}
			const exact = source.text === destination.text;
			const similarity = (2 * overlap.weight) / (source.weight + destination.weight);
			// Renaming can replace entire words while retaining nearly all characters.
			const characterSimilarity =
				source.change.modified.isEmpty && destination.change.original.isEmpty && source.lines.length >= 3 && destination.lines.length >= 3
					? yield* moveCharacterSimilarity(source.text, destination.text)
					: 0;
			// Punctuation and a single shared keyword cannot establish an edited move.
			if (exact || (overlap.words >= 2 && overlap.weight >= 8 && (similarity >= 0.7 || characterSimilarity > 0.9))) {
				candidates.push({ source, destination, score: exact ? 2 : Math.max(similarity, characterSimilarity) });
			}
		}
		yield;
	}
	candidates.sort(
		(left, right) =>
			right.score - left.score ||
			Math.abs(left.source.range.startLineNumber - left.destination.range.startLineNumber) - Math.abs(right.source.range.startLineNumber - right.destination.range.startLineNumber),
	);
	const usedSources: LineRange[] = [];
	const usedDestinations: LineRange[] = [];
	const moves: MovedText[] = [];
	for (const { source, destination } of candidates) {
		if (usedSources.some(range => range.intersect(source.range)?.isEmpty === false) || usedDestinations.some(range => range.intersect(destination.range)?.isEmpty === false)) {
			continue;
		}
		usedSources.push(source.range);
		usedDestinations.push(destination.range);
		const result = yield* diffLines(source.lines, destination.lines, { ...options, computeMoves: false });
		const originalOffset = source.range.startLineNumber - 1;
		const modifiedOffset = destination.range.startLineNumber - 1;
		const moveChanges = result.changes.map(
			change =>
				new DetailedLineRangeMapping(
					change.original.delta(originalOffset),
					change.modified.delta(modifiedOffset),
					change.innerChanges?.map(
						inner =>
							new RangeMapping(
								new Range(
									inner.originalRange.startLineNumber + originalOffset,
									inner.originalRange.startColumn,
									inner.originalRange.endLineNumber + originalOffset,
									inner.originalRange.endColumn,
								),
								new Range(
									inner.modifiedRange.startLineNumber + modifiedOffset,
									inner.modifiedRange.startColumn,
									inner.modifiedRange.endLineNumber + modifiedOffset,
									inner.modifiedRange.endColumn,
								),
							),
					),
				),
		);
		moves.push(new MovedText(new LineRangeMapping(source.range, destination.range), moveChanges));
	}
	return moves.sort((left, right) => left.lineRangeMapping.original.startLineNumber - right.lineRangeMapping.original.startLineNumber);
}

interface MoveCandidate {
	readonly source: MoveFragment;
	readonly destination: MoveFragment;
	readonly score: number;
}

/** Revisit unmatched lines so reordered blocks in the same two hunks remain discoverable. */
function* anchoredMoveCandidates(source: MoveSpan, destination: MoveSpan): Generator<void, MoveCandidate[]> {
	const original = source.lines.map(line => line.trim());
	const modified = destination.lines.map(line => line.trim());
	const remainingOriginal = new Set(original.map((_, index) => index));
	const remainingModified = new Set(modified.map((_, index) => index));
	const candidates: MoveCandidate[] = [];
	for (;;) {
		const originalIndexes = [...remainingOriginal];
		const modifiedIndexes = [...remainingModified];
		const matches = yield* matchingItems(
			originalIndexes.map(index => original[index]!),
			modifiedIndexes.map(index => modified[index]!),
		);
		const anchors = matches.map(([left, right]): Match => [originalIndexes[left]!, modifiedIndexes[right]!]);
		let found = false;
		// Line anchors identify the moved portion of a hunk containing other code.
		// Short gaps may contain edits; unrelated neighboring lines end the fragment.
		for (let first = 0; first < anchors.length;) {
			let last = first;
			while (last + 1 < anchors.length && anchors[last + 1]![0] - anchors[last]![0] <= 3 && anchors[last + 1]![1] - anchors[last]![1] <= 3) {
				last++;
			}
			const meaningful = anchors.slice(first, last + 1).filter(([line]) => original[line]!.length >= 2);
			if (last - first >= 2 && meaningful.length >= 2 && meaningful.reduce((length, [line]) => length + original[line]!.length, 0) >= 15) {
				let [sourceStart, destinationStart] = anchors[first]!;
				let [sourceEnd, destinationEnd] = anchors[last]!;
				sourceEnd++;
				destinationEnd++;
				while (
					remainingOriginal.has(sourceStart - 1) &&
					remainingModified.has(destinationStart - 1) &&
					(yield* similarMoveLines(original[sourceStart - 1]!, modified[destinationStart - 1]!))
				) {
					sourceStart--;
					destinationStart--;
				}
				while (remainingOriginal.has(sourceEnd) && remainingModified.has(destinationEnd) && (yield* similarMoveLines(original[sourceEnd]!, modified[destinationEnd]!))) {
					sourceEnd++;
					destinationEnd++;
				}
				candidates.push({
					source: moveFragment(source, sourceStart, sourceEnd),
					destination: moveFragment(destination, destinationStart, destinationEnd),
					score: 1 + (last - first + 1) / Math.max(sourceEnd - sourceStart, destinationEnd - destinationStart),
				});
				for (let line = sourceStart; line < sourceEnd; line++) remainingOriginal.delete(line);
				for (let line = destinationStart; line < destinationEnd; line++) remainingModified.delete(line);
				found = true;
			}
			first = last + 1;
			yield;
		}
		if (!found) return candidates;
	}
}

function moveFragment(span: MoveFragment, start: number, end: number): MoveFragment {
	return {
		range: new LineRange(span.range.startLineNumber + start, span.range.startLineNumber + end),
		lines: span.lines.slice(start, end),
	};
}

function* similarMoveLines(left: string, right: string): Generator<void, boolean> {
	if (left === right) return true;
	const original = Array.from(left.replace(/\s/gu, ''));
	const modified = Array.from(right.replace(/\s/gu, ''));
	const length = Math.max(original.length, modified.length);
	if (length <= 10) return false;
	const matches = yield* matchingItems(original, modified);
	return matches.length / length > 0.6;
}

function* moveCharacterSimilarity(left: string, right: string): Generator<void, number> {
	const counts = new Map<string, number>();
	let length = 0;
	let shared = 0;
	for (const [text, direction] of [
		[left, 1],
		[right, -1],
	] as const) {
		for (const character of text) {
			if (/\s/u.test(character)) continue;
			length++;
			const count = counts.get(character) ?? 0;
			if (direction === -1 && count > 0) shared++;
			counts.set(character, count + direction);
			if (length % 256 === 0) yield;
		}
	}
	return length === 0 ? 0 : (2 * shared) / length;
}

function timedOutDiff(originalLineCount: number, modifiedLineCount: number): LinesDiff {
	return new LinesDiff([new DetailedLineRangeMapping(new LineRange(1, originalLineCount + 1), new LineRange(1, modifiedLineCount + 1), undefined)], [], true);
}
type Match = readonly [originalIndex: number, modifiedIndex: number];
type Span = readonly [originalStart: number, originalEnd: number, modifiedStart: number, modifiedEnd: number];

/** Linear-space Myers partitioning; only matched indices survive each partition. */
function* matchingItems(original: readonly string[], modified: readonly string[]): Generator<void, Match[]> {
	const pending: Span[] = [[0, original.length, 0, modified.length]];
	const matches: Match[] = [];
	let work = 0;
	while (pending.length) {
		let [leftStart, leftEnd, rightStart, rightEnd] = pending.pop()!;
		while (leftStart < leftEnd && rightStart < rightEnd && original[leftStart] === modified[rightStart]) {
			matches.push([leftStart++, rightStart++]);
			if (++work % 2048 === 0) {
				yield;
			}
		}
		while (leftStart < leftEnd && rightStart < rightEnd && original[leftEnd - 1] === modified[rightEnd - 1]) {
			matches.push([--leftEnd, --rightEnd]);
			if (++work % 2048 === 0) {
				yield;
			}
		}
		if (leftStart === leftEnd || rightStart === rightEnd) {
			continue;
		}
		if (leftEnd - leftStart === 1 || rightEnd - rightStart === 1) {
			for (let left = leftStart; left < leftEnd; left++) {
				for (let right = rightStart; right < rightEnd; right++) {
					if (original[left] === modified[right]) {
						matches.push([left, right]);
						left = leftEnd;
						break;
					}
					if (++work % 2048 === 0) {
						yield;
					}
				}
			}
			continue;
		}
		// Disjoint spans have an exact empty match set, without exploring every edit path.
		const values = new Set<string>();
		for (let index = leftStart; index < leftEnd; index++) {
			values.add(original[index]!);
			if (++work % 2048 === 0) {
				yield;
			}
		}
		let hasMatch = false;
		for (let index = rightStart; index < rightEnd; index++) {
			if (values.has(modified[index]!)) {
				hasMatch = true;
				break;
			}
			if (++work % 2048 === 0) {
				yield;
			}
		}
		if (!hasMatch) {
			continue;
		}
		const [left, right] = yield* partition(original, modified, [leftStart, leftEnd, rightStart, rightEnd]);
		pending.push([left, leftEnd, right, rightEnd], [leftStart, left, rightStart, right]);
	}
	return matches.sort((left, right) => left[0] - right[0]);
}

function* partition(original: readonly string[], modified: readonly string[], span: Span): Generator<void, Match> {
	const [leftStart, leftEnd, rightStart, rightEnd] = span;
	const leftLength = leftEnd - leftStart;
	const rightLength = rightEnd - rightStart;
	const distance = Math.ceil((leftLength + rightLength) / 2);
	const offset = distance + 1;
	const forward = new Int32Array(2 * distance + 3).fill(-1);
	const backward = new Int32Array(forward.length).fill(-1);
	forward[offset + 1] = 0;
	backward[offset + 1] = 0;
	const delta = leftLength - rightLength;
	const odd = delta % 2 !== 0;
	let work = 0;
	for (let edits = 0; edits <= distance; edits++) {
		for (const reverse of [false, true]) {
			const frontier = reverse ? backward : forward;
			for (let diagonal = -edits; diagonal <= edits; diagonal += 2) {
				const index = offset + diagonal;
				let left = diagonal === -edits || (diagonal !== edits && frontier[index - 1]! < frontier[index + 1]!) ? frontier[index + 1]! : frontier[index - 1]! + 1;
				let right = left - diagonal;
				while (left < leftLength && right < rightLength && original[reverse ? leftEnd - left - 1 : leftStart + left] === modified[reverse ? rightEnd - right - 1 : rightStart + right]) {
					left++;
					right++;
					if (++work % 2048 === 0) {
						yield;
					}
				}
				frontier[index] = left;
				const otherDiagonal = delta - diagonal;
				const otherDistance = reverse ? edits : edits - 1;
				if (reverse !== odd && Math.abs(otherDiagonal) <= otherDistance) {
					const other = (reverse ? forward : backward)[offset + otherDiagonal]!;
					if (other >= 0 && left + other >= leftLength) {
						return reverse ? [leftStart + other, rightStart + other - otherDiagonal] : [leftStart + left, rightStart + right];
					}
				}
				if (++work % 2048 === 0) {
					yield;
				}
			}
		}
	}
	throw new Error('Diff partition did not intersect');
}
