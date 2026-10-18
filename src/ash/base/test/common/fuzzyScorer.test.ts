import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { scoreFuzzy } from '../../common/fuzzyScorer.js';

suite('Fuzzy scorer', () => {
	test('selects a later contiguous word instead of the first possible subsequence', () => {
		const [score, positions] = scoreFuzzy('a---ab', 'ab', 'ab', true);
		assert.deepEqual(positions, [4, 5]);
		assert.ok(score > scoreFuzzy('a--xb', 'ab', 'ab', true)[0]);
	});

	test('requires all characters in order and returns no score for empty inputs', () => {
		for (const [target, query] of [['', 'a'], ['a', ''], ['ab', 'ba'], ['ab', 'abc']]) {
			assert.deepEqual(scoreFuzzy(target!, query!, query!.toLowerCase(), true), [0, []]);
		}
	});

	test('contiguous mode rejects gaps while finding later substrings', () => {
		assert.deepEqual(scoreFuzzy('a---b', 'ab', 'ab', false), [0, []]);
		assert.deepEqual(scoreFuzzy('a---ab', 'ab', 'ab', false)[1], [4, 5]);
	});

	test('prefers original casing, word starts and adjacent matches', () => {
		assert.ok(scoreFuzzy('Build', 'B', 'b', true)[0] > scoreFuzzy('Build', 'b', 'b', true)[0]);
		assert.ok(scoreFuzzy('fooBar', 'b', 'b', true)[0] > scoreFuzzy('foobar', 'b', 'b', true)[0]);
		assert.ok(scoreFuzzy('build', 'bui', 'bui', true)[0] > scoreFuzzy('buxixld', 'bui', 'bui', true)[0]);
		assert.ok(scoreFuzzy('x build', 'b', 'b', true)[0] > scoreFuzzy('xbuild', 'b', 'b', true)[0]);
	});

	test('matches either path separator and keeps source UTF-16 positions', () => {
		assert.deepEqual(scoreFuzzy('src\\build.ts', 'src/b', 'src/b', true)[1], [0, 1, 2, 3, 4]);
		assert.deepEqual(scoreFuzzy('x😀-文件', '😀文', '😀文', true)[1], [1, 2, 4]);
	});

	test('projects expanding and contextual lowercase matches onto their source characters', () => {
		assert.deepEqual(scoreFuzzy('İstanbul', 'i\u0307s', 'i\u0307s', true)[1], [0, 1]);
		assert.deepEqual(scoreFuzzy('xİb', 'b', 'b', true)[1], [2]);
		assert.deepEqual(scoreFuzzy('ΟΣ', 'ος', 'ος', true)[1], [0, 1]);
	});

	test('large inputs retain complete matches and reject late failures without a scoring matrix', () => {
		const prefix = 'x'.repeat(50_000);
		const query = 'a'.repeat(1_024);
		const target = prefix + query;
		const expected = Array.from({ length: query.length }, (_, index) => prefix.length + index);
		assert.deepEqual(scoreFuzzy(target, query, query, true)[1], expected);
		assert.deepEqual(scoreFuzzy(target, query, query, false)[1], expected);
		assert.deepEqual(scoreFuzzy(target, query + 'b', query + 'b', true), [0, []]);
		assert.deepEqual(scoreFuzzy(target, query + 'b', query + 'b', false), [0, []]);
		const repeated = 'a'.repeat(50_000);
		assert.deepEqual(scoreFuzzy(repeated, query + 'b', query + 'b', false), [0, []]);
		assert.deepEqual(scoreFuzzy(repeated + 'b', query + 'b', query + 'b', false)[1], Array.from({ length: query.length + 1 }, (_, index) => repeated.length - query.length + index));
		assert.deepEqual(scoreFuzzy(prefix + 'İ😀', 'i😀', 'i😀', true)[1], [prefix.length, prefix.length + 1, prefix.length + 2]);
	});

	test('breaks equal alignment scores by their earliest ending position', () => {
		assert.deepEqual(scoreFuzzy('ab ab', 'ab', 'ab', true)[1], [0, 1]);
	});
});
