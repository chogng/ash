import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { Range } from '../../../../../editor/common/core/range.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { DocumentSymbolService } from '../../../../../editor/contrib/documentSymbols/common/languageDocumentSymbols.js';
import { FoldingRangeService } from '../../../../../editor/contrib/folding/common/languageFoldingRanges.js';
import { createLanguageFeatureRequest } from '../../../../../editor/common/languages.js';
import { TestLanguageFeaturesService as LanguageFeaturesService } from '../../../../../editor/test/common/testLanguageFeaturesService.js';
import { AppServerSyntaxProviders, syntaxLanguageForEditorLanguage } from '../../browser/appServerSyntaxProviders.js';
import { createSyntaxWorker } from '../../../../../editor/common/services/editorWebWorker.js';

test('Frontend tokens remain independent of App Server diagnostics, symbols, folds, and selection ranges', async () => {
	using model = new TextModel('fn main() {\n  /* hi\n  */\n}\n', { languageId: 'rust' });
	using languages = new LanguageFeaturesService();
	let analyzeCalls = 0;
	let selectionCalls = 0;
	let workerCalls = 0;
	using providers = new AppServerSyntaxProviders(languages, {
		analyze: async params => {
			analyzeCalls += 1;
			return {
				revision: params.revision,
				hasErrors: true,
				tokens: [
					{ kind: 'variable', range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 7 } } },
					{ kind: 'keyword', range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 2 } } },
					{ kind: 'function', range: { start: { lineIndex: 0, columnIndex: 3 }, end: { lineIndex: 0, columnIndex: 7 } } },
					{ kind: 'comment', range: { start: { lineIndex: 1, columnIndex: 2 }, end: { lineIndex: 2, columnIndex: 4 } } },
				],
				foldingRanges: [{ range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 3, columnIndex: 1 } } }],
				symbols: [{ name: 'main', kind: 'function', range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 3, columnIndex: 1 } }, selectionRange: { start: { lineIndex: 0, columnIndex: 3 }, end: { lineIndex: 0, columnIndex: 7 } } }],
				diagnostics: [{ kind: 'missing', range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 2 } } }],
			};
		},
		selectionRanges: async params => {
			selectionCalls += 1;
			return { revision: params.revision, ranges: [{ range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 3, columnIndex: 1 } } }] };
		},
	});
	using syntax = createSyntaxWorker(languages.syntaxProvider, {
		workerFactory: () => ({
			run: async request => {
				workerCalls += 1;
				return request.lane === 'tokens' ? { lane: 'tokens' as const, value: { tokens: [{ range: new Range(1, 1, 1, 3), tokenType: 'keyword', modifiers: [] }] } } : { lane: 'diagnostics' as const, value: { diagnostics: [] } };
			},
			dispose() {},
			[Symbol.dispose]() {},
		}),
	});
	using symbols = new DocumentSymbolService(model, languages.documentSymbolProvider);
	using folding = new FoldingRangeService(model, languages.foldingRangeProvider);

	const tokens = await syntax.run({ requestId: 1, lane: 'tokens', payload: { languageId: 'rust' }, snapshot: model.createVersionedSnapshot() }, new AbortController().signal);
	assert.equal(analyzeCalls, 0, 'Lexical tokens must not request backend analysis');
	assert.equal(workerCalls, 1);
	const diagnostics = await syntax.run({ requestId: 2, lane: 'diagnostics', payload: { languageId: 'rust' }, snapshot: model.createVersionedSnapshot() }, new AbortController().signal);
	assert.equal(tokens.lane, 'tokens');
	assert.equal(diagnostics.lane, 'diagnostics');
	if (tokens.lane !== 'tokens' || diagnostics.lane !== 'diagnostics') throw new Error('Unexpected lane');
	const documentSymbols = await symbols.provideDocumentSymbols('rust');
	const foldingRanges = await folding.provideFoldingRanges('rust');
	const signal = new AbortController().signal;
	const structural = await languages.selectionRangeProvider.ordered(model)[0]!.provideSelectionRanges({
		...createLanguageFeatureRequest(model, model.getLanguageId(), signal),
		ranges: [new Range(1, 4, 1, 8)],
	}, signal);

	assert.equal(analyzeCalls, 1);
	assert.equal(workerCalls, 1);
	assert.deepEqual(tokens.value.tokens.map(token => [token.range.getStartPosition().lineNumber, token.range.getStartPosition().column, token.range.getEndPosition().lineNumber, token.range.getEndPosition().column, token.tokenType]), [
		[1, 1, 1, 3, 'keyword'],
	]);
	assert.ok(diagnostics.value.diagnostics.some(diagnostic => diagnostic.code === 'syntax-missing' && diagnostic.source === 'ash-syntax'));
	assert.deepEqual(documentSymbols.map(symbol => [symbol.name, symbol.kind]), [['main', 'function']]);
	assert.deepEqual(foldingRanges, [{ startLineIndex: 0, endLineIndex: 3 }]);
	assert.equal(model.getTextInRange(structural[0]!), 'fn main() {\n  /* hi\n  */\n}');
	assert.equal(selectionCalls, 1);
});

test('App Server syntax maps only supported editor languages', () => {
	assert.equal(syntaxLanguageForEditorLanguage('javascriptreact'), 'javascriptreact');
	assert.equal(syntaxLanguageForEditorLanguage('rust'), 'rust');
	assert.equal(syntaxLanguageForEditorLanguage('typescriptreact'), 'typescriptreact');
	assert.equal(syntaxLanguageForEditorLanguage('shellscript'), 'shell');
	assert.equal(syntaxLanguageForEditorLanguage('shell'), undefined);
	assert.equal(syntaxLanguageForEditorLanguage('markdown'), undefined);
});
