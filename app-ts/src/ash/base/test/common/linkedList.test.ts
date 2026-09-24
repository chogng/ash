import assert from 'node:assert/strict';
import { test } from 'mocha';
import { LinkedList } from '../../common/linkedList.js';

test('LinkedList removes the exact registration even for duplicate values', () => {
	const list = new LinkedList<string>();
	const removeOld = list.push('shared');
	list.push('middle');
	const removeNew = list.unshift('shared');

	removeOld();
	assert.deepEqual([...list], ['shared', 'middle']);
	removeNew();
	assert.deepEqual([...list], ['middle']);
});

test('LinkedList owns both ends and stale removers are harmless', () => {
	const list = new LinkedList<number>();
	const remove = list.push(1);
	list.push(2);
	assert.equal(list.peek(), 2);
	assert.equal(list.shift(), 1);
	assert.equal(list.pop(), 2);
	assert.equal(list.isEmpty(), true);

	list.push(3);
	list.clear();
	remove();
	assert.deepEqual({ size: list.size, values: [...list] }, { size: 0, values: [] });
});

test('LinkedList iteration skips entries removed between steps', () => {
	const list = new LinkedList<string>();
	const removeFirst = list.push('first');
	const removeSecond = list.push('second');
	list.push('third');
	const iterator = list[Symbol.iterator]();

	assert.deepEqual(iterator.next(), { value: 'first', done: false });
	removeFirst();
	removeSecond();
	assert.deepEqual(iterator.next(), { value: 'third', done: false });
});
