import assert from 'node:assert/strict';
import { test } from 'mocha';
import { RangeMap } from '../../browser/ui/list/rangeMap.js';

test('RangeMap preserves row boundaries through insertions, removals and height changes', () => {
	const map = new RangeMap();
	map.splice(0, 0, [{ size: 20 }, { size: 35 }, { size: 10 }]);
	map.splice(1, 1, [{ size: 12 }, { size: 18 }]);
	assert.equal(map.size, 60);
	assert.equal(map.count, 4);
	assert.deepEqual([0, 1, 2, 3].map(index => map.positionAt(index)), [0, 20, 32, 50]);
	assert.deepEqual([0, 19, 20, 31, 32, 59, 60].map(position => map.indexAt(position)), [0, 0, 1, 1, 2, 3, 4]);
	assert.equal(map.indexAfter(20), 2);
	map.splice(0, 2);
	assert.equal(map.size, 28);
	assert.equal(map.positionAt(1), 18);
});

test('RangeMap distinguishes padding, row positions and the end of an empty list', () => {
	const map = new RangeMap(8);
	assert.equal(map.size, 8);
	assert.equal(map.indexAt(0), 0);
	assert.equal(map.indexAt(-1), -1);
	assert.equal(map.positionAt(0), -1);
	map.splice(0, 0, [{ size: 24 }]);
	assert.equal(map.positionAt(0), 8);
	assert.equal(map.indexAt(31), 0);
	assert.equal(map.indexAt(32), 1);
	assert.equal(map.positionAt(1), -1);
	map.paddingTop = 12;
	assert.equal(map.size, 36);
	assert.equal(map.positionAt(0), 12);
});
