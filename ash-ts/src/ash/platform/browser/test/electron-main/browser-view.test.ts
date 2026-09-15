import assert from "node:assert/strict";
import { test } from "mocha";
import {
	BROWSER_VIEW_CREATE_CHANNEL,
	BROWSER_VIEW_LAYOUT_CHANNEL,
	BROWSER_VIEW_NAVIGATE_CHANNEL,
	BROWSER_VIEW_VISIBILITY_CHANNEL,
	normalizeBrowserViewUrl,
	validateBrowserViewCreateRequest,
	validateBrowserViewLayoutRequest,
	validateBrowserViewNavigateRequest,
	validateBrowserViewVisibilityRequest,
	type IBrowserViewState,
} from "../../../../platform/browser/common/browserView.js";
import {
	browserViewIpcRoutes,
	type IBrowserViewMainService,
} from "../../../../platform/browser/electron-main/browserViewIpc.js";
import { directBrowserViewNavigation } from "../../../../platform/browser/common/browserViewNavigation.js";

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

test("direct Browser navigation owns exactly one normalized origin", () => {
	const navigation = directBrowserViewNavigation("https://example.com/path");
	assert.equal(navigation.ownsRequestedUrl("https://example.com/next"), true);
	assert.equal(navigation.ownsLoadedUrl("https://other.example/"), false);
	assert.equal(navigation.loadUrlFor("https://example.com/next"), "https://example.com/next");
	assert.throws(() => navigation.loadUrlFor("https://other.example/"));
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
	const service: IBrowserViewMainService = {
		createTarget: async () => {
			calls.push("create");
			return state;
		},
		observe: () => state,
		layout: () => calls.push("layout"),
		setVisibility: () => calls.push("visibility"),
		navigate: async () => {
			calls.push("navigate");
		},
		goBack: () => calls.push("back"),
		goForward: () => calls.push("forward"),
		reload: () => calls.push("reload"),
		stop: () => calls.push("stop"),
		focus: () => calls.push("focus"),
		close: () => calls.push("close"),
	};
	const routes = browserViewIpcRoutes(service);
	const route = (channel: string) => {
		const result = routes.find((candidate) => candidate.channel === channel);
		assert.ok(result);
		return result;
	};

	const create = route(BROWSER_VIEW_CREATE_CHANNEL);
	const createRequest = create.validate({ url: "https://example.com" });
	assert.deepEqual(await create.invoke(createRequest), state);

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
