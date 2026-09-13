import assert from "node:assert/strict";
import { test } from "mocha";
import { DeleteOperations } from "../../common/cursor/cursorDeleteOperations.js";
import { TypeOperations } from '../../common/cursor/cursorTypeOperations.js';
import { WordNavigationType, WordOperations } from '../../common/cursor/cursorWordOperations.js';
import { ReplaceCommand } from '../../common/commands/replaceCommand.js';
import { CursorsController } from "../../common/cursor/cursor.js";
import { EditOperationType } from '../../common/cursorCommon.js';
import { Selection } from "../../common/core/selection.js";
import { Position } from "../../common/core/position.js";
import { TextModel } from "../../common/model/textModel.js";
import { TestLanguageConfigurationService } from './modes/testLanguageConfigurationService.js';
import { createTestCursorConfiguration, createTestCursorsController, createTestDeleteWordContext, executeTestDeleteOperation, executeTestEditOperation } from './testCursorConfiguration.js';
import { ViewModelEventsCollector } from '../../common/viewModelEventDispatcher.js';

test("Typing replaces multiple selections and coalesces with following text", () => {
	using model = new TextModel("abcd efgh");
	const initial = primaryFirst([
		Selection.fromPositions(new Position((0) + 1, (3) + 1), new Position((0) + 1, (1) + 1)),
		caret(0, 8),
	], 1);
	using controller = createTestCursorsController(model, initial);

	typeText(controller, 'X');
	assert.deepEqual({
		text: model.getText(),
		selections: controller.getSelections(),
	}, {
		text: "aXd efgXh",
		selections: primaryFirst([
			caret(0, 2),
			caret(0, 8),
		], 1),
	});

	typeText(controller, 'Y');
	assert.equal(model.getText(), "aXYd efgXYh");
	controller.context.model.undo();
	assert.deepEqual({
		text: model.getText(),
		selections: controller.getSelections(),
	}, {
		text: "abcd efgh",
		selections: initial,
	});
});

test("Backspace deletes graphemes and joins lines", () => {
	using model = new TextModel("a😀b\ncd");
	using languages = new TestLanguageConfigurationService();
	const config = createTestCursorConfiguration(model, languages);
	using controller = createTestCursorsController(
		model,
		[caret(0, 3)],
	);

	executeTestDeleteOperation(controller, DeleteOperations.deleteLeft(controller.getPrevEditOperationType(), config, model, [...controller.getSelections()], []), EditOperationType.DeletingLeft);
	assert.deepEqual({
		text: model.getText(),
		selection: controller.getSelections()[0]!,
	}, {
		text: "ab\ncd",
		selection: caret(0, 1),
	});

	controller.setSelections([caret(1, 0)]);
	executeTestDeleteOperation(controller, DeleteOperations.deleteLeft(controller.getPrevEditOperationType(), config, model, [...controller.getSelections()], []), EditOperationType.DeletingLeft);
	assert.deepEqual({
		text: model.getText(),
		selection: controller.getSelections()[0]!,
	}, {
		text: "abcd",
		selection: caret(0, 2),
	});
});

test("Forward Delete removes graphemes and line breaks", () => {
	using model = new TextModel("a😀b\ncd");
	using languages = new TestLanguageConfigurationService();
	const config = createTestCursorConfiguration(model, languages);
	using controller = createTestCursorsController(
		model,
		[caret(0, 1)],
	);

	executeTestDeleteOperation(controller, DeleteOperations.deleteRight(controller.getPrevEditOperationType(), config, model, [...controller.getSelections()]), EditOperationType.DeletingRight);
	assert.deepEqual({
		text: model.getText(),
		selection: controller.getSelections()[0]!,
	}, {
		text: "ab\ncd",
		selection: caret(0, 1),
	});

	controller.setSelections([caret(0, 2)]);
	executeTestDeleteOperation(controller, DeleteOperations.deleteRight(controller.getPrevEditOperationType(), config, model, [...controller.getSelections()]), EditOperationType.DeletingRight);
	assert.deepEqual({
		text: model.getText(),
		selection: controller.getSelections()[0]!,
	}, {
		text: "abcd",
		selection: caret(0, 2),
	});
});

test("Word deletion uses shared editor word boundaries and coalesces by direction", () => {
	using model = new TextModel("alpha beta gamma");
	using languages = new TestLanguageConfigurationService();
	const config = createTestCursorConfiguration(model, languages);
	using controller = createTestCursorsController(model, [caret(0, 10)]);

	deleteTestWord(controller, config, model, 'left');
	deleteTestWord(controller, config, model, 'left');
	assert.equal(model.getText(), " gamma");
	assert.deepEqual(controller.getSelections()[0]!, caret(0, 0));
	controller.context.model.undo();
	assert.equal(model.getText(), "alpha beta gamma");

	controller.setSelections([caret(0, 0)]);
	deleteTestWord(controller, config, model, 'right');
	assert.equal(model.getText(), " beta gamma");
});

test("Selection deletion is multi-cursor aware and preserves selected ranges", () => {
	using model = new TextModel("alpha\nbeta");
	using languages = new TestLanguageConfigurationService();
	const config = createTestCursorConfiguration(model, languages);
	using controller = createTestCursorsController(model, primaryFirst([
		Selection.fromPositions(new Position(1, 1), new Position(1, 4)),
		Selection.fromPositions(new Position(2, 1), new Position(2, 2)),
	], 1));

	executeTestDeleteOperation(controller, DeleteOperations.deleteLeft(EditOperationType.Other, config, model, [...controller.getSelections()], []), EditOperationType.DeletingLeft);
	assert.deepEqual({ text: model.getText(), selections: controller.getSelections() }, {
		text: "ha\neta",
		selections: primaryFirst([caret(0, 0), caret(1, 0)], 1),
	});
	controller.context.model.undo();
	assert.equal(model.getText(), "alpha\nbeta");

	controller.setSelections([Selection.fromPositions(new Position((0) + 1, (1) + 1), new Position((1) + 1, (2) + 1))]);
	executeTestDeleteOperation(controller, DeleteOperations.deleteRight(EditOperationType.Other, config, model, [...controller.getSelections()]), EditOperationType.DeletingRight);
	assert.deepEqual({ text: model.getText(), selection: controller.getSelections()[0]! }, {
		text: "ata",
		selection: caret(0, 1),
	});
});

test("Typing normalizes line endings before calculating carets", () => {
	using model = new TextModel("ab");
	using controller = createTestCursorsController(
		model,
		[caret(0, 1)],
	);

	typeText(controller, '\r\n');
	assert.deepEqual({
		text: model.getText(),
		selection: controller.getSelections()[0]!,
	}, {
		text: "a\nb",
		selection: caret(1, 0),
	});
});

test('Tab advances carets and partial selections to the next indentation stop', () => {
	using model = new TextModel('ab cd');
	model.updateOptions({ insertSpaces: true, indentSize: 4, tabSize: 4 });
	using languages = new TestLanguageConfigurationService();
	const config = createTestCursorConfiguration(model, languages);
	using controller = createTestCursorsController(model, primaryFirst([
		caret(0, 2),
		Selection.fromPositions(new Position(1, 4), new Position(1, 6)),
	], 1));

	controller.executeCommands(TypeOperations.tab(config, model, [...controller.getSelections()]), 'keyboard');

	assert.deepEqual({
		text: model.getText(),
		selections: controller.getSelections(),
	}, {
		text: 'ab    ',
		selections: primaryFirst([
			caret(0, 4),
			caret(0, 6),
		], 1),
	});
});

test('Tab indents selected lines without replacing their text', () => {
	using model = new TextModel('alpha\nbeta\ngamma');
	model.updateOptions({ insertSpaces: true, indentSize: 2, tabSize: 2 });
	using languages = new TestLanguageConfigurationService();
	const config = createTestCursorConfiguration(model, languages);
	const selection = Selection.fromPositions(new Position(1, 3), new Position(3, 1));
	using controller = createTestCursorsController(model, [selection]);

	controller.executeCommands(TypeOperations.tab(config, model, [...controller.getSelections()]), 'keyboard');

	assert.deepEqual({
		text: model.getText(),
		selection: controller.getSelections()[0],
	}, {
		text: '  alpha\n  beta\ngamma',
		selection: Selection.fromPositions(new Position(1, 5), new Position(3, 1)),
	});
});

test('Tab normalizes a whitespace-only line to the next indentation stop', () => {
	using model = new TextModel('   ');
	model.updateOptions({ insertSpaces: true, indentSize: 4, tabSize: 4 });
	using languages = new TestLanguageConfigurationService();
	const config = createTestCursorConfiguration(model, languages);
	using controller = createTestCursorsController(model, [caret(0, 1)]);

	controller.executeCommands(TypeOperations.tab(config, model, [...controller.getSelections()]), 'keyboard');

	assert.equal(model.getText(), '    ');
	assert.deepEqual(controller.getSelections()[0], caret(0, 4));
});

test('TypeOperations indents, outdents, and transforms indentation through the shared command owner', () => {
	using model = new TextModel('alpha\nbeta');
	model.updateOptions({ insertSpaces: true, indentSize: 2, tabSize: 2 });
	using languages = new TestLanguageConfigurationService();
	const config = createTestCursorConfiguration(model, languages);
	const selection = Selection.fromPositions(new Position(1, 1), new Position(2, model.getLineMaxColumn(2)));
	using controller = createTestCursorsController(model, [selection]);

	controller.executeCommands(TypeOperations.indent(config, model, [...controller.getSelections()]), 'keyboard');
	assert.equal(model.getText(), '  alpha\n  beta');
	controller.executeCommands(TypeOperations.outdent(config, model, [...controller.getSelections()]), 'keyboard');
	assert.equal(model.getText(), 'alpha\nbeta');
	assert.equal(TypeOperations.shiftIndent(config, '  ', 2), '      ');
	assert.equal(TypeOperations.unshiftIndent(config, '      ', 2), '  ');
});

test('Composition typing replaces its local text window as one cursor transaction', () => {
	using model = new TextModel('abcd');
	using controller = createTestCursorsController(model, [caret(0, 2)]);
	const events = new ViewModelEventsCollector();

	controller.startComposition(events);
	controller.compositionType(events, 'X', 1, 1, 0, 'keyboard');
	controller.endComposition(events, 'keyboard');

	assert.equal(model.getText(), 'aXd');
	assert.deepEqual(controller.getSelections()[0], caret(0, 2));
	model.undo();
	assert.equal(model.getText(), 'abcd');
});

test('Composition typing replaces a selected range and restores it on undo', () => {
	using model = new TextModel('abcd');
	const selection = Selection.fromPositions(new Position(1, 2), new Position(1, 4));
	using controller = createTestCursorsController(model, [selection]);
	const events = new ViewModelEventsCollector();

	controller.startComposition(events);
	controller.compositionType(events, 'X', 0, 0, 0, 'keyboard');
	controller.endComposition(events, 'keyboard');

	assert.equal(model.getText(), 'aXd');
	assert.deepEqual(controller.getSelections()[0], caret(0, 2));
	model.undo();
	assert.equal(model.getText(), 'abcd');
	assert.deepEqual(controller.getSelections()[0], selection);
});

test("Delete boundaries are no-ops and overlapping selections fail early", () => {
	using model = new TextModel("abc");
	using languages = new TestLanguageConfigurationService();
	const config = createTestCursorConfiguration(model, languages);
	using controller = createTestCursorsController(
		model,
		[caret(0, 0)],
	);

	const version = model.version;
	executeTestDeleteOperation(controller, DeleteOperations.deleteLeft(EditOperationType.Other, config, model, [...controller.getSelections()], []), EditOperationType.DeletingLeft);
	assert.equal(model.version, version);
	controller.setSelections([caret(0, 3)]);
	executeTestDeleteOperation(controller, DeleteOperations.deleteRight(EditOperationType.Other, config, model, [...controller.getSelections()]), EditOperationType.DeletingRight);
	assert.equal(model.version, version);

	const overlapping = primaryFirst([
		Selection.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (2) + 1)),
		Selection.fromPositions(new Position((0) + 1, (1) + 1), new Position((0) + 1, (3) + 1)),
	], 0);
	controller.setSelections(overlapping);
	typeText(controller, 'X');
	assert.equal(model.getText(), 'Xc');
});

test("Adjacent deletions merge converged carets while history restores sources", () => {
	using model = new TextModel("abc");
	using languages = new TestLanguageConfigurationService();
	const config = createTestCursorConfiguration(model, languages);
	const initial = primaryFirst([
		caret(0, 1),
		caret(0, 2),
	], 1);
	using controller = createTestCursorsController(model, initial);

	executeTestDeleteOperation(controller, DeleteOperations.deleteLeft(EditOperationType.Other, config, model, [...controller.getSelections()], []), EditOperationType.DeletingLeft);
	assert.deepEqual({
		text: model.getText(),
		selections: controller.getSelections(),
	}, {
		text: "c",
		selections: [caret(0, 0)],
	});

	controller.context.model.undo();
	assert.deepEqual({
		text: model.getText(),
		selections: controller.getSelections(),
	}, {
		text: "abc",
		selections: initial,
	});
	controller.context.model.redo();
	assert.deepEqual(controller.getSelections(), [caret(0, 0)]);
});

test("Paste commands support shared and distributed isolated text", () => {
	using model = new TextModel("ab cd");
	using controller = createTestCursorsController(
		model,
		primaryFirst([
			Selection.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (2) + 1)),
			Selection.fromPositions(new Position((0) + 1, (3) + 1), new Position((0) + 1, (5) + 1)),
		], 1),
	);

	controller.paste(new ViewModelEventsCollector(), 'A\nB\nC', false, ['A\r\nB', 'C'], 'test');
	assert.deepEqual({
		text: model.getText(),
		selections: controller.getSelections(),
	}, {
		text: "A\nB C",
		selections: primaryFirst([
			caret(1, 1),
			caret(1, 3),
		], 0),
	});

	controller.paste(new ViewModelEventsCollector(), '!', false, null, 'test');
	assert.equal(model.getText(), "A\nB! C!");
	controller.context.model.undo();
	assert.equal(model.getText(), "A\nB C");
	controller.context.model.undo();
	assert.equal(model.getText(), "ab cd");

	controller.paste(new ViewModelEventsCollector(), 'only one', false, ['only one'], 'test');
	assert.equal(model.getText(), 'only one only one');
});

test("Cut preserves collapsed cursors and restores history", () => {
	using model = new TextModel("abc def");
	using languages = new TestLanguageConfigurationService();
	const config = createTestCursorConfiguration(model, languages, { emptySelectionClipboard: false });
	const initial = primaryFirst([
		Selection.fromPositions(new Position((0) + 1, (2) + 1), new Position((0) + 1, (0) + 1)),
		caret(0, 7),
	], 0);
	using controller = createTestCursorsController(model, initial);

	executeTestEditOperation(controller, DeleteOperations.cut(config, model, [...controller.getSelections()]));
	assert.deepEqual({
		text: model.getText(),
		selections: controller.getSelections(),
	}, {
		text: "c def",
		selections: primaryFirst([
			caret(0, 0),
			caret(0, 5),
		], 0),
	});

	controller.context.model.undo();
	assert.deepEqual({
		text: model.getText(),
		selections: controller.getSelections(),
	}, {
		text: "abc def",
		selections: initial,
	});
});

function caret(lineIndex: number, columnIndex: number): Selection {
	return Selection.fromPositions(new Position((lineIndex) + 1, (columnIndex) + 1));
}

function typeText(controller: CursorsController, text: string): void {
	controller.type(new ViewModelEventsCollector(), text, 'test');
}

function deleteTestWord(controller: CursorsController, config: ReturnType<typeof createTestCursorConfiguration>, model: TextModel, direction: 'left' | 'right'): void {
	controller.executeCommands(controller.getSelections().map(selection => {
		const context = createTestDeleteWordContext(config, model, selection, [...controller.getAutoClosedCharacters()]);
		const range = direction === 'left'
			? WordOperations.deleteWordLeft(context, WordNavigationType.WordStart)
			: WordOperations.deleteWordRight(context, WordNavigationType.WordEnd);
		return range ? new ReplaceCommand(range, '') : null;
	}), 'test');
}

function primaryFirst<T>(items: readonly T[], primaryIndex: number): readonly T[] {
	if (primaryIndex === 0) return Object.freeze([...items]);
	return Object.freeze([items[primaryIndex]!, ...items.slice(0, primaryIndex), ...items.slice(primaryIndex + 1)]);
}
