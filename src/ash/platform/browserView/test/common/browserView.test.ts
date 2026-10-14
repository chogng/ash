import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter } from '../../../../base/common/event.js';
import type { VSBuffer } from '../../../../base/common/buffer.js';
import { IPCClient, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import {
	normalizeBrowserViewUrl, BrowserViewStorageScope,
	validateBrowserViewCreateRequest,
	validateBrowserViewLayoutRequest,
	validateBrowserViewNavigateRequest,
	validateBrowserViewVisibilityRequest,
	type IBrowserViewState, type BrowserViewEvent, type IBrowserViewService,
} from "../../../../platform/browserView/common/browserView.js";
import {
	browserViewChannel
} from "../../../../platform/browserView/electron-main/browserViewIpc.js";

const options = { initialUrl: 'https://example.com/', owner: { type: 'user' as const }, session: { scope: BrowserViewStorageScope.Workspace as const } };
const targetId = "browser_target_123e4567-e89b-12d3-a456-426614174000";

test("browser view validators admit secure and loopback navigation", () => {
	assert.equal(
		normalizeBrowserViewUrl("https://example.com/path"),
		"https://example.com/path",
	);
	assert.equal(
		normalizeBrowserViewUrl("http://localhost:3000/path"),
		"http://localhost:3000/path",
	);
	assert.equal(normalizeBrowserViewUrl("about:blank"), "about:blank");
	assert.deepEqual(validateBrowserViewCreateRequest({ targetId, options }), { targetId, options });
	assert.deepEqual(
		validateBrowserViewNavigateRequest({
			targetId,
			url: "https://example.com",
		}),
		{
			targetId,
			url: "https://example.com/",
		},
	);
});

test("browser view validators reject privileged URLs and malformed geometry", () => {
	for (
		const url of [
			"http://example.com",
			"file:///secret.txt",
			"javascript:alert(1)",
			"https://user:password@example.com",
		]
	) {
		assert.throws(() => normalizeBrowserViewUrl(url));
	}
	assert.throws(() =>
		validateBrowserViewCreateRequest({
			targetId,
			url: "https://example.com",
			preload: "unsafe.js",
		})
	);
	assert.throws(() =>
		validateBrowserViewLayoutRequest({
			targetId,
			bounds: { x: 0, y: 0, width: 0, height: 600 },
		})
	);
	assert.throws(() =>
		validateBrowserViewLayoutRequest({
			targetId,
			bounds: { x: 0.5, y: 0, width: 800, height: 600 },
		})
	);
	assert.throws(() =>
		validateBrowserViewVisibilityRequest({
			targetId: "not-a-target",
			visible: true,
		})
	);
});

test("browser view proxies preserve validated commands, subscriptions and backend sharing across IPC", async () => {
	const calls: string[] = [];
	using events = new Emitter<BrowserViewEvent>();
	const received: BrowserViewEvent[] = [];
	const state: IBrowserViewState = {
		targetId,
		url: "https://example.com/",
		title: "",
		loading: true,
		canGoBack: false,
		canGoForward: false,
		visible: false,
	};
	const service: Parameters<typeof browserViewChannel>[0] = {
		getBrowserHistory: async () => ({ items: [] }), deleteBrowserHistory: async () => { },
		getSharing: async () => [], setSharing: async () => { throw new Error('Sharing must pass through the backend'); },
		onDidEvent: events.event,
		respondToPermission: async () => { }, clearPermissions: async () => { }, cancelDownloads: async () => { },
		getBrowserViews: async () => [],
		getOrCreateBrowserView: async () => {
			calls.push("create");
			return { id: targetId, host: { windowId: 1 }, owner: options.owner, session: options.session, state };
		},
		getState: async () => state,
		layout: async () => { calls.push("layout"); },
		setVisible: async () => { calls.push("visibility"); },
		loadURL: async () => {
			calls.push("navigate");
		},
		goBack: async () => { calls.push("back"); },
		goForward: async () => { calls.push("forward"); },
		reload: async () => { calls.push("reload"); },
		stop: async () => { calls.push("stop"); },
		focus: async () => { calls.push("focus"); },
		destroyBrowserView: async () => { calls.push("close"); },
	};
	const grants: unknown[] = [];
	const channel = browserViewChannel(service, {
		call: async <T>(command: string, arg: unknown): Promise<T> => {
			grants.push({ command, arg });
			throw new Error('Backend authorization denied');
		},
		listen: () => { throw new Error('Unexpected sharing event'); },
	});
	using toMain = new Emitter<VSBuffer>();
	using toRenderer = new Emitter<VSBuffer>();
	using main = new IPCClient({ onMessage: toMain.event, send: buffer => toRenderer.fire(buffer) }, 'window:1');
	using renderer = new IPCClient({ onMessage: toRenderer.event, send: buffer => toMain.fire(buffer) }, 'main');
	main.registerChannel('browserView', channel);
	const proxy = ProxyChannel.toService<IBrowserViewService>(renderer.getChannel('browserView'));
	assert.deepEqual(await proxy.getBrowserViews(), []);
	assert.deepEqual(await proxy.getOrCreateBrowserView(targetId, options), { id: targetId, host: { windowId: 1 }, owner: options.owner, session: options.session, state });
	await proxy.layout(targetId, { x: -10, y: 20, width: 800, height: 600 });
	await proxy.setVisible(targetId, true);
	await proxy.loadURL(targetId, 'https://example.com/next');
	await proxy.deleteBrowserHistory(targetId);
	await proxy.deleteBrowserHistory(targetId, undefined);
	assert.deepEqual(calls, ['create', 'layout', 'visibility', 'navigate']);

	const subscription = proxy.onDidEvent(event => received.push(event));
	events.fire({ type: 'closed', targetId });
	subscription.dispose();
	events.fire({ type: 'closed', targetId });
	assert.deepEqual(received, [{ type: 'closed', targetId }]);

	await assert.rejects(proxy.setSharing(targetId, ['thread-one']), /Backend authorization denied/);
	assert.deepEqual(grants, [{ command: 'setSharing', arg: [targetId, ['thread-one']] }]);
	await assert.rejects(proxy.loadURL(targetId, 'file:///secret.txt'));
	await assert.rejects(channel.call('window:1', 'getBrowserViews', [targetId]), /Invalid browser view arguments/);
	await assert.rejects(channel.call('window:1', 'loadURL', [targetId]), /Invalid browser view arguments/);
	await assert.rejects(channel.call('window:1', 'disposeCore', []), /Unknown browser view command/);
	assert.throws(() => channel.listen('window:1', 'disposeCore'), /Unknown browser view event/);
	assert.deepEqual(calls, ['create', 'layout', 'visibility', 'navigate']);
});
