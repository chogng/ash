import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Range } from '../../../../common/core/range.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { TestLanguageConfigurationService } from '../../../../test/common/modes/testLanguageConfigurationService.js';
import { registerTestTokens } from '../../../../test/common/testTokenization.js';
import { computeEditorLanguageFoldingRanges, mergeEditorFoldingRanges } from '../../browser/syntaxRangeProvider.js';

test('syntax folding merge keeps deterministic nested and disjoint ranges', () => {
	const merged = mergeEditorFoldingRanges(
		[{ startLineIndex: 0, endLineIndex: 5 }, { startLineIndex: 8, endLineIndex: 9 }],
		[{ startLineIndex: 1, endLineIndex: 3 }, { startLineIndex: 2, endLineIndex: 6 }],
	);
	assert.deepEqual(merged.map(range => [range.startLineIndex, range.endLineIndex]), [[0, 5], [1, 3], [8, 9]]);
});

test('structural folding uses model brackets and grammar comments alongside region markers', async () => {
	using configurations = new TestLanguageConfigurationService();
	using configuration = configurations.register('typescript', {
		brackets: [['{', '}'], ['[', ']'], ['(', ')']],
		comments: { blockComment: ['/*', '*/'] },
		folding: { markers: { start: /^\/\/ region/u, end: /^\/\/ endregion/u } },
	});
	using tokens = registerTestTokens(new Map([
		['"}"', [{ offset: 0, type: 'string' }]],
		['/* {', [{ offset: 0, type: 'comment' }]],
		[' */', [{ offset: 0, type: 'comment' }]],
	]));
	using model = new TextModel('{\n"}"\n}\n/* {\n */\n// region\nvalue\n// endregion\n(\nvalue\n)', {
		languageId: 'typescript', languageConfigurationService: configurations,
	});
	await new Promise(resolve => setImmediate(resolve));

	const ranges = computeEditorLanguageFoldingRanges(model, 'typescript', configurations);
	assert.deepEqual(ranges.map(range => [range.startLineIndex, range.endLineIndex]), [[0, 2], [3, 4], [5, 7]]);
});

test('structural folding follows newly registered tokens instead of retaining a second bracket index', async () => {
	using configurations = new TestLanguageConfigurationService();
	using configuration = configurations.register('typescript', { brackets: [['{', '}']] });
	using model = new TextModel('{\n"}"\n}', { languageId: 'typescript', languageConfigurationService: configurations });
	const ranges = () => computeEditorLanguageFoldingRanges(model, 'typescript', configurations).map(range => [range.startLineIndex, range.endLineIndex]);
	assert.deepEqual(ranges(), [[0, 1]]);

	using tokens = registerTestTokens(new Map([['"}"', [{ offset: 0, type: 'string' }]]]));
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(ranges(), [[0, 2]]);
});

test('token change listeners see bracket ranges for the edited text immediately', async () => {
	using configurations = new TestLanguageConfigurationService();
	using configuration = configurations.register('typescript', { brackets: [['{', '}']] });
	using tokens = registerTestTokens(new Map());
	using model = new TextModel('prefix {\n}', { languageId: 'typescript', languageConfigurationService: configurations });
	await new Promise(resolve => setImmediate(resolve));
	model.bracketPairs.getBracketPairsInRange(model.getFullModelRange()).toArray();
	const observations: number[][] = [];
	using listener = model.onDidChangeTokens(() => {
		observations.push(computeEditorLanguageFoldingRanges(model, 'typescript', configurations).map(range => range.endLineIndex));
	});

	model.applyEdits([{ range: new Range(1, 1, 1, 8), text: '' }]);
	await new Promise(resolve => setImmediate(resolve));
	assert.ok(observations.length > 0);
	assert.ok(observations.every(ranges => ranges.length === 1 && ranges[0] === 1));
});
