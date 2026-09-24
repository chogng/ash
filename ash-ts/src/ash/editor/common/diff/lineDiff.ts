import { type IDocumentDiff } from './documentDiffProvider.js';
import { type RangeMapping } from './rangeMapping.js';

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

/** Projects the standard diff result into aligned rows for Ash's read-only diff widget. */
export function toLineDiff(diff: Pick<IDocumentDiff, 'changes'>, originalLineCount: number, modifiedLineCount: number): LineDiff {
	const rows: LineDiffRow[] = [];
	const hunks: LineDiffHunk[] = [];
	let originalIndex = 0;
	let modifiedIndex = 0;
	for (const change of diff.changes) {
		const originalStart = change.original.startLineNumber - 1;
		const modifiedStart = change.modified.startLineNumber - 1;
		while (originalIndex < originalStart && modifiedIndex < modifiedStart) {
			rows.push({ kind: LineDiffKind.Unchanged, originalLineIndex: originalIndex++, modifiedLineIndex: modifiedIndex++, originalChanges: [], modifiedChanges: [] });
		}
		const rowStart = rows.length;
		const originalCount = change.original.length;
		const modifiedCount = change.modified.length;
		for (let offset = 0; offset < Math.max(originalCount, modifiedCount); offset++) {
			const left = offset < originalCount ? originalStart + offset : undefined;
			const right = offset < modifiedCount ? modifiedStart + offset : undefined;
			rows.push({
				kind: left === undefined ? LineDiffKind.Added : right === undefined ? LineDiffKind.Removed : LineDiffKind.Modified,
				originalLineIndex: left,
				modifiedLineIndex: right,
				originalChanges: left === undefined ? [] : changesForLine(change.innerChanges, left + 1, 'original'),
				modifiedChanges: right === undefined ? [] : changesForLine(change.innerChanges, right + 1, 'modified'),
			});
		}
		hunks.push({
			rowStart,
			rowEnd: rows.length,
			originalStartLineIndex: originalStart,
			originalLineCount: originalCount,
			modifiedStartLineIndex: modifiedStart,
			modifiedLineCount: modifiedCount,
		});
		originalIndex = originalStart + originalCount;
		modifiedIndex = modifiedStart + modifiedCount;
	}
	while (originalIndex < originalLineCount && modifiedIndex < modifiedLineCount) {
		rows.push({ kind: LineDiffKind.Unchanged, originalLineIndex: originalIndex++, modifiedLineIndex: modifiedIndex++, originalChanges: [], modifiedChanges: [] });
	}
	return { rows, hunks };
}

function changesForLine(changes: readonly RangeMapping[] | undefined, lineNumber: number, side: 'original' | 'modified'): DiffRange[] {
	return (changes ?? []).flatMap(change => {
		const range = side === 'original' ? change.originalRange : change.modifiedRange;
		return range.startLineNumber === lineNumber && !range.isEmpty()
			? [{ startColumn: range.startColumn - 1, endColumn: range.endColumn - 1 }]
			: [];
	});
}
