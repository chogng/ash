import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IPositionedRectangle } from '../../../base/browser/geometry.js';
import type { IView } from '../../../base/browser/ui/grid/grid.js';
import { getWindowById } from '../../../base/browser/window.js';
import { installEditorTestDom } from '../../../editor/test/browser/editorTestGlobals.js';
import { createTestEditorServices } from '../../../workbench/test/common/testEditorServices.js';
import { WorkbenchWindowBarHeight } from '../../../workbench/browser/parts/workbenchPartDimensions.js';
import { SessionGridLayout } from '../../browser/parts/sessions/sessionGridLayout.js';
import { StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';

ensureNoDisposablesAreLeakedInTestSuite();

class TestView implements IView {
	public readonly element: HTMLDivElement;
	public readonly minimumWidth = 100;
	public readonly maximumWidth = Number.POSITIVE_INFINITY;
	public readonly minimumHeight = 0;
	public readonly maximumHeight = Number.POSITIVE_INFINITY;
	public bounds: IPositionedRectangle | undefined;

	constructor(document: Document) {
		this.element = document.createElement('div');
		this.element.append(document.createElement('input'));
	}

	public layout(bounds: IPositionedRectangle): void {
		this.bounds = bounds;
	}
}

test('Sessions split insertion preserves an unrelated pane and retained input focus', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	using globals = installEditorTestDom(browser, ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent']);
	const document = browser.window.document;
	const first = new TestView(document);
	const second = new TestView(document);
	const third = new TestView(document);
	try {
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'test', flushInterval: 0 });
		using services = createTestEditorServices(undefined, undefined, browser.window.document, storage);
		using layout = services.createInstance(SessionGridLayout, document.body, first);
		layout.reconcile([{ id: 'first', view: first }, { id: 'second', view: second }], 'first');
		await layout.whenReady();
		layout.layout(1_200, 800);
		const firstBounds = first.bounds;
		first.element.querySelector('input')!.focus();
		layout.reconcile([{ id: 'first', view: first }, { id: 'second', view: second }, { id: 'third', view: third }], 'first');
		await layout.whenReady();
		layout.layout(1_200, 800);
		assert.deepEqual({ bounds: first.bounds, focused: document.activeElement }, { bounds: firstBounds, focused: first.element.querySelector('input') });
		const beforeMaterialization = [first.bounds, second.bounds, third.bounds];
		layout.reconcile([{ id: 'durable-first', view: first }, { id: 'second', view: second }, { id: 'third', view: third }], 'durable-first');
		await layout.whenReady();
		assert.deepEqual([first.bounds, second.bounds, third.bounds], beforeMaterialization);
	} finally {
		getWindowById(1)?.disposables.dispose();
		browser.window.close();
	}
});

test('Sessions rearrangement keeps live inputs and does not steal focus from another region', async () => {
	const browser = new JSDOM('<!doctype html><body><button>Sidebar</button></body>', { url: 'https://ash.test' });
	using globals = installEditorTestDom(browser, ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent']);
	const document = browser.window.document;
	const first = new TestView(document);
	const second = new TestView(document);
	try {
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'test', flushInterval: 0 });
		using services = createTestEditorServices(undefined, undefined, browser.window.document, storage);
		using layout = services.createInstance(SessionGridLayout, document.body, first);
		layout.reconcile([{ id: 'first', view: first }, { id: 'second', view: second }], 'first');
		await layout.whenReady();
		layout.layout(1_200, 800);
		first.element.querySelector('input')!.value = 'Unsent text';
		const sidebar = document.querySelector('button')!;
		sidebar.focus();
		layout.reconcile([{ id: 'second', view: second }, { id: 'first', view: first }], 'first');
		await layout.whenReady();
		assert.deepEqual({ focused: document.activeElement, input: first.element.querySelector('input')!.value }, { focused: sidebar, input: 'Unsent text' });
		layout.reconcile([{ id: 'first', view: first }], 'first');
		await layout.whenReady();
		assert.equal(second.element.isConnected, false);
		assert.equal(first.element.isConnected, true);
	} finally {
		getWindowById(1)?.disposables.dispose();
		browser.window.close();
	}
});

test('Sessions restores and immediately saves widths from both legacy layouts without reviving missing panes', async () => {
	const browser = new JSDOM('<!doctype html><body><button>Sidebar</button></body>', { url: 'https://ash.test', pretendToBeVisual: true });
	using globals = installEditorTestDom(browser, ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent']);
	try {
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'test', flushInterval: 0 });
		storage.store('sessions.gridState.chat', JSON.stringify({ version: 1, widths: [{ id: 'first', width: 300 }, { id: 'missing', width: 200 }, { id: 'second', width: 600 }] }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		storage.store('sessions.gridState.code', JSON.stringify({ version: 1, widths: [{ id: 'code', width: 900 }] }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		using services = createTestEditorServices(undefined, undefined, browser.window.document, storage);
		const first = new TestView(browser.window.document);
		const second = new TestView(browser.window.document);
		using layout = services.createInstance(SessionGridLayout, browser.window.document.body, first);
		layout.layout(0, 0);
		layout.reconcile([{ id: 'first', view: first }, { id: 'second', view: second }], 'second');
		await layout.whenReady();
		const input = second.element.querySelector('input')!;
		input.value = 'Unsent text';
		browser.window.document.querySelector('button')!.focus();
		layout.layout(600, 800);
		layout.setVisible(false);
		layout.layout(1_200, 800);
		await new Promise(resolve => browser.window.requestAnimationFrame(resolve));
		assert.equal(JSON.parse(storage.get('sessions.gridState.chat', StorageScope.WORKSPACE)!).widths[0].width, 300, 'Hidden layouts retain their pending saved widths');
		layout.setVisible(true);
		layout.layout(1_200, 800);
		await new Promise(resolve => browser.window.requestAnimationFrame(resolve));
		const stored = JSON.parse(storage.get('sessions.gridState', StorageScope.WORKSPACE)!);
		assert.deepEqual({ widths: [first.bounds!.width, second.bounds!.width], draft: input.value, focus: browser.window.document.activeElement?.tagName, stored: { version: stored.version, ids: stored.groups.map((group: { id: string; }) => group.id), orientation: stored.layout.orientation, sizes: stored.layout.children.map((child: { size: number; }) => child.size) }, code: storage.get('sessions.gridState.code', StorageScope.WORKSPACE), chat: storage.get('sessions.gridState.chat', StorageScope.WORKSPACE) }, {
			widths: [400, 800], draft: 'Unsent text', focus: 'BUTTON', stored: { version: 2, ids: ['first', 'second'], orientation: 'horizontal', sizes: [400, 800] }, code: undefined, chat: undefined,
		});
		layout.layout(150, 800);
		await new Promise(resolve => browser.window.requestAnimationFrame(resolve));
		layout.layout(1_200, 800);
		await new Promise(resolve => browser.window.requestAnimationFrame(resolve));
		assert.deepEqual({ widths: [first.bounds!.width, second.bounds!.width], input: second.element.querySelector('input') }, { widths: [400, 800], input });
	} finally {
		getWindowById(1)?.disposables.dispose();
		browser.window.close();
	}
});

test('Sessions ignores saved widths when every pane has been replaced before its first layout', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test', pretendToBeVisual: true });
	using globals = installEditorTestDom(browser, ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent']);
	try {
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'test', flushInterval: 0 });
		storage.store('sessions.gridState.code', JSON.stringify({ version: 1, widths: [{ id: 'old', width: 900 }] }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		using services = createTestEditorServices(undefined, undefined, browser.window.document, storage);
		const view = new TestView(browser.window.document);
		using layout = services.createInstance(SessionGridLayout, browser.window.document.body, view);
		layout.reconcile([{ id: 'new', view }], 'new');
		await layout.whenReady();
		layout.layout(1_200, 800);
		await new Promise(resolve => browser.window.requestAnimationFrame(resolve));
		assert.equal(view.bounds!.width, 1_200);
		const stored = JSON.parse(storage.get('sessions.gridState', StorageScope.WORKSPACE)!);
		assert.deepEqual({ version: stored.version, ids: stored.groups.map((group: { id: string; }) => group.id) }, { version: 2, ids: ['new'] });
	} finally {
		getWindowById(1)?.disposables.dispose();
		browser.window.close();
	}
});

function savedNestedLayout(): object {
	const leaf = (id: string, size: number) => ({ type: 'leaf', data: { groupId: id }, size, visible: true, priority: 'normal' });
	return {
		version: 2,
		groups: ['first', 'second', 'third'].map(id => ({ groupId: `saved-${id}`, id })),
		layout: {
			type: 'branch', orientation: 'horizontal', size: 1200, priority: 'normal',
			children: [leaf('saved-first', 400), { type: 'branch', orientation: 'vertical', size: 800, priority: 'normal', children: [leaf('saved-second', 200), leaf('saved-third', 400)] }],
		},
	};
}

test('Sessions restores a nested split as providers arrive and retains the complete saved layout until all bindings resolve', async () => {
	const browser = new JSDOM('<!doctype html><body><button>Sidebar</button></body>', { url: 'https://ash.test', pretendToBeVisual: true });
	using globals = installEditorTestDom(browser, ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent']);
	try {
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'test', flushInterval: 0 });
		const saved = savedNestedLayout();
		storage.store('sessions.gridState', JSON.stringify(saved), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		using services = createTestEditorServices(undefined, undefined, browser.window.document, storage);
		const empty = new TestView(browser.window.document);
		const first = new TestView(browser.window.document);
		const second = new TestView(browser.window.document);
		const third = new TestView(browser.window.document);
		using layout = services.createInstance(SessionGridLayout, browser.window.document.body, empty);
		layout.layout(1200, 600);
		await layout.whenReady();
		await new Promise(resolve => browser.window.requestAnimationFrame(resolve));
		assert.deepEqual(JSON.parse(storage.get('sessions.gridState', StorageScope.WORKSPACE)!), saved);
		layout.reconcile([{ id: 'first', view: first }, { id: 'third', view: third }], 'third');
		await layout.whenReady();
		await new Promise(resolve => browser.window.requestAnimationFrame(resolve));
		const input = third.element.querySelector('input')!;
		input.value = 'Keep the live draft';
		input.focus();
		assert.deepEqual(JSON.parse(storage.get('sessions.gridState', StorageScope.WORKSPACE)!), saved);
		layout.reconcile([{ id: 'first', view: first }, { id: 'second', view: second }, { id: 'third', view: third }], 'third');
		await layout.whenReady();
		await new Promise(resolve => browser.window.requestAnimationFrame(resolve));
		assert.deepEqual({ sizes: [first, second, third].map(view => ({ width: view.bounds!.width, height: view.bounds!.height })), focused: browser.window.document.activeElement === input, retained: third.element.querySelector('input') === input, text: input.value }, {
			sizes: [{ width: 400, height: 600 - WorkbenchWindowBarHeight }, { width: 800, height: 200 - WorkbenchWindowBarHeight }, { width: 800, height: 400 - WorkbenchWindowBarHeight }], focused: true, retained: true, text: 'Keep the live draft',
		});
		layout.layout(600, 300);
		await new Promise(resolve => browser.window.requestAnimationFrame(resolve));
		layout.layout(1200, 600);
		await new Promise(resolve => browser.window.requestAnimationFrame(resolve));
		assert.deepEqual([second.bounds!.height, third.bounds!.height], [200 - WorkbenchWindowBarHeight, 400 - WorkbenchWindowBarHeight]);
		layout.reconcile([{ id: 'first', view: first }, { id: 'replacement', view: second }, { id: 'third', view: third }], 'replacement');
		await layout.whenReady();
		const updated = JSON.parse(storage.get('sessions.gridState', StorageScope.WORKSPACE)!);
		assert.deepEqual(updated.groups.map((group: { id: string; }) => group.id), ['first', 'replacement', 'third']);
		assert.equal(updated.layout.children[1].orientation, 'vertical');
	} finally {
		getWindowById(1)?.disposables.dispose();
		browser.window.close();
	}
});

test('invalid stored geometry falls back to a usable conversation without mounting an unknown group', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test', pretendToBeVisual: true });
	using globals = installEditorTestDom(browser, ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent']);
	const warn = console.warn;
	const warnings: unknown[][] = [];
	console.warn = (...args) => { warnings.push(args); };
	try {
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'test', flushInterval: 0 });
		storage.store('sessions.gridState', JSON.stringify({ version: 2, groups: [{ groupId: 'known', id: 'first' }], layout: { type: 'leaf', data: { groupId: 'unknown' }, size: 1000, visible: true, priority: 'normal' } }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		using services = createTestEditorServices(undefined, undefined, browser.window.document, storage);
		const view = new TestView(browser.window.document);
		using layout = services.createInstance(SessionGridLayout, browser.window.document.body, view);
		layout.reconcile([{ id: 'first', view }], 'first');
		await layout.whenReady();
		layout.layout(1000, 600);
		assert.equal(view.bounds!.width, 1000);
		assert.equal(warnings.length, 1);
		assert.equal(JSON.parse(storage.get('sessions.gridState', StorageScope.WORKSPACE)!).groups[0].id, 'first');
	} finally {
		console.warn = warn;
		getWindowById(1)?.disposables.dispose();
		browser.window.close();
	}
});
