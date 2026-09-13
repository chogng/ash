import assert from 'node:assert/strict';
import { test } from 'mocha';
import { mergeEditorFoldingRanges } from '../../browser/syntaxRangeProvider.js';

test('syntax folding merge keeps deterministic nested and disjoint ranges', () => {
	const merged = mergeEditorFoldingRanges(
		[{ startLineIndex: 0, endLineIndex: 5 }, { startLineIndex: 8, endLineIndex: 9 }],
		[{ startLineIndex: 1, endLineIndex: 3 }, { startLineIndex: 2, endLineIndex: 6 }],
	);
	assert.deepEqual(merged.map(range => [range.startLineIndex, range.endLineIndex]), [[0, 5], [1, 3], [8, 9]]);
});
