import assert from 'node:assert/strict';
import { test } from 'mocha';
import { IdentityCoordinatesConverter } from '../../common/coordinatesConverter.js';
import { Position } from '../../common/core/position.js';
import { Range } from '../../common/core/range.js';
import { TextModel } from '../../common/model/textModel.js';

test('IdentityCoordinatesConverter validates positions and ranges through the text model', () => {
	using model = new TextModel('alpha\nbeta');
	const converter = new IdentityCoordinatesConverter(model);

	assert.deepEqual(converter.convertViewPositionToModelPosition(new Position(9, 9)), new Position(2, 5));
	assert.deepEqual(converter.convertModelPositionToViewPosition(new Position(0, 0)), new Position(1, 1));
	assert.deepEqual(converter.convertViewRangeToModelRange(new Range(1, 2, 9, 9)), new Range(1, 2, 2, 5));
	assert.deepEqual(converter.validateViewPosition(new Position(1, 1), new Position(2, 9)), new Position(2, 5));
	assert.deepEqual(converter.validateViewRange(new Range(1, 1, 1, 1), new Range(0, 0, 2, 9)), new Range(1, 1, 2, 5));
	assert.equal(converter.modelPositionIsVisible(new Position(2, 1)), true);
	assert.equal(converter.modelPositionIsVisible(new Position(3, 1)), false);
	assert.equal(converter.modelRangeIsVisible(new Range(1, 1, 2, 1)), true);
	assert.equal(converter.getModelLineViewLineCount(1), 1);
	assert.equal(converter.getViewLineNumberOfModelPosition(2, 3), 2);
});
