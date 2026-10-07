import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ColumnSelection } from '../../common/cursor/cursorColumnSelection.js';
import { Position } from '../../common/core/position.js';
import { TextModel } from '../../common/model/textModel.js';

test('column selection clamps each physical line independently', () => {
	using model = new TextModel('abcdef\nab\n12345');
	const result = ColumnSelection.columnSelect(model, new Position(1, 3), new Position(3, 6));
	assert.deepEqual(result.map(selection => [selection.startLineNumber, selection.startColumn, selection.endColumn]), [
		[1, 3, 6], [2, 3, 3], [3, 3, 6],
	]);
});
