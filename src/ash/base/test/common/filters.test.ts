import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { matchesContiguousSubString, matchesSubString } from '../../common/filters.js';

suite('Label filters', () => {
	test('finds case-insensitive subsequences in source order and merges adjacent ranges', () => {
		assert.deepEqual(matchesSubString('aLpT', 'Alpha Tree'), [
			{ start: 0, end: 3 },
			{ start: 6, end: 7 },
		]);
		assert.deepEqual(matchesSubString('abc', 'aaabbbccc'), [
			{ start: 0, end: 1 },
			{ start: 3, end: 4 },
			{ start: 6, end: 7 },
		]);
		assert.equal(matchesSubString('ta', 'Alpha Tree'), null);
		assert.equal(matchesSubString('longer', 'short'), null);
		assert.deepEqual(matchesSubString('', ''), []);
		assert.deepEqual(matchesSubString('', 'label'), []);
	});

	test('reports UTF-16 offsets for astral characters and text following them', () => {
		assert.deepEqual(matchesSubString('🌲t', 'a🌲 Trail'), [
			{ start: 1, end: 3 },
			{ start: 4, end: 5 },
		]);
		assert.deepEqual(matchesSubString('🌲🌲', '🌲🌲'), [{ start: 0, end: 4 }]);
		assert.deepEqual(matchesSubString('中文', '中间文字'), [
			{ start: 0, end: 1 },
			{ start: 2, end: 3 },
		]);
	});

	test('keeps contiguous matching distinct from subsequences and handles empty queries', () => {
		assert.equal(matchesContiguousSubString('at', 'Alpha Tree'), null);
		assert.deepEqual(matchesContiguousSubString('TR', 'Alpha Tree'), [{ start: 6, end: 8 }]);
		assert.deepEqual(matchesContiguousSubString('🌲', 'a🌲 Trail'), [{ start: 1, end: 3 }]);
		assert.deepEqual(matchesContiguousSubString('', ''), [{ start: 0, end: 0 }]);
	});

	test('projects lowercase expansions back to original source offsets', () => {
		for (const filter of [matchesSubString, matchesContiguousSubString]) {
			assert.deepEqual(filter('b', 'İb'), [{ start: 1, end: 2 }]);
			assert.deepEqual(filter('i', 'İb'), [{ start: 0, end: 1 }]);
			assert.deepEqual(filter('i\u0307', 'İ'), [{ start: 0, end: 1 }]);
			assert.deepEqual(filter('İ', 'İ'), [{ start: 0, end: 1 }]);
			assert.deepEqual(filter('B', 'İ🌲B'), [{ start: 3, end: 4 }]);
		}
		assert.deepEqual(matchesSubString('ib', 'İb'), [{ start: 0, end: 2 }]);
		assert.equal(matchesContiguousSubString('ib', 'İb'), null);
	});
});
