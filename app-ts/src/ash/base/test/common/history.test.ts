import assert from 'node:assert/strict';
import { test } from 'mocha';
import { HistoryNavigator } from '../../common/history.js';

test('HistoryNavigator keeps recent unique values and navigates past the end', () => {
	const history = new Set(['one', 'two', 'three']);
	using navigator = new HistoryNavigator(history, 2);

	assert.deepEqual(navigator.getHistory(), ['two', 'three']);
	assert.deepEqual([...history], ['two', 'three']);
	assert.equal(navigator.previous(), 'three');
	assert.equal(navigator.previous(), 'two');
	assert.equal(navigator.previous(), null);
	assert.equal(navigator.next(), 'three');
	assert.equal(navigator.next(), null);

	navigator.add('two');
	assert.deepEqual(navigator.getHistory(), ['three', 'two']);
});
