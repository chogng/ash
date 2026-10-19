import { registerTestCodeEditorFeatures } from '../../../../../../../test/fixtures/codeEditorFeatures.js';
import { after as afterCodeFeatures } from 'mocha';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Range } from '../../../../common/core/range.js';
import type { LanguageDocumentSymbol } from '../../../../common/languages.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { LanguageFeaturesService } from '../../../../common/services/languageFeaturesService.js';
import { OutlineModel } from '../../../../../../../extensions/code/browser/contrib/documentSymbols/browser/outlineModel.js';

suite('OutlineModel', () => {
	test('large outlines allow an edit to cancel conversion before any stale tree is published', async () => {
		using model = new TextModel('x\n'.repeat(5000), { languageId: 'typescript' });
		using features = new LanguageFeaturesService();
		using provider = features.documentSymbolProvider.register('*', { provideDocumentSymbols: () => Array.from({ length: 5000 }, (_, index) => symbol(`item${index}`, index + 1, 1, index + 1, 2)) });
		const timer = setTimeout(() => model.applyEdits([{ range: new Range(1, 1, 1, 1), text: 'y' }]), 0);
		try {
			assert.equal(await OutlineModel.create(features.documentSymbolProvider, model, new AbortController().signal, error => { throw error; }), null);
			const current = await OutlineModel.create(features.documentSymbolProvider, model, new AbortController().signal, error => { throw error; });
			assert.equal(current?.version, model.version);
			assert.equal(current?.asListOfDocumentSymbols().length, 5000);
		} finally { clearTimeout(timer); }
	});
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

	test('thousands of repeated labels retain unique stable identities alongside literal suffix names', async () => {
		using model = new TextModel('x\n'.repeat(10_004));
		using features = new LanguageFeaturesService();
		const names = ['section', 'section_1', 'section', 'section_2', ...Array<string>(10_000).fill('section')];
		using provider = features.documentSymbolProvider.register('*', { provideDocumentSymbols: () => names.map((name, index) => symbol(name, index + 1, 1, index + 1, 2)) });
		const create = () => OutlineModel.create(features.documentSymbolProvider, model, new AbortController().signal, error => { throw error; });
		const first = await create();
		const second = await create();
		const ids = (outline: OutlineModel) => [...outline.children.values()].flatMap(group => [...group.children.keys()]);
		assert.ok(first && second);
		const actual = ids(first);
		assert.equal(actual.length, names.length);
		assert.equal(new Set(actual).size, names.length);
		assert.deepEqual(actual, ids(second));
		assert.deepEqual(actual.slice(0, 4).map(id => id.slice(id.lastIndexOf('/') + 1)), ['section', 'section_1', 'section_2', 'section_2_1']);
		assert.deepEqual(first.asListOfDocumentSymbols().map(symbol => symbol.name), names);
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

const codeFeatures = registerTestCodeEditorFeatures();
afterCodeFeatures(() => codeFeatures.dispose());
