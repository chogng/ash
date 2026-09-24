import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { Range } from '../../../../../editor/common/core/range.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { OutlineModel } from '../../../../../editor/contrib/documentSymbols/browser/outlineModel.js';
import { FoldingRangeService } from '../../../../../editor/contrib/folding/common/languageFoldingRanges.js';
import { createLanguageFeatureRequest } from '../../../../../editor/common/languages.js';
import { TestLanguageFeaturesService as LanguageFeaturesService } from '../../../../../editor/test/common/testLanguageFeaturesService.js';
import { AppServerSyntaxProviders, syntaxLanguageForEditorLanguage } from '../../browser/appServerSyntaxProviders.js';
import { createSyntaxWorker, SyntaxProviderWorker } from '../../../../../editor/common/services/editorWebWorker.js';

test('Frontend tokens remain independent of App Server diagnostics, symbols, folds, and selection ranges', async () => {
	using model = new TextModel('fn main() {\n  /* hi\n  */\n}\n', { languageId: 'rust' });
	using languages = new LanguageFeaturesService();
	let analyzeCalls = 0;
	let selectionCalls = 0;
	let workerCalls = 0;
	const closed: string[] = [];
	using providers = new AppServerSyntaxProviders(languages, {
		generation: 1,
		open: async () => {},
		update: async () => {},
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
		close: async params => { closed.push(params.documentId); },
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
	using folding = new FoldingRangeService(model, languages.foldingRangeProvider);
	using diagnosticsWorker = new SyntaxProviderWorker(languages.syntaxProvider, undefined, undefined, model);

	const tokens = await syntax.run({ requestId: 1, lane: 'tokens', payload: { languageId: 'rust' }, snapshot: model.createVersionedSnapshot() }, new AbortController().signal);
	assert.equal(analyzeCalls, 0, 'Lexical tokens must not request backend analysis');
	assert.equal(workerCalls, 1);
	const diagnostics = await diagnosticsWorker.run({ requestId: 2, lane: 'diagnostics', payload: { languageId: 'rust' }, snapshot: model.createVersionedSnapshot() }, new AbortController().signal);
	assert.equal(tokens.lane, 'tokens');
	assert.equal(diagnostics.lane, 'diagnostics');
	if (tokens.lane !== 'tokens' || diagnostics.lane !== 'diagnostics') throw new Error('Unexpected lane');
	const outline = await OutlineModel.create(languages.documentSymbolProvider, model, new AbortController().signal, error => { throw error; });
	const documentSymbols = outline?.getTopLevelSymbols() ?? [];
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
	model.dispose();
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(closed, [model.id]);
});

test('App Server syntax maps only supported editor languages', () => {
	assert.equal(syntaxLanguageForEditorLanguage('javascriptreact'), 'javascriptreact');
	assert.equal(syntaxLanguageForEditorLanguage('rust'), 'rust');
	assert.equal(syntaxLanguageForEditorLanguage('typescriptreact'), 'typescriptreact');
	assert.equal(syntaxLanguageForEditorLanguage('shellscript'), 'shell');
	assert.equal(syntaxLanguageForEditorLanguage('shell'), undefined);
	assert.equal(syntaxLanguageForEditorLanguage('markdown'), undefined);
});

test('App Server parser sessions follow each model revision and release independently', async () => {
	using first = new TextModel('fn first() {}\n', { languageId: 'rust' });
	using second = new TextModel('fn second() {}\n', { languageId: 'rust' });
	using languages = new LanguageFeaturesService();
	const requests: { documentId: string; revision: number }[] = [];
	const opened: { documentId: string; revision: number; text: string }[] = [];
	const updated: { documentId: string; previousRevision: number; revision: number; text: string }[] = [];
	const closed: string[] = [];
	using providers = new AppServerSyntaxProviders(languages, {
		generation: 1,
		open: async params => { opened.push({ documentId: params.documentId, revision: params.revision, text: params.text }); },
		update: async params => { updated.push({ documentId: params.documentId, previousRevision: params.previousRevision, revision: params.revision, text: params.edits[0]?.text ?? '' }); },
		analyze: async params => {
			requests.push({ documentId: params.documentId, revision: params.revision });
			return { revision: params.revision, hasErrors: false, tokens: [], foldingRanges: [], symbols: [], diagnostics: [] };
		},
		selectionRanges: async params => ({ revision: params.revision, ranges: [] }),
		close: async params => { closed.push(params.documentId); },
	});
	const signal = new AbortController().signal;
	const symbols = async (model: TextModel): Promise<void> => {
		const provider = languages.documentSymbolProvider.ordered(model)[0]!;
		await provider.provideDocumentSymbols(createLanguageFeatureRequest(model, model.getLanguageId(), signal), signal);
	};

	await symbols(first);
	await symbols(second);
	await symbols(first);
	first.setValue('fn renamed() {}\n');
	await symbols(first);
	assert.deepEqual(requests, [
		{ documentId: first.id, revision: 1 },
		{ documentId: second.id, revision: 1 },
		{ documentId: first.id, revision: first.version },
	]);
	assert.deepEqual(opened, [
		{ documentId: first.id, revision: 1, text: 'fn first() {}\n' },
		{ documentId: second.id, revision: 1, text: 'fn second() {}\n' },
	]);
	assert.deepEqual(updated, [{ documentId: first.id, previousRevision: 1, revision: first.version, text: 'fn renamed() {}\n' }]);
	first.dispose();
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(closed, [first.id]);
	await symbols(second);
	second.dispose();
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(closed, [first.id, second.id]);
});

test('Selection-only parser sessions close with their editor model', async () => {
	using model = new TextModel('fn selected() {}\n', { languageId: 'rust' });
	using languages = new LanguageFeaturesService();
	const selected: { documentId: string; revision: number; text: string }[] = [];
	const closed: string[] = [];
	using providers = new AppServerSyntaxProviders(languages, {
		generation: 1,
		open: async () => {},
		update: async () => {},
		analyze: async () => { throw new Error('Selection must not request full analysis'); },
		selectionRanges: async params => {
			selected.push({ documentId: params.documentId, revision: params.revision, text: '' });
			return { revision: params.revision, ranges: [] };
		},
		close: async params => { closed.push(params.documentId); },
	});
	const signal = new AbortController().signal;
	const provider = languages.selectionRangeProvider.ordered(model)[0]!;
	const stale = createLanguageFeatureRequest(model, model.getLanguageId(), signal);
	model.setValue('fn renamed() {}\n');
	await provider.provideSelectionRanges({
		...createLanguageFeatureRequest(model, model.getLanguageId(), signal),
		ranges: [new Range(1, 4, 1, 12)],
	}, signal);
	await provider.provideSelectionRanges({ ...stale, ranges: [new Range(1, 4, 1, 12)] }, signal);
	await languages.documentSymbolProvider.ordered(model)[0]!.provideDocumentSymbols(stale, signal);
	assert.deepEqual(selected, [{ documentId: model.id, revision: model.version, text: '' }]);
	model.dispose();
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(closed, [model.id]);
});

test('oversized intermediate revisions reopen from the current bounded snapshot', async () => {
	using model = new TextModel('fn initial() {}\n', { languageId: 'rust' });
	using languages = new LanguageFeaturesService();
	const opened: string[] = [];
	let updates = 0;
	using providers = new AppServerSyntaxProviders(languages, {
		generation: 1,
		open: async params => { opened.push(params.text); },
		update: async () => { updates += 1; },
		analyze: async params => ({ revision: params.revision, hasErrors: false, tokens: [], foldingRanges: [], symbols: [], diagnostics: [] }),
		selectionRanges: async params => ({ revision: params.revision, ranges: [] }),
		close: async () => {},
	});
	const signal = new AbortController().signal;
	const provider = languages.documentSymbolProvider.ordered(model)[0]!;
	const request = () => provider.provideDocumentSymbols(createLanguageFeatureRequest(model, model.getLanguageId(), signal), signal);
	await request();
	model.setValue('x'.repeat(4 * 1024 * 1024 + 1));
	model.setValue('fn compact() {}\n');
	await request();
	assert.deepEqual(opened, ['fn initial() {}\n', 'fn compact() {}\n']);
	assert.equal(updates, 0);
});
