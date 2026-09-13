import assert from 'node:assert/strict';
import { test } from 'mocha';
import { CachedFunction, LRUCachedFunction, WeakCachedFunction } from '../../common/cache.js';

test('CachedFunction memoizes every computed key', () => {
	let calls = 0;
	const cached = new CachedFunction({ getCacheKey: value => value.id }, (value: { readonly id: number }) => {
		calls += 1;
		return value.id * 2;
	});
	assert.equal(cached.get({ id: 2 }), 4);
	assert.equal(cached.get({ id: 2 }), 4);
	assert.equal(calls, 1);
});

test('LRUCachedFunction retains only the most recent key', () => {
	let calls = 0;
	const cached = new LRUCachedFunction<number, number>(value => {
		calls += 1;
		return value * 2;
	});
	assert.equal(cached.get(2), 4);
	assert.equal(cached.get(2), 4);
	assert.equal(cached.get(3), 6);
	assert.equal(cached.get(2), 4);
	assert.equal(calls, 3);
});

test('WeakCachedFunction memoizes object keys without retaining them strongly', () => {
	let calls = 0;
	const cached = new WeakCachedFunction<object, number>(() => ++calls);
	const key = {};
	assert.equal(cached.get(key), 1);
	assert.equal(cached.get(key), 1);
});
