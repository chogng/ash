import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Range } from '../../common/core/range.js';
import { TextModel } from '../../common/model/textModel.js';

test('TextModel resolves intersecting decorations in model range order', () => {
	using model = new TextModel('one\ntwo\nthree\nfour\nfive');
	const ids = model.deltaDecorations([], [{
		range: new Range(4, 1, 4, 2),
		options: { description: 'four', className: 'four' },
	}, {
		range: new Range(2, 2, 3, 2),
		options: { description: 'two-three', className: 'two-three' },
	}, {
		range: new Range(1, 1, 1, 2),
		options: { description: 'one', className: 'one' },
	}]);

	assert.deepEqual(model.getDecorationsInRange(new Range(1, 1, 2, 1)).map(decoration => decoration.id), [ids[2]]);
	assert.deepEqual(model.getDecorationsInRange(new Range(3, 2, 4, 1)).map(decoration => decoration.id), [ids[0], ids[1]]);
	assert.deepEqual(model.getDecorationsInRange(new Range(5, 1, 5, 2)), []);
});

test('TextModel decoration owner queries include shared owner zero only', () => {
	using model = new TextModel('one\ntwo');
	const [shared] = model.deltaDecorations([], [{ range: new Range(1, 1, 1, 2), options: { description: 'shared' } }], 0);
	const [first] = model.deltaDecorations([], [{ range: new Range(1, 1, 1, 2), options: { description: 'first' } }], 1);
	const [second] = model.deltaDecorations([], [{ range: new Range(2, 1, 2, 2), options: { description: 'second' } }], 2);

	assert.deepEqual(model.getAllDecorations(1).map(decoration => decoration.id), [shared, first]);
	assert.deepEqual(model.getAllDecorations(2).map(decoration => decoration.id), [shared, second]);
	assert.deepEqual(model.getAllDecorations(0).map(decoration => decoration.id), [shared, first, second]);
});
