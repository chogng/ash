import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import type { ICodeEditor } from '../../../../browser/editorBrowser.js';
import { EditorOption, type EditorStickyScrollOptions } from '../../../../common/config/editorOptions.js';
import { Range } from '../../../../common/core/range.js';
import type { LanguageDocumentSymbol } from '../../../../common/languages.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { ILanguageFeaturesService } from '../../../../common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../../../common/services/languageFeaturesService.js';
import { EditorFoldingModel } from '../../../folding/browser/foldingModel.js';
import { StickyModelProvider } from '../../browser/stickyScrollModelProvider.js';

suite('Sticky scroll scope sources', () => {
	test('folding ancestors retain one-based bounds and parent ownership', async () => {
		using fixture = new Fixture();
		fixture.folding.setRanges([{ startLineIndex: 0, endLineIndex: 4 }, { startLineIndex: 1, endLineIndex: 3 }]);
		const model = await fixture.provider.update(CancellationToken.None);
		const outer = model!.element!.children[0]!;
		const inner = outer.children[0]!;
		assert.deepEqual([outer.range, inner.range].map(range => [range!.startLineNumber, range!.endLineNumber]), [[1, 6], [2, 5]]);
		assert.equal(inner.parent, outer);
	});

	test('outline headers start at the declaration and keep the innermost end separate', async () => {
		using fixture = new Fixture();
		using registration = fixture.features.documentSymbolProvider.register('*', {
			provideDocumentSymbols: () => [{
				name: 'scope', kind: 'class', range: new Range(1, 1, 7, 2), selectionRange: new Range(2, 1, 2, 6),
				children: [{ name: 'body', kind: 'function', range: new Range(2, 1, 5, 2), selectionRange: new Range(3, 1, 3, 2) }],
			}],
		});
		const model = await fixture.provider.update(CancellationToken.None);
		const outer = model!.element!.children[0]!;
		assert.deepEqual([outer.range, outer.children[0]!.range].map(range => [range!.startLineNumber, range!.endLineNumber]), [[2, 7], [3, 5]]);
	});

	test('outline selection compares total scope coverage including nested symbols', async () => {
		using fixture = new Fixture();
		using nested = fixture.features.documentSymbolProvider.register('*', {
			provideDocumentSymbols: () => [{ ...symbol(2, 7), children: [symbol(3, 6)] }],
		});
		using flat = fixture.features.documentSymbolProvider.register('*', {
			provideDocumentSymbols: () => [symbol(1, 7)],
		});
		const model = await fixture.provider.update(CancellationToken.None);
		const outer = model!.element!.children[0]!;
		assert.deepEqual([outer.range, outer.children[0]!.range].map(range => [range!.startLineNumber, range!.endLineNumber]), [[2, 7], [3, 6]]);
	});

	test('outline selection keeps its provider across refreshes and selects again after removal', async () => {
		using fixture = new Fixture();
		using smaller = fixture.features.documentSymbolProvider.register('*', {
			provideDocumentSymbols: () => [symbol(3, 5)],
		});
		using original = fixture.features.documentSymbolProvider.register('*', {
			provideDocumentSymbols: () => [symbol(2, 7)],
		});
		const first = await fixture.provider.update(CancellationToken.None);
		using added = fixture.features.documentSymbolProvider.register('*', {
			provideDocumentSymbols: () => [symbol(1, 7)],
		});
		fixture.model.applyEdits([{ range: new Range(1, 1, 1, 1), text: 'changed ' }]);
		const refreshed = await fixture.provider.update(CancellationToken.None);
		assert.equal(refreshed!.outlineProviderId, first!.outlineProviderId);
		assert.equal(refreshed!.element!.children[0]!.range!.startLineNumber, 2);
		original.dispose();
		const replaced = await fixture.provider.update(CancellationToken.None);
		assert.notEqual(replaced!.outlineProviderId, first!.outlineProviderId);
		assert.equal(replaced!.element!.children[0]!.range!.startLineNumber, 1);
	});

	test('a single outline does not preselect the winner before competing providers arrive', async () => {
		using fixture = new Fixture();
		using original = fixture.features.documentSymbolProvider.register('*', { provideDocumentSymbols: () => [symbol(2, 7)] });
		const single = await fixture.provider.update(CancellationToken.None);
		using added = fixture.features.documentSymbolProvider.register('*', { provideDocumentSymbols: () => [symbol(1, 7)] });
		const competing = await fixture.provider.update(CancellationToken.None);
		assert.equal(single!.outlineProviderId, undefined);
		assert.equal(competing!.element!.children[0]!.range!.startLineNumber, 1);
	});

	test('an empty or failed outline provider does not discard another providers scopes', async () => {
		using fixture = new Fixture();
		const failure = new Error('Symbol provider failed');
		using valid = fixture.features.documentSymbolProvider.register('*', {
			provideDocumentSymbols: () => [symbol(2, 7)],
		});
		using failed = fixture.features.documentSymbolProvider.register('*', {
			provideDocumentSymbols: () => { throw failure; },
		});
		using empty = fixture.features.documentSymbolProvider.register('*', {
			provideDocumentSymbols: () => [],
		});
		const model = await fixture.provider.update(CancellationToken.None);
		assert.deepEqual({ starts: model!.element!.children.map(child => child.range!.startLineNumber), errors: fixture.errors }, { starts: [2], errors: [failure] });
	});

	for (const source of ['outlineModel', 'foldingProviderModel'] as const) {
		test(`${source} selects folding ranges, then indentation when no source supplies ranges`, async () => {
			using fixture = new Fixture(source);
			let requests = 0;
			using empty = fixture.features.documentSymbolProvider.register('*', {
				provideDocumentSymbols: () => {
					requests++;
					return [];
				},
			});
			fixture.folding.setRanges([{ startLineIndex: 0, endLineIndex: 5 }]);
			const folded = await fixture.provider.update(CancellationToken.None);
			fixture.folding.setRanges([]);
			const indented = await fixture.provider.update(CancellationToken.None);
			assert.deepEqual({
				folded: folded!.element!.children.map(child => child.range!.startLineNumber),
				indented: indented!.element!.children.map(child => child.range!.startLineNumber),
				providerIds: [folded!.outlineProviderId, indented!.outlineProviderId],
				requests,
			}, { folded: [1], indented: [2], providerIds: [undefined, undefined], requests: source === 'outlineModel' ? 2 : 0 });
		});
	}

	test('an empty preferred outline provider yields to a remaining nonempty provider', async () => {
		using fixture = new Fixture();
		let original: readonly LanguageDocumentSymbol[] = [symbol(1, 7)];
		using first = fixture.features.documentSymbolProvider.register('*', { provideDocumentSymbols: () => original });
		using second = fixture.features.documentSymbolProvider.register('*', { provideDocumentSymbols: () => [symbol(2, 7)] });
		const before = await fixture.provider.update(CancellationToken.None);
		original = [];
		const after = await fixture.provider.update(CancellationToken.None);
		assert.deepEqual([before, after].map(model => model!.element!.children[0]!.range!.startLineNumber), [1, 2]);
	});

	test('overlapping updates cancel all previous providers and keep the newer selection', async () => {
		using fixture = new Fixture();
		const pending: { signal: AbortSignal; finish: (symbols: readonly LanguageDocumentSymbol[]) => void }[] = [];
		using first = fixture.features.documentSymbolProvider.register('*', {
			provideDocumentSymbols: request => new Promise(resolve => { pending.push({ signal: request.signal, finish: resolve }); }),
		});
		using second = fixture.features.documentSymbolProvider.register('*', {
			provideDocumentSymbols: request => new Promise(resolve => { pending.push({ signal: request.signal, finish: resolve }); }),
		});
		const previous = fixture.provider.update(CancellationToken.None);
		assert.equal(pending.length, 2);
		const current = fixture.provider.update(CancellationToken.None);
		assert.deepEqual(pending.map(request => request.signal.aborted), [true, true, false, false]);
		pending[2]!.finish([]);
		pending[3]!.finish([symbol(2, 7)]);
		const model = await current;
		pending[0]!.finish([symbol(1, 7)]);
		pending[1]!.finish([]);
		assert.equal(await previous, null);
		assert.equal(model!.element!.children[0]!.range!.startLineNumber, 2);
		assert.deepEqual(fixture.errors, []);
	});

	test('cancellation reaches a waiting symbol provider and its late result is discarded', async () => {
		using fixture = new Fixture();
		let finish!: (symbols: readonly LanguageDocumentSymbol[]) => void;
		let signal!: AbortSignal;
		using registration = fixture.features.documentSymbolProvider.register('*', {
			provideDocumentSymbols: request => {
				signal = request.signal;
				return new Promise(resolve => { finish = resolve; });
			},
		});
		using cancellation = new CancellationTokenSource();
		const pending = fixture.provider.update(cancellation.token);
		cancellation.cancel();
		finish([]);
		assert.equal(await pending, null);
		assert.equal(signal.aborted, true);
	});

	test('indentation selection ignores registered symbols and works with folding disabled', async () => {
		using fixture = new Fixture('indentationModel', false);
		using registration = fixture.features.documentSymbolProvider.register('*', {
			provideDocumentSymbols: () => { throw new Error('Outline must not be requested'); },
		});
		const model = await fixture.provider.update(CancellationToken.None);
		assert.deepEqual(model!.element!.children.map(child => [child.range!.startLineNumber, child.range!.endLineNumber]), [[2, 5]]);
	});
});

class Fixture extends Disposable {
	public readonly model = this._register(new TextModel('comment\nouter\n  body\n  last\n}\nmore\n}'));
	public readonly folding = this._register(new EditorFoldingModel(this.model));
	private readonly services = this._register(new ServiceContainer());
	public readonly features = this._register(new LanguageFeaturesService());
	public readonly provider: StickyModelProvider;
	public readonly errors: unknown[] = [];

	constructor(source: EditorStickyScrollOptions['defaultModel'] = 'outlineModel', folding = true) {
		super();
		this.services.registerInstance(ILanguageFeaturesService, this.features);
		const editor = {
			getOption: (option: EditorOption) => {
				if (option === EditorOption.stickyScroll) return { defaultModel: source };
				assert.equal(option, EditorOption.folding);
				return folding;
			},
		} as unknown as ICodeEditor;
		this.provider = this._register(this.services.createInstance(StickyModelProvider, editor, this.folding, (error: unknown) => this.errors.push(error)));
	}
}

function symbol(start: number, end: number): LanguageDocumentSymbol {
	return { name: 'scope', kind: 'function', range: new Range(start, 1, end, 2), selectionRange: new Range(start, 1, start, 2) };
}
