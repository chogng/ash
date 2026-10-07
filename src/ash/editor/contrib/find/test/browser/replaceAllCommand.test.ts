import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Selection } from '../../../../common/core/selection.js';
import { Position } from '../../../../common/core/position.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { findTextMatches } from '../../../../common/model/textModelSearch.js';
import { createTestCursorsController } from '../../../../test/common/testCursorConfiguration.js';
import { ReplaceAllCommand } from '../../browser/replaceAllCommand.js';

test('replace all preserves the editor selection and undoes as one edit', () => {
	using model = new TextModel('a a a');
	const selection = Selection.fromPositions(new Position(1, 6));
	using cursors = createTestCursorsController(model, [selection]);
	const ranges = findTextMatches(model, { pattern: 'a' }).map(match => match.range);

	cursors.executeCommand(new ReplaceAllCommand(selection, ranges, ['long', '', 'x']));
	assert.equal(model.getText(), 'long  x');
	assert.deepEqual(cursors.getSelections()[0]!.getPosition(), new Position(1, 8));
	model.undo();
	assert.equal(model.getText(), 'a a a');
});

test('replace all combines touching matches before editing', () => {
	using model = new TextModel('aaa');
	const selection = Selection.fromPositions(new Position(1, 4));
	using cursors = createTestCursorsController(model, [selection]);
	const ranges = findTextMatches(model, { pattern: 'a' }).map(match => match.range);
	cursors.executeCommand(new ReplaceAllCommand(selection, ranges, ['x', 'y', 'z']));
	assert.equal(model.getText(), 'xyz');
});
