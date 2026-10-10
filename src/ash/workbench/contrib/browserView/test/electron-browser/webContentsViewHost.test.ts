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
		second.setVisible(false);
		await settle(() => f.bounds.get('shared')?.x === 10);
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

	test('menus obscure the page and dismissal restores it without taking keyboard focus', async () => {
		using f = fixture();
		const host = f.host(10);
		host.setModel(f.model('page'));
		host.setVisible(true);
		await settle(() => f.visible.get('page') === true);
		f.menuShown.fire();
		await settle(() => f.visible.get('page') === false);
		assert.equal(host.tryFocus(), false);
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
	const service = {
		onDidEvent: events.event,
		layout: async (id: string, value: IBrowserViewBounds) => { bounds.set(id, value); },
		setVisible: async (id: string, value: boolean) => { visible.set(id, value); },
		focus: async (id: string) => { focused.push(id); },
	} as IBrowserViewService;
	const dialogs = store.add(new DialogsModel());
	const instantiation = store.add(new InstantiationService(new ServiceCollection(
		[IBrowserViewService, service],
		[ILogService, new NullLoggerService()],
		[IDialogsModel, dialogs],
		[IContextMenuService, { onDidShowContextMenu: menuShown.event, onDidHideContextMenu: menuHidden.event, showContextMenu() { }, hideContextMenu() { } }],
	)));
	return Object.assign(store, {
		dom, service, events, menuShown, menuHidden, visible, bounds, focused,
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
