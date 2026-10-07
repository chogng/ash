import { Selection } from "../../../common/core/selection.js";
import { type ITextModel, type FindMatch } from "../../../common/model.js";

const MAX_OCCURRENCE_SELECTIONS = 100_000;

/** Selects the direction in which one additional matching occurrence is found. */
export enum EditorOccurrenceDirection {
	Next = "next",
	Previous = "previous",
}

/**
 * Adds the next or previous exact occurrence of the primary selection.
 *
 * A collapsed primary cursor first selects its current word-like segment. The
 * model remains unchanged; callers own the resulting live selection state.
 */
export function addOccurrenceSelection(model: ITextModel, selections: readonly Selection[], direction: EditorOccurrenceDirection): readonly Selection[] {
	if (!Object.values(EditorOccurrenceDirection).includes(direction)) {
		throw new TypeError("Unknown editor occurrence direction");
	}
	const source = sourceSelection(model, selections);
	if (!source) return selections;
	if (selections[0]!.isEmpty()) return replacePrimarySelection(selections, source);

	const matches = findOccurrences(model, source);
	const selectedRanges = new Set(selections.map(selection => rangeKey(model, selection)));
	const startOffset = direction === EditorOccurrenceDirection.Next
		? model.getOffsetAt(source.getEndPosition())
		: model.getOffsetAt(source.getStartPosition());
	const candidate = orderedCandidates(model, matches, startOffset, direction)
		.find(match => !selectedRanges.has(rangeKey(model, Selection.fromPositions(match.range.getStartPosition(), match.range.getEndPosition()))));
	if (!candidate) return selections;
	return Object.freeze([
		...selections,
		Selection.fromPositions(candidate.range.getStartPosition(), candidate.range.getEndPosition()),
	]);
}

/** Selects every exact occurrence of the primary selection or cursor word. */
export function selectAllOccurrences(model: ITextModel, selections: readonly Selection[]): readonly Selection[] {
	const source = sourceSelection(model, selections);
	if (!source) return selections;
	const matches = findOccurrences(model, source);
	if (matches.length === 0) return selections;
	const sourceKey = rangeKey(model, source);
	const nextSelections = Object.freeze(matches.map(match => Selection.fromPositions(match.range.getStartPosition(), match.range.getEndPosition())));
	const primaryIndex = nextSelections.findIndex(selection => rangeKey(model, selection) === sourceKey);
	return primaryFirst(nextSelections, primaryIndex < 0 ? 0 : primaryIndex);
}

function sourceSelection(model: ITextModel, selections: readonly Selection[]): Selection | undefined {
	const primary = selections[0]!;
	if (!primary.isEmpty()) return primary;
	const word = model.getWordAtPosition(primary.getPosition());
	return word ? new Selection(primary.positionLineNumber, word.startColumn, primary.positionLineNumber, word.endColumn) : undefined;
}

function findOccurrences(model: ITextModel, source: Selection): readonly FindMatch[] {
	return model.findMatches(model.getValueInRange(source), false, false, true, null, false, MAX_OCCURRENCE_SELECTIONS);
}

function orderedCandidates(model: ITextModel, matches: readonly FindMatch[], startOffset: number, direction: EditorOccurrenceDirection): readonly FindMatch[] {
	const ordered = direction === EditorOccurrenceDirection.Next ? matches : [...matches].reverse();
	const beforeWrap = ordered.filter(match => direction === EditorOccurrenceDirection.Next
		? model.getOffsetAt(match.range.getStartPosition()) >= startOffset
		: model.getOffsetAt(match.range.getEndPosition()) <= startOffset);
	const afterWrap = ordered.filter(match => direction === EditorOccurrenceDirection.Next
		? model.getOffsetAt(match.range.getStartPosition()) < startOffset
		: model.getOffsetAt(match.range.getEndPosition()) > startOffset);
	return Object.freeze([...beforeWrap, ...afterWrap]);
}

function replacePrimarySelection(selections: readonly Selection[], replacement: Selection): readonly Selection[] {
	const nextSelections = selections.map((selection, index) => index === 0 ? replacement : selection);
	return Object.freeze(nextSelections);
}

function primaryFirst(selections: readonly Selection[], primaryIndex: number): readonly Selection[] {
	if (primaryIndex === 0) return Object.freeze([...selections]);
	return Object.freeze([selections[primaryIndex]!, ...selections.slice(0, primaryIndex), ...selections.slice(primaryIndex + 1)]);
}

function rangeKey(model: ITextModel, selection: Selection): string {
	return `${model.getOffsetAt(selection.getStartPosition())}:${model.getOffsetAt(selection.getEndPosition())}`;
}
