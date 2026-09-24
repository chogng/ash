import assert from 'node:assert/strict';
import { test } from 'mocha';
import { getOrSet, LRUCache, NKeyMap } from '../../common/map.js';

test('getOrSet returns existing values without replacing them', () => {
	const map = new Map([['key', 'existing']]);

	assert.equal(getOrSet(map, 'key', 'replacement'), 'existing');
	assert.equal(map.get('key'), 'existing');
});

test('getOrSet inserts absent and undefined values', () => {
	const map = new Map<string, string | undefined>([['present', undefined]]);

	assert.equal(getOrSet(map, 'missing', 'created'), 'created');
	assert.equal(map.get('missing'), 'created');
	assert.equal(getOrSet(map, 'present', 'replacement'), 'replacement');
	assert.equal(map.get('present'), 'replacement');
});

test('LRUCache trims oldest entries and touches values on read', () => {
	const cache = new LRUCache<string, number>(4, 0.5);
	cache.set('one', 1).set('two', 2).set('three', 3).set('four', 4);
	assert.equal(cache.get('one'), 1);

	cache.set('five', 5);

	assert.deepEqual([...cache], [['one', 1], ['five', 5]]);
});

test('LRUCache peek preserves age and validates its bounds', () => {
	const cache = new LRUCache<string, number>(2);
	cache.set('one', 1).set('two', 2);
	assert.equal(cache.peek('one'), 1);
	cache.set('three', 3);

	assert.deepEqual([...cache], [['two', 2], ['three', 3]]);
	assert.throws(() => new LRUCache(-1), RangeError);
	assert.throws(() => new LRUCache(1, 2), RangeError);
});

test('LRUCache iteration remains finite while reads update recency', () => {
	const cache = new LRUCache<string, number>(3);
	cache.set('one', 1).set('two', 2).set('three', 3);
	const seen: string[] = [];

	cache.forEach((_value, key) => {
		seen.push(key);
		cache.get(key);
	});

	assert.deepEqual(seen, ['one', 'two', 'three']);
});

test('NKeyMap keeps tuple components distinct without composite-key collisions', () => {
	const map = new NKeyMap<string, [string, string]>();
	map.set('first', 'a|b', 'c');
	map.set('second', 'a', 'b|c');

	assert.equal(map.get('a|b', 'c'), 'first');
	assert.equal(map.get('a', 'b|c'), 'second');
});

test('NKeyMap accepts map values and supports prefix operations', () => {
	const map = new NKeyMap<Map<string, number>, [string, number, boolean]>();
	const first = new Map([['value', 1]]);
	const second = new Map([['value', 2]]);
	const third = new Map([['value', 3]]);
	map.set(first, 'group', 0, false);
	map.set(second, 'group', 1, true);
	map.set(third, 'other', 0, false);

	assert.deepEqual([...map.getAll('group')], [first, second]);
	assert.equal(map.delete('group', 0, false), true);
	assert.equal(map.delete('group', 0, false), false);
	assert.equal(map.deleteAll('group'), true);
	assert.deepEqual([...map.values()], [third]);
	assert.equal(map.deleteAll(), true);
	assert.deepEqual([...map.values()], []);
	assert.equal(map.deleteAll(), false);
});
