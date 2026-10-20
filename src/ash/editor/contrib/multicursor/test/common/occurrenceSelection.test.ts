import assert from "node:assert/strict";
import { test } from "mocha";
import { addOccurrenceSelection, EditorOccurrenceDirection, selectAllOccurrences } from "../../common/occurrenceSelection.js";
import { Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { TextModel } from "../../../../common/model/textModel.js";

test("Occurrence selection starts from a caret word and adds unselected matches with wraparound", () => {
	using model = new TextModel("echo echo\necho");
	let selections: readonly Selection[] = [Selection.fromPositions(new Position((0) + 1, (1) + 1))];

	selections = addOccurrenceSelection(model, selections, EditorOccurrenceDirection.Next);
	assert.deepEqual(selections, [Selection.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (4) + 1))]);
	selections = addOccurrenceSelection(model, selections, EditorOccurrenceDirection.Next);
	assert.deepEqual(selections, [
		Selection.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (4) + 1)),
		Selection.fromPositions(new Position((0) + 1, (5) + 1), new Position((0) + 1, (9) + 1)),
	]);
	selections = addOccurrenceSelection(model, selections, EditorOccurrenceDirection.Next);
	assert.deepEqual(selections, [
		Selection.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (4) + 1)),
		Selection.fromPositions(new Position((0) + 1, (5) + 1), new Position((0) + 1, (9) + 1)),
		Selection.fromPositions(new Position((1) + 1, (0) + 1), new Position((1) + 1, (4) + 1)),
	]);
	assert.equal(addOccurrenceSelection(model, selections, EditorOccurrenceDirection.Next), selections);
});

test("Occurrence selection preserves other cursors when its primary cursor becomes a word selection", () => {
	using model = new TextModel("echo echo");
	const selections = primaryFirst([
		Selection.fromPositions(new Position((0) + 1, (1) + 1)),
		Selection.fromPositions(new Position((0) + 1, (6) + 1)),
	], 0);
	assert.deepEqual(addOccurrenceSelection(model, selections, EditorOccurrenceDirection.Next), primaryFirst([
		Selection.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (4) + 1)),
		Selection.fromPositions(new Position((0) + 1, (6) + 1)),
	], 0));
});

test("Occurrence selection supports previous direction, Unicode text, select-all, and input validation", () => {
	using model = new TextModel("猫 猫\n犬 猫");
	const source = [Selection.fromPositions(new Position((1) + 1, (2) + 1), new Position((1) + 1, (3) + 1))];
	const previous = addOccurrenceSelection(model, source, EditorOccurrenceDirection.Previous);
	assert.deepEqual(previous, [
		Selection.fromPositions(new Position((1) + 1, (2) + 1), new Position((1) + 1, (3) + 1)),
		Selection.fromPositions(new Position((0) + 1, (2) + 1), new Position((0) + 1, (3) + 1)),
	]);
	const all = selectAllOccurrences(model, source);
	assert.deepEqual(all, primaryFirst([
		Selection.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (1) + 1)),
		Selection.fromPositions(new Position((0) + 1, (2) + 1), new Position((0) + 1, (3) + 1)),
		Selection.fromPositions(new Position((1) + 1, (2) + 1), new Position((1) + 1, (3) + 1)),
	], 2));
	assert.throws(() => addOccurrenceSelection(model, source, "elsewhere" as EditorOccurrenceDirection), /Unknown editor occurrence direction/);
});

test("Occurrence selection leaves an empty cursor unchanged", () => {
	using model = new TextModel("");
	const selections = [Selection.fromPositions(new Position((0) + 1, (0) + 1))];
	assert.equal(addOccurrenceSelection(model, selections, EditorOccurrenceDirection.Next), selections);
	assert.equal(selectAllOccurrences(model, selections), selections);
});

function primaryFirst<T>(items: readonly T[], primaryIndex: number): readonly T[] {
	if (primaryIndex === 0) return Object.freeze([...items]);
	return Object.freeze([items[primaryIndex]!, ...items.slice(0, primaryIndex), ...items.slice(primaryIndex + 1)]);
}
