import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Range } from '../../common/core/range.js';
import { type Position } from '../../common/core/position.js';
import { EndOfLineSequence } from '../../common/model.js';
import { TextModel } from '../../common/model/textModel.js';

test('Repeated decoration viewport queries reuse resolved text positions', () => {
	using model = new PositionQueryModel(Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n'));
	model.deltaDecorations([], Array.from({ length: 100 }, (_, index) => ({
		range: new Range(index + 1, 1, index + 1, 4), options: { description: 'sample', inlineClassName: 'sample' },
	})));
	model.getAllDecorations();
	model.positionQueries = 0;
	for (let line = 10; line < 30; line++) {
		assert.equal(model.getDecorationsInRange(new Range(line, 1, line, 5)).length, 1);
	}
	assert.equal(model.positionQueries, 0);
});

test('Resolved decoration ranges follow same-length edits, EOL changes and replacement', () => {
	using model = new TextModel('aa\nbb\ncc');
	let [id] = model.deltaDecorations([], [{ range: new Range(2, 1, 2, 3), options: { description: 'sample' } }]);
	const read = () => model.getAllDecorations().find(decoration => decoration.id === id)!.range;
	assert.deepEqual(read(), new Range(2, 1, 2, 3));
	model.applyEdits([{ range: new Range(1, 1, 1, 3), text: '\nX' }]);
	assert.deepEqual(read(), new Range(3, 1, 3, 3));
	model.setEOL(EndOfLineSequence.CRLF);
	assert.deepEqual(read(), new Range(3, 1, 3, 3));
	model.applyEdits([{ range: new Range(1, 1, 1, 1), text: 'prefix\r\n' }]);
	assert.deepEqual(read(), new Range(4, 1, 4, 3));
	[id] = model.deltaDecorations([id], [{ range: new Range(3, 1, 3, 2), options: { description: 'replacement' } }]);
	assert.deepEqual(read(), new Range(3, 1, 3, 2));
	model.setValue('reset');
	assert.deepEqual(read(), model.getDecorationRange(id));
});

test('Decoration queries during cursor-state computation and undo see moved ranges', () => {
	using model = new TextModel('first\nsecond');
	const [id] = model.deltaDecorations([], [{ range: new Range(2, 1, 2, 7), options: { description: 'sample' } }]);
	const read = () => model.getAllDecorations().find(decoration => decoration.id === id)!.range;
	assert.deepEqual(read(), new Range(2, 1, 2, 7));
	let callbackRange: Range | undefined;
	model.pushEditOperations(null, [{ range: new Range(1, 1, 1, 1), text: 'X\n' }], () => {
		callbackRange = read();
		return null;
	});
	assert.deepEqual(callbackRange, new Range(3, 1, 3, 7));
	assert.deepEqual(read(), new Range(3, 1, 3, 7));
	model.undo();
	assert.deepEqual(read(), new Range(2, 1, 2, 7));
	model.redo();
	assert.deepEqual(read(), new Range(3, 1, 3, 7));
});

class PositionQueryModel extends TextModel {
	public positionQueries = 0;
	public override positionAt(offset: number): Position {
		this.positionQueries++;
		return super.positionAt(offset);
	}
}

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
