import assert from 'node:assert/strict';
import { test } from 'mocha';
import { MoveOperations } from '../../../common/cursor/cursorMoveOperations.js';
import { SelectionStartKind, SingleCursorState } from '../../../common/cursorCommon.js';
import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { TextModel } from '../../../common/model/textModel.js';
import { TestLanguageConfigurationService } from '../../common/modes/testLanguageConfigurationService.js';
import { createTestCursorConfiguration } from '../../common/testCursorConfiguration.js';

test('vertical navigation retains the requested visual column', () => {
	using model = new TextModel('12345\n12\n12345');
	using languages = new TestLanguageConfigurationService();
	const config = createTestCursorConfiguration(model, languages);
	const source = new SingleCursorState(Range.fromPositions(new Position(1, 5)), SelectionStartKind.Simple, 0, new Position(1, 5), 0);
	const result = MoveOperations.moveDown(config, model, source, false, 1);
	assert.deepEqual([result.position.lineNumber, result.position.column], [2, 3]);
	assert.equal(result.leftoverVisibleColumns, 2);
});
