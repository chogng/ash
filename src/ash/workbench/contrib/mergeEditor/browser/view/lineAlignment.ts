import type { LineRangeMapping } from '../../../../../editor/common/diff/rangeMapping.js';
import type { MergeEditorHunk, MergeEditorSide } from '../model/mergeEditorModel.js';

type ChangedSide = Exclude<MergeEditorSide, 'base'>;
type LineAlignment = Readonly<Partial<Record<MergeEditorSide, number>>>;

/** Pairs lines inside one conflict using the same line pairs as the document diff. */
export function getAlignments(
	hunk: MergeEditorHunk,
	changes: Readonly<Record<ChangedSide, readonly LineRangeMapping[]>>,
	visibleSides: readonly MergeEditorSide[],
): readonly LineAlignment[] {
	const nextChange: Record<ChangedSide, number> = { current: 0, incoming: 0, result: 0 };
	const canPairResultChanges = hunk.resolution === 'current' || hunk.resolution === 'incoming' || hunk.resolution === 'base';
	const alignments: LineAlignment[] = [];
	for (let baseLine = hunk.base.startLineNumber; baseLine < hunk.base.endLineNumberExclusive; baseLine++) {
		const alignment: Partial<Record<MergeEditorSide, number>> = {};
		for (const side of visibleSides) {
			if (side === 'base') {
				alignment.base = baseLine;
				continue;
			}
			const sideChanges = changes[side];
			let index = nextChange[side];
			while (index < sideChanges.length && sideChanges[index].original.endLineNumberExclusive <= baseLine) index++;
			nextChange[side] = index;
			const change = sideChanges[index];
			let sideLine: number | undefined;
			if (change?.original.contains(baseLine)) {
				// Conflict markers and manual result text have no reliable base-line pairs.
				const canPairChangedLine = side !== 'result' || canPairResultChanges;
				const offset = baseLine - change.original.startLineNumber;
				if (canPairChangedLine && offset < change.modified.length) sideLine = change.modified.startLineNumber + offset;
			} else {
				const previous = sideChanges[index - 1];
				const delta = previous ? previous.modified.endLineNumberExclusive - previous.original.endLineNumberExclusive : 0;
				sideLine = baseLine + delta;
			}
			if (sideLine !== undefined && hunk[side].contains(sideLine)) alignment[side] = sideLine;
		}
		if (Object.keys(alignment).length >= 2) alignments.push(alignment);
	}
	return alignments;
}
