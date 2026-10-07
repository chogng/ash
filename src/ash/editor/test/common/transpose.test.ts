import assert from "node:assert/strict";
import { test } from "mocha";
import { Selection } from "../../common/core/selection.js";
import { Position } from "../../common/core/position.js";
import { TextModel } from "../../common/model/textModel.js";
import { TransposeAction } from '../../contrib/linesOperations/browser/linesOperations.js';
import { createTestCursorsController } from './testCursorConfiguration.js';
import { type ICodeEditor } from '../../browser/editorBrowser.js';

test("Transpose swaps complete graphemes for multiple carets and undoes atomically", () => {
	using model = new TextModel("a😊b\néx");
	using selections = createTestCursorsController(model, primaryFirst([
		caret(0, 1),
		caret(1, 2),
	], 1));
	runTranspose(model, selections);
	assert.equal(model.getText(), "😊ab\nxé");
	assert.deepEqual(selections.getSelections(), primaryFirst([
		caret(0, 3),
		caret(1, 3),
	], 1));
	selections.context.model.undo();
	assert.equal(model.getText(), "a😊b\néx");
});

test('Transpose swaps the preceding grapheme with the following line break at a line end', () => {
	using model = new TextModel("ab\ncd");
	using selections = createTestCursorsController(model, [caret(0, 2)]);
	runTranspose(model, selections);
	assert.equal(model.getText(), "a\nbcd");
	assert.deepEqual(selections.getSelections()[0]!, caret(1, 1));
});

test("Transpose ignores ranges and resolves overlapping cursor edits in favor of the primary cursor", () => {
	using model = new TextModel("abc");
	using selections = createTestCursorsController(model, primaryFirst([
		caret(0, 1),
		caret(0, 2),
		Selection.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (1) + 1)),
	], 1));
	runTranspose(model, selections);
	assert.equal(model.getText(), "acb");
	assert.deepEqual(selections.getSelections()[0]!, caret(0, 3));

	selections.setSelections([caret(0, 3)]);
	runTranspose(model, selections);
	assert.equal(model.getText(), "acb");
});

function runTranspose(model: TextModel, selections: ReturnType<typeof createTestCursorsController>): void {
	const editor = {
		getModel: () => model,
		getSelections: () => selections.getSelections(),
		pushUndoStop: () => { selections.pushUndoStop(); return true; },
		executeCommands: (_source: string | null | undefined, commands: Parameters<typeof selections.executeCommands>[0]) => selections.executeCommands(commands),
	} as unknown as ICodeEditor;
	new TransposeAction().run({} as never, editor);
}

function caret(lineIndex: number, columnIndex: number): Selection {
	return Selection.fromPositions(new Position((lineIndex) + 1, (columnIndex) + 1));
}

function primaryFirst<T>(items: readonly T[], primaryIndex: number): readonly T[] {
	if (primaryIndex === 0) return Object.freeze([...items]);
	return Object.freeze([items[primaryIndex]!, ...items.slice(0, primaryIndex), ...items.slice(primaryIndex + 1)]);
}
