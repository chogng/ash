import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, WebContentsView } from 'electron/main';
import { suite, test } from 'mocha';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { promiseWithResolvers } from '../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { BrowserViewStorageScope, type BrowserViewEvent } from '../../common/browserView.js';
import { BrowserViewMainService, IBrowserViewMainService } from '../../electron-main/browserViewMainService.js';
import { AppServerBrowserHost } from '../../../app-server/electron-main/appServerBrowserHost.js';
import { IPlaywrightService } from '../../common/playwrightService.js';
import type { IBrowserViewObservation } from '../../common/browserView.js';

const id = 'browser_target_123e4567-e89b-12d3-a456-426614174000';
const observation = { includeAccessibilityTree: false, includeDomSnapshot: false, includeScreenshot: false };
const agent = { owner: { type: 'agent' as const, sessionId: 'thread-one' }, session: { scope: BrowserViewStorageScope.Agent as const, affinity: 'thread-one' } };
const signal = () => new AbortController().signal;

suite('Browser view ownership and operations', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('construction requires the host page manager', () => {
		using instantiation = new InstantiationService();
		assert.throws(() => instantiation.createInstance(AppServerBrowserHost), /browserViewMainService/);
	});

	test('one id has one page, including simultaneous creation', async () => {
		using f = fixture();
		await Promise.all([f.manager.getOrCreateBrowserView(id, { initialUrl: 'https://example.test/', ...agent }), f.manager.getOrCreateBrowserView(id, { initialUrl: 'https://ignored.test/', ...agent })]);
		assert.deepEqual([f.children.size, f.events.filter(e => e.type === 'created').length, (await f.manager.getState(id)).url], [1, 1, 'https://example.test/']);
	});

	test('layout precedes visibility and follows the host zoom', async () => {
		using f = fixture();
		const page = await f.create();
		await assert.rejects(f.manager.setVisible(id, true), /BrowserTargetNotLaidOut/);
		await f.manager.layout(id, { x: 2, y: 3, width: 400, height: 300 });
		await f.manager.setVisible(id, true);
		assert.deepEqual([page.view.getBounds(), page.getState().visible], [{ x: 4, y: 6, width: 800, height: 600 }, true]);
	});

	test('closing releases the page once, removes listeners and aborts loading observations', async () => {
		using f = fixture();
		const page = await f.create();
		f.loading = true;
		const pending = page.runOperation(signal(), operationSignal => page.waitForLoad(operationSignal));
		await Promise.resolve();
		await f.manager.destroyBrowserView(id);
		await assert.rejects(pending, /BrowserRequestCancelled/);
		page.dispose();
		assert.deepEqual([f.manager.tryGetBrowserView(id), f.children.size, f.contents.eventNames(), f.events.filter(e => e.type === 'closed').length, f.networkReleases], [undefined, 0, [], 1, 0]);
	});

	test('a destroyed Chromium page leaves the manager immediately', async () => {
		using f = fixture();
		await f.create();
		f.contents.emit('destroyed');
		assert.equal(f.manager.tryGetBrowserView(id), undefined);
	});

	test('cancelling a queued operation leaves the next page operation usable', async () => {
		using f = fixture();
		const page = await f.create();
		const started = promiseWithResolvers<void>();
		const finish = promiseWithResolvers<void>();
		f.observe = async pageId => { started.resolve(); await finish.promise; return { targetId: pageId, url: f.url, title: f.title, loading: false }; };
		using host = f.createHost();
		const first = host.observe({ threadId: 'thread-one', targetId: id, ...observation }, { signal: signal() });
		await started.promise;
		const cancellation = new AbortController();
		const second = host.observe({ threadId: 'thread-one', targetId: id, ...observation }, { signal: cancellation.signal });
		cancellation.abort();
		await assert.rejects(second, /BrowserRequestCancelled/);
		const third = host.observe({ threadId: 'thread-one', targetId: id, ...observation }, { signal: signal() });
		finish.resolve();
		await Promise.all([first, third]);
		assert.equal(f.observations.length, 2);
	});

	test('network authority serializes different pages sharing an agent session', async () => {
		using f = fixture();
		await f.create();
		using host = f.createHost();
		const sibling = await host.create({ threadId: 'thread-one', url: 'about:blank' }, { signal: signal() });
		const started = promiseWithResolvers<void>();
		const finish = promiseWithResolvers<void>();
		const order: string[] = [];
		f.observe = async pageId => {
			order.push(pageId);
			if (pageId === id) { started.resolve(); await finish.promise; }
			return { targetId: pageId, url: f.url, title: f.title, loading: false };
		};
		const first = host.observe({ threadId: 'thread-one', targetId: id, networkToken: 'first-tool', ...observation }, { signal: signal() });
		await started.promise;
		const second = host.observe({ threadId: 'thread-one', targetId: sibling.targetId, networkToken: 'second-tool', ...observation }, { signal: signal() });
		await Promise.resolve();
		await Promise.resolve();
		assert.deepEqual(order, [id]);
		finish.resolve();
		await Promise.all([first, second]);
		assert.deepEqual(order, [id, sibling.targetId]);
	});

	test('an observation reads the state after preceding navigation', async () => {
		using f = fixture();
		const page = await f.create();
		const started = promiseWithResolvers<void>();
		const finish = promiseWithResolvers<void>();
		f.load = async url => { started.resolve(); await finish.promise; f.url = url; f.title = 'Loaded page'; };
		const navigation = f.manager.loadURL(id, 'https://example.test/next');
		await started.promise;
		using host = f.createHost();
		const observed = host.observe({ threadId: 'thread-one', targetId: id, ...observation }, { signal: signal() });
		finish.resolve();
		await navigation;
		assert.deepEqual(await observed, { targetId: id, url: 'https://example.test/next', title: 'Loaded page', loading: false });
	});

	test('editor navigation waits until the agent screenshot finishes', async () => {
		using f = fixture();
		const page = await f.create();
		const started = promiseWithResolvers<void>();
		const finish = promiseWithResolvers<void>();
		const order: string[] = [];
		f.observe = async pageId => { order.push('capture'); started.resolve(); await finish.promise; order.push('captured'); return { targetId: pageId, url: f.url, title: f.title, loading: false }; };
		f.load = async url => { order.push('navigate'); f.url = url; };
		using host = f.createHost();
		const observed = host.observe({ threadId: 'thread-one', targetId: id, ...observation, includeScreenshot: true }, { signal: signal() });
		await started.promise;
		const navigation = f.manager.loadURL(id, 'https://example.test/next');
		finish.resolve();
		await Promise.all([observed, navigation]);
		assert.deepEqual(order, ['capture', 'captured', 'navigate']);
	});

	test('navigation replaces a loading page without waiting for its old load', async () => {
		using f = fixture();
		const page = await f.create();
		f.loading = true;
		f.load = async url => { f.url = url; f.loading = false; };
		await page.loadURL('https://example.test/next', signal());
		assert.equal(page.getState().url, 'https://example.test/next');
	});

	test('host cancellation returns before loading finishes and removes its load listener', async () => {
		using f = fixture();
		await f.create();
		f.loading = true;
		using host = f.createHost();
		const routes = host.routes();
		const observe = routes.find(r => r.channel === 'ash:browser-host:observe')!;
		const cancel = routes.find(r => r.channel === 'ash:browser-host:cancel')!;
		const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		const pending = observe.invoke(observe.validate({ id: requestId, params: { threadId: 'thread-one', targetId: id, ...observation } }));
		await Promise.resolve();
		await cancel.invoke(cancel.validate({ id: requestId }));
		await assert.rejects(Promise.resolve(pending), /BrowserRequestCancelled/);
		f.loading = false;
		f.contents.emit('did-stop-loading');
		await host.observe({ threadId: 'thread-one', targetId: id, ...observation }, { signal: signal() });
		assert.equal(f.contents.listenerCount('did-stop-loading'), 1); // The page's state listener remains.
	});

	test('host reset cancels a snapshot before the next Chromium command', async () => {
		using f = fixture();
		await f.create();
		using host = f.createHost();
		const started = promiseWithResolvers<void>();
		const finish = promiseWithResolvers<void>();
		f.observe = async pageId => { started.resolve(); await finish.promise; return { targetId: pageId, url: f.url, title: f.title, loading: false }; };
		const pending = host.observe({ threadId: 'thread-one', targetId: id, includeAccessibilityTree: true, includeDomSnapshot: true, includeScreenshot: false }, { signal: signal() });
		await started.promise;
		host.reset();
		await assert.rejects(pending, /BrowserRequestCancelled/);
		finish.resolve();
		await host.observe({ threadId: 'thread-one', targetId: id, ...observation }, { signal: signal() });
		assert.equal(f.cancelled.length, 1);
	});

	test('host reset closes its pages while retaining the user page', async () => {
		using f = fixture();
		await f.manager.getOrCreateBrowserView(id, { initialUrl: 'about:blank', owner: { type: 'user' }, session: { scope: BrowserViewStorageScope.Workspace } });
		using host = f.createHost();
		const created = await host.create({ threadId: 'thread-one', url: 'about:blank' }, { signal: signal() });
		host.reset(); host.reset();
		assert.deepEqual([f.manager.tryGetBrowserView(created.targetId), f.manager.tryGetBrowserView(id)?.id], [undefined, id]);
	});

	test('retiring the manager releases a pending network owner without creating a page', async () => {
		using f = fixture();
		const started = promiseWithResolvers<void>();
		const finish = promiseWithResolvers<void>();
		f.remote = true;
		f.proxy = async () => { started.resolve(); await finish.promise; return { localPort: 1234, signal: signal(), ...toDisposable(() => { f.networkReleases++; }) }; };
		const pending = f.manager.createTarget('about:blank', 'thread-one', signal());
		await started.promise;
		f.manager.dispose();
		finish.resolve();
		await assert.rejects(pending, /BrowserCapabilityUnavailable/);
		assert.deepEqual([f.children.size, f.networkReleases], [0, 1]);
	});

	test('retiring the host during creation releases its late network owner', async () => {
		using f = fixture();
		using host = f.createHost();
		const started = promiseWithResolvers<void>();
		const finish = promiseWithResolvers<void>();
		f.remote = true;
		f.proxy = async () => { started.resolve(); await finish.promise; return { localPort: 1234, signal: signal(), ...toDisposable(() => { f.networkReleases++; }) }; };
		const pending = host.create({ threadId: 'thread-one', url: 'about:blank' }, { signal: signal() });
		await started.promise;
		host.dispose();
		finish.resolve();
		await assert.rejects(pending, /BrowserCapabilityUnavailable/);
		assert.deepEqual([f.children.size, f.networkReleases], [0, 1]);
	});

	test('agent threads share their own storage and cannot read, drive or close another thread page', async () => {
		using f = fixture();
		using host = f.createHost();
		const first = await host.create({ threadId: 'thread-one', url: 'about:blank' }, { signal: signal() });
		const sibling = await host.create({ threadId: 'thread-one', url: 'about:blank' }, { signal: signal() });
		const other = await host.create({ threadId: 'thread-two', url: 'about:blank' }, { signal: signal() });
		const firstSession = f.manager.tryGetBrowserView(first.targetId)!.session;
		assert.equal(firstSession, f.manager.tryGetBrowserView(sibling.targetId)!.session);
		assert.notEqual(firstSession, f.manager.tryGetBrowserView(other.targetId)!.session);
		assert.throws(() => host.observe({ threadId: 'thread-two', targetId: first.targetId, ...observation }, { signal: signal() }), /BrowserTargetAccessDenied/);
		await assert.rejects(host.perform({ threadId: 'thread-two', action: { type: 'reload', targetId: first.targetId } }, { signal: signal() }), /BrowserTargetAccessDenied/);
		await assert.rejects(host.close({ threadId: 'thread-two', targetId: first.targetId }), /BrowserTargetAccessDenied/);
		assert.equal(f.manager.tryGetBrowserView(first.targetId)?.id, first.targetId);
	});

	test('user storage is workspace scoped and user pages are private from agents', async () => {
		using f = fixture();
		using host = f.createHost();
		await f.manager.getOrCreateBrowserView(id, { initialUrl: 'about:blank', owner: { type: 'user' }, session: { scope: BrowserViewStorageScope.Workspace } });
		assert.throws(() => host.observe({ threadId: 'thread-one', targetId: id, ...observation }, { signal: signal() }), /BrowserTargetAccessDenied/);
		assert.ok([...f.partitions.keys()].every(partition => partition.startsWith('persist:')));
	});
});

test('sharing grants only the chosen thread and revocation cancels its operation without closing the user page', async () => {
	using f = fixture();
	using host = f.createHost();
	await f.manager.getOrCreateBrowserView(id, { initialUrl: 'about:blank', owner: { type: 'user' }, session: { scope: BrowserViewStorageScope.Workspace } });
	await f.manager.setSharing(id, ['thread-one']);
	await assert.rejects(host.perform({ threadId: 'thread-one', action: { type: 'reload', targetId: id } }, { signal: signal() }), /BrowserNetworkIsolationRequired/);
	await assert.rejects(host.close({ threadId: 'thread-one', targetId: id }), /BrowserNetworkIsolationRequired/);
	assert.throws(() => host.observe({ threadId: 'thread-two', targetId: id, ...observation }, { signal: signal() }), /BrowserTargetAccessDenied/);
	const started = promiseWithResolvers<void>();
	const finish = promiseWithResolvers<void>();
	f.observe = async pageId => { started.resolve(); await finish.promise; return { targetId: pageId, url: f.url, title: f.title, loading: false }; };
	const pending = host.observe({ threadId: 'thread-one', targetId: id, ...observation }, { signal: signal() });
	await started.promise;
	await f.manager.setSharing(id, []);
	await assert.rejects(pending, /BrowserRequestCancelled/);
	assert.equal(f.cancelled.length, 1);
	finish.resolve();
	assert.throws(() => host.observe({ threadId: 'thread-one', targetId: id, ...observation }, { signal: signal() }), /BrowserTargetAccessDenied/);
	assert.ok(f.manager.tryGetBrowserView(id));
	await f.manager.setSharing(id, ['thread-one']);
	host.reset();
	assert.deepEqual(await f.manager.getSharing(id), []);
	assert.ok(f.manager.tryGetBrowserView(id));
});

export function fixture() {
	const store = new DisposableStore();
	const events: BrowserViewEvent[] = [];
	const children = new Set<WebContentsView>();
	const contents = new EventEmitter();
	const partitions = new Map<string, Electron.Session>();
	const f = {
		[Symbol.dispose]: () => store.dispose(), events, children, contents, partitions,
		url: '', title: 'Example', loading: false, attached: false, networkReleases: 0,
		commands: [] as Array<{ method: string; params: unknown; }>,
		observations: [] as string[], cancelled: [] as string[], retired: [] as string[],
		observe: async (pageId: string): Promise<IBrowserViewObservation> => ({ targetId: pageId, url: f.url, title: f.title, loading: f.loading }),
		command: async (_method: string, _params?: unknown): Promise<unknown> => ({}),
		load: async (url: string): Promise<void> => { f.url = url; },
		capture: async () => ({ toPNG: () => Buffer.from('png') }),
		remote: false,
		proxy: async () => ({ localPort: 1234, signal: signal(), ...toDisposable(() => { f.networkReleases++; }) }),
	};
	const window = { id: 1, contentView: { addChildView: (view: WebContentsView) => children.add(view), removeChildView: (view: WebContentsView) => children.delete(view) }, webContents: { getZoomFactor: () => 2, focus: () => { } }, isDestroyed: () => false } as unknown as BrowserWindow;
	const instantiation = store.add(new InstantiationService());
	const manager = store.add(instantiation.createInstance(BrowserViewMainService, {
		window, getWorkspaceId: () => 'workspace-one',
		getRemoteNetwork() { return f.remote ? { authority: 'ssh-remote+test', tunnels: { openProxy: () => f.proxy() } as unknown as import('../../../remote/electron-main/sshRemoteTunnelService.js').SshRemoteTunnelService } : undefined; }, createSession: (partition: string) => {
			let session = partitions.get(partition);
			if (!session) {
				session = Object.assign(new EventEmitter(), { webRequest: { onBeforeRequest: () => {} }, setPermissionCheckHandler: () => { }, setPermissionRequestHandler: () => { }, setDevicePermissionHandler: () => { }, setProxy: async () => { }, closeAllConnections: async () => { } }) as unknown as Electron.Session;
				partitions.set(partition, session);
			}
			return session;
		}, createView: (browserStorage: Electron.Session) => {
			const chromiumId = 'chromium-target-' + children.size;
			const pageContents = children.size === 0 ? contents : new EventEmitter();
			let destroyed = false;
			let bounds = { x: 0, y: 0, width: 0, height: 0 };
			Object.assign(pageContents, {
				id: children.size + 1,
				setWebRTCIPHandlingPolicy: () => { },
				session: browserStorage,
				setWindowOpenHandler: () => { }, isDestroyed: () => destroyed, isLoading: () => f.loading,
				getURL: () => f.url, getTitle: () => f.title, focus: () => { }, stop: () => { f.loading = false; }, reload: () => { },
				navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack: () => { }, goForward: () => { } },
				loadURL: (url: string) => f.load(url), capturePage: () => f.capture(),
				close: () => { destroyed = true; pageContents.emit('destroyed'); },
				debugger: Object.assign(new EventEmitter(), { isAttached: () => f.attached, attach: () => { f.attached = true; }, detach: () => { f.attached = false; }, sendCommand: (method: string, params?: unknown) => { f.commands.push({ method, params }); return method === 'Target.getTargetInfo' ? Promise.resolve({ targetInfo: { targetId: chromiumId } }) : f.command(method, params); } }),
			});
			return { webContents: pageContents, setVisible: () => { }, setBounds: (value: typeof bounds) => { bounds = value; }, getBounds: () => bounds } as unknown as WebContentsView;
		},
	}));
	instantiation.registerInstance(IBrowserViewMainService, manager);
	instantiation.registerInstance(IPlaywrightService, {
		getObservation: async (_operationId, _sessionId, pageId) => { f.observations.push(pageId); return f.observe(pageId); },
		performAction: async () => { },
		cancelOperation: async operationId => { f.cancelled.push(operationId); },
		disposeSession: async sessionId => { f.retired.push(sessionId); },
	});
	store.add(manager.onDidEvent(event => events.push(event)));
	return Object.assign(f, { manager, instantiation, store, createHost: () => instantiation.createInstance(AppServerBrowserHost), create: async () => { await manager.getOrCreateBrowserView(id, { initialUrl: 'https://example.test/', ...agent }); return manager.tryGetBrowserView(id)!; } });
}
