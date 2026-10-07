import assert from 'node:assert/strict';
import { test } from 'mocha';
import { TextModel } from '../../../../common/model/textModel.js';
import { computeEditorIndentFoldingRanges } from '../../browser/indentRangeProvider.js';

test('indent folding closes nested blocks at the first peer line', () => {
	using model = new TextModel('root\n  child\n    leaf\n  peer\nafter');
	assert.deepEqual(computeEditorIndentFoldingRanges(model), [
		{ startLineIndex: 1, endLineIndex: 2, collapsed: false, source: 'provider' },
		{ startLineIndex: 0, endLineIndex: 3, collapsed: false, source: 'provider' },
	]);
});

test('indent folding validates tab size', () => {
	using model = new TextModel('a\n\tb');
	assert.throws(() => computeEditorIndentFoldingRanges(model, { tabSize: 0 }), RangeError);
});
