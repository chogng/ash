import { type IDocumentDiff } from './documentDiffProvider.js';
import type { RangeMapping, DetailedLineRangeMapping, LineRangeMapping } from './rangeMapping.js';
import type { MovedText } from './linesDiffComputer.js';

export enum LineDiffKind {
	Unchanged = 'unchanged',
	Modified = 'modified',
	Removed = 'removed',
	Added = 'added',
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
	readonly rows: LineDiffRows;
	readonly hunks: readonly LineDiffHunk[];
	readonly changes: readonly DetailedLineRangeMapping[];
	readonly moves: readonly MovedText[];
}

interface RowSegment {
	readonly start: number;
	readonly end: number;
	readonly originalStart: number;
	readonly modifiedStart: number;
	readonly changed?: readonly LineDiffRow[];
}

const noChanges: readonly DiffRange[] = Object.freeze([]);

/** Unchanged runs occupy one segment; only changed lines retain row objects. */
export class LineDiffRows implements Iterable<LineDiffRow> {
	static readonly empty = new LineDiffRows([]);
	readonly length: number;

	constructor(private readonly segments: readonly RowSegment[]) {
		this.length = segments.at(-1)?.end ?? 0;
	}

	get(index: number): LineDiffRow | undefined {
		if (index < 0 || index >= this.length) return undefined;
		let low = 0;
		let high = this.segments.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (this.segments[middle]!.end <= index) low = middle + 1;
			else high = middle;
		}
		return this.row(this.segments[low]!, index);
	}

	private row(segment: RowSegment, index: number): LineDiffRow {
		const offset = index - segment.start;
		return segment.changed?.[offset] ?? {
			kind: LineDiffKind.Unchanged,
			originalLineIndex: segment.originalStart + offset,
			modifiedLineIndex: segment.modifiedStart + offset,
			originalChanges: noChanges, modifiedChanges: noChanges,
		};
	}

	/** Materializes only a requested hunk, never the entire unchanged document. */
	slice(start: number, end: number): LineDiffRow[] {
		return Array.from({ length: Math.max(0, Math.min(end, this.length) - start) }, (_, offset) => this.get(start + offset)!);
	}

	/** A run's last unchanged row is sufficient to anchor unwrapped alignment zones. */
	*alignmentEntries(): IterableIterator<[number, LineDiffRow]> {
		for (const segment of this.segments) {
			if (!segment.changed) yield [segment.end - 1, this.row(segment, segment.end - 1)];
			else for (let index = segment.start; index < segment.end; index++) yield [index, segment.changed[index - segment.start]!];
		}
	}

	*entries(): IterableIterator<[number, LineDiffRow]> {
		for (const segment of this.segments) {
			for (let index = segment.start; index < segment.end; index++) yield [index, this.row(segment, index)];
		}
	}

	*changedEntries(): IterableIterator<[number, LineDiffRow]> {
		for (const segment of this.segments) {
			if (!segment.changed) continue;
			for (let index = segment.start; index < segment.end; index++) yield [index, segment.changed[index - segment.start]!];
		}
	}

	*unchangedRanges(): IterableIterator<readonly [number, number]> {
		for (const segment of this.segments) if (!segment.changed) yield [segment.start, segment.end];
	}

	*[Symbol.iterator](): IterableIterator<LineDiffRow> {
		for (const [, row] of this.entries()) yield row;
	}
}

/** Builds a sparse aligned projection, retaining mapping identities for edit and move controls. */
export function toLineDiff(diff: Pick<IDocumentDiff, 'changes' | 'moves'>, originalLineCount: number, modifiedLineCount: number, range?: LineRangeMapping): LineDiff {
	const segments: RowSegment[] = [];
	const hunks: LineDiffHunk[] = [];
	let rowCount = 0;
	let originalIndex = (range?.original.startLineNumber ?? 1) - 1;
	let modifiedIndex = (range?.modified.startLineNumber ?? 1) - 1;
	const appendUnchanged = (originalEnd: number, modifiedEnd: number): void => {
		const count = Math.min(originalEnd - originalIndex, modifiedEnd - modifiedIndex);
		if (count <= 0) return;
		segments.push({ start: rowCount, end: rowCount + count, originalStart: originalIndex, modifiedStart: modifiedIndex });
		rowCount += count;
	};
	for (const change of diff.changes) {
		const originalStart = change.original.startLineNumber - 1;
		const modifiedStart = change.modified.startLineNumber - 1;
		appendUnchanged(originalStart, modifiedStart);
		const changed: LineDiffRow[] = [];
		appendChangedRows(changed, change);
		const rowStart = rowCount;
		rowCount += changed.length;
		if (changed.length) segments.push({ start: rowStart, end: rowCount, originalStart, modifiedStart, changed });
		hunks.push({
			rowStart, rowEnd: rowCount,
			originalStartLineIndex: originalStart, originalLineCount: change.original.length,
			modifiedStartLineIndex: modifiedStart, modifiedLineCount: change.modified.length,
		});
		originalIndex = change.original.endLineNumberExclusive - 1;
		modifiedIndex = change.modified.endLineNumberExclusive - 1;
	}
	appendUnchanged(range ? range.original.endLineNumberExclusive - 1 : originalLineCount,
		range ? range.modified.endLineNumberExclusive - 1 : modifiedLineCount);
	return { rows: new LineDiffRows(segments), hunks, changes: diff.changes, moves: diff.moves };
}

function appendChangedRows(rows: LineDiffRow[], change: DetailedLineRangeMapping): void {
	let originalIndex = change.original.startLineNumber - 1;
	let modifiedIndex = change.modified.startLineNumber - 1;
	const appendUntil = (originalEnd: number, modifiedEnd: number): void => {
		while (originalIndex < originalEnd || modifiedIndex < modifiedEnd) {
			const left = originalIndex < originalEnd ? originalIndex++ : undefined;
			const right = modifiedIndex < modifiedEnd ? modifiedIndex++ : undefined;
			rows.push({
				kind: left === undefined ? LineDiffKind.Added : right === undefined ? LineDiffKind.Removed : LineDiffKind.Modified,
				originalLineIndex: left,
				modifiedLineIndex: right,
				originalChanges: left === undefined ? [] : changesForLine(change.innerChanges, left + 1, 'original'),
				modifiedChanges: right === undefined ? [] : changesForLine(change.innerChanges, right + 1, 'modified'),
			});
		}
	};
	// The algorithm's inner mappings carry the chosen line pairs. Preserve them
	// for both decorations and view zones rather than pairing the hunk by offset.
	for (const inner of change.innerChanges ?? []) {
		const left = inner.originalRange.startLineNumber - 1;
		const right = inner.modifiedRange.startLineNumber - 1;
		if (left < originalIndex || right < modifiedIndex) {
			continue;
		}
		appendUntil(left, right);
		appendUntil(left + 1, right + 1);
	}
	appendUntil(change.original.endLineNumberExclusive - 1, change.modified.endLineNumberExclusive - 1);
}

function changesForLine(changes: readonly RangeMapping[] | undefined, lineNumber: number, side: 'original' | 'modified'): DiffRange[] {
	return (changes ?? []).flatMap(change => {
		const range = side === 'original' ? change.originalRange : change.modifiedRange;
		return range.startLineNumber === lineNumber
			? [{ startColumn: range.startColumn - 1, endColumn: range.endColumn - 1 }]
			: [];
	});
}
