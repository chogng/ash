import { computeDiffRowLayout, computeDiffPreviewLayout } from '../../../browser/widget/multiDiffEditor/compressedVirtualizedScrollLayout.js';
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
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { type IDocumentDiff, type IDocumentDiffProvider, type IDocumentDiffProviderOptions } from '../../../common/diff/documentDiffProvider.js';
import { DefaultLinesDiffComputer } from '../../../common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';
import { type ITextModel } from '../../../common/model.js';
import { TextModel } from '../../../common/model/textModel.js';
import { Range } from '../../../common/core/range.js';
import { SyntaxProviderRegistry } from '../../../common/languageFeatureRegistry.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { StandaloneLayoutService } from '../../../standalone/browser/standaloneLayoutService.js';
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
], { ResizeObserver: TestResizeObserver, WheelEvent: browserEnvironment.window.WheelEvent });

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
	test('review projection keeps source rows stable when hidden regions expand', async () => {
		using resources = new DisposableStore();
		const text = Array.from({ length: 1600 }, (_, line) => `line ${line}`);
		const after = [...text];
		after[100] = 'changed';
		const original = resources.add(new TextModel(text.join('\n')));
		const modified = resources.add(new TextModel(after.join('\n')));
		const model = resources.add(new DiffModel({ original, modified, diffProvider: new MultiDiffTestComputationService(), diffOptions }));
		await waitForReady(model);
		const options = { enabled: true, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 10 };
		const compact = computeDiffPreviewLayout(model, 20, options, new Set());
		assert.equal(compact.height, 220);
		assert.equal(compact.getOffset(100), 100);
		assert.deepEqual(compact.getVisibleRows(80, 60), [
			{ rowIndex: 99, top: 80, height: 20, hiddenCount: 0 }, { rowIndex: 100, top: 100, height: 20, hiddenCount: 0 }, { rowIndex: 101, top: 120, height: 20, hiddenCount: 0 },
		]);
		const expanded = computeDiffPreviewLayout(model, 20, options, new Set([0]));
		assert.equal(expanded.getOffset(100), 2000);
		assert.equal(expanded.height, 2120);
		assert.equal(expanded.getVisibleRows(1800, 100).length, 5);
	});

	test('header navigation retains a loading destination and restores its resolved position', async () => {
		using resources = new DisposableStore();
		const services = createCodeEditorServices(resources);
		const container = h(browserEnvironment.window.document, 'main');
		browserEnvironment.window.document.body.append(container);
		resources.add(toDisposable(() => container.remove()));
		const provider = new MultiDiffTestComputationService();
		const comparison = (count: number) => resources.add(new DiffModel({
			original: resources.add(new TextModel(lines('before', count))), modified: resources.add(new TextModel(lines('after', count))), diffProvider: provider, diffOptions,
		}));
		const first = comparison(500);
		const last = comparison(20);
		await Promise.all([waitForReady(first), waitForReady(last)]);
		const loading = new DeferredPromise<InstanceType<typeof DiffModel>>();
		const destination = resources.add(new DocumentDiffItem({ id: 'last', label: 'last.ts' }, () => loading.p));
		const model = resources.add(new MultiDiffEditorModel([resources.add(new DocumentDiffItem({ id: 'first', label: 'first.ts' }, first)), destination]));
		const editor = resources.add(services.createInstance(MultiDiffEditorWidget, { container, model, preview: true, onOpenEditor: () => { }, lineHeight: 20 }));
		editor.layout({ width: 700, height: 240 });
		let nativeScrollTop = 0;
		Object.defineProperties(editor.domNode, {
			scrollTop: { get: () => nativeScrollTop, set: (value: number) => { nativeScrollTop = Math.max(0, Math.min(value, editor.domNode.scrollHeight - 240)); } },
			clientHeight: { get: () => 240 }, clientWidth: { get: () => 700 }, scrollWidth: { get: () => 700 },
			scrollHeight: { get: () => parseFloat(requiredElement<HTMLElement>(container, '.stanza-multi-diff-editor-content').style.height) },
		});
		const header = requiredElement<HTMLButtonElement>(container, '.stanza-multi-diff-editor-header-toggle');
		header.focus();
		header.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		assert.equal(destination.isInUse, true);
		// A native clamp or another loading file can temporarily move the viewport.
		editor.domNode.scrollTop = 0;
		editor.domNode.dispatchEvent(new browserEnvironment.window.Event('scroll'));
		await loading.complete(last);
		await waitForText(container, 'after 19');
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		assert.equal(browserEnvironment.window.document.activeElement?.closest('section')?.getAttribute('aria-label'), 'last.ts');
		assert.ok(editor.domNode.scrollTop > 9000);
		const cancelled = new DeferredPromise<InstanceType<typeof DiffModel>>();
		model.setItems([
			resources.add(new DocumentDiffItem({ id: 'first', label: 'first.ts' }, first)),
			resources.add(new DocumentDiffItem({ id: 'pending', label: 'pending.ts' }, () => cancelled.p)),
		]);
		editor.domNode.scrollTop = 0;
		editor.domNode.dispatchEvent(new browserEnvironment.window.Event('scroll'));
		const restart = requiredElement<HTMLButtonElement>(container, '.stanza-multi-diff-editor-header-toggle');
		restart.focus();
		restart.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		editor.domNode.dispatchEvent(new browserEnvironment.window.WheelEvent('wheel', { deltaY: -100000, bubbles: true }));
		await cancelled.complete(last);
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		assert.equal(editor.domNode.scrollTop, 0, 'A wheel gesture cancels the pending header reveal');

	});

	for (const preview of [true, false]) test(`a short final header stays visible after neighboring loads and ${preview ? 'preview' : 'editor'} layout`, async () => {
		using resources = new DisposableStore();
		const services = createCodeEditorServices(resources);
		resources.add(services.createInstance(StandaloneLayoutService));
		const container = h(browserEnvironment.window.document, 'main');
		browserEnvironment.window.document.body.append(container);
		resources.add(toDisposable(() => container.remove()));
		const comparison = (count: number, compact = false) => resources.add(new DiffModel({
			original: resources.add(new TextModel(lines('before', count))), modified: resources.add(new TextModel(compact ? ['after 0', ...lines('before', count).split('\n').slice(1)].join('\n') : lines('after', count))), diffProvider: new MultiDiffTestComputationService(), diffOptions,
		}));
		const first = comparison(500), middle = comparison(200), last = comparison(400, true);
		await Promise.all([waitForReady(first), waitForReady(middle), waitForReady(last)]);
		const loading = new DeferredPromise<InstanceType<typeof DiffModel>>();
		const model = resources.add(new MultiDiffEditorModel([
			resources.add(new DocumentDiffItem({ id: 'first', label: 'first.ts' }, first)),
			resources.add(new DocumentDiffItem({ id: 'middle', label: 'middle.ts' }, () => loading.p)),
			resources.add(new DocumentDiffItem({ id: 'last', label: 'last.ts' }, last)),
		]));
		const editor = resources.add(services.createInstance(MultiDiffEditorWidget, { container, model, preview, onOpenEditor: () => { }, lineHeight: 20 }));
		editor.layout({ width: 700, height: 240 });
		let scrollTop = 0;
		const scrollHeight = () => parseFloat(requiredElement<HTMLElement>(container, '.stanza-multi-diff-editor-content').style.height);
		Object.defineProperties(editor.domNode, {
			clientHeight: { get: () => 240 }, clientWidth: { get: () => 700 }, scrollWidth: { get: () => 700 }, scrollHeight: { get: scrollHeight },
			scrollTop: { get: () => scrollTop, set: (value: number) => { scrollTop = Math.max(0, Math.min(value, scrollHeight() - 240)); } },
		});
		const header = requiredElement<HTMLButtonElement>(container, '.stanza-multi-diff-editor-header-toggle');
		header.focus();
		header.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		await loading.complete(middle);
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		const final = container.querySelector<HTMLElement>('section[aria-label="last.ts"]');
		assert.ok(final, 'The requested tail file remains mounted after its neighbor resolves');
		assert.ok(editor.domNode.scrollTop > 13000);
		assert.ok(parseFloat(final.style.top) < editor.domNode.scrollTop + 240);
		// A later wheel gesture owns the viewport again.
		const beforeWheel = editor.domNode.scrollTop;
		editor.domNode.dispatchEvent(new browserEnvironment.window.WheelEvent('wheel', { deltaY: -1000, bubbles: true }));
		assert.equal(Math.round(beforeWheel - editor.domNode.scrollTop), 1000);
	});

	test('review uses shared models without full editors and preserves selection through virtualization and mode changes', async () => {
		using resources = new DisposableStore();
		const services = createCodeEditorServices(resources);
		resources.add(services.createInstance(StandaloneLayoutService));
		const container = h(browserEnvironment.window.document, 'main');
		browserEnvironment.window.document.body.append(container);
		resources.add(toDisposable(() => container.remove()));
		const original = resources.add(new TextModel(lines('before', 200)));
		const providers = resources.add(new SyntaxProviderRegistry());
		resources.add(providers.register({
			id: 'review-syntax', languageIds: ['review-syntax'], provideTokens: () => ({
				tokens: [{ range: new Range(1, 1, 1, 6), tokenType: 'keyword', modifiers: [] }],
			})
		}));
		const modified = resources.add(new TextModel(lines('after 中文 😀', 200), { languageId: 'review-syntax', tokenization: { syntaxProviderRegistry: providers } }));
		await modified.tokenization.whenReady(new AbortController().signal);
		const model = resources.add(new DiffModel({ original, modified, diffProvider: new MultiDiffTestComputationService(), diffOptions }));
		await waitForReady(model);
		const item = resources.add(new DocumentDiffItem({ id: 'review', label: 'review.ts', originalUri: original.uri, modifiedUri: modified.uri }, model));
		let opened: { item: IDocumentDiffItem; side: string; range: Range; } | undefined;
		const editor = resources.add(services.createInstance(MultiDiffEditorWidget, {
			container, model: resources.add(new MultiDiffEditorModel([item])), preview: true, lineHeight: 20,
			onOpenEditor: (item: IDocumentDiffItem, side: 'original' | 'modified', range: Range) => { opened = { item, side, range }; },
		}));
		editor.layout({ width: 700, height: 240 });
		await editor.resolveVisible();
		assert.equal(container.querySelectorAll('.stanza-editor').length, 0);
		assert.ok(container.querySelectorAll('.ash-diff-review-row').length < 60);
		assert.equal(services.get(ICodeEditorService).listCodeEditors().length, 0);
		assert.equal(container.querySelector('.token-keyword')?.textContent, 'after');
		for (const top of [1000, 400, 0]) {
			editor.domNode.scrollTop = top;
			editor.domNode.dispatchEvent(new browserEnvironment.window.Event('scroll'));
			for (const column of container.querySelectorAll('.ash-diff-review-column')) {
				const rows = [...column.querySelectorAll<HTMLElement>('[data-review-row]')].map(node => Number(node.dataset.reviewRow));
				assert.deepEqual(rows, [...rows].sort((a, b) => a - b));
			}
		}
		const preview = requiredElement<HTMLElement>(container, '.ash-diff-review-preview');
		preview.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		preview.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
		preview.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		assert.equal(opened?.item.model?.modified, modified);
		assert.equal(opened?.side, 'modified');
		assert.deepEqual(opened?.range, new Range(2, 1, 3, modified.getLineMaxColumn(3)));
		const saved = editor.saveViewState();
		editor.restoreViewState(JSON.parse(JSON.stringify(saved)));
		editor.setPreview(false);
		assert.equal(editor.getActiveControl()?.modifiedEditor.getModel(), modified);
		assert.equal(editor.getActiveControl()?.modifiedEditor.getSelection()?.toString(), opened?.range.toString());
		editor.setPreview(true);
		modified.applyEdits([{ range: new Range(1, 1, 1, modified.getLineMaxColumn(1)), text: '<b>shared update</b>' }]);
		await waitForReady(model);
		await waitForText(container, '<b>shared update</b>');
		assert.equal(container.querySelector('b'), null, 'Source text must not become markup');
		assert.equal(container.querySelectorAll('.stanza-editor').length, 0);
		assert.match(editor.getAccessibleContent()!, /shared update/);
	});
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
					assert.equal(editorService.listDiffEditors().length, 1);
					assert.equal(editorService.listCodeEditors().length, 2);
					for (const child of editorService.listCodeEditors()) assert.equal(child.getModel(), null);
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

test('MultiDiff bounds unresolved file loading and mounts editors only after their initial diff is ready', async () => {
	using resources = new DisposableStore();
	const services = createCodeEditorServices(resources);
	const container = h(browserEnvironment.window.document, 'main');
	browserEnvironment.window.document.body.append(container);
	const computation = new DeferredPromise<IDocumentDiff>();
	let result: IDocumentDiff | undefined;
	try {
		const before = Array.from({ length: 1000 }, (_, index) => `shared ${index}`);
		const after = [...before];
		after[500] = 'changed';
		const original = resources.add(new TextModel(before.join('\n')));
		const modified = resources.add(new TextModel(after.join('\n')));
		const provider = resources.add(new MultiDiffTestComputationService());
		result = await provider.computeDiff(original, modified, diffOptions, { isCancellationRequested: false, onCancellationRequested: Event.None });
		provider.computeDiff = () => computation.p;
		let loaded = 0;
		const items = Array.from({ length: 24 }, (_, index) => resources.add(new DocumentDiffItem({ id: String(index), label: `${index}.ts` }, async () => {
			loaded++;
			return resources.add(new DiffModel({ original, modified, diffProvider: provider, diffOptions }));
		})));
		using collection = new MultiDiffEditorModel(items);
		using editor = services.createInstance(MultiDiffEditorWidget, { container, model: collection, lineHeight: 20 });
		editor.layout({ width: 800, height: 600 });
		await Promise.resolve();
		await Promise.resolve();
		assert.ok(loaded > 0 && loaded <= 2, 'Pending comparisons reserve viewport height instead of eagerly loading offscreen files');
		assert.equal(services.get(ICodeEditorService).listCodeEditors().length, 0, 'Pending first diffs must not render an intermediate full-file editor');
		await computation.complete(result);
		await editor.resolveVisible();
		assert.ok(editor.getActiveControl());
		assert.ok(container.querySelectorAll('.ash-diff-hidden-region').length > 0);
	} finally {
		if (result) await computation.complete(result);
		container.remove();
	}
});

test('MultiDiff remounts a default cursor with compact geometry and restores other selections', async () => {
	using resources = new DisposableStore();
	const services = createCodeEditorServices(resources);
	const container = h(browserEnvironment.window.document, 'main');
	browserEnvironment.window.document.body.append(container);
	try {
		const before = Array.from({ length: 200 }, (_, index) => `shared ${index}`);
		const after = [...before];
		after[99] = 'changed';
		using original = new TextModel(before.join('\n'));
		using modified = new TextModel(after.join('\n'));
		using provider = new MultiDiffTestComputationService();
		using model = new DiffModel({ original, modified, diffProvider: provider, diffOptions });
		await waitForReady(model);
		using item = new DocumentDiffItem({ id: 'first', label: 'first.ts' }, model);
		using collection = new MultiDiffEditorModel([item]);
		using editor = services.createInstance(MultiDiffEditorWidget, { container, model: collection, lineHeight: 20 });
		editor.restoreViewState({ scrollTop: 0, activeItemId: 'first', collapsedItemIds: [], itemViewStates: [] });
		editor.layout({ width: 800, height: 300 });
		await editor.resolveVisible();
		const child = editor.getActiveControl()!;
		const compactHeight = child.getContentHeight();
		assert.ok(compactHeight < 200 * 20);
		for (let iteration = 0; iteration < 3; iteration++) {
			editor.collapseAll();
			editor.expandAll();
			await editor.resolveVisible();
			assert.equal(editor.getActiveControl()!.modifiedEditor.getPosition()?.lineNumber, 1);
			assert.equal(editor.getActiveControl()!.modifiedEditor.getPosition()?.column, 1);
			assert.equal(editor.getActiveControl()!.getContentHeight(), compactHeight);
		}
		child.modifiedEditor.setSelection(new Range(100, 2, 101, 4));
		editor.collapseAll();
		editor.expandAll();
		await editor.resolveVisible();
		assert.ok(Range.equalsRange(editor.getActiveControl()!.modifiedEditor.getSelection(), new Range(100, 2, 101, 4)));
	} finally {
		container.remove();
	}
});

test('MultiDiff scrolling preserves child layout while resize and remount apply current dimensions', async () => {
	using resources = new DisposableStore();
	const services = createCodeEditorServices(resources);
	const container = h(browserEnvironment.window.document, 'main');
	browserEnvironment.window.document.body.append(container);
	try {
		using original = new TextModel(lines('before', 200));
		using modified = new TextModel(lines('after', 200));
		using provider = new MultiDiffTestComputationService();
		using model = new DiffModel({ original, modified, diffProvider: provider, diffOptions });
		await waitForReady(model);
		using item = new DocumentDiffItem({ id: 'first', label: 'first.ts' }, model);
		using collection = new MultiDiffEditorModel([item]);
		using editor = services.createInstance(MultiDiffEditorWidget, { container, model: collection, lineHeight: 20 });
		// Supply the native viewport geometry that jsdom does not calculate.
		Object.defineProperties(editor.domNode, {
			clientWidth: { get: () => 800 },
			clientHeight: { get: () => 300 },
			scrollHeight: { get: () => Number.parseFloat((editor.domNode.firstElementChild as HTMLElement).style.height) },
		});
		editor.layout({ width: 800, height: 300 });
		await editor.resolveVisible();
		const child = editor.getActiveControl();
		assert.ok(child);
		const layout = child.layout;
		let layoutCalls = 0;
		child.layout = function (size): void {
			layoutCalls++;
			layout.call(this, size);
		};
		try {
			for (const scrollTop of [100, 200, 300, 200]) {
				editor.domNode.scrollTop = scrollTop;
				editor.domNode.dispatchEvent(new browserEnvironment.window.Event('scroll'));
				assert.equal(child.originalEditor.getScrollTop(), scrollTop - 8);
				assert.equal(child.modifiedEditor.getScrollTop(), scrollTop - 8);
			}
			assert.equal(layoutCalls, 0, 'Scrolling within a file must not resize its child editors');
			assert.strictEqual(editor.getActiveControl(), child);
			editor.layout({ width: 640, height: 240 });
			assert.equal(layoutCalls, 1);
			const dimensions = child.modifiedEditor.getLayoutInfo();
			assert.equal(dimensions.height, 206);
			editor.collapseAll();
			assert.equal(child.originalEditor.getModel(), null);
			assert.equal(child.modifiedEditor.getModel(), null);
			editor.expandAll();
			await editor.resolveVisible();
			const remounted = editor.getActiveControl();
			assert.ok(remounted);
			assert.strictEqual(remounted, child);
			assert.equal(remounted.modifiedEditor.getLayoutInfo().width, dimensions.width);
			assert.equal(remounted.modifiedEditor.getLayoutInfo().height, dimensions.height);
		} finally {
			child.layout = layout;
		}
	} finally {
		container.remove();
	}
});

suite('MultiDiff editor reuse', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('crossing files bounds editor creation and restores file state without retaining idle models', async () => {
		using resources = new DisposableStore();
		const services = createCodeEditorServices(resources);
		const codeEditors = services.get(ICodeEditorService);
		const layout = resources.add(services.createInstance(StandaloneLayoutService));
		const container = h(browserEnvironment.window.document, 'main');
		browserEnvironment.window.document.body.append(container);
		try {
			const provider = resources.add(new MultiDiffTestComputationService());
			const models = Array.from({ length: 16 }, (_, index) => {
				const original = resources.add(new TextModel(lines(`before-${index} ` + 'wide '.repeat(40), 120)));
				const modified = resources.add(new TextModel(lines(`after-${index} ` + 'wide '.repeat(40), 120)));
				return resources.add(new DiffModel({ original, modified, diffProvider: provider, diffOptions }));
			});
			await Promise.all(models.map(waitForReady));
			const items = models.map((model, index) => resources.add(new DocumentDiffItem({
				id: `file-${index}`, label: `file-${index}.ts`, readOnly: index % 2 === 1,
				originalUri: model.original.uri, modifiedUri: model.modified.uri,
				originalLabel: `Before ${index}`, modifiedLabel: `After ${index}`,
			}, model)));
			const collection = resources.add(new MultiDiffEditorModel(items));
			const editor = resources.add(services.createInstance(MultiDiffEditorWidget, { container, model: collection, lineHeight: 20, overscanRowCount: 0 }));
			editor.layout({ width: 700, height: 240 });
			await editor.resolveVisible();
			editor.reveal({ original: models[0]!.original.uri, modified: models[0]!.modified.uri });
			const first = editor.getActiveControl()!;
			first.modifiedEditor.setPosition({ lineNumber: 20, column: 12 });
			models[0]!.modified.applyEdits([{ range: new Range(1, 1, 1, 1), text: 'unsaved ' }]);
			await waitForReady(models[0]!);
			const seen = new Set([first]);
			for (let index = 1; index < models.length; index++) {
				editor.reveal({ original: models[index]!.original.uri, modified: models[index]!.modified.uri });
				await editor.resolveVisible();
				const child = editor.getActiveControl()!;
				seen.add(child);
				assert.strictEqual(child.modifiedEditor.getModel(), models[index]!.modified);
				assert.equal(child.modifiedEditor.getOption(EditorOption.readOnly), index % 2 === 1);
				assert.equal(child.modifiedEditor.getOption(EditorOption.ariaLabel), `After ${index}`);
				assert.equal(child.originalEditor.getOption(EditorOption.ariaLabel), `Before ${index}`);
				assert.ok(codeEditors.listDiffEditors().length <= 2);
				assert.ok(codeEditors.listCodeEditors().length <= 4);
			}
			assert.ok(seen.size <= 2, 'Crossing sixteen files must reuse a bounded number of controls');
			editor.reveal({ original: models[0]!.original.uri, modified: models[0]!.modified.uri });
			await editor.resolveVisible();
			const restored = editor.getActiveControl()!.modifiedEditor;
			assert.equal(restored.getPosition()!.lineNumber, 20);
			assert.equal(restored.getPosition()!.column, 12);
			assert.ok(restored.getModel()!.getValue().startsWith('unsaved '));
			editor.collapseAll();
			assert.equal(container.querySelectorAll('.stanza-diff-editor').length, 0);
			for (const child of codeEditors.listCodeEditors()) assert.equal(child.getModel(), null);
			assert.strictEqual(layout.mainContainer, browserEnvironment.window.document.body);
			assert.strictEqual(layout.activeContainer, browserEnvironment.window.document.body);
			assert.equal([...layout.containers].length, 0);
			assert.ok(codeEditors.listDiffEditors().length <= 2);
			editor.dispose();
			assert.equal(codeEditors.listDiffEditors().length, 0);
			assert.equal(codeEditors.listCodeEditors().length, 0);
			assert.ok(models.every(model => !model.isDisposed), 'Releasing controls must preserve caller-owned comparisons');
		} finally { container.remove(); }
	});
});

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
