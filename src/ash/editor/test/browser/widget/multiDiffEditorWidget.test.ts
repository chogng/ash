import { computeDiffRowLayout } from '../../../browser/widget/multiDiffEditor/compressedVirtualizedScrollLayout.js';
import { TEST_FONT_INFO } from '../config/testConfiguration.js';
import { registerTestCodeEditorFeatures } from '../../../../../../test/fixtures/codeEditorFeatures.js';
import { after as afterCodeFeatures } from 'mocha';
import assert from 'node:assert/strict';
import { test, suite, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { h } from '../../../../base/browser/dom.js';
import { setIconResolver } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { type CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { type IDocumentDiff, type IDocumentDiffProvider, type IDocumentDiffProviderOptions } from '../../../common/diff/documentDiffProvider.js';
import { DefaultLinesDiffComputer } from '../../../common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';
import { type ITextModel } from '../../../common/model.js';
import { TextModel } from '../../../common/model/textModel.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { ICodeEditorService } from '../../../browser/services/codeEditorService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { DocumentDiffItem, MultiDiffEditorModel, type IDocumentDiffItem } from '../../../browser/widget/multiDiffEditor/model.js';
import { installEditorTestDom } from '../editorTestGlobals.js';
import { getIconDefinition } from '../../../../platform/theme/common/iconRegistry.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
setIconResolver(browserEnvironment.window.document, icon => getIconDefinition(icon));
browserEnvironment.window.HTMLCanvasElement.prototype.getContext = () => null;
class TestResizeObserver {
	observe(): void { }
	unobserve(): void { }
	disconnect(): void { }
}
const installedGlobals = installEditorTestDom(browserEnvironment, [
	'Node', 'Element', 'HTMLElement', 'Event', 'KeyboardEvent',
], { ResizeObserver: TestResizeObserver });

const { DiffModel } = await import('../../../common/diff/diffModel.js');
const { MultiDiffEditorWidget } = await import('../../../browser/widget/multiDiffEditor/multiDiffEditorWidget.js');
const { createCodeEditorServices } = await import('../testCodeEditor.js');
await import('../../../contrib/diffEditorBreadcrumbs/browser/contribution.js');
suiteTeardown(() => {
	installedGlobals.dispose();
	browserEnvironment.window.close();
});
const diffOptions: IDocumentDiffProviderOptions = { ignoreTrimWhitespace: false, maxComputationTimeMs: 0, computeMoves: false };

suite('MultiDiff comparison retention', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('row height estimates preserve paired wraps across bounded computation batches', async () => {
		using resources = new DisposableStore();
		const before = Array.from({ length: 300 }, () => 'x');
		before[254] = 'x'.repeat(25);
		const after = [...before];
		after[256] = 'x'.repeat(45);
		const original = resources.add(new TextModel(before.join('\n')));
		const modified = resources.add(new TextModel(after.join('\n')));
		const model = resources.add(new DiffModel({ original, modified, diffProvider: new MultiDiffTestComputationService(), diffOptions }));
		await waitForReady(model);
		const plain = computeDiffRowLayout(model, 20);
		assert.equal(plain.height, 6000);
		assert.equal(plain.getOffset(257), 5140);
		const wrapped = computeDiffRowLayout(model, 20, { fontInfo: TEST_FONT_INFO, column: 10 });
		assert.deepEqual([254, 255, 256, 257, 300].map(index => wrapped.getOffset(index)), [5080, 5140, 5160, 5260, 6120]);
		assert.equal(wrapped.height, 6120);
	});

	test('comparison retention pins pending navigation and permits reload after the final release', async () => {
		using resources = new DisposableStore();
		const original = resources.add(new TextModel('before'));
		const modified = resources.add(new TextModel('after'));
		const provider = new MultiDiffTestComputationService();
		let current: InstanceType<typeof DiffModel> | undefined;
		let loads = 0;
		const loaded = new DeferredPromise<void>();
		const item = resources.add(new DocumentDiffItem({ id: 'retained', label: 'retained.txt' }, async () => {
			loads++;
			await loaded.p;
			return current = resources.add(new DiffModel({ original, modified, diffProvider: provider, diffOptions }));
		}, { onDidChange: () => { }, release: () => current?.dispose() }));
		const viewport = item.retain();
		const navigation = item.retain();
		const pending = item.resolve();
		viewport.dispose();
		assert.equal(item.release(), false);
		await loaded.complete();
		const first = await pending;
		assert.equal(item.release(), false, 'Navigation still owns the ready comparison');
		navigation.dispose();
		assert.equal(item.release(), true);
		assert.equal(first?.isDisposed, true);
		assert.equal(item.model, undefined);
		assert.equal(item.state, 'unresolved');
		const second = await item.resolve();
		assert.notEqual(second, first);
		assert.equal(loads, 2, 'Eviction must drop the settled promise as well as the model');
	});
});

test('MultiDiff collapse toggle follows individual headers, restored state and source replacement', () => {
	using resources = new DisposableStore();
	const services = createCodeEditorServices(resources);
	const container = h(browserEnvironment.window.document, 'main');
	browserEnvironment.window.document.body.append(container);
	try {
		const first = resources.add(new DocumentDiffItem({ id: 'first', label: 'first.bin', binary: true }, undefined));
		const second = resources.add(new DocumentDiffItem({ id: 'second', label: 'second.bin', binary: true }, undefined));
		const third = resources.add(new DocumentDiffItem({ id: 'third', label: 'third.bin', binary: true }, undefined));
		using collection = new MultiDiffEditorModel([first, second]);
		using editor = services.createInstance(MultiDiffEditorWidget, { container, model: collection });
		editor.layout({ width: 800, height: 300 });
		const states: boolean[] = [];
		using listener = editor.onDidChangeCollapseState(() => states.push(editor.allCollapsed));
		assert.equal(editor.allCollapsed, false);
		editor.toggleCollapseAll();
		assert.equal(editor.allCollapsed, true);
		const collapsedState = editor.saveViewState();
		requiredElement<HTMLButtonElement>(container, '.stanza-multi-diff-editor-header-toggle').click();
		assert.equal(editor.allCollapsed, false);
		editor.toggleCollapseAll();
		assert.equal(editor.allCollapsed, true);
		editor.toggleCollapseAll();
		assert.equal(editor.allCollapsed, false);
		editor.restoreViewState(collapsedState);
		assert.equal(editor.allCollapsed, true);
		collection.setItems([second, third]);
		assert.equal(editor.allCollapsed, false, 'New source items start expanded');
		editor.toggleCollapseAll();
		assert.equal(editor.allCollapsed, true);
		collection.setItems([]);
		assert.equal(editor.allCollapsed, false, 'An empty source has no collapsed display mode');
		assert.deepEqual(states, [true, false, true, false, true, false, true, false]);
	} finally {
		container.remove();
	}
});

test('source replacement releases readiness waits for disposed models during initial navigation', async function () {
	this.timeout(2000);
	using resources = new DisposableStore();
	const services = createCodeEditorServices(resources);
	const container = h(browserEnvironment.window.document, 'main');
	browserEnvironment.window.document.body.append(container);
	try {
		using original = new TextModel('before');
		using modified = new TextModel('after');
		using slowProvider = new MultiDiffTestComputationService();
		const computation = new DeferredPromise<IDocumentDiff>();
		slowProvider.computeDiff = async () => computation.p;
		using staleModel = new DiffModel({ original, modified, diffProvider: slowProvider, diffOptions });
		using staleItem = new DocumentDiffItem({ id: 'file', label: 'old.ts' }, staleModel);
		using collection = new MultiDiffEditorModel([staleItem]);
		using editor = services.createInstance(MultiDiffEditorWidget, { container, model: collection });
		editor.layout({ width: 800, height: 300 });
		const loading = editor.resolveVisible();
		await Promise.resolve();
		await Promise.resolve();
		using provider = new MultiDiffTestComputationService();
		using nextModel = new DiffModel({ original, modified, diffProvider: provider, diffOptions });
		using nextItem = new DocumentDiffItem({ id: 'file', label: 'new.ts' }, nextModel);
		collection.setItems([nextItem]);
		staleModel.dispose();
		await loading;
		await editor.resolveVisible();
		assert.equal(editor.domNode.querySelector('.stanza-multi-diff-editor-title')?.textContent, 'new.ts');
		assert.equal(editor.currentChange, undefined);
		await computation.complete(await provider.computeDiff(original, modified, diffOptions, { isCancellationRequested: false, onCancellationRequested: Event.None }));
	} finally {
		container.remove();
	}
});

for (const restore of [false, true]) {
	test(`MultiDiffEditorWidget ${restore ? 'preserves restored collapse state during' : 'reveals the first change without focus during'} initial navigation`, async () => {
		const dom = new JSDOM('<!doctype html><body><main tabindex="0"></main></body>');
		setIconResolver(dom.window.document, icon => getIconDefinition(icon));
		try {
			dom.window.HTMLCanvasElement.prototype.getContext = () => null;
			using resources = new DisposableStore();
			const services = createCodeEditorServices(resources);
			const container = requiredElement<HTMLElement>(dom.window.document, 'main');
			container.focus();
			const original = Array.from({ length: 100 }, (_, index) => `shared ${index + 1}`);
			assert.equal(services.get(IConfigurationService).getValue('diffEditor.hideUnchangedRegions.enabled'), false, 'The ordinary diff default stays independent');
			const modified = [...original];
			modified[59] = 'changed';
			using before = new TextModel(original.join('\n'));
			using after = new TextModel(modified.join('\n'));
			using provider = new MultiDiffTestComputationService();
			using model = new DiffModel({ original: before, modified: after, diffProvider: provider, diffOptions });
			using item = new DocumentDiffItem({ id: 'first', label: 'first.ts' }, model);
			using collection = new MultiDiffEditorModel([item]);
			using editor = services.createInstance(MultiDiffEditorWidget, { container, model: collection, lineHeight: 20 });
			editor.layout({ width: 800, height: 300 });
			if (restore) editor.restoreViewState({ scrollTop: 0, collapsedItemIds: ['first'], itemViewStates: [] });
			await editor.resolveVisible();
			assert.equal(dom.window.document.activeElement, container);
			if (restore) {
				assert.equal(editor.currentChange, undefined);
				assert.equal(container.querySelector('.stanza-multi-diff-editor-header-toggle')?.getAttribute('aria-expanded'), 'false');
			} else {
				assert.deepEqual(editor.currentChange, { itemId: 'first', rowIndex: 59 });
				assert.equal(editor.getActiveControl()?.modifiedEditor.getPosition()?.lineNumber, 60);
				assert.ok(container.querySelectorAll('.ash-diff-hidden-region').length > 0);
				const changeTop = editor.getActiveControl()!.modifiedEditor.getTopForLineNumber(60);
				assert.ok(changeTop >= 0 && changeTop < 300);
				const editorService = services.get(ICodeEditorService);
				for (let iteration = 0; iteration < 5; iteration++) {
					editor.collapseAll();
					assert.equal(editorService.listDiffEditors().length, 0);
					assert.equal(editorService.listCodeEditors().length, 0);
					editor.expandAll();
					assert.equal(editorService.listDiffEditors().length, 1);
					assert.equal(editorService.listCodeEditors().length, 2);
					assert.equal(container.querySelectorAll('.ash-diff-hidden-region').length, 4);
				}
				editor.collapseAll();
				await editor.toggleCollapseUnchangedRegions();
				editor.expandAll();
				assert.equal(container.querySelectorAll('.ash-diff-hidden-region').length, 0);
				await editor.toggleCollapseUnchangedRegions();
				assert.ok(container.querySelectorAll('.ash-diff-hidden-region').length > 0);
			}
		} finally {
			dom.window.close();
		}
	});
}

test('MultiDiffEditorWidget presents ordered file sections with one outer viewport', async () => {
	using resources = new DisposableStore();
	const services = createCodeEditorServices(resources);
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	setIconResolver(dom.window.document, icon => getIconDefinition(icon));
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
		workbenchUIElementFactory: {
			createItemActions: (container: HTMLElement, item: IDocumentDiffItem) => {
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
			}
		},
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
	assert.equal(editor.getActiveItem()?.id, 'second');
	assert.ok([...editor.domNode.querySelectorAll('.stanza-multi-diff-editor-header-toggle')].every(header => header.getAttribute('aria-expanded') === 'true'));
	editor.updateOptions({ fontSize: 18, lineHeight: 30, showLineNumbers: true, showInlineChanges: false, loopChanges: false });
	assert.equal(editor.domNode.classList.contains('hide-line-numbers'), false);
	for (const child of services.get(ICodeEditorService).listCodeEditors()) {
		assert.equal(child.getOption(EditorOption.fontInfo).fontSize, 18);
		assert.equal(child.getOption(EditorOption.lineHeight), 30);
	}
	assert.throws(() => editor.restoreViewState({ scrollTop: -1, collapsedItemIds: [], itemViewStates: [] }), TypeError);
	assert.throws(() => editor.restoreViewState({ scrollTop: 0, activeItemId: 1, collapsedItemIds: [], itemViewStates: [] }), TypeError);
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

	dispose(): void { }

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

const codeFeatures = registerTestCodeEditorFeatures();
afterCodeFeatures(() => codeFeatures.dispose());
