import { type IDocumentDiff } from './documentDiffProvider.js';
import type { RangeMapping, DetailedLineRangeMapping, LineRangeMapping } from './rangeMapping.js';
import type { MovedText } from './linesDiffComputer.js';

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
	readonly changes: readonly DetailedLineRangeMapping[];
	readonly moves: readonly MovedText[];
}

/** Builds aligned display rows while retaining the current result's mapping identities for edit and move controls. */
export function toLineDiff(diff: Pick<IDocumentDiff, 'changes' | 'moves'>, originalLineCount: number, modifiedLineCount: number, range?: LineRangeMapping): LineDiff {
	const rows: LineDiffRow[] = [];
	const hunks: LineDiffHunk[] = [];
	let originalIndex = (range?.original.startLineNumber ?? 1) - 1;
	let modifiedIndex = (range?.modified.startLineNumber ?? 1) - 1;
	const originalEnd = range ? range.original.endLineNumberExclusive - 1 : originalLineCount;
	const modifiedEnd = range ? range.modified.endLineNumberExclusive - 1 : modifiedLineCount;
	for (const change of diff.changes) {
		const originalStart = change.original.startLineNumber - 1;
		const modifiedStart = change.modified.startLineNumber - 1;
		while (originalIndex < originalStart && modifiedIndex < modifiedStart) {
			rows.push({ kind: LineDiffKind.Unchanged, originalLineIndex: originalIndex++, modifiedLineIndex: modifiedIndex++, originalChanges: [], modifiedChanges: [] });
		}
		const rowStart = rows.length;
		appendChangedRows(rows, change);
		hunks.push({
			rowStart,
			rowEnd: rows.length,
			originalStartLineIndex: originalStart,
			originalLineCount: change.original.length,
			modifiedStartLineIndex: modifiedStart,
			modifiedLineCount: change.modified.length,
		});
		originalIndex = change.original.endLineNumberExclusive - 1;
		modifiedIndex = change.modified.endLineNumberExclusive - 1;
	}
	while (originalIndex < originalEnd && modifiedIndex < modifiedEnd) {
		rows.push({ kind: LineDiffKind.Unchanged, originalLineIndex: originalIndex++, modifiedLineIndex: modifiedIndex++, originalChanges: [], modifiedChanges: [] });
	}
	return { rows, hunks, changes: diff.changes, moves: diff.moves };
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
