import assert from 'node:assert/strict';
import { test } from 'mocha';
import { MoveOperations } from '../../common/cursor/cursorMoveOperations.js';
import { SelectionStartKind, SingleCursorState } from '../../common/cursorCommon.js';
import { Position } from '../../common/core/position.js';
import { Range } from '../../common/core/range.js';
import { Selection } from '../../common/core/selection.js';
import { TextModel } from '../../common/model/textModel.js';
import { TestLanguageConfigurationService } from './modes/testLanguageConfigurationService.js';
import { createTestCursorConfiguration } from './testCursorConfiguration.js';

test('standard cursor movement keeps the anchor while extending a selection', () => {
	using model = new TextModel('abcdef');
	using languages = new TestLanguageConfigurationService();
	const config = createTestCursorConfiguration(model, languages);
	const source = state(new Selection(1, 2, 1, 2));
	const extended = MoveOperations.moveRight(config, model, source, true, 1);

	assert.deepEqual(extended.selection, new Selection(1, 2, 1, 3));
	assert.deepEqual(MoveOperations.moveLeft(config, model, extended, false, 1).selection, new Selection(1, 2, 1, 2));
});

test('standard vertical state carries its visible-column remainder across short lines', () => {
	using model = new TextModel('abcdef\nx\nabcdef');
	using languages = new TestLanguageConfigurationService();
	const config = createTestCursorConfiguration(model, languages);
	const first = MoveOperations.moveDown(config, model, state(new Selection(1, 6, 1, 6)), false, 1);
	const second = MoveOperations.moveDown(config, model, first, false, 1);

	assert.deepEqual([first.position.lineNumber, first.position.column, first.leftoverVisibleColumns], [2, 2, 4]);
	assert.deepEqual([second.position.lineNumber, second.position.column, second.leftoverVisibleColumns], [3, 6, 0]);
});

test('page and buffer moves clamp to document edges', () => {
	using model = new TextModel('one\ntwo\nthree\nfour');
	using languages = new TestLanguageConfigurationService();
	const config = createTestCursorConfiguration(model, languages);
	const source = state(new Selection(2, 2, 2, 2));

	assert.equal(MoveOperations.moveDown(config, model, source, false, 20).position.lineNumber, 4);
	assert.equal(MoveOperations.moveUp(config, model, source, false, 20).position.lineNumber, 1);
	assert.deepEqual(MoveOperations.moveToBeginningOfBuffer(config, model, source, true).selection, new Selection(2, 2, 1, 1));
	assert.deepEqual(MoveOperations.moveToEndOfBuffer(config, model, source, true).selection, new Selection(2, 2, 4, 5));
});

test('atomic tab stops only apply inside indentation', () => {
	using model = new TextModel('        value');
	using languages = new TestLanguageConfigurationService();
	const config = createTestCursorConfiguration(model, languages, { stickyTabStops: true });

	assert.equal(MoveOperations.moveLeft(config, model, state(new Selection(1, 9, 1, 9)), false, 1).position.column, 5);
	assert.equal(MoveOperations.moveRight(config, model, state(new Selection(1, 1, 1, 1)), false, 1).position.column, 5);
	assert.equal(MoveOperations.moveRight(config, model, state(new Selection(1, 9, 1, 9)), false, 1).position.column, 10);
});

function state(selection: Selection): SingleCursorState {
	return new SingleCursorState(
		Range.fromPositions(selection.getSelectionStart()),
		SelectionStartKind.Simple,
		0,
		new Position(selection.positionLineNumber, selection.positionColumn),
		0,
	);
}
