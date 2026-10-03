import { timeout } from '../../../../base/common/async.js';
import { getTextGraphemeBoundaries } from '../../core/textSegmentation.js';
import { LineRange } from '../../core/ranges/lineRange.js';
import { Range } from '../../core/range.js';
import { LinesDiff, MovedText, type ILinesDiffComputer, type ILinesDiffComputerOptions } from '../linesDiffComputer.js';
import { DetailedLineRangeMapping, LineRangeMapping, RangeMapping } from '../rangeMapping.js';

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
	const changes: DetailedLineRangeMapping[] = [];
	let originalIndex = 0;
	let modifiedIndex = 0;
	for (const [originalMatch, modifiedMatch] of matches) {
		const originalCount = originalMatch - originalIndex;
		const modifiedCount = modifiedMatch - modifiedIndex;
		if (originalCount || modifiedCount) {
			const innerChanges: RangeMapping[] = [];
			for (let offset = 0; offset < Math.min(originalCount, modifiedCount); offset++) {
				innerChanges.push(...(yield* diffCharacters(
					original[originalIndex + offset]!,
					modified[modifiedIndex + offset]!,
					originalIndex + offset + 1,
					modifiedIndex + offset + 1,
				)));
				if (offset % 256 === 0) yield;
			}
			changes.push(new DetailedLineRangeMapping(
				new LineRange(originalIndex + 1, originalMatch + 1),
				new LineRange(modifiedIndex + 1, modifiedMatch + 1),
				innerChanges.length === 0 ? undefined : innerChanges,
			));
		}
		originalIndex = originalMatch + 1;
		modifiedIndex = modifiedMatch + 1;
	}
	const moves = options.computeMoves ? yield* findMoves(changes, original, modified, options) : [];
	return new LinesDiff(changes, moves, false);
}

function* diffCharacters(original: string, modified: string, originalLineNumber: number, modifiedLineNumber: number): Generator<void, RangeMapping[]> {
	const originalBoundaries = getTextGraphemeBoundaries(original);
	const modifiedBoundaries = getTextGraphemeBoundaries(modified);
	const originalGraphemes = originalBoundaries.slice(1).map((end, index) => original.slice(originalBoundaries[index], end));
	const modifiedGraphemes = modifiedBoundaries.slice(1).map((end, index) => modified.slice(modifiedBoundaries[index], end));
	const matches = yield* matchingItems(originalGraphemes, modifiedGraphemes);
	matches.push([originalGraphemes.length, modifiedGraphemes.length]);
	const changes: RangeMapping[] = [];
	let originalIndex = 0;
	let modifiedIndex = 0;
	for (const [originalMatch, modifiedMatch] of matches) {
		if (originalMatch > originalIndex || modifiedMatch > modifiedIndex) {
			changes.push(new RangeMapping(
				new Range(originalLineNumber, originalBoundaries[originalIndex]! + 1, originalLineNumber, originalBoundaries[originalMatch]! + 1),
				new Range(modifiedLineNumber, modifiedBoundaries[modifiedIndex]! + 1, modifiedLineNumber, modifiedBoundaries[modifiedMatch]! + 1),
			));
		}
		originalIndex = originalMatch + 1;
		modifiedIndex = modifiedMatch + 1;
	}
	return changes;
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
	for (const [lines, side, spans] of [[original, 'original', sources], [modified, 'modified', destinations]] as const) {
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
				change, range, lines: content, words, weight,
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
					candidates.push({ source, destination: moveFragment(destination, start, start + source.lines.length), score: 2 });
				}
			}
			const exact = source.text === destination.text;
			const similarity = 2 * overlap.weight / (source.weight + destination.weight);
			// Renaming can replace entire words while retaining nearly all characters.
			const characterSimilarity = source.change.modified.isEmpty && destination.change.original.isEmpty
				&& source.lines.length >= 3 && destination.lines.length >= 3
				? yield* moveCharacterSimilarity(source.text, destination.text) : 0;
			// Punctuation and a single shared keyword cannot establish an edited move.
			if (exact || overlap.words >= 2 && overlap.weight >= 8 && (similarity >= 0.7 || characterSimilarity > 0.9)) {
				candidates.push({ source, destination, score: exact ? 2 : Math.max(similarity, characterSimilarity) });
			}
		}
		yield;
	}
	candidates.sort((left, right) => right.score - left.score
		|| Math.abs(left.source.range.startLineNumber - left.destination.range.startLineNumber) - Math.abs(right.source.range.startLineNumber - right.destination.range.startLineNumber));
	const usedSources: LineRange[] = [];
	const usedDestinations: LineRange[] = [];
	const moves: MovedText[] = [];
	for (const { source, destination } of candidates) {
		if (usedSources.some(range => range.intersect(source.range)?.isEmpty === false)
			|| usedDestinations.some(range => range.intersect(destination.range)?.isEmpty === false)) {
			continue;
		}
		usedSources.push(source.range);
		usedDestinations.push(destination.range);
		const result = yield* diffLines(source.lines, destination.lines, { ...options, computeMoves: false });
		const originalOffset = source.range.startLineNumber - 1;
		const modifiedOffset = destination.range.startLineNumber - 1;
		const moveChanges = result.changes.map(change => new DetailedLineRangeMapping(
			change.original.delta(originalOffset),
			change.modified.delta(modifiedOffset),
			change.innerChanges?.map(inner => new RangeMapping(
				new Range(inner.originalRange.startLineNumber + originalOffset, inner.originalRange.startColumn, inner.originalRange.endLineNumber + originalOffset, inner.originalRange.endColumn),
				new Range(inner.modifiedRange.startLineNumber + modifiedOffset, inner.modifiedRange.startColumn, inner.modifiedRange.endLineNumber + modifiedOffset, inner.modifiedRange.endColumn),
			)),
		));
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
		const matches = yield* matchingItems(originalIndexes.map(index => original[index]!), modifiedIndexes.map(index => modified[index]!));
		const anchors = matches.map(([left, right]): Match => [originalIndexes[left]!, modifiedIndexes[right]!]);
		let found = false;
		// Line anchors identify the moved portion of a hunk containing other code.
		// Short gaps may contain edits; unrelated neighboring lines end the fragment.
		for (let first = 0; first < anchors.length;) {
			let last = first;
			while (last + 1 < anchors.length
				&& anchors[last + 1]![0] - anchors[last]![0] <= 3
				&& anchors[last + 1]![1] - anchors[last]![1] <= 3) {
				last++;
			}
			const meaningful = anchors.slice(first, last + 1).filter(([line]) => original[line]!.length >= 2);
			if (last - first >= 2 && meaningful.length >= 2
				&& meaningful.reduce((length, [line]) => length + original[line]!.length, 0) >= 15) {
				let [sourceStart, destinationStart] = anchors[first]!;
				let [sourceEnd, destinationEnd] = anchors[last]!;
				sourceEnd++;
				destinationEnd++;
				while (remainingOriginal.has(sourceStart - 1) && remainingModified.has(destinationStart - 1)
					&& (yield* similarMoveLines(original[sourceStart - 1]!, modified[destinationStart - 1]!))) {
					sourceStart--;
					destinationStart--;
				}
				while (remainingOriginal.has(sourceEnd) && remainingModified.has(destinationEnd)
					&& (yield* similarMoveLines(original[sourceEnd]!, modified[destinationEnd]!))) {
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
	for (const [text, direction] of [[left, 1], [right, -1]] as const) {
		for (const character of text) {
			if (/\s/u.test(character)) continue;
			length++;
			const count = counts.get(character) ?? 0;
			if (direction === -1 && count > 0) shared++;
			counts.set(character, count + direction);
			if (length % 256 === 0) yield;
		}
	}
	return length === 0 ? 0 : 2 * shared / length;
}

function timedOutDiff(originalLineCount: number, modifiedLineCount: number): LinesDiff {
	return new LinesDiff([
		new DetailedLineRangeMapping(new LineRange(1, originalLineCount + 1), new LineRange(1, modifiedLineCount + 1), undefined),
	], [], true);
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
				let left = diagonal === -edits || (diagonal !== edits && frontier[index - 1]! < frontier[index + 1]!)
					? frontier[index + 1]!
					: frontier[index - 1]! + 1;
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
