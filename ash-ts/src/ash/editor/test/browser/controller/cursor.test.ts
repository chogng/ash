import assert from 'node:assert/strict';
import { test } from 'mocha';
import { CursorsController } from '../../../common/cursor/cursor.js';
import { Range } from '../../../common/core/range.js';
import { Selection } from '../../../common/core/selection.js';
import { TextModel } from '../../../common/model/textModel.js';
import { ReplaceCommand } from '../../../common/commands/replaceCommand.js';
import { createTestCursorsController } from '../../common/testCursorConfiguration.js';

test('CursorsController owns per-editor selections and cursor-only undo', () => {
	using model = new TextModel('alpha\nbeta');
	const initial = [new Selection(1, 1, 1, 1), new Selection(2, 3, 2, 3)];
	using cursors = createTestCursorsController(model, initial);
	assert.deepEqual({
		selection: cursors.getSelection(),
		position: cursors.getPosition(),
		states: cursors.getCursorStates().map(state => state.modelState.selection),
		primary: cursors.getPrimaryCursorState().modelState.selection,
		top: cursors.getTopMostViewPosition(),
		bottom: cursors.getBottomMostViewPosition(),
		lastAdded: cursors.getLastAddedCursorIndex(),
	}, {
		selection: initial[0],
		position: initial[0]!.getPosition(),
		states: initial,
		primary: initial[0],
		top: initial[0]!.getPosition(),
		bottom: initial[1]!.getPosition(),
		lastAdded: 1,
	});
	cursors.setCursorSelections([new Selection(2, 3, 2, 3)]);
	assert.equal(cursors.undoCursorOperation(), true);
	assert.deepEqual(cursors.getSelections(), initial);
});

test('CursorsController validates read-only ownership', () => {
	using model = new TextModel('text');
	using cursors = createTestCursorsController(model, [new Selection(1, 1, 1, 1)], { readOnly: true });
	assert.equal(cursors.context.cursorConfig.readOnly, true);
	assert.equal(cursors.context.model, model);
});

test('CursorCollection keeps the last bottom-most view position on ties', () => {
	using model = new TextModel('text');
	const shared = new Selection(1, 3, 1, 3);
	using cursors = createTestCursorsController(model, [shared, shared], { multiCursorMergeOverlapping: false });
	const states = cursors.getCursorStates();

	assert.strictEqual(cursors.getBottomMostViewPosition(), states[1]!.viewState.position);
});

test('cursor edit updates the shared model and resulting selection together', () => {
	using model = new TextModel('bc');
	using cursors = createTestCursorsController(model, [new Selection(1, 1, 1, 1)]);
	cursors.executeCommand(new ReplaceCommand(new Range(1, 1, 1, 1), 'a'));
	assert.equal(model.getValue(), 'abc');
	assert.equal(cursors.getSelections()[0]!.positionColumn, 2);
});
