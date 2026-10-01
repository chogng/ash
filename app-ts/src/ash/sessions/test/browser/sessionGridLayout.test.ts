import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IPositionedRectangle } from '../../../base/browser/geometry.js';
import type { IView } from '../../../base/browser/ui/grid/grid.js';
import { installEditorTestDom } from '../../../editor/test/browser/editorTestGlobals.js';
import { SessionGridLayout } from '../../browser/parts/sessionGridLayout.js';
import { ServiceContainer } from '../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';

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

test('Sessions split insertion preserves an unrelated pane and retained input focus', () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	using globals = installEditorTestDom(browser, ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent']);
	const document = browser.window.document;
	const first = new TestView(document);
	const second = new TestView(document);
	const third = new TestView(document);
	try {
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, applicationId: 'grid-test', workspaceId: 'test', flushInterval: 0 });
		using services = new ServiceContainer();
		services.registerInstance(IStorageService, storage);
		using layout = services.createInstance(SessionGridLayout, document.body, first, 'chat');
		layout.reconcile([{ id: 'first', view: first }, { id: 'second', view: second }], 'first');
		layout.layout(1_200, 800);
		const firstBounds = first.bounds;
		first.element.querySelector('input')!.focus();
		layout.reconcile([{ id: 'first', view: first }, { id: 'second', view: second }, { id: 'third', view: third }], 'first');
		layout.layout(1_200, 800);
		assert.deepEqual({ bounds: first.bounds, focused: document.activeElement }, { bounds: firstBounds, focused: first.element.querySelector('input') });
		const beforeMaterialization = [first.bounds, second.bounds, third.bounds];
		layout.reconcile([{ id: 'durable-first', view: first }, { id: 'second', view: second }, { id: 'third', view: third }], 'durable-first');
		assert.deepEqual([first.bounds, second.bounds, third.bounds], beforeMaterialization);
	} finally {
		browser.window.close();
	}
});

test('Sessions rearrangement keeps live inputs and does not steal focus from another region', () => {
	const browser = new JSDOM('<!doctype html><body><button>Sidebar</button></body>', { url: 'https://ash.test' });
	using globals = installEditorTestDom(browser, ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent']);
	const document = browser.window.document;
	const first = new TestView(document);
	const second = new TestView(document);
	try {
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, applicationId: 'grid-test', workspaceId: 'test', flushInterval: 0 });
		using services = new ServiceContainer();
		services.registerInstance(IStorageService, storage);
		using layout = services.createInstance(SessionGridLayout, document.body, first, 'chat');
		layout.reconcile([{ id: 'first', view: first }, { id: 'second', view: second }], 'first');
		layout.layout(1_200, 800);
		first.element.querySelector('input')!.value = 'Unsent text';
		const sidebar = document.querySelector('button')!;
		sidebar.focus();
		layout.reconcile([{ id: 'second', view: second }, { id: 'first', view: first }], 'first');
		assert.deepEqual({ focused: document.activeElement, input: first.element.querySelector('input')!.value }, { focused: sidebar, input: 'Unsent text' });
		layout.reconcile([{ id: 'first', view: first }], 'first');
		assert.equal(second.element.isConnected, false);
		assert.equal(first.element.isConnected, true);
	} finally {
		browser.window.close();
	}
});

test('Sessions restores saved widths at the available size without reviving missing panes or changing another page', async () => {
	const browser = new JSDOM('<!doctype html><body><button>Sidebar</button></body>', { url: 'https://ash.test' });
	using globals = installEditorTestDom(browser, ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent']);
	try {
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, applicationId: 'grid-test', workspaceId: 'test', flushInterval: 0 });
		storage.store('sessions.gridState.chat', JSON.stringify({ version: 1, widths: [{ id: 'first', width: 300 }, { id: 'missing', width: 200 }, { id: 'second', width: 600 }] }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		storage.store('sessions.gridState.code', JSON.stringify({ version: 1, widths: [{ id: 'code', width: 900 }] }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		using services = new ServiceContainer();
		services.registerInstance(IStorageService, storage);
		const first = new TestView(browser.window.document);
		const second = new TestView(browser.window.document);
		using layout = services.createInstance(SessionGridLayout, browser.window.document.body, first, 'chat');
		layout.layout(0, 0);
		layout.reconcile([{ id: 'first', view: first }, { id: 'second', view: second }], 'second');
		const input = second.element.querySelector('input')!;
		input.value = 'Unsent text';
		browser.window.document.querySelector('button')!.focus();
		layout.layout(1_200, 800);
		await storage.flush();
		assert.deepEqual({ widths: [first.bounds!.width, second.bounds!.width], draft: input.value, focus: browser.window.document.activeElement?.tagName, stored: JSON.parse(storage.get('sessions.gridState.chat', StorageScope.WORKSPACE)!), code: JSON.parse(storage.get('sessions.gridState.code', StorageScope.WORKSPACE)!) }, {
			widths: [400, 800], draft: 'Unsent text', focus: 'BUTTON', stored: { version: 1, widths: [{ id: 'first', width: 400 }, { id: 'second', width: 800 }] }, code: { version: 1, widths: [{ id: 'code', width: 900 }] },
		});
	} finally {
		browser.window.close();
	}
});
