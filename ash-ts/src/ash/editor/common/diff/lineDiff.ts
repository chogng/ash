export enum LineDiffKind {
	Unchanged = "unchanged",
	Modified = "modified",
	Removed = "removed",
	Added = "added",
}

export interface DiffRange {
	readonly startColumn: number;
	readonly endColumn: number;
}

/** One aligned visual row in a side-by-side line diff. */
export interface LineDiffRow {
	readonly kind: LineDiffKind;
	readonly originalLineIndex?: number;
	readonly modifiedLineIndex?: number;
	readonly originalChanges: readonly DiffRange[];
	readonly modifiedChanges: readonly DiffRange[];
}

/** One changed hunk in the aligned row projection. */
export interface LineDiffHunk {
	readonly rowStart: number;
	readonly rowEnd: number;
	readonly originalStartLineIndex: number;
	readonly originalLineCount: number;
	readonly modifiedStartLineIndex: number;
	readonly modifiedLineCount: number;
}

export interface LineDiff {
	readonly rows: readonly LineDiffRow[];
	readonly hunks: readonly LineDiffHunk[];
}

/** Computes snapshot-local differences, yielding so a Worker can receive cancellation. */
export async function computeLineDiff(original: string, modified: string, signal: AbortSignal): Promise<LineDiff> {
	signal.throwIfAborted();
	const computation = diffLines(original.split('\n'), modified.split('\n'));
	let deadline = performance.now() + 8;
	for (;;) {
		signal.throwIfAborted();
		const step = computation.next();
		if (step.done) {
			return step.value;
		}
		if (performance.now() >= deadline) {
			await timeout(0);
			deadline = performance.now() + 8;
		}
	}
}

function* diffLines(original: readonly string[], modified: readonly string[]): Generator<void, LineDiff> {
	const matches = yield* matchingItems(original, modified);
	matches.push([original.length, modified.length]);
	const rows: LineDiffRow[] = [];
	const hunks: LineDiffHunk[] = [];
	let originalIndex = 0;
	let modifiedIndex = 0;
	for (const [originalMatch, modifiedMatch] of matches) {
		const originalCount = originalMatch - originalIndex;
		const modifiedCount = modifiedMatch - modifiedIndex;
		if (originalCount || modifiedCount) {
			const rowStart = rows.length;
			for (let offset = 0; offset < Math.max(originalCount, modifiedCount); offset++) {
				const left = offset < originalCount ? originalIndex + offset : undefined;
				const right = offset < modifiedCount ? modifiedIndex + offset : undefined;
				let originalChanges: DiffRange[] = [];
				let modifiedChanges: DiffRange[] = [];
				let kind = LineDiffKind.Modified;
				if (left === undefined) {
					kind = LineDiffKind.Added;
				} else if (right === undefined) {
					kind = LineDiffKind.Removed;
				}
				if (left !== undefined && right !== undefined) {
					[originalChanges, modifiedChanges] = yield* diffCharacters(original[left]!, modified[right]!);
				}
				rows.push({
					kind,
					originalLineIndex: left,
					modifiedLineIndex: right,
					originalChanges,
					modifiedChanges,
				});
				if (offset % 256 === 0) {
					yield;
				}
			}
			hunks.push({
				rowStart,
				rowEnd: rows.length,
				originalStartLineIndex: originalIndex,
				originalLineCount: originalCount,
				modifiedStartLineIndex: modifiedIndex,
				modifiedLineCount: modifiedCount,
			});
		}
		if (originalMatch < original.length) {
			rows.push({ kind: LineDiffKind.Unchanged, originalLineIndex: originalMatch, modifiedLineIndex: modifiedMatch, originalChanges: [], modifiedChanges: [] });
		}
		originalIndex = originalMatch + 1;
		modifiedIndex = modifiedMatch + 1;
		if (rows.length % 256 === 0) {
			yield;
		}
	}
	return { rows, hunks };
}

function* diffCharacters(original: string, modified: string): Generator<void, [DiffRange[], DiffRange[]]> {
	const leftBoundaries = getTextGraphemeBoundaries(original);
	const rightBoundaries = getTextGraphemeBoundaries(modified);
	const left = leftBoundaries.slice(1).map((end, index) => original.slice(leftBoundaries[index], end));
	const right = rightBoundaries.slice(1).map((end, index) => modified.slice(rightBoundaries[index], end));
	const matches = yield* matchingItems(left, right);
	matches.push([left.length, right.length]);
	const originalChanges: DiffRange[] = [];
	const modifiedChanges: DiffRange[] = [];
	let leftIndex = 0;
	let rightIndex = 0;
	for (const [leftMatch, rightMatch] of matches) {
		if (leftMatch > leftIndex) {
			originalChanges.push({ startColumn: leftBoundaries[leftIndex]!, endColumn: leftBoundaries[leftMatch]! });
		}
		if (rightMatch > rightIndex) {
			modifiedChanges.push({ startColumn: rightBoundaries[rightIndex]!, endColumn: rightBoundaries[rightMatch]! });
		}
		leftIndex = leftMatch + 1;
		rightIndex = rightMatch + 1;
	}
	return [originalChanges, modifiedChanges];
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
import { timeout } from '../../../base/common/async.js';
import { getTextGraphemeBoundaries } from '../core/textSegmentation.js';
