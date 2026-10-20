import assert from "node:assert/strict";
import { test } from "mocha";
import { LineCommentCommand, Type } from '../../browser/lineCommentCommand.js';
import { Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { Range } from "../../../../common/core/range.js";
import { TextModel } from "../../../../common/model/textModel.js";
import { createTestCursorsController, setTestCursorSelections } from '../../../../test/common/testCursorConfiguration.js';
import { TestLanguageConfigurationService } from '../../../../test/common/modes/testLanguageConfigurationService.js';

test("Toggle line comment inserts after indentation and restores one isolated undo step", () => {
	using model = new TextModel("  alpha\n\tbeta\n\n gamma", { languageId: 'typescript' });
	using selections = createTestCursorsController(model, [Selection.fromPositions(new Position((0) + 1, (2) + 1), new Position((3) + 1, (1) + 1))]);
	using configurations = lineCommentConfigurations();
	selections.executeCommands(selections.getSelections().map(selection => new LineCommentCommand(configurations, selection, 4, Type.Toggle, true, false)));

	assert.equal(model.getText(), "//   alpha\n// \tbeta\n// \n//  gamma");
	assert.deepEqual(
		selections.getSelections()[0]!,
		Selection.fromPositions(new Position((0) + 1, (5) + 1), new Position((3) + 1, (4) + 1)),
	);
	selections.context.model.undo();
	assert.equal(model.getText(), "  alpha\n\tbeta\n\n gamma");
	selections.context.model.redo();
	assert.equal(model.getText(), "//   alpha\n// \tbeta\n// \n//  gamma");
});

test("Toggle line comment removes only when all selected content lines are commented", () => {
	using model = new TextModel("// alpha\n  // beta\n\n// gamma", { languageId: 'typescript' });
	using selections = createTestCursorsController(model, [Selection.fromPositions(new Position((0) + 1, (0) + 1), new Position((3) + 1, (8) + 1))]);
	using configurations = lineCommentConfigurations();
	selections.executeCommands(selections.getSelections().map(selection => new LineCommentCommand(configurations, selection, 4, Type.Toggle, true, false)));
	assert.equal(model.getText(), "alpha\n  beta\n\ngamma");

	model.applyEdits([{
		range: Range.fromPositions(new Position((1) + 1, (0) + 1)),
		text: "x",
	}]);
	setTestCursorSelections(selections, [Selection.fromPositions(new Position((0) + 1, (0) + 1), new Position((1) + 1, (7) + 1))]);
	selections.executeCommands(selections.getSelections().map(selection => new LineCommentCommand(configurations, selection, 4, Type.Toggle, false, false)));
	assert.equal(model.getText(), "//alpha\n//x  beta\n\ngamma");
});

test("Force add and force remove use the aligned command type", () => {
	using model = new TextModel('alpha', { languageId: 'typescript' });
	using selections = createTestCursorsController(model, [Selection.fromPositions(new Position(1, 1))]);
	using configurations = lineCommentConfigurations();
	selections.executeCommand(new LineCommentCommand(configurations, selections.getSelection(), 4, Type.ForceAdd, false, false));
	assert.equal(model.getText(), '//alpha');
	selections.executeCommand(new LineCommentCommand(configurations, selections.getSelection(), 4, Type.ForceRemove, false, false));
	assert.equal(model.getText(), 'alpha');
});

function lineCommentConfigurations(): TestLanguageConfigurationService {
	const configurations = new TestLanguageConfigurationService();
	configurations.register('typescript', { comments: { lineComment: '//' } });
	return configurations;
}
