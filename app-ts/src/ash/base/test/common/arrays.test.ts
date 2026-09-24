import assert from 'node:assert/strict';
import { test } from 'mocha';
import { arraysEqual, CallbackIterable, commonArraySuffixLength, commonPrefixLength, distinct, isNonEmptyArray } from '../../common/arrays.js';

test('arraysEqual compares complete sequences', () => {
	assert.equal(arraysEqual([1, 2], [1, 2]), true);
	assert.equal(arraysEqual([1, 2], [1, 3]), false);
	assert.equal(arraysEqual([1], [1, 2]), false);
});

test('arraysEqual accepts domain equality', () => {
	assert.equal(arraysEqual(['A'], ['a'], (left, right) => left.toLowerCase() === right.toLowerCase()), true);
});

test('commonPrefixLength returns the shared leading run', () => {
	assert.equal(commonPrefixLength(['a', 'b', 'c'], ['a', 'b', 'd']), 2);
	assert.equal(commonPrefixLength([], ['a']), 0);
});

test('commonSuffixLength excludes an already matched prefix', () => {
	assert.equal(commonArraySuffixLength(['a', 'x', 'c'], ['a', 'y', 'c'], 1), 1);
	assert.equal(commonArraySuffixLength(['a'], ['a'], 1), 0);
	assert.throws(() => commonArraySuffixLength(['a'], ['a'], 2), RangeError);
});

test('isNonEmptyArray rejects nullish and empty sequences', () => {
	assert.equal(isNonEmptyArray([1]), true);
	assert.equal(isNonEmptyArray([]), false);
	assert.equal(isNonEmptyArray(undefined), false);
	assert.equal(isNonEmptyArray(null), false);
});

test('distinct retains the first value for every computed key', () => {
	assert.deepEqual(distinct(['A', 'a', 'B'], value => value.toLowerCase()), ['A', 'B']);
});

test('CallbackIterable composes lazy mapping and early termination', () => {
	const visited: number[] = [];
	const values = new CallbackIterable<number>(callback => {
		for (const value of [1, 2, 3, 4]) {
			visited.push(value);
			if (!callback(value)) break;
		}
	});
	assert.equal(values.map(value => value * 2).some(value => value === 6), true);
	assert.deepEqual(visited, [1, 2, 3]);
	assert.deepEqual(values.filter(value => value % 2 === 0).toArray(), [2, 4]);
});
