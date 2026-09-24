import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { h } from '../../../../base/browser/dom.js';
import { type CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { type IDocumentDiff, type IDocumentDiffProvider, type IDocumentDiffProviderOptions } from '../../../common/diff/documentDiffProvider.js';
import { DefaultLinesDiffComputer } from '../../../common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';
import { type ITextModel } from '../../../common/model.js';
import { TextModel } from '../../../common/model/textModel.js';
import { DocumentDiffItem, MultiDiffEditorModel, type IDocumentDiffItem } from '../../../browser/widget/multiDiffEditor/model.js';
import { installEditorTestDom } from '../editorTestGlobals.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
browserEnvironment.window.HTMLCanvasElement.prototype.getContext = () => null;
class TestResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const installedGlobals = installEditorTestDom(browserEnvironment, [
	'Node', 'Element', 'HTMLElement', 'Event', 'KeyboardEvent',
], { ResizeObserver: TestResizeObserver });

const { DiffModel } = await import('../../../common/diff/diffModel.js');
const { MultiDiffEditorWidget } = await import('../../../browser/widget/multiDiffEditor/multiDiffEditorWidget.js');
const { createCodeEditorServices } = await import('../testCodeEditor.js');
suiteTeardown(() => {
	installedGlobals.dispose();
	browserEnvironment.window.close();
});
const diffOptions: IDocumentDiffProviderOptions = { ignoreTrimWhitespace: false, maxComputationTimeMs: 0, computeMoves: false };

test('MultiDiffEditorWidget presents ordered file sections with one outer viewport', async () => {
	using resources = new DisposableStore();
	const services = createCodeEditorServices(resources);
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement<HTMLElement>(dom.window.document, 'main');
	using firstOriginal = new TextModel('old\nsame');
	using firstModified = new TextModel('new\nsame');
	using secondOriginal = new TextModel(lines('before', 100));
	using secondModified = new TextModel(lines('after', 100));
	using computationService = new MultiDiffTestComputationService();
	using firstModel = new DiffModel({ original: firstOriginal, modified: firstModified, diffProvider: computationService, diffOptions });
	using secondModel = new DiffModel({ original: secondOriginal, modified: secondModified, diffProvider: computationService, diffOptions });
	using firstItem = new DocumentDiffItem({ id: 'first', label: 'src/first.ts', originalLabel: 'HEAD', modifiedLabel: 'Working Tree' }, firstModel);
	using secondItem = new DocumentDiffItem({ id: 'second', label: 'src/second.ts', originalLabel: 'HEAD', modifiedLabel: 'Working Tree' }, secondModel);
	using collection = new MultiDiffEditorModel([firstItem, secondItem]);
	await Promise.all([waitForReady(firstModel), waitForReady(secondModel)]);
	let disposedItemActions = 0;
	using editor = services.createInstance(MultiDiffEditorWidget, {
		container,
		model: collection,
		lineHeight: 20,
		overscanRowCount: 1,
		showLineNumbers: false,
		workbenchUIElementFactory: { createItemActions: (container: HTMLElement, item: IDocumentDiffItem) => {
			const button = h(container.ownerDocument, 'button');
			button.type = 'button';
			button.textContent = `Open ${item.label}`;
			container.append(button);
			let disposed = false;
			const dispose = () => {
				if (disposed) return;
				disposed = true;
				disposedItemActions += 1;
			};
			return { dispose, [Symbol.dispose]: dispose };
		} },
	});
	editor.layout({ width: 480, height: 80 });

	assert.equal(editor.domNode.querySelectorAll('.stanza-multi-diff-editor-section').length, 2);
	assert.ok([...editor.domNode.querySelectorAll<HTMLElement>('.stanza-multi-diff-editor-section')].every((section) => section.style.transform === ''));
	assert.deepEqual(
		[...editor.domNode.querySelectorAll('.stanza-multi-diff-editor-title')].map((element) => element.textContent),
		['src/first.ts', 'src/second.ts'],
	);
	assert.equal(editor.domNode.classList.contains('hide-line-numbers'), true);
	assert.equal(editor.domNode.querySelectorAll('.stanza-diff-editor').length, 2);
	assert.equal(editor.domNode.querySelectorAll('.stanza-editor').length, 4);
	assert.equal(editor.domNode.querySelectorAll('.stanza-multi-diff-editor-file-actions').length, 2);
	assert.equal(editor.domNode.querySelectorAll('button button').length, 0);
	assert.equal(editor.domNode.querySelectorAll('.stanza-multi-diff-editor-chevron.expanded-icon').length, 2);
	assert.equal(editor.domNode.querySelectorAll('.stanza-multi-diff-editor-chevron.collapsed-icon').length, 2);

	const firstHeader = requiredElement<HTMLButtonElement>(editor.domNode, '.stanza-multi-diff-editor-header-toggle');
	requiredElement<HTMLButtonElement>(editor.domNode, '.stanza-multi-diff-editor-file-actions button').click();
	assert.equal(firstHeader.getAttribute('aria-expanded'), 'true');
	editor.collapseAll();
	assert.ok([...editor.domNode.querySelectorAll('.stanza-multi-diff-editor-header-toggle')].every((header) => header.getAttribute('aria-expanded') === 'false'));
	editor.expandAll();
	assert.ok([...editor.domNode.querySelectorAll('.stanza-multi-diff-editor-header-toggle')].every((header) => header.getAttribute('aria-expanded') === 'true'));
	firstHeader.click();
	assert.equal(firstHeader.getAttribute('aria-expanded'), 'false');
	assert.equal((await editor.nextChange())?.itemId, 'first');
	assert.equal(firstHeader.getAttribute('aria-expanded'), 'true');
	assert.equal(editor.currentChange?.rowIndex, 0);
	const keyboardNavigation = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'F7' });
	editor.domNode.dispatchEvent(keyboardNavigation);
	assert.equal(keyboardNavigation.defaultPrevented, true);
	await waitForText(editor.domNode.querySelector('.stanza-multi-diff-editor-accessibility-status')!, 'Change 2 of 101');
	assert.equal(editor.currentChange?.itemId, 'second');
	assert.match(editor.domNode.querySelector('.stanza-multi-diff-editor-accessibility-status')?.textContent ?? '', /Change 2 of 101/);
	editor.domNode.scrollTop = 52;
	const viewState: unknown = JSON.parse(JSON.stringify(editor.saveViewState()));
	editor.collapseAll();
	editor.domNode.scrollTop = 0;
	editor.restoreViewState(viewState);
	assert.equal(editor.domNode.scrollTop, 52);
	assert.ok([...editor.domNode.querySelectorAll('.stanza-multi-diff-editor-header-toggle')].every(header => header.getAttribute('aria-expanded') === 'true'));
	assert.throws(() => editor.restoreViewState({ scrollTop: -1, collapsedItemIds: [], itemViewStates: [] }), TypeError);
	editor.dispose();
	assert.equal(disposedItemActions, 2);
	dom.window.close();
});

class MultiDiffTestComputationService implements IDocumentDiffProvider {
	readonly onDidChange = Event.None;

	async computeDiff(original: ITextModel, modified: ITextModel, options: IDocumentDiffProviderOptions, token: CancellationToken): Promise<IDocumentDiff> {
		assert.equal(token.isCancellationRequested, false);
		const result = new DefaultLinesDiffComputer().computeDiff(original.getLinesContent(), modified.getLinesContent(), options);
		return { identical: original.getValue() === modified.getValue(), quitEarly: result.hitTimeout, changes: result.changes, moves: result.moves };
	}

	dispose(): void {}

	[Symbol.dispose](): void {
		this.dispose();
	}
}

function lines(prefix: string, count: number): string {
	return Array.from({ length: count }, (_, index) => `${prefix} ${index}`).join('\n');
}

function requiredElement<T extends Element>(owner: ParentNode, selector: string): T {
	const element = owner.querySelector<T>(selector);
	if (!element) throw new Error(`Missing ${selector}`);
	return element;
}

function waitForText(element: Element, value: string): Promise<void> {
	if (element.textContent?.includes(value)) return Promise.resolve();
	return new Promise(resolve => {
		const observer = new browserEnvironment.window.MutationObserver(() => {
			if (!element.textContent?.includes(value)) return;
			observer.disconnect();
			resolve();
		});
		observer.observe(element, { childList: true, subtree: true, characterData: true });
	});
}

function waitForReady(model: InstanceType<typeof DiffModel>): Promise<void> {
	if (model.state.kind === 'ready') return Promise.resolve();
	return new Promise((resolve, reject) => {
		const listener = model.onDidChange((state) => {
			if (state.kind === 'loading') return;
			listener.dispose();
			if (state.kind === 'error') reject(state.error);
			else resolve();
		});
	});
}
