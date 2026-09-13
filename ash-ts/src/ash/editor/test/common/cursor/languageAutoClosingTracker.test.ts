import { strict as assert } from "node:assert";
import { test } from "mocha";
import { CursorsController } from "../../../common/cursor/cursor.js";
import { DeleteOperations } from "../../../common/cursor/cursorDeleteOperations.js";
import { EditOperationType } from "../../../common/cursorCommon.js";
import { registerBuiltinLanguageConfigurations } from "../../../common/languages/languageBuiltinConfigurations.js";
import { TestLanguageConfigurationService } from '../modes/testLanguageConfigurationService.js';
import { Selection } from "../../../common/core/selection.js";
import { Position } from "../../../common/core/position.js";
import { Range } from "../../../common/core/range.js";
import { TextModel } from "../../../common/model/textModel.js";
import { createTestCursorConfiguration, createTestCursorsController, executeTestDeleteOperation } from '../testCursorConfiguration.js';
import { ViewModelEventsCollector } from '../../../common/viewModelEventDispatcher.js';

test("Auto-closing trust follows external edits and rejects a changed closer", () => {
	using model = new TextModel('x', { languageId: 'typescript' });
	using configurations = new TestLanguageConfigurationService();
	using builtins = registerBuiltinLanguageConfigurations(configurations);
	using selections = createTestCursorsController(model, [caret(1)], {}, configurations);
	typeText(selections, '(');

	model.applyEdits([{ range: Range.fromPositions(new Position((0) + 1, (0) + 1)), text: "pre" }]);
	assert.deepEqual(selections.getSelections()[0]!, caret(5));
	assert.equal(canOvertype(model, selections, new Position((0) + 1, (5) + 1), ")"), true);

	model.applyEdits([{ range: Range.fromPositions(new Position((0) + 1, (5) + 1), new Position((0) + 1, (6) + 1)), text: "]" }]);
	assert.equal(canOvertype(model, selections, selections.getSelections()[0]!.getPosition(), ")"), false);
});

test("Leaving an auto-closed pair invalidates its trust permanently", () => {
	using model = new TextModel('', { languageId: 'typescript' });
	using configurations = new TestLanguageConfigurationService();
	using builtins = registerBuiltinLanguageConfigurations(configurations);
	using selections = createTestCursorsController(model, [caret(0)], {}, configurations);
	typeText(selections, '(');
	assert.equal(canOvertype(model, selections, new Position((0) + 1, (1) + 1), ")"), true);

	selections.setSelections([caret(0)]);
	selections.setSelections([caret(1)]);
	assert.equal(canOvertype(model, selections, new Position((0) + 1, (1) + 1), ")"), false);
});

test("User-authored pairs cannot be overtyped or pair-deleted", () => {
	using model = new TextModel("()", { languageId: 'typescript' });
	using configurations = new TestLanguageConfigurationService();
	using builtins = registerBuiltinLanguageConfigurations(configurations);
	using selections = createTestCursorsController(model, [caret(1)], {}, configurations);

	typeText(selections, ')');
	assert.equal(model.getText(), "())");

	selections.setSelections([caret(1)]);
	executeBackspace(model, selections, configurations);
	assert.equal(model.getText(), "))");
});

test("Multi-selection auto-closing entries retain independent ownership", () => {
	using model = new TextModel('a b', { languageId: 'typescript' });
	using configurations = new TestLanguageConfigurationService();
	using builtins = registerBuiltinLanguageConfigurations(configurations);
	using selections = createTestCursorsController(model, primaryFirst([caret(1), caret(3)], 0), {}, configurations);
	typeText(selections, '(');
	assert.equal(model.getText(), "a() b()");
	assert.equal(canOvertype(model, selections, new Position((0) + 1, (2) + 1), ")"), true);
	assert.equal(canOvertype(model, selections, new Position((0) + 1, (6) + 1), ")"), true);

	selections.setSelections([caret(2)]);
	assert.equal(canOvertype(model, selections, new Position((0) + 1, (2) + 1), ")"), true);
	assert.equal(canOvertype(model, selections, new Position((0) + 1, (6) + 1), ")"), false);
});

test("Undo removes provenance and redo does not invent it again", () => {
	using model = new TextModel("", { languageId: 'typescript' });
	using configurations = new TestLanguageConfigurationService();
	using builtins = registerBuiltinLanguageConfigurations(configurations);
	using selections = createTestCursorsController(model, [caret(0)], {}, configurations);
	typeText(selections, '(');

	selections.context.model.undo();
	assert.equal(model.getText(), "");
	selections.context.model.redo();
	assert.equal(model.getText(), "()");
	assert.equal(canOvertype(model, selections, new Position((0) + 1, (1) + 1), ")"), false);
	executeBackspace(model, selections, configurations);
	assert.equal(model.getText(), ")");
});

test("Cursor disposal leaves the model alive", () => {
	using model = new TextModel('()', { languageId: 'typescript' });
	using configurations = new TestLanguageConfigurationService();
	using builtins = registerBuiltinLanguageConfigurations(configurations);
	using selections = createTestCursorsController(model, [caret(0)], {}, configurations);

	selections.dispose();
	assert.throws(() => selections.getAutoClosedCharacters(), ReferenceError);
	model.applyEdits([{ range: Range.fromPositions(new Position(1, 1)), text: "x" }]);
	assert.equal(model.getText(), 'x()');
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

function canOvertype(model: TextModel, selections: CursorsController, position: Position, close: string): boolean {
	return selections.getAutoClosedCharacters().some(range => Position.equals(range.getStartPosition(), position) && model.getTextInRange(range) === close);
}

function caret(columnIndex: number): Selection {
	return Selection.fromPositions(new Position((0) + 1, (columnIndex) + 1));
}

function primaryFirst<T>(items: readonly T[], primaryIndex: number): readonly T[] {
	if (primaryIndex === 0) return Object.freeze([...items]);
	return Object.freeze([items[primaryIndex]!, ...items.slice(0, primaryIndex), ...items.slice(primaryIndex + 1)]);
}
