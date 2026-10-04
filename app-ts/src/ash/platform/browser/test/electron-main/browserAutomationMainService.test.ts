import assert from "node:assert/strict";
import { suite, test } from "mocha";
import { EventEmitter } from 'node:events';
import { BrowserAutomationMainService } from "../../../../platform/browser/electron-main/browserAutomationMainService.js";
import type { IBrowserViewMainService } from "../../../../platform/browser/electron-main/browserViewIpc.js";
import { BrowserTargetRegistry, type BrowserTargetView } from "../../../../platform/browser/electron-main/browserTargetRegistry.js";
import { promiseWithResolvers } from '../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { BrowserAutomationHost } from '../../electron-main/browserAutomationHostRoutes.js';
import { decodeAppServerServerRequestResult } from '../../../app-server/common/generated/AppServerProtocolDecoder.js';

const targetId = "browser_target_123e4567-e89b-12d3-a456-426614174000";

suite('Browser automation lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test("browser automation observes and operates the registered WebContents target", async () => {
		const commands: Array<{ method: string; params: unknown }> = [];
		let attached = false;
		const debuggerClient = {
			isAttached: () => attached,
			attach: () => {
				attached = true;
			},
			detach: () => {
				attached = false;
			},
			sendCommand: async (method: string, params?: unknown) => {
				commands.push({ method, params });
				if (method === "Accessibility.getFullAXTree") return { nodes: [{ backendDOMNodeId: 42 }] };
				if (method === "DOMSnapshot.captureSnapshot") return { documents: [] };
				if (method === "DOM.resolveNode") return { object: { objectId: "remote-1" } };
				if (method === "Runtime.callFunctionOn") return { result: { value: { x: 10, y: 20 } } };
				return {};
			},
		};
		const view = {
			webContents: Object.assign(new EventEmitter(), {
				debugger: debuggerClient,
				isDestroyed: () => false,
				isLoading: () => false,
				capturePage: async () => ({ toPNG: () => Buffer.from("png") }),
			}),
			getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
		} as BrowserTargetView;
		const registry = new BrowserTargetRegistry();
		registry.register(targetId, view);
		const browserViews = browserViewService();
		const service = new BrowserAutomationMainService();
		using binding = service.bind(browserViews, registry);

		const observed = await service.observe({
			targetId,
			includeAccessibilityTree: true,
			includeDomSnapshot: true,
			includeScreenshot: true,
		}, { signal: new AbortController().signal });
		assert.equal(observed.targetId, targetId);
		assert.match(observed.accessibilityTree ?? "", /backendDOMNodeId/);
		assert.equal(observed.screenshot?.dataBase64, Buffer.from("png").toString("base64"));
		assert.equal(attached, false);
		const summary = await service.observe({ targetId, includeAccessibilityTree: false, includeDomSnapshot: false, includeScreenshot: false }, requestContext());
		assert.deepEqual(decodeAppServerServerRequestResult('browser/observe', summary), summary);
		assert.equal(Object.hasOwn(summary, 'screenshot'), false);

		await service.perform({ action: { type: "click", targetId, target: { nodeId: "42" } } }, { signal: new AbortController().signal });
		assert.deepEqual(commands.filter(command => command.method === "Input.dispatchMouseEvent").map(command => (command.params as { type: string }).type), ["mousePressed", "mouseReleased"]);
		assert.equal(attached, false);
		binding.dispose();
	});

	test("browser host reset closes only targets created through the host capability", async () => {
		const closed: string[] = [];
		const service = new BrowserAutomationMainService();
		const registry = new BrowserTargetRegistry();
		const views = browserViewService({ close: target => closed.push(target) });
		using binding = service.bind(views, registry);

		assert.deepEqual(await service.create({ url: "about:blank" }, requestContext()), { targetId });
		service.reset();
		service.reset();

		assert.deepEqual(closed, [targetId]);
		binding.dispose();
	});

	test("browser host closes a target whose asynchronous creation outlives its runtime binding", async () => {
		let finishCreate: (createdState: ReturnType<typeof state>) => void = () => {};
		const created = new Promise<ReturnType<typeof state>>(resolve => {
			finishCreate = resolve;
		});
		const closed: string[] = [];
		const service = new BrowserAutomationMainService();
		using binding = service.bind(browserViewService({ createTarget: () => created, close: target => closed.push(target) }), new BrowserTargetRegistry());
		const pending = service.create({ url: "about:blank" }, requestContext());

		binding.dispose();
		finishCreate(state());

		await assert.rejects(pending, /BrowserCapabilityUnavailable/);
		assert.deepEqual(closed, [targetId]);
	});

	test("a cancelled queued debugger turn does not block the next browser observation", async () => {
		let releaseFirst: () => void = () => {};
		let markFirstStarted: () => void = () => {};
		const firstStarted = new Promise<void>(resolve => {
			markFirstStarted = resolve;
		});
		const holdFirst = new Promise<void>(resolve => {
			releaseFirst = resolve;
		});
		let commandCount = 0;
		const debuggerClient = {
			isAttached: () => false,
			attach: () => {},
			detach: () => {},
			sendCommand: async () => {
				commandCount += 1;
				if (commandCount === 1) {
					markFirstStarted();
					await holdFirst;
				}
				return { nodes: [] };
			},
		};
		const view = {
			webContents: Object.assign(new EventEmitter(), {
				debugger: debuggerClient,
				isDestroyed: () => false,
				isLoading: () => false,
				capturePage: async () => ({ toPNG: () => Buffer.from("png") }),
			}),
			getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
		} as BrowserTargetView;
		const registry = new BrowserTargetRegistry();
		registry.register(targetId, view);
		const service = new BrowserAutomationMainService();
		using binding = service.bind(browserViewService(), registry);
		const observeParams = { targetId, includeAccessibilityTree: true, includeDomSnapshot: false, includeScreenshot: false };

		const first = service.observe(observeParams, { signal: new AbortController().signal });
		await firstStarted;
		const cancellation = new AbortController();
		const cancelled = service.observe(observeParams, { signal: cancellation.signal });
		cancellation.abort();
		await assert.rejects(cancelled, /BrowserRequestCancelled/);
		releaseFirst();
		await first;
		const third = service.observe(observeParams, { signal: new AbortController().signal });
		await third;
		assert.equal(commandCount, 2);
		binding.dispose();
	});

	test('observation waits behind navigation and reads the loaded page state', async () => {
		const started = promiseWithResolvers<void>();
		const finish = promiseWithResolvers<void>();
		let current = state();
		const view = targetView();
		const registry = new BrowserTargetRegistry();
		registry.register(targetId, view);
		const service = new BrowserAutomationMainService();
		using binding = service.bind(browserViewService({
			observe: () => current,
			navigate: async request => {
				started.resolve();
				await finish.promise;
				current = { ...current, url: request.url, title: 'Loaded page' };
			},
		}), registry);
		const navigation = service.perform({ action: { type: 'navigate', targetId, url: 'https://example.test/next' } }, requestContext());
		await started.promise;
		const observation = service.observe({ targetId, includeAccessibilityTree: false, includeDomSnapshot: false, includeScreenshot: false }, requestContext());
		finish.resolve();
		await navigation;
		assert.deepEqual(await observation, { targetId, url: 'https://example.test/next', title: 'Loaded page', loading: false });
	});

	test('closing a loading target ends observation and removes load listeners', async () => {
		const view = targetView({ isLoading: () => true });
		const registry = new BrowserTargetRegistry();
		registry.register(targetId, view);
		const service = new BrowserAutomationMainService();
		using binding = service.bind(browserViewService(), registry);
		const pending = service.observe({ targetId, includeAccessibilityTree: true, includeDomSnapshot: true, includeScreenshot: true }, requestContext());
		// Enter the queued operation before closing, so its event subscription is exercised.
		await Promise.resolve();
		assert.equal(view.webContents.listenerCount('did-stop-loading'), 1);
		registry.unregister(targetId);
		await assert.rejects(pending, error => error instanceof Error && error.cause instanceof Error && error.cause.message === 'BrowserTargetUnavailable');
		assert.equal(view.webContents.listenerCount('did-stop-loading'), 0);
	});

	test('navigation cannot change a page while its screenshot is being captured', async () => {
		const started = promiseWithResolvers<void>();
		const finish = promiseWithResolvers<void>();
		const order: string[] = [];
		const view = targetView({ capturePage: async () => {
			order.push('capture');
			started.resolve();
			await finish.promise;
			order.push('captured');
			return { toPNG: () => Buffer.from('png') };
		} });
		const registry = new BrowserTargetRegistry();
		registry.register(targetId, view);
		const service = new BrowserAutomationMainService();
		using binding = service.bind(browserViewService({ navigate: async () => { order.push('navigate'); } }), registry);
		const observation = service.observe({ targetId, includeAccessibilityTree: false, includeDomSnapshot: false, includeScreenshot: true }, requestContext());
		await started.promise;
		const navigation = service.perform({ action: { type: 'navigate', targetId, url: 'https://example.test/next' } }, requestContext());
		finish.resolve();
		await Promise.all([observation, navigation]);
		assert.deepEqual(order, ['capture', 'captured', 'navigate']);
	});

	test('navigation can replace a page that has not finished loading', async () => {
		let loading = true;
		const view = targetView({ isLoading: () => loading });
		const registry = new BrowserTargetRegistry();
		registry.register(targetId, view);
		const service = new BrowserAutomationMainService();
		using binding = service.bind(browserViewService({ navigate: async () => { loading = false; } }), registry);
		assert.deepEqual(await service.perform({ action: { type: 'navigate', targetId, url: 'https://example.test/next' } }, requestContext()), { targetId });
	});

	test('host cancellation returns before a page load ends and the target remains usable', async () => {
		let loading = true;
		const view = targetView({ isLoading: () => loading });
		const registry = new BrowserTargetRegistry();
		registry.register(targetId, view);
		const service = new BrowserAutomationMainService();
		using binding = service.bind(browserViewService(), registry);
		using host = new BrowserAutomationHost(service);
		const routes = host.routes();
		const observe = routes.find(route => route.channel === 'ash:browser-host:observe')!;
		const cancel = routes.find(route => route.channel === 'ash:browser-host:cancel')!;
		const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		const pending = observe.invoke(observe.validate({ id, params: { targetId, includeAccessibilityTree: false, includeDomSnapshot: false, includeScreenshot: false } }));
		await Promise.resolve();
		await cancel.invoke(cancel.validate({ id }));
		await assert.rejects(Promise.resolve(pending), /BrowserRequestCancelled/);
		loading = false;
		view.webContents.emit('did-stop-loading');
		assert.equal((await service.observe({ targetId, includeAccessibilityTree: false, includeDomSnapshot: false, includeScreenshot: false }, requestContext())).url, state().url);
		assert.equal(view.webContents.listenerCount('did-stop-loading'), 0);
	});

	test('host reset cancels in-flight work before another snapshot command can run', async () => {
		const started = promiseWithResolvers<void>();
		const finish = promiseWithResolvers<void>();
		const commands: string[] = [];
		const view = targetView({ debugger: {
			isAttached: () => true,
			attach: () => {},
			detach: () => {},
			sendCommand: async method => {
				commands.push(method);
				started.resolve();
				await finish.promise;
				return { nodes: [] };
			},
		} });
		const registry = new BrowserTargetRegistry();
		registry.register(targetId, view);
		const service = new BrowserAutomationMainService();
		using binding = service.bind(browserViewService(), registry);
		const pending = service.observe({ targetId, includeAccessibilityTree: true, includeDomSnapshot: true, includeScreenshot: false }, requestContext());
		await started.promise;
		service.reset();
		await assert.rejects(pending, error => error instanceof Error && error.cause instanceof Error && error.cause.message === 'BrowserCapabilityUnavailable');
		finish.resolve();
		await service.observe({ targetId, includeAccessibilityTree: false, includeDomSnapshot: false, includeScreenshot: false }, requestContext());
		assert.deepEqual(commands, ['Accessibility.getFullAXTree']);
	});

	test('typing into an unfocusable node cannot write into the previously focused field', async () => {
		const commands: string[] = [];
		const view = targetView({ debugger: {
			isAttached: () => true,
			attach: () => {},
			detach: () => {},
			sendCommand: async method => {
				commands.push(method);
				if (method === 'DOM.resolveNode') return { object: { objectId: 'readonly-input' } };
				if (method === 'Runtime.callFunctionOn') return { result: { value: false } };
				return {};
			},
		} });
		const registry = new BrowserTargetRegistry();
		registry.register(targetId, view);
		const service = new BrowserAutomationMainService();
		using binding = service.bind(browserViewService(), registry);
		await assert.rejects(service.perform({ action: { type: 'typeText', targetId, target: { type: 'element', target: { nodeId: '42' } }, text: 'wrong field' } }, requestContext()), /BrowserNodeNotEditable/);
		assert.deepEqual(commands, ['DOM.resolveNode', 'Runtime.callFunctionOn', 'Runtime.releaseObject']);
	});

});

function targetView(overrides: Partial<BrowserTargetView['webContents']> = {}) {
	return {
		webContents: Object.assign(new EventEmitter(), {
			debugger: { isAttached: () => false, attach: () => {}, detach: () => {}, sendCommand: async () => ({}) },
			isDestroyed: () => false,
			isLoading: () => false,
			capturePage: async () => ({ toPNG: () => Buffer.from('png') }),
		}, overrides),
		getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
	};
}

function browserViewService(overrides: Partial<IBrowserViewMainService> = {}): IBrowserViewMainService {
	return {
		createTarget: async () => state(),
		observe: () => state(),
		layout: () => {},
		setVisibility: () => {},
		navigate: async () => {},
		goBack: () => {},
		goForward: () => {},
		reload: () => {},
		stop: () => {},
		focus: () => {},
		close: () => {},
		...overrides,
	};
}

function state() {
	return {
		targetId,
		url: "https://example.test/",
		title: "Example",
		loading: false,
		canGoBack: false,
		canGoForward: false,
		visible: false,
	};
}

function requestContext() {
	return { signal: new AbortController().signal };
}
