import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Position } from '../../../../common/core/position.js';
import { Selection } from '../../../../common/core/selection.js';
import { createBuiltinLanguageConfigurationService } from '../../../../common/languages/languageBuiltinConfigurations.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { IndentationToSpacesCommand, IndentationToTabsCommand } from '../../browser/indentation.js';
import { getReindentEditOperations } from '../../common/indentation.js';
import { generateIndent, getSpaceCnt } from '../../common/indentUtils.js';
import { createTestCursorsController } from '../../../../test/common/testCursorConfiguration.js';

test('indent utilities validate widths and generate compact indentation', () => {
	assert.equal(getSpaceCnt('\t  ', 4), 6);
	assert.equal(generateIndent(10, 4, false), '\t\t  ');
	assert.equal(generateIndent(3, 4, true), '   ');
	assert.throws(() => getSpaceCnt('\t', 0), /positive safe integer/);
});

test('canonical indentation commands convert the document and preserve the selection', () => {
	using model = new TextModel('\talpha\n    beta', { tabSize: 4 });
	const initial = Selection.fromPositions(new Position(1, 2), new Position(2, 5));
	using cursors = createTestCursorsController(model, [initial]);

	cursors.executeCommand(new IndentationToSpacesCommand(initial, 4));
	assert.equal(model.getText(), '    alpha\n    beta');
	assert.deepEqual(cursors.getSelections(), [Selection.fromPositions(new Position(1, 5), new Position(2, 5))]);
	cursors.executeCommand(new IndentationToTabsCommand(cursors.getSelections()[0]!, 4));
	assert.equal(model.getText(), '\talpha\n\tbeta');
});

test('getReindentEditOperations follows registered language indentation rules', () => {
	using configurations = createBuiltinLanguageConfigurationService();
	using model = new TextModel('if (ok) {\nvalue();\n}', { languageId: 'javascript', tabSize: 4, indentSize: 4, insertSpaces: true });
	const edits = getReindentEditOperations(model, configurations, 1, 3);
	model.applyEdits(edits);
	assert.equal(model.getText(), 'if (ok) {\n    value();\n}');
});

test('indentation conversion preserves tab stops after leading spaces', () => {
	using model = new TextModel(' \talpha\n   \tbeta\n    \tgamma', { tabSize: 4 });
	using cursors = createTestCursorsController(model, [new Selection(1, 3, 1, 3)]);
	cursors.executeCommand(new IndentationToSpacesCommand(cursors.getSelections()[0]!, 4));
	assert.equal(model.getText(), '    alpha\n    beta\n        gamma');
	assert.deepEqual(cursors.getSelections(), [new Selection(1, 5, 1, 5)]);
	cursors.executeCommand(new IndentationToTabsCommand(cursors.getSelections()[0]!, 4));
	assert.equal(model.getText(), '\talpha\n\tbeta\n\t\tgamma');
});
