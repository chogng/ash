import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ShiftCommand } from '../../../../common/commands/shiftCommand.js';
import { EditorAutoIndentStrategy } from '../../../../common/config/editorOptions.js';
import { Position } from '../../../../common/core/position.js';
import { Selection } from '../../../../common/core/selection.js';
import { createTestLanguageConfigurationService } from '../../../../test/common/modes/testLanguageConfigurationService.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { createTestCursorsController } from '../../../../test/common/testCursorConfiguration.js';

test('ShiftCommand owns selected-line indentation after the legacy helper retires', () => {
	using configurations = createTestLanguageConfigurationService();
	using model = new TextModel('one\n  two\nthree', { tabSize: 2, indentSize: 2, insertSpaces: true });
	const initial = Selection.fromPositions(new Position(1, 1), new Position(2, 6));
	using cursors = createTestCursorsController(model, [initial]);
	const options = {
		isUnshift: false,
		tabSize: 2,
		indentSize: 2,
		insertSpaces: true,
		useTabStops: true,
		autoIndent: EditorAutoIndentStrategy.None,
	};

	cursors.executeCommand(new ShiftCommand(initial, options, configurations));
	assert.equal(model.getText(), '  one\n    two\nthree');
	cursors.executeCommand(new ShiftCommand(cursors.getSelections()[0]!, { ...options, isUnshift: true }, configurations));
	assert.equal(model.getText(), 'one\n  two\nthree');
});
