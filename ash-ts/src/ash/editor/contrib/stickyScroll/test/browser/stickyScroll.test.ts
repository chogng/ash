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
		this.provider = this._register(this.services.createInstance(StickyModelProvider, editor, this.folding));
	}
}
