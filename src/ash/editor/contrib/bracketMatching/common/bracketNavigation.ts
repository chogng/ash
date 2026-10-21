import { Selection } from "../../../common/core/selection.js";
import { type IBracketPairsTextModelPart } from "../../../common/textModelBracketPairs.js";
import { type Range } from "../../../common/core/range.js";
import { Position } from "../../../common/core/position.js";

/** Moves every active cursor to its lexically valid matching bracket when present. */
export function jumpToMatchingBrackets(bracketPairs: IBracketPairsTextModelPart, selections: readonly Selection[]): readonly Selection[] {
	let changed = false;
	const nextSelections = selections.map(selection => {
		const match = matchAtOrAfter(bracketPairs, selection.getPosition());
		if (!match) return selection;
		const next = Selection.fromPositions(isAtOpening(match[0].getStartPosition(), match[0].getEndPosition(), selection.getPosition())
			? match[1].getStartPosition()
			: match[0].getStartPosition());
		changed ||= Position.compare(next.getPosition(), selection.getPosition()) !== 0 || !selection.isEmpty();
		return next;
	});
	return changed ? Object.freeze(nextSelections) : selections;
}

/** Selects the full configured bracket pair around every active cursor when present. */
export function selectToMatchingBrackets(bracketPairs: IBracketPairsTextModelPart, selections: readonly Selection[]): readonly Selection[] {
	let changed = false;
	const nextSelections = selections.map(selection => {
		const match = matchAtOrAfter(bracketPairs, selection.getPosition());
		if (!match) return selection;
		const next = Selection.fromPositions(match[0].getStartPosition(), match[1].getEndPosition());
		changed ||= Position.compare(next.getStartPosition(), selection.getStartPosition()) !== 0 || Position.compare(next.getEndPosition(), selection.getEndPosition()) !== 0;
		return next;
	});
	return changed ? Object.freeze(nextSelections) : selections;
}

function matchAtOrAfter(bracketPairs: IBracketPairsTextModelPart, position: Position): [Range, Range] | null {
	const match = bracketPairs.matchBracket(position) ?? bracketPairs.findEnclosingBrackets(position);
	const next = match ? undefined : bracketPairs.findNextBracket(position);
	const pair = match ?? (next ? bracketPairs.matchBracket(next.range.getStartPosition()) : null);
	if (!pair) return null;
	return Position.compare(pair[0].getStartPosition(), pair[1].getStartPosition()) <= 0 ? pair : [pair[1], pair[0]];
}

function isAtOpening(start: Position, end: Position, position: Position): boolean {
	return Position.compare(position, start) >= 0 && Position.compare(position, end) <= 0;
}
