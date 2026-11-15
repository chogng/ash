import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IBrowserViewService, BrowserViewStorageScope, type BrowserViewEvent, type IBrowserViewBounds } from '../../../../../platform/browserView/common/browserView.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { DialogsModel, IDialogsModel } from '../../../../common/dialogs.js';
import { BrowserViewModel } from '../../common/browserView.js';
import { WebContentsViewHost } from '../../electron-browser/webContentsViewHost.js';

suite('Browser page presentation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	for (const detached of [true, false]) {
		test(`${detached ? 'closing' : 'attached'} page handles a late unavailable presentation response`, async () => {
			using f = fixture();
			const pending = promiseWithResolvers<void>();
			const started = promiseWithResolvers<void>();
			f.service.setVisible = async () => { started.resolve(); await pending.promise; throw new Error('BrowserTargetUnavailable'); };
			const host = f.host(10);
			host.setModel(f.model('page'));
			host.setVisible(true);
			await started.promise;
			if (detached) host.setModel(undefined);
			pending.resolve();
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(f.errors.length, detached ? 0 : 1);
		});
	}

	test('unchanged presentation does not resend native commands or steal focus', async () => {
		using f = fixture();
		let layouts = 0;
		let visibilityChanges = 0;
		const layout = f.service.layout;
		const setVisible = f.service.setVisible;
		f.service.layout = async (...args) => { layouts++; await layout(...args); };
		f.service.setVisible = async (...args) => { visibilityChanges++; await setVisible(...args); };
		const host = f.host(10);
		host.setModel(f.model('page'));
		host.setVisible(true);
		await settle(() => f.visible.get('page') === true);
		for (let i = 0; i < 30; i++) {
			host.setVisible(true);
			host.layout();
			await new Promise(resolve => setImmediate(resolve));
		}
		assert.deepEqual([layouts, visibilityChanges, f.focused], [1, 1, []]);
		assert.equal(host.tryFocus(), true);
		await settle(() => f.focused.length === 1);
		assert.deepEqual([layouts, visibilityChanges], [1, 1]);
	});

	test('Workbench zoom repositions an unchanged CSS viewport', async () => {
		using f = fixture();
		let layouts = 0;
		const layout = f.service.layout;
		f.service.layout = async (...args) => { layouts++; await layout(...args); };
		const host = f.host(10);
		host.setModel(f.model('page'));
		host.setVisible(true);
		await settle(() => f.visible.get('page') === true);
		Object.defineProperty(f.dom.window, 'devicePixelRatio', { value: 1.2 });
		host.layout();
		await settle(() => layouts === 2);
		assert.deepEqual(f.bounds.get('page'), { x: 10, y: 20, width: 300, height: 200 });
	});

	test('Main hiding a page invalidates presentation without requiring changed bounds', async () => {
		using f = fixture();
		const host = f.host(10);
		const model = f.model('page');
		host.setModel(model);
		host.setVisible(true);
		await settle(() => f.visible.get('page') === true);
		f.visible.set('page', false);
		f.events.fire({ type: 'stateChanged', state: { ...model.state, visible: false } });
		host.setVisible(true);
		await settle(() => f.visible.get('page') === true);
	});

	test('switching the host input hides the previous page and presents the new one', async () => {
		using f = fixture();
		const host = f.host(10);
		host.setModel(f.model('first'));
		host.setVisible(true);
		await settle(() => f.visible.get('first') === true);
		host.setModel(f.model('second'));
		await settle(() => f.visible.get('first') === false && f.visible.get('second') === true);
		assert.deepEqual([...f.visible], [['first', false], ['second', true]]);
	});

	test('the remaining split takes over when the current host hides or is disposed', async () => {
		using f = fixture();
		const model = f.model('shared');
		const first = f.host(10);
		const second = f.host(400);
		first.setModel(model);
		first.setVisible(true);
		second.setModel(model);
		second.setVisible(true);
		await settle(() => f.bounds.get('shared')?.x === 400 && f.visible.get('shared') === true);
		assert.deepEqual([first.isActive, second.isActive], [false, true]);
		first.setVisible(true);
		await settle(() => f.bounds.get('shared')?.x === 10);
		second.setVisible(true);
		await settle(() => f.bounds.get('shared')?.x === 400);
		second.setVisible(false);
		await settle(() => f.bounds.get('shared')?.x === 10);
		assert.deepEqual([first.isActive, second.isActive], [true, false]);
		second.setVisible(true);
		await settle(() => f.bounds.get('shared')?.x === 400);
		second.dispose();
		await settle(() => f.bounds.get('shared')?.x === 10);
		first.dispose();
		await settle(() => f.visible.get('shared') === false);
		assert.deepEqual([f.bounds.get('shared'), f.visible.get('shared')], [{ x: 10, y: 20, width: 300, height: 200 }, false]);
	});

	test('an input switch while positioning is pending cannot focus or retain the old page', async () => {
		using f = fixture();
		const pending = promiseWithResolvers<void>();
		const started = promiseWithResolvers<void>();
		f.service.layout = async (id, bounds) => {
			if (id === 'first') { started.resolve(); await pending.promise; }
			f.bounds.set(id, bounds);
		};
		const host = f.host(10);
		host.setModel(f.model('first'));
		host.setVisible(true);
		host.tryFocus();
		await started.promise;
		host.setModel(f.model('second'));
		pending.resolve();
		await settle(() => f.visible.get('first') === false && f.visible.get('second') === true);
		assert.deepEqual(f.focused, []);
	});

	test('a page closed while positioning is pending receives no later visibility or focus command', async () => {
		using f = fixture();
		const pending = promiseWithResolvers<void>();
		const started = promiseWithResolvers<void>();
		f.service.layout = async () => { started.resolve(); await pending.promise; };
		const host = f.host(10);
		host.setModel(f.model('closed'));
		host.setVisible(true);
		host.tryFocus();
		await started.promise;
		f.events.fire({ type: 'closed', targetId: 'closed' });
		pending.resolve();
		await Promise.resolve();
		await Promise.resolve();
		assert.deepEqual([host.tryFocus(), [...f.visible], f.focused], [false, [], []]);
	});

	test('a restored pane detects overlays added while it was hidden', async () => {
		using f = fixture();
		const host = f.host(10);
		host.setModel(f.model('page'));
		host.setVisible(true);
		await settle(() => f.visible.get('page') === true);
		host.setVisible(false);
		await settle(() => f.visible.get('page') === false);
		const overlay = f.dom.window.document.createElement('div');
		overlay.className = 'ash-context-view';
		overlay.getBoundingClientRect = () => new f.dom.window.DOMRect(20, 20, 100, 100);
		f.dom.window.document.body.append(overlay);
		await new Promise(resolve => setImmediate(resolve));
		host.setVisible(true);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(f.visible.get('page'), false);
		assert.equal(host.tryFocus(), false);
		overlay.remove();
		await settle(() => f.visible.get('page') === true);
	});

	test('native menus keep the page visible while overlapping DOM menus obscure it', async () => {
		using f = fixture();
		const host = f.host(10);
		host.setModel(f.model('page'));
		host.setVisible(true);
		await settle(() => f.visible.get('page') === true);
		f.menuShown.fire();
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(f.visible.get('page'), true);
		const menu = f.dom.window.document.createElement('div');
		menu.className = 'ash-context-view';
		menu.getBoundingClientRect = () => new f.dom.window.DOMRect(20, 20, 100, 100);
		f.dom.window.document.body.append(menu);
		await settle(() => f.visible.get('page') === false);
		assert.equal(host.tryFocus(), false);
		menu.remove();
		f.menuHidden.fire();
		await settle(() => f.visible.get('page') === true);
		assert.deepEqual(f.focused, []);
	});

	test('only an overlapping visible notification obscures the page', async () => {
		using f = fixture();
		const host = f.host(10);
		host.setModel(f.model('page'));
		host.setVisible(true);
		await settle(() => f.visible.get('page') === true);
		const notification = f.dom.window.document.createElement('div');
		notification.className = 'ash-notification';
		let left = 600;
		notification.getBoundingClientRect = () => new f.dom.window.DOMRect(left, 20, 100, 100);
		f.dom.window.document.body.append(notification);
		await Promise.resolve();
		assert.equal(f.visible.get('page'), true);
		left = 20;
		notification.style.left = '20px';
		await settle(() => f.visible.get('page') === false);
		notification.hidden = true;
		await settle(() => f.visible.get('page') === true);
		assert.deepEqual(f.focused, []);
	});

	test('a DOM menu outside the page still obscures it through its pointer shield', async () => {
		using f = fixture();
		const host = f.host(10);
		host.setModel(f.model('page'));
		host.setVisible(true);
		await settle(() => f.visible.get('page') === true);
		const menu = f.dom.window.document.createElement('div');
		menu.className = 'ash-context-view';
		menu.getBoundingClientRect = () => new f.dom.window.DOMRect(600, 20, 100, 100);
		f.dom.window.document.body.append(menu);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(f.visible.get('page'), true);
		const shield = f.dom.window.document.createElement('div');
		shield.className = 'ash-context-view-pointer-shield';
		shield.getBoundingClientRect = () => new f.dom.window.DOMRect(0, 0, 1000, 800);
		menu.append(shield);
		f.menuShown.fire();
		await settle(() => f.visible.get('page') === false);
		assert.equal(host.tryFocus(), false);
		menu.remove();
		f.menuHidden.fire();
		await settle(() => f.visible.get('page') === true);
		assert.deepEqual(f.focused, []);
	});
});

function fixture(): DisposableStore & {
	dom: JSDOM;
	service: IBrowserViewService;
	events: Emitter<BrowserViewEvent>;
	menuShown: Emitter<void>;
	menuHidden: Emitter<void>;
	visible: Map<string, boolean>;
	bounds: Map<string, IBrowserViewBounds>;
	focused: string[];
	errors: unknown[];
	model(id: string): BrowserViewModel;
	host(left: number): WebContentsViewHost;
} {
	const store = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body></body>');
	store.add(toDisposable(() => dom.window.close()));
	const targetWindow = dom.window as unknown as Window & typeof globalThis;
	targetWindow.ResizeObserver = class implements ResizeObserver {
		public observe(): void { }
		public unobserve(): void { }
		public disconnect(): void { }
	};
	const events = store.add(new Emitter<BrowserViewEvent>());
	const menuShown = store.add(new Emitter<void>());
	const menuHidden = store.add(new Emitter<void>());
	const visible = new Map<string, boolean>();
	const bounds = new Map<string, IBrowserViewBounds>();
	const focused: string[] = [];
	const errors: unknown[] = [];
	const service = {
		onDidEvent: events.event,
		layout: async (id: string, value: IBrowserViewBounds) => { bounds.set(id, value); },
		setVisible: async (id: string, value: boolean) => { visible.set(id, value); },
		focus: async (id: string) => { focused.push(id); },
	} as IBrowserViewService;
	const dialogs = store.add(new DialogsModel());
	const instantiation = store.add(new InstantiationService(new ServiceCollection(
		[IBrowserViewService, service],
		[ILogService, new class extends NullLoggerService {
			override error(_category: string | Error, message?: unknown): void { errors.push(message); }
		}()],
		[IDialogsModel, dialogs],
		[IContextMenuService, { onDidShowContextMenu: menuShown.event, onDidHideContextMenu: menuHidden.event, showContextMenu() { }, hideContextMenu() { } }],
	)));
	return Object.assign(store, {
		dom, service, events, menuShown, menuHidden, visible, bounds, focused, errors,
		model: (id: string) => store.add(instantiation.createInstance(BrowserViewModel, {
			id, host: { windowId: 1 }, owner: { type: 'user' }, session: { scope: BrowserViewStorageScope.Workspace },
			state: { targetId: id, url: 'https://example.test/', title: id, loading: false, visible: false, canGoBack: false, canGoForward: false },
		})),
		host: (left: number) => {
			const container = dom.window.document.createElement('div');
			container.tabIndex = 0;
			container.getBoundingClientRect = () => new dom.window.DOMRect(left, 20, 300, 200);
			dom.window.document.body.append(container);
			const host = store.add(instantiation.createInstance(WebContentsViewHost, targetWindow));
			host.onContainerCreated(container);
			return host;
		},
	});
}

async function settle(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50 && !condition(); attempt++) { await Promise.resolve(); }
	assert.equal(condition(), true, 'Expected the presentation command to finish');
}
