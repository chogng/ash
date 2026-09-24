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
	return new LinesDiff(changes, options.computeMoves ? findExactMoves(changes, original, modified) : [], false);
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

function findExactMoves(changes: readonly DetailedLineRangeMapping[], original: readonly string[], modified: readonly string[]): MovedText[] {
	const removed = changes.filter(change => !change.original.isEmpty && change.modified.isEmpty);
	const added = changes.filter(change => change.original.isEmpty && !change.modified.isEmpty);
	const moves: MovedText[] = [];
	const used = new Set<DetailedLineRangeMapping>();
	for (const source of removed) {
		const text = original.slice(source.original.startLineNumber - 1, source.original.endLineNumberExclusive - 1);
		const destination = added.find(change => !used.has(change)
			&& change.modified.length === text.length
			&& text.every((line, index) => line === modified[change.modified.startLineNumber - 1 + index]));
		if (!destination) continue;
		used.add(destination);
		moves.push(new MovedText(new LineRangeMapping(source.original, destination.modified), []));
	}
	return moves;
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
