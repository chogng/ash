import assert from "node:assert/strict";
import { test } from "mocha";
import { DeleteLinesAction, InsertLineAfterAction, InsertLineBeforeAction } from "../../browser/linesOperations.js";
import { Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { TextModel } from "../../../../common/model/textModel.js";
import { CopyLinesCommand } from '../../browser/copyLinesCommand.js';
import { MoveLinesCommand } from '../../browser/moveLinesCommand.js';
import { SortLinesCommand } from '../../browser/sortLinesCommand.js';
import { EditorAutoIndentStrategy } from '../../../../common/config/editorOptions.js';
import { createBuiltinLanguageConfigurationService } from '../../../../common/languages/languageBuiltinConfigurations.js';
import { createTestCursorConfiguration, createTestCursorsController } from '../../../../test/common/testCursorConfiguration.js';
import { type ICodeEditor } from '../../../../browser/editorBrowser.js';
import { type EditorAction } from '../../../../browser/editorExtensions.js';

test('Canonical line commands execute through ICommand without the legacy controller', () => {
	using configurations = createBuiltinLanguageConfigurationService();
	using model = new TextModel('zero\none\ntwo');
	using selections = createTestCursorsController(model, [caret(1, 1)]);

	executeIsolated(selections, new CopyLinesCommand(selections.getSelections()[0]!, true));
	assert.deepEqual({ text: model.getText(), selection: selections.getSelections()[0] }, {
		text: 'zero\none\none\ntwo',
		selection: caret(2, 1),
	});
	executeIsolated(selections, new MoveLinesCommand(
		selections.getSelections()[0]!,
		true,
		EditorAutoIndentStrategy.None,
		configurations,
	));
	assert.deepEqual({ text: model.getText(), selection: selections.getSelections()[0] }, {
		text: 'zero\none\ntwo\none',
		selection: caret(3, 1),
	});
	selections.setSelections([Selection.fromPositions(new Position(1, 1), new Position(4, 4))]);
	executeIsolated(selections, new SortLinesCommand(selections.getSelections()[0]!, false));
	assert.equal(model.getText(), 'one\none\ntwo\nzero');
	selections.context.model.undo();
	assert.equal(model.getText(), 'zero\none\ntwo\none');
});

test('SortLinesCommand rejects single-line and already-sorted work', () => {
	using model = new TextModel('a\nb');
	assert.equal(SortLinesCommand.canRun(model, caret(0, 0), false), false);
	assert.equal(SortLinesCommand.canRun(model, Selection.fromPositions(new Position(1, 1), new Position(2, 2)), false), false);
	assert.equal(SortLinesCommand.canRun(model, Selection.fromPositions(new Position(1, 1), new Position(2, 2)), true), true);
});

test("Delete lines removes selected physical line groups and keeps a valid final line", () => {
	using model = new TextModel("zero\none\ntwo\nthree\nfour");
	using selections = createTestCursorsController(model, primaryFirst([
		caret(1, 1),
		Selection.fromPositions(new Position((3) + 1, (0) + 1), new Position((4) + 1, (0) + 1)),
	], 1));

	runAction(new DeleteLinesAction(), model, selections);
	assert.equal(model.getText(), "zero\ntwo\nfour");
	selections.context.model.undo();
	assert.equal(model.getText(), "zero\none\ntwo\nthree\nfour");

	selections.setSelections([caret(0, 0)]);
	runAction(new DeleteLinesAction(), model, selections);
	assert.equal(model.getText(), "one\ntwo\nthree\nfour");
	selections.setSelections([caret(3, 0)]);
	runAction(new DeleteLinesAction(), model, selections);
	assert.equal(model.getText(), "one\ntwo\nthree");
	selections.setSelections([caret(0, 0)]);
	runAction(new DeleteLinesAction(), model, selections);
	runAction(new DeleteLinesAction(), model, selections);
	runAction(new DeleteLinesAction(), model, selections);
	assert.equal(model.getText(), "");
});

test("Duplicate lines supports multi-line groups, document edges, and isolated undo", () => {
	using model = new TextModel("zero\none\ntwo\nthree");
	using selections = createTestCursorsController(model, [Selection.fromPositions(new Position((1) + 1, (0) + 1), new Position((3) + 1, (0) + 1))]);

	selections.executeCommands(selections.getSelections().map(selection => new CopyLinesCommand(selection, true)));
	assert.equal(model.getText(), "zero\none\ntwo\none\ntwo\nthree");
	selections.context.model.undo();
	assert.equal(model.getText(), "zero\none\ntwo\nthree");

	selections.setSelections([caret(0, 1)]);
	selections.executeCommands(selections.getSelections().map(selection => new CopyLinesCommand(selection, false)));
	assert.equal(model.getText(), "zero\nzero\none\ntwo\nthree");
	selections.setSelections([caret(4, 2)]);
	selections.executeCommands(selections.getSelections().map(selection => new CopyLinesCommand(selection, true)));
	assert.equal(model.getText(), "zero\nzero\none\ntwo\nthree\nthree");
});

test("CopyLinesCommand construction does not mutate the model", () => {
	using model = new TextModel("alpha");
	const selections = [caret(0, 0)];
	new CopyLinesCommand(selections[0]!, true);
	assert.equal(model.getText(), "alpha");
});

for (const down of [false, true]) {
	test(`Copy adjacent final lines ${down ? 'down' : 'up'} includes the empty last line`, () => {
		using model = new TextModel('head\ntail\n');
		const original = [new Selection(3, 1, 3, 1), new Selection(2, 3, 2, 1)];
		using cursors = createTestCursorsController(model, original);
		cursors.executeCommands(cursors.getSelections().map(selection => new CopyLinesCommand(selection, down)));
		const delta = down ? 1 : 0;
		assert.deepEqual({ text: model.getValue(), selections: cursors.getSelections() }, {
			text: 'head\ntail\ntail\n\n',
			selections: [new Selection(4 + delta, 1, 4 + delta, 1), new Selection(2 + delta, 3, 2 + delta, 1)],
		});
		model.undo();
		assert.deepEqual({ text: model.getValue(), selections: cursors.getSelections() }, { text: 'head\ntail\n', selections: original });
	});

	test(`Copy lines ${down ? 'down' : 'up'} keeps every cursor on its own copy`, () => {
		using model = new TextModel('alpha\nbeta\ngamma');
		const original = [new Selection(3, 4, 3, 2), new Selection(1, 2, 1, 2)];
		using cursors = createTestCursorsController(model, original);
		cursors.executeCommands(cursors.getSelections().map(selection => new CopyLinesCommand(selection, down)));
		const delta = down ? 1 : 0;
		assert.deepEqual({ text: model.getValue(), selections: cursors.getSelections() }, {
			text: 'alpha\nalpha\nbeta\ngamma\ngamma',
			selections: [new Selection(4 + delta, 4, 4 + delta, 2), new Selection(1 + delta, 2, 1 + delta, 2)],
		});
		model.undo();
		assert.deepEqual({ text: model.getValue(), selections: cursors.getSelections() }, { text: 'alpha\nbeta\ngamma', selections: original });
	});
}

test("Move lines swaps selected groups with their neighboring rows and keeps directional selections", () => {
	using model = new TextModel("zero\none\ntwo\nthree\nfour");
	using selections = createTestCursorsController(model, [Selection.fromPositions(new Position((2) + 1, (3) + 1), new Position((1) + 1, (1) + 1))]);
	using configurations = createBuiltinLanguageConfigurationService();

	selections.executeCommands(selections.getSelections().map(selection => new MoveLinesCommand(selection, true, EditorAutoIndentStrategy.None, configurations)));
	assert.equal(model.getText(), "zero\nthree\none\ntwo\nfour");
	assert.deepEqual(selections.getSelections()[0]!, Selection.fromPositions(
		new Position((3) + 1, (3) + 1),
		new Position((2) + 1, (1) + 1),
	));
	selections.executeCommands(selections.getSelections().map(selection => new MoveLinesCommand(selection, false, EditorAutoIndentStrategy.None, configurations)));
	assert.equal(model.getText(), "zero\none\ntwo\nthree\nfour");
	assert.deepEqual(selections.getSelections()[0]!, Selection.fromPositions(
		new Position((2) + 1, (3) + 1),
		new Position((1) + 1, (1) + 1),
	));

	selections.setSelections([caret(0, 0)]);
	selections.executeCommands(selections.getSelections().map(selection => new MoveLinesCommand(selection, false, EditorAutoIndentStrategy.None, configurations)));
	assert.equal(model.getText(), "zero\none\ntwo\nthree\nfour");
});

test("MoveLinesCommand preserves disjoint selected groups", () => {
	using model = new TextModel("zero\none\ntwo\nthree\nfour");
	using selections = createTestCursorsController(model, primaryFirst([
		caret(1, 1),
		caret(3, 2),
	], 1));
	using configurations = createBuiltinLanguageConfigurationService();

	selections.executeCommands(selections.getSelections().map(selection => new MoveLinesCommand(selection, true, EditorAutoIndentStrategy.None, configurations)));
	assert.equal(model.getText(), "zero\ntwo\none\nfour\nthree");
	assert.deepEqual(selections.getSelections(), primaryFirst([
		caret(2, 1),
		caret(4, 2),
	], 1));
	selections.context.model.undo();
	assert.equal(model.getText(), "zero\none\ntwo\nthree\nfour");

});

test("Insert line actions follow active cursor lines and undo atomically", () => {
	using model = new TextModel("zero\none\ntwo\nthree");
	using selections = createTestCursorsController(model, primaryFirst([
		caret(0, 1),
		Selection.fromPositions(new Position((2) + 1, (0) + 1), new Position((3) + 1, (0) + 1)),
	], 1));

	runAction(new InsertLineAfterAction(), model, selections);
	assert.equal(model.getText(), "zero\n\none\ntwo\nthree\n");
	assert.deepEqual(selections.getSelections(), primaryFirst([
		caret(1, 0),
		caret(5, 0),
	], 1));
	selections.context.model.undo();
	assert.equal(model.getText(), "zero\none\ntwo\nthree");

	selections.setSelections([caret(0, 0)]);
	runAction(new InsertLineBeforeAction(), model, selections);
	assert.equal(model.getText(), "\nzero\none\ntwo\nthree");
	assert.deepEqual(selections.getSelections()[0]!, caret(0, 0));
});

function runAction(action: EditorAction, model: TextModel, selections: ReturnType<typeof createTestCursorsController>): void {
	using configurations = createBuiltinLanguageConfigurationService();
	const cursorConfig = createTestCursorConfiguration(model, configurations);
	const editor = {
		getModel: () => model,
		getSelections: () => selections.getSelections(),
		_getViewModel: () => ({ cursorConfig }) as never,
		pushUndoStop: () => { selections.pushUndoStop(); return true; },
		executeCommands: (_source: string | null | undefined, commands: Parameters<typeof selections.executeCommands>[0]) => selections.executeCommands(commands),
		executeEdits: (_source: unknown, edits: Parameters<TextModel['pushEditOperations']>[1], endCursorState?: unknown) => {
			const result = model.pushEditOperations(
				selections.getSelections(),
				edits,
				() => Array.isArray(endCursorState) ? endCursorState : null,
			);
			if (result) selections.setSelections(result);
			return true;
		},
	} as unknown as ICodeEditor;
	action.run({} as never, editor, {});
}

function executeIsolated(selections: ReturnType<typeof createTestCursorsController>, command: Parameters<typeof selections.executeCommand>[0]): void {
	selections.pushUndoStop();
	selections.executeCommand(command);
	selections.pushUndoStop();
}

function caret(lineIndex: number, columnIndex: number): Selection {
	return Selection.fromPositions(new Position((lineIndex) + 1, (columnIndex) + 1));
}

function primaryFirst<T>(items: readonly T[], primaryIndex: number): readonly T[] {
	if (primaryIndex === 0) return Object.freeze([...items]);
	return Object.freeze([items[primaryIndex]!, ...items.slice(0, primaryIndex), ...items.slice(primaryIndex + 1)]);
}
