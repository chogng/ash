import assert from "node:assert/strict";
import { test } from "mocha";
import {
	BROWSER_VIEW_CREATE_CHANNEL,
	BROWSER_VIEW_LAYOUT_CHANNEL,
	BROWSER_VIEW_LIST_CHANNEL,
	BROWSER_VIEW_NAVIGATE_CHANNEL,
	BROWSER_VIEW_VISIBILITY_CHANNEL,
	normalizeBrowserViewUrl, BrowserViewStorageScope,
	validateBrowserViewCreateRequest,
	validateBrowserViewLayoutRequest,
	validateBrowserViewNavigateRequest,
	validateBrowserViewVisibilityRequest,
	type IBrowserViewState,
} from "../../../../platform/browserView/common/browserView.js";
import {
	browserViewIpcRoutes
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

test("browser view IPC routes delegate only validated commands", async () => {
	const calls: string[] = [];
	const state: IBrowserViewState = {
		targetId,
		url: "https://example.com/",
		title: "",
		loading: true,
		canGoBack: false,
		canGoForward: false,
		visible: false,
	};
	const service: Parameters<typeof browserViewIpcRoutes>[0] = {
		getSharing: async () => [], setSharing: async () => { },
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
	const routes = browserViewIpcRoutes(service);
	const route = (channel: string) => {
		const result = routes.find((candidate) => candidate.channel === channel);
		assert.ok(result);
		return result;
	};

	const create = route(BROWSER_VIEW_CREATE_CHANNEL);
	const list = route(BROWSER_VIEW_LIST_CHANNEL);
	assert.deepEqual(await list.invoke(list.validate(undefined)), []);
	assert.throws(() => list.validate({ targetId }), /does not accept parameters/);
	const createRequest = create.validate({ targetId, options });
	assert.deepEqual(await create.invoke(createRequest), { id: targetId, host: { windowId: 1 }, owner: options.owner, session: options.session, state });

	const layout = route(BROWSER_VIEW_LAYOUT_CHANNEL);
	await layout.invoke(layout.validate({
		targetId,
		bounds: { x: -10, y: 20, width: 800, height: 600 },
	}));

	const visibility = route(BROWSER_VIEW_VISIBILITY_CHANNEL);
	await visibility.invoke(visibility.validate({ targetId, visible: true }));

	const navigate = route(BROWSER_VIEW_NAVIGATE_CHANNEL);
	await navigate.invoke(navigate.validate({
		targetId,
		url: "https://example.com/next",
	}));

	assert.deepEqual(calls, ["create", "layout", "visibility", "navigate"]);
	assert.throws(() =>
		navigate.validate({
			targetId,
			url: "file:///secret.txt",
		})
	);
});
