import assert from "node:assert/strict";
import { test } from "mocha";
import { BrowserAutomationMainService } from "../../../../platform/browser/electron-main/browserAutomationMainService.js";
import type { IBrowserViewMainService } from "../../../../platform/browser/electron-main/browserViewIpc.js";
import { BrowserTargetRegistry, type BrowserTargetView } from "../../../../platform/browser/electron-main/browserTargetRegistry.js";
import type { IDisposable } from "../../../../base/common/lifecycle.js";

const targetId = "browser_target_123e4567-e89b-12d3-a456-426614174000";

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
		webContents: {
			debugger: debuggerClient,
			isDestroyed: () => false,
			capturePage: async () => ({ toPNG: () => Buffer.from("png") }),
		},
		getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
	} as BrowserTargetView;
	const registry = new BrowserTargetRegistry();
	registry.register(targetId, view);
	const browserViews = browserViewService();
	const service = new BrowserAutomationMainService();
	const binding = service.bind(browserViews, registry);

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
	const binding = service.bind(views, registry);

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
	const binding = service.bind(browserViewService({ createTarget: () => created, close: target => closed.push(target) }), new BrowserTargetRegistry());
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
		webContents: {
			debugger: debuggerClient,
			isDestroyed: () => false,
			capturePage: async () => ({ toPNG: () => Buffer.from("png") }),
		},
		getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
	} as BrowserTargetView;
	const registry = new BrowserTargetRegistry();
	registry.register(targetId, view);
	const service = new BrowserAutomationMainService();
	const binding = service.bind(browserViewService(), registry);
	const observeParams = { targetId, includeAccessibilityTree: true, includeDomSnapshot: false, includeScreenshot: false };

	const first = service.observe(observeParams, { signal: new AbortController().signal });
	await firstStarted;
	const cancellation = new AbortController();
	const cancelled = service.observe(observeParams, { signal: cancellation.signal });
	cancellation.abort();
	releaseFirst();
	await first;
	await assert.rejects(cancelled);
	const third = service.observe(observeParams, { signal: new AbortController().signal });
	await Promise.race([
		third,
		new Promise((_, reject) => setTimeout(() => reject(new Error("next debugger turn remained blocked")), 250)),
	]);
	assert.equal(commandCount, 2);
	binding.dispose();
});

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

function disposable(): IDisposable {
	return { dispose: () => {}, [Symbol.dispose]: () => {} };
}

function requestContext() {
	return { signal: new AbortController().signal };
}
