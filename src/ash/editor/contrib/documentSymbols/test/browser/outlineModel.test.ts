import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Range } from '../../../../common/core/range.js';
import type { LanguageDocumentSymbol } from '../../../../common/languages.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { LanguageFeaturesService } from '../../../../common/services/languageFeaturesService.js';
import { OutlineModel } from '../../browser/outlineModel.js';

suite('OutlineModel', () => {
	test('groups every provider and sorts flattened symbols by document position', async () => {
		using model = new TextModel('first second\nnested', { languageId: 'typescript' });
		using features = new LanguageFeaturesService();
		using first = features.documentSymbolProvider.register('*', {
			provideDocumentSymbols: () => [symbol('second', 1, 7, 1, 13)],
		});
		using second = features.documentSymbolProvider.register('*', {
			provideDocumentSymbols: () => [{ ...symbol('first', 1, 1, 2, 7), children: [symbol('nested', 2, 1, 2, 7)] }],
		});
		const errors: unknown[] = [];
		const outline = await OutlineModel.create(features.documentSymbolProvider, model, new AbortController().signal, error => errors.push(error));
		assert.ok(outline);
		assert.deepEqual({
			groups: outline.children.size,
			topLevel: outline.getTopLevelSymbols().map(entry => entry.name),
			flattened: outline.asListOfDocumentSymbols().map(entry => entry.name),
			parents: [...outline.children.values()].every(group => [...group.children.values()].every(entry => entry.parent === group)),
			errors,
		}, { groups: 2, topLevel: ['first', 'second'], flattened: ['first', 'second', 'nested'], parents: true, errors: [] });
	});

	test('cancels concurrent providers and rejects their late results', async () => {
		using model = new TextModel('first second');
		using features = new LanguageFeaturesService();
		const pending: Array<(symbols: readonly LanguageDocumentSymbol[]) => void> = [];
		const provider = {
			provideDocumentSymbols: () => new Promise<readonly LanguageDocumentSymbol[]>(resolve => pending.push(resolve)),
		};
		using first = features.documentSymbolProvider.register('*', provider);
		using second = features.documentSymbolProvider.register('*', provider);
		const controller = new AbortController();
		const outline = OutlineModel.create(features.documentSymbolProvider, model, controller.signal, error => { throw error; });
		assert.equal(pending.length, 2);
		controller.abort();
		for (const finish of pending) finish([symbol('first', 1, 1, 1, 6)]);
		assert.equal(await outline, null);
	});

	test('keeps separate groups when one provider is registered twice', async () => {
		using model = new TextModel('first');
		using features = new LanguageFeaturesService();
		const provider = { provideDocumentSymbols: () => [symbol('first', 1, 1, 1, 6)] };
		using first = features.documentSymbolProvider.register('*', provider);
		using second = features.documentSymbolProvider.register('*', provider);
		const outline = await OutlineModel.create(features.documentSymbolProvider, model, new AbortController().signal, error => { throw error; });
		assert.equal(outline?.children.size, 2);
	});

	test('keeps a valid provider when another provider fails', async () => {
		using model = new TextModel('first');
		using features = new LanguageFeaturesService();
		const failure = new Error('provider failed');
		using valid = features.documentSymbolProvider.register('*', {
			provideDocumentSymbols: () => [symbol('first', 1, 1, 1, 6)],
		});
		using broken = features.documentSymbolProvider.register('*', {
			provideDocumentSymbols: () => { throw failure; },
		});
		const errors: unknown[] = [];
		const outline = await OutlineModel.create(features.documentSymbolProvider, model, new AbortController().signal, error => errors.push(error));
		assert.deepEqual({ symbols: outline?.getTopLevelSymbols().map(entry => entry.name), errors }, { symbols: ['first'], errors: [failure] });
	});
});

function symbol(name: string, startLine: number, startColumn: number, endLine: number, endColumn: number): LanguageDocumentSymbol {
	const range = new Range(startLine, startColumn, endLine, endColumn);
	return { name, kind: 'function', range, selectionRange: range };
}
