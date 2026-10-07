import assert from 'node:assert/strict';
import { test } from 'mocha';
import { MoveOperations } from '../../common/cursor/cursorMoveOperations.js';
import { SelectionStartKind, SingleCursorState } from '../../common/cursorCommon.js';
import { Selection } from '../../common/core/selection.js';
import { Position } from '../../common/core/position.js';
import { Range } from '../../common/core/range.js';
import { TextModel } from '../../common/model/textModel.js';
import { TestLanguageConfigurationService } from './modes/testLanguageConfigurationService.js';
import { createTestCursorConfiguration } from './testCursorConfiguration.js';

test('MoveOperations moves horizontally, collapses selections, and honors atomic indentation', () => {
	using model = new TextModel('        a😀b\nnext');
	using languages = new TestLanguageConfigurationService();
	const config = createTestCursorConfiguration(model, languages, { stickyTabStops: true });
	const selection = state(new Selection(1, 2, 1, 9));

	assert.equal(MoveOperations.moveLeft(config, model, selection, false, 1).position.column, 2);
	assert.equal(MoveOperations.moveRight(config, model, selection, false, 1).position.column, 9);
	assert.deepEqual(MoveOperations.leftPosition(model, new Position(1, 12)), new Position(1, 10));
	assert.deepEqual(MoveOperations.rightPosition(model, 1, 10), new Position(1, 12));
	assert.deepEqual(MoveOperations.rightPositionAtomicSoftTabs(model, 1, 1, 4, 4), new Position(1, 5));
	const atomicRight = MoveOperations.right(config, model, new Position(1, 1));
	assert.deepEqual([atomicRight.lineNumber, atomicRight.column, atomicRight.leftoverVisibleColumns], [1, 5, 0]);
});

test('MoveOperations preserves visible columns across vertical movement and translation', () => {
	using model = new TextModel('12345\n1\n12345');
	using languages = new TestLanguageConfigurationService();
	const config = createTestCursorConfiguration(model, languages);
	const source = state(new Selection(1, 5, 1, 5));

	const down = MoveOperations.down(config, model, 1, 5, 0, 1, true);
	assert.deepEqual([down.lineNumber, down.column, down.leftoverVisibleColumns], [2, 2, 3]);
	const up = MoveOperations.up(config, model, down.lineNumber, down.column, down.leftoverVisibleColumns, 1, true);
	assert.deepEqual([up.lineNumber, up.column, up.leftoverVisibleColumns], [1, 5, 0]);
	const vertical = MoveOperations.vertical(config, model, 1, 5, 0, 3, true);
	assert.deepEqual([vertical.lineNumber, vertical.column, vertical.leftoverVisibleColumns], [3, 5, 0]);

	const movedDown = MoveOperations.moveDown(config, model, source, false, 1);
	assert.deepEqual([movedDown.position.lineNumber, movedDown.position.column, movedDown.leftoverVisibleColumns], [2, 2, 3]);
	const movedUp = MoveOperations.moveUp(config, model, movedDown, false, 1);
	assert.deepEqual([movedUp.position.lineNumber, movedUp.position.column], [1, 5]);
	assert.equal(MoveOperations.translateDown(config, model, source).position.lineNumber, 2);
	assert.equal(MoveOperations.translateUp(config, model, MoveOperations.translateDown(config, model, source)).position.lineNumber, 1);
});

test('MoveOperations finds blank lines and standard line and buffer boundaries', () => {
	using model = new TextModel('  first\nsecond\n\nlast');
	using languages = new TestLanguageConfigurationService();
	const config = createTestCursorConfiguration(model, languages);
	const middle = state(new Selection(2, 4, 2, 4));

	assert.equal(MoveOperations.moveToNextBlankLine(config, model, middle, false).position.lineNumber, 3);
	assert.equal(MoveOperations.moveToPrevBlankLine(config, model, state(new Selection(4, 2, 4, 2)), false).position.lineNumber, 3);
	assert.equal(MoveOperations.moveToBeginningOfLine(config, model, state(new Selection(1, 4, 1, 4)), false).position.column, 3);
	assert.equal(MoveOperations.moveToBeginningOfLine(config, model, state(new Selection(1, 3, 1, 3)), false).position.column, 1);
	assert.equal(MoveOperations.moveToEndOfLine(config, model, middle, false, false).position.column, 7);
	assert.deepEqual(MoveOperations.moveToBeginningOfBuffer(config, model, middle, false).position, new Position(1, 1));
	assert.deepEqual(MoveOperations.moveToEndOfBuffer(config, model, middle, false).position, new Position(4, 5));
});

function state(selection: Selection): SingleCursorState {
	return new SingleCursorState(
		Range.fromPositions(selection.getSelectionStart()),
		SelectionStartKind.Simple,
		0,
		selection.getPosition(),
		0,
	);
}
