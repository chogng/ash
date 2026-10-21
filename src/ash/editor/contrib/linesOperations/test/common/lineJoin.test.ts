import assert from "node:assert/strict";
import { test } from "mocha";
import { JoinLinesAction } from '../../browser/linesOperations.js';
import { Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { TextModel } from "../../../../common/model/textModel.js";
import { createTestCursorsController } from '../../../../test/common/testCursorConfiguration.js';
import { type ICodeEditor } from '../../../../browser/editorBrowser.js';

test("Join lines removes indentation, retains one separator, and restores undo", () => {
	using model = new TextModel("hello\n  world\nhello \n\tworld\n\nlast");
	using selections = createTestCursorsController(model, [caret(0, 2)]);

	runJoin(model, selections);
	assert.equal(model.getText(), "hello world\nhello \n\tworld\n\nlast");
	assert.deepEqual(selections.getSelections()[0]!, caret(0, 5));
	selections.context.model.undo();
	assert.equal(model.getText(), "hello\n  world\nhello \n\tworld\n\nlast");

	selections.setSelections([caret(2, 1)]);
	runJoin(model, selections);
	assert.equal(model.getText(), "hello\n  world\nhello world\n\nlast");
	assert.deepEqual(selections.getSelections()[0]!, caret(2, 6));
});

test("Join lines joins ranges, reduces overlapping cursors, and preserves the primary group", () => {
	using model = new TextModel("zero\none\ntwo\nthree\nfour\nfive");
	using selections = createTestCursorsController(model, primaryFirst([
		caret(0, 1),
		caret(1, 2),
		Selection.fromPositions(new Position((3) + 1, (1) + 1), new Position((4) + 1, (2) + 1)),
	], 2));

	runJoin(model, selections);
	assert.equal(model.getText(), "zero one\ntwo\nthree four\nfive");
	assert.deepEqual(selections.getSelections(), primaryFirst([
		Selection.fromPositions(new Position((0) + 1, (1) + 1), new Position((0) + 1, (7) + 1)),
		Selection.fromPositions(new Position((2) + 1, (1) + 1), new Position((2) + 1, (8) + 1)),
	], 1));
});

test("Join lines at the final line leaves collapsed and range selections unchanged", () => {
	using model = new TextModel("first\nlast");
	using selections = createTestCursorsController(model, [Selection.fromPositions(
		new Position((1) + 1, (1) + 1),
		new Position((1) + 1, (3) + 1),
	)]);
	runJoin(model, selections);
	assert.equal(model.getText(), "first\nlast");
	assert.deepEqual(selections.getSelections()[0]!, Selection.fromPositions(
		new Position((1) + 1, (1) + 1),
		new Position((1) + 1, (3) + 1),
	));
});

function runJoin(model: TextModel, selections: ReturnType<typeof createTestCursorsController>): void {
	const editor = {
		getModel: () => model,
		getSelections: () => selections.getSelections(),
		pushUndoStop: () => { selections.pushUndoStop(); return true; },
		executeEdits: (_source: unknown, edits: Parameters<TextModel['pushEditOperations']>[1], endCursorState?: unknown) => {
			const result = model.pushEditOperations(selections.getSelections(), edits, () => Array.isArray(endCursorState) ? endCursorState : null);
			if (result) selections.setSelections(result);
			return true;
		},
	} as unknown as ICodeEditor;
	new JoinLinesAction().run({} as never, editor);
}

function caret(lineIndex: number, columnIndex: number): Selection {
	return Selection.fromPositions(new Position((lineIndex) + 1, (columnIndex) + 1));
}

function primaryFirst<T>(items: readonly T[], primaryIndex: number): readonly T[] {
	if (primaryIndex === 0) return Object.freeze([...items]);
	return Object.freeze([items[primaryIndex]!, ...items.slice(0, primaryIndex), ...items.slice(primaryIndex + 1)]);
}
