import { strict as assert } from "node:assert";
import { test } from "mocha";
import { CursorsController } from "../../../common/cursor/cursor.js";
import { DeleteOperations } from "../../../common/cursor/cursorDeleteOperations.js";
import { EditOperationType } from "../../../common/cursorCommon.js";
import { registerBuiltinLanguageConfigurations } from "../../../common/languages/languageBuiltinConfigurations.js";
import { TestLanguageConfigurationService } from '../modes/testLanguageConfigurationService.js';
import { Selection } from "../../../common/core/selection.js";
import { Position } from "../../../common/core/position.js";
import { TextModel } from "../../../common/model/textModel.js";
import { createTestCursorConfiguration, createTestCursorsController, executeTestDeleteOperation } from '../testCursorConfiguration.js';
import { ViewModelEventsCollector } from '../../../common/viewModelEventDispatcher.js';

test("Language pair typing auto-closes and overtypes one existing closer", () => {
	using model = new TextModel('call', { languageId: 'typescript' });
	using configurations = new TestLanguageConfigurationService();
	using builtins = registerBuiltinLanguageConfigurations(configurations);
	using selections = createTestCursorsController(model, [caret(4)], {}, configurations);

	typeText(selections, '(');
	assert.equal(model.getText(), "call()");
	assert.deepEqual(selections.getSelections()[0]!, caret(5));
	const version = model.version;

	typeText(selections, ')');
	assert.equal(model.getText(), "call()");
	assert.equal(model.version, version);
	assert.deepEqual(selections.getSelections()[0]!, caret(6));

	selections.context.model.undo();
	assert.equal(model.getText(), "call");
	assert.deepEqual(selections.getSelections()[0]!, caret(4));
});

test("Language pair backspace removes both empty sides and remains one undo step", () => {
	using model = new TextModel("", { languageId: 'typescript' });
	using configurations = new TestLanguageConfigurationService();
	using builtins = registerBuiltinLanguageConfigurations(configurations);
	using selections = createTestCursorsController(model, [caret(0)], {}, configurations);
	typeText(selections, '[');

	executeBackspace(model, selections, configurations);
	assert.equal(model.getText(), "");
	assert.deepEqual(selections.getSelections()[0]!, caret(0));

	selections.context.model.undo();
	assert.equal(model.getText(), "[]");
	assert.deepEqual(selections.getSelections()[0]!, caret(1));
});

test("Language pair typing surrounds directional selections and auto-closes collapsed cursors", () => {
	using model = new TextModel('alpha beta', { languageId: 'typescript' });
	const backward = Selection.fromPositions(new Position((0) + 1, (5) + 1), new Position((0) + 1, (0) + 1));
	using configurations = new TestLanguageConfigurationService();
	using builtins = registerBuiltinLanguageConfigurations(configurations);
	using selections = createTestCursorsController(model, primaryFirst([backward, caret(10)], 1), {}, configurations);
	typeText(selections, '"');
	assert.equal(model.getText(), "\"alpha\" beta\"\"");
	assert.deepEqual(selections.getSelections(), primaryFirst([
		Selection.fromPositions(new Position((0) + 1, (6) + 1), new Position((0) + 1, (1) + 1)),
		caret(13),
	], 1));

	selections.context.model.undo();
	assert.equal(model.getText(), "alpha beta");
	assert.deepEqual(selections.getSelections(), primaryFirst([backward, caret(10)], 1));
});

test("Auto-closing respects following text and supports multi-token pairs", () => {
	using model = new TextModel("name", { languageId: 'template' });
	using configurations = new TestLanguageConfigurationService();
	using custom = configurations.register("template", {
		autoClosingPairs: [{ open: "<%", close: "%>" }],
		surroundingPairs: [{ open: "<%", close: "%>" }],
		autoCloseBefore: " ",
	});
	using selections = createTestCursorsController(model, [caret(0)], {}, configurations);

	typeText(selections, '<%');
	assert.equal(model.getText(), "<%name");
	assert.deepEqual(selections.getSelections()[0]!, caret(2));

	selections.setSelections([caret(6)]);
	typeText(selections, '<%');
	assert.equal(model.getText(), "<%name<%%>");
	assert.deepEqual(selections.getSelections()[0]!, caret(8));
	executeBackspace(model, selections, configurations);
	assert.equal(model.getText(), "<%name");
});

test("Auto-closing notIn keeps string and comment input single while code still pairs", () => {
	using configurations = new TestLanguageConfigurationService();
	using builtins = registerBuiltinLanguageConfigurations(configurations);

	using stringModel = new TextModel('"value "', { languageId: 'typescript' });
	using stringSelections = createTestCursorsController(stringModel, [caret(7)], {}, configurations);
	typeText(stringSelections, "'");
	assert.equal(stringModel.getText(), "\"value '\"");
	assert.deepEqual(stringSelections.getAutoClosedCharacters(), []);

	using commentModel = new TextModel('// note ', { languageId: 'typescript' });
	using commentSelections = createTestCursorsController(commentModel, [caret(8)], {}, configurations);
	typeText(commentSelections, "'");
	assert.equal(commentModel.getText(), "// note '");

	using codeModel = new TextModel('', { languageId: 'typescript' });
	using codeSelections = createTestCursorsController(codeModel, [caret(0)], {}, configurations);
	typeText(codeSelections, "'");
	assert.equal(codeModel.getText(), "''");
	assert.equal(codeSelections.getAutoClosedCharacters().length, 1);
});

test('Each cursor uses the language configuration at its own position', () => {
	using model = new TextModel('first\nsecond');
	model.getLanguageIdAtPosition = lineNumber => lineNumber === 1 ? 'angle' : 'template';
	using configurations = new TestLanguageConfigurationService();
	using angle = configurations.register('angle', {
		autoClosingPairs: [{ open: '<', close: '>' }],
	});
	using template = configurations.register('template', {
		autoClosingPairs: [{ open: '<', close: '%>' }],
	});
	using selections = createTestCursorsController(model, [
		Selection.fromPositions(new Position(1, 6)),
		Selection.fromPositions(new Position(2, 7)),
	], {}, configurations);

	typeText(selections, '<');

	assert.equal(model.getText(), 'first<>\nsecond<%>');
	assert.deepEqual(selections.getSelections(), [
		Selection.fromPositions(new Position(1, 7)),
		Selection.fromPositions(new Position(2, 8)),
	]);
});

test('Composition ending with a surrounding character restores and surrounds the original selection', () => {
	using model = new TextModel('word', { languageId: 'typescript' });
	using configurations = new TestLanguageConfigurationService();
	using builtins = registerBuiltinLanguageConfigurations(configurations);
	const original = Selection.fromPositions(new Position(1, 1), new Position(1, 5));
	using selections = createTestCursorsController(model, [original], {}, configurations);
	const events = new ViewModelEventsCollector();

	selections.startComposition(events);
	selections.compositionType(events, '"', 0, 0, 0, 'keyboard');
	selections.endComposition(events, 'keyboard');

	assert.equal(model.getText(), '"word"');
	assert.deepEqual(selections.getSelections()[0], Selection.fromPositions(new Position(1, 2), new Position(1, 6)));
	model.undo();
	assert.equal(model.getText(), 'word');
	assert.deepEqual(selections.getSelections()[0], original);
});

function typeText(selections: CursorsController, text: string): void {
	selections.type(new ViewModelEventsCollector(), text, 'keyboard');
}

function executeBackspace(model: TextModel, selections: CursorsController, configurations: TestLanguageConfigurationService): void {
	const operation = DeleteOperations.deleteLeft(
		selections.getPrevEditOperationType(),
		createTestCursorConfiguration(model, configurations),
		model,
		[...selections.getSelections()],
		[...selections.getAutoClosedCharacters()],
	);
	executeTestDeleteOperation(selections, operation, EditOperationType.DeletingLeft);
}

function caret(columnIndex: number): Selection {
	return Selection.fromPositions(new Position((0) + 1, (columnIndex) + 1));
}

function primaryFirst<T>(items: readonly T[], primaryIndex: number): readonly T[] {
	if (primaryIndex === 0) return Object.freeze([...items]);
	return Object.freeze([items[primaryIndex]!, ...items.slice(0, primaryIndex), ...items.slice(primaryIndex + 1)]);
}
