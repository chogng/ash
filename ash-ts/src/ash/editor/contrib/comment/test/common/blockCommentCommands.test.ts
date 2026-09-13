import assert from "node:assert/strict";
import { test } from "mocha";
import { BlockCommentCommand } from '../../browser/blockCommentCommand.js';
import { Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { TextModel } from "../../../../common/model/textModel.js";
import { createTestCursorsController } from '../../../../test/common/testCursorConfiguration.js';
import { TestLanguageConfigurationService } from '../../../../test/common/modes/testLanguageConfigurationService.js';

test("Block comments wrap and unwrap directional selections in isolated undo steps", () => {
	using model = new TextModel("alpha beta", { languageId: 'typescript' });
	using selections = createTestCursorsController(model, [Selection.fromPositions(new Position((0) + 1, (10) + 1), new Position((0) + 1, (6) + 1))]);
	using configurations = blockCommentConfigurations();
	executeIsolated(selections, configurations);
	assert.equal(model.getText(), "alpha /* beta */");
	assert.deepEqual(selections.getSelections()[0]!, Selection.fromPositions(
		new Position((0) + 1, (13) + 1),
		new Position((0) + 1, (9) + 1),
	));
	executeIsolated(selections, configurations);
	assert.equal(model.getText(), "alpha beta");
	assert.deepEqual(selections.getSelections()[0]!, Selection.fromPositions(
		new Position((0) + 1, (10) + 1),
		new Position((0) + 1, (6) + 1),
	));
	selections.context.model.undo();
	assert.equal(model.getText(), "alpha /* beta */");
});

test("Block comments place collapsed carets inside the generated pair and support independent cursors", () => {
	using model = new TextModel("one two", { languageId: 'typescript' });
	using selections = createTestCursorsController(model, primaryFirst([
		Selection.fromPositions(new Position((0) + 1, (0) + 1)),
		Selection.fromPositions(new Position((0) + 1, (4) + 1)),
	], 1));
	using configurations = blockCommentConfigurations();
	executeIsolated(selections, configurations);
	assert.equal(model.getText(), "/*  */one /*  */two");
	assert.deepEqual(selections.getSelections(), primaryFirst([
		Selection.fromPositions(new Position((0) + 1, (3) + 1)),
		Selection.fromPositions(new Position((0) + 1, (13) + 1)),
	], 1));
});

test("Block comment command leaves unsupported languages unchanged", () => {
	using model = new TextModel('alpha');
	using selections = createTestCursorsController(model, [Selection.fromPositions(new Position(1, 1))]);
	using configurations = new TestLanguageConfigurationService();
	selections.executeCommand(new BlockCommentCommand(selections.getSelection(), true, configurations));
	assert.equal(model.getText(), 'alpha');
});

function blockCommentConfigurations(): TestLanguageConfigurationService {
	const configurations = new TestLanguageConfigurationService();
	configurations.register('typescript', { comments: { blockComment: ['/*', '*/'] } });
	return configurations;
}

function executeIsolated(selections: ReturnType<typeof createTestCursorsController>, configurations: TestLanguageConfigurationService): void {
	selections.pushUndoStop();
	selections.executeCommands(selections.getSelections().map(selection => new BlockCommentCommand(selection, true, configurations)));
	selections.pushUndoStop();
}

function primaryFirst<T>(items: readonly T[], primaryIndex: number): readonly T[] {
	if (primaryIndex === 0) return Object.freeze([...items]);
	return Object.freeze([items[primaryIndex]!, ...items.slice(0, primaryIndex), ...items.slice(primaryIndex + 1)]);
}
