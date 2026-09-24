import assert from 'node:assert/strict';
import { test } from 'mocha';
import {
	findFirst,
	findFirstIdx,
	findFirstIdxMonotonous,
	findFirstIdxMonotonousOrArrLen,
	findFirstMax,
	findFirstMin,
	findLast,
	findLastIdx,
	findLastIdxMonotonous,
	findLastMax,
	findMaxIdx,
	mapFindFirst,
	MonotonousArray,
} from '../../common/arraysFind.js';

test('linear array searches honor direction and start indexes', () => {
	const values = [1, 2, 3, 2, 1];
	assert.equal(findFirst(values, value => value === 2), 2);
	assert.equal(findFirstIdx(values, value => value === 2, 2), 3);
	assert.equal(findLast(values, value => value === 2), 2);
	assert.equal(findLastIdx(values, value => value === 2, 2), 1);
	assert.equal(findFirst(values, value => value === 9), undefined);
	assert.equal(findLast(values, value => value === 9), undefined);
});

test('monotonous searches preserve bounded no-match semantics', () => {
	const values = [1, 2, 3, 4, 5, 6];
	assert.equal(findLastIdxMonotonous(values, value => value <= 4), 3);
	assert.equal(findLastIdxMonotonous(values, value => value < 3, 2, 5), 1);
	assert.equal(findFirstIdxMonotonousOrArrLen(values, value => value >= 4), 3);
	assert.equal(findFirstIdxMonotonous(values, value => value > 9, 1, 4), -1);
	assert.throws(() => findLastIdxMonotonous(values, () => true, -1), RangeError);
	assert.throws(() => findFirstIdxMonotonous(values, () => true, 4, 3), RangeError);
});

test('MonotonousArray resumes from the last matching boundary', () => {
	const values = new MonotonousArray([1, 2, 3, 4, 5]);
	assert.equal(values.findLastMonotonous(value => value <= 2), 2);
	assert.equal(values.findLastMonotonous(value => value <= 4), 4);
	assert.equal(values.findLastMonotonous(value => value <= 5), 5);
});

test('array extrema choose the documented first or last tie', () => {
	const values = [{ id: 'first', score: 2 }, { id: 'middle', score: 1 }, { id: 'last', score: 2 }];
	const compare = (left: typeof values[number], right: typeof values[number]) => left.score - right.score;
	assert.equal(findFirstMax(values, compare)?.id, 'first');
	assert.equal(findLastMax(values, compare)?.id, 'last');
	assert.equal(findFirstMin(values, compare)?.id, 'middle');
	assert.equal(findMaxIdx(values, compare), 0);
});

test('mapFindFirst returns the first defined mapped value', () => {
	assert.equal(mapFindFirst([1, 2, 3], value => value > 1 ? value * 10 : undefined), 20);
	assert.equal(mapFindFirst([], value => value), undefined);
});
