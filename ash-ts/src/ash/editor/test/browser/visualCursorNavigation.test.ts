import assert from "node:assert/strict";
import { test } from "mocha";
import { navigateStanzaVisualCursors } from "../../common/viewModel/visualCursorNavigation.js";
import { EditorCursorNavigationCommand, EditorCursorNavigationMode } from "../../common/viewModel/visualCursorNavigation.js";
import { Selection } from "../../common/core/selection.js";
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";
import { EditorVisualLineProjection } from "../../common/viewModel/modelLineProjection.js";

test("Visual cursor navigation preserves measured horizontal intent across wrapped rows", () => {
	using model = new TextModel("abcdef\na😀bc");
	const projection = EditorVisualLineProjection.fromBreakColumns(model, [
		[2, 4, 6],
		[3, 5],
	]);
	const first = navigateStanzaVisualCursors(
		model,
		projection,
		[caret(0, 1)],
		{
			command: EditorCursorNavigationCommand.LineDown,
			mode: EditorCursorNavigationMode.Move,
			pageLineCount: 1,
		},
		text => [...text].length * 10,
	);
	assert.deepEqual(first.selections[0]!, caret(0, 3));
	assert.deepEqual(first.preferredHorizontalOffsets, [10]);

	const second = navigateStanzaVisualCursors(
		model,
		projection,
		first.selections,
		{
			command: EditorCursorNavigationCommand.PageDown,
			mode: EditorCursorNavigationMode.Move,
			pageLineCount: 2,
			preferredHorizontalOffsets: first.preferredHorizontalOffsets,
		},
		text => [...text].length * 10,
	);
	assert.deepEqual(second.selections[0]!, caret(1, 1));
	assert.deepEqual(second.preferredHorizontalOffsets, [10]);

	const extended = navigateStanzaVisualCursors(
		model,
		projection,
		[caret(0, 1)],
		{
			command: EditorCursorNavigationCommand.LineDown,
			mode: EditorCursorNavigationMode.Extend,
			pageLineCount: 1,
		},
		text => [...text].length * 10,
	);
	assert.deepEqual(
		extended.selections[0]!,
		Selection.fromPositions(new Position((0) + 1, (1) + 1), new Position((0) + 1, (3) + 1)),
	);
});

test("Visual cursor navigation removes continuation indentation before resolving a target column", () => {
	using model = new TextModel("abcdef");
	const projection = EditorVisualLineProjection.fromBreakColumns(model, [[2, 4, 6]], [20]);
	const result = navigateStanzaVisualCursors(
		model,
		projection,
		[caret(0, 1)],
		{
			command: EditorCursorNavigationCommand.LineDown,
			mode: EditorCursorNavigationMode.Move,
			pageLineCount: 1,
		},
		text => [...text].length * 10,
	);

	assert.deepEqual(result.selections[0]!, caret(0, 2));
	assert.deepEqual(result.preferredHorizontalOffsets, [10]);
});

test("Visual cursor navigation uses browser geometry when bidirectional layout provides it", () => {
	using model = new TextModel("abc אבג");
	const projection = EditorVisualLineProjection.fromBreakColumns(model, [[3, 7]]);
	const result = navigateStanzaVisualCursors(
		model,
		projection,
		[caret(0, 1)],
		{
			command: EditorCursorNavigationCommand.LineDown,
			mode: EditorCursorNavigationMode.Move,
			pageLineCount: 1,
		},
		() => 0,
		{
			getHorizontalOffset: position => position.column === 2 ? 91 : undefined,
			getNearestPosition: (visualLineIndex, horizontalOffset) => {
				assert.equal(visualLineIndex, 1);
				assert.equal(horizontalOffset, 91);
				return new Position((0) + 1, (5) + 1);
			},
		},
	);
	assert.deepEqual(result.selections[0]!, caret(0, 5));
	assert.deepEqual(result.preferredHorizontalOffsets, [91]);
});

test("Visual cursor navigation rejects stale projections and invalid preferred offsets", () => {
	using model = new TextModel("abc");
	const projection = EditorVisualLineProjection.fromBreakColumns(model, [[3]]);
	model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (3) + 1)),
		text: "d",
	}]);

	assert.throws(() => navigateStanzaVisualCursors(
		model,
		projection,
		[caret(0, 0)],
		{
			command: EditorCursorNavigationCommand.LineDown,
			mode: EditorCursorNavigationMode.Move,
			pageLineCount: 1,
		},
		text => text.length,
	), /current text model projection/);

	const current = EditorVisualLineProjection.fromBreakColumns(model, [[4]]);
	assert.throws(() => navigateStanzaVisualCursors(
		model,
		current,
		[caret(0, 0)],
		{
			command: EditorCursorNavigationCommand.LineDown,
			mode: EditorCursorNavigationMode.Move,
			pageLineCount: 1,
			preferredHorizontalOffsets: [-1],
		},
		text => text.length,
	), /preferred horizontal offsets/);
});

function caret(lineIndex: number, columnIndex: number): Selection {
	return Selection.fromPositions(new Position((lineIndex) + 1, (columnIndex) + 1));
}
