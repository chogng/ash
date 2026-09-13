import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeleteOperations } from '../../common/cursor/cursorDeleteOperations.js';
import { EditOperationType } from '../../common/cursorCommon.js';
import { Position } from '../../common/core/position.js';
import { Selection } from '../../common/core/selection.js';
import { TextModel } from '../../common/model/textModel.js';
import { TestLanguageConfigurationService } from './modes/testLanguageConfigurationService.js';
import { createTestCursorConfiguration, createTestCursorsController, executeTestDeleteOperation } from './testCursorConfiguration.js';

test('delete-left removes one complete grapheme', () => {
	using model = new TextModel('a😀b');
	using languages = new TestLanguageConfigurationService();
	using controller = createTestCursorsController(model, [Selection.fromPositions(new Position(1, 4))]);
	const operation = DeleteOperations.deleteLeft(EditOperationType.Other, createTestCursorConfiguration(model, languages), model, [...controller.getSelections()], []);
	executeTestDeleteOperation(controller, operation, EditOperationType.DeletingLeft);
	assert.equal(model.getText(), 'ab');
	assert.deepEqual(controller.getSelections(), [Selection.fromPositions(new Position(1, 2))]);
});

test('delete-right joins adjacent physical lines', () => {
	using model = new TextModel('a\nb');
	using languages = new TestLanguageConfigurationService();
	using controller = createTestCursorsController(model, [Selection.fromPositions(new Position(1, 2))]);
	const operation = DeleteOperations.deleteRight(EditOperationType.Other, createTestCursorConfiguration(model, languages), model, [...controller.getSelections()]);
	executeTestDeleteOperation(controller, operation, EditOperationType.DeletingRight);
	assert.equal(model.getText(), 'ab');
	assert.deepEqual(controller.getSelections(), [Selection.fromPositions(new Position(1, 2))]);
});
