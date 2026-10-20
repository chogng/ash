import assert from 'node:assert/strict';
import { test } from 'mocha';
import { TextModel } from '../../../../common/model/textModel.js';
import { EditorFoldingRangeSource, normalizeEditorFoldingRanges } from '../../browser/foldingRanges.js';

test('folding ranges are sorted, deduplicated, and given provider defaults', () => {
	using model = new TextModel('a\nb\nc\nd');
	const ranges = normalizeEditorFoldingRanges(model, [
		{ startLineIndex: 1, endLineIndex: 2 },
		{ startLineIndex: 0, endLineIndex: 3, collapsed: true, source: EditorFoldingRangeSource.Manual },
		{ startLineIndex: 1, endLineIndex: 2 },
	]);
	assert.deepEqual(ranges, [
		{ startLineIndex: 0, endLineIndex: 3, collapsed: true, source: EditorFoldingRangeSource.Manual },
		{ startLineIndex: 1, endLineIndex: 2, collapsed: false, source: EditorFoldingRangeSource.Provider },
	]);
});

test('crossing folding ranges are rejected', () => {
	using model = new TextModel('a\nb\nc\nd');
	assert.throws(() => normalizeEditorFoldingRanges(model, [
		{ startLineIndex: 0, endLineIndex: 2 },
		{ startLineIndex: 1, endLineIndex: 3 },
	]), /nested or disjoint/u);
});
