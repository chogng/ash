import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";

const browserEnvironment = new JSDOM("<!doctype html><html><head></head><body></body></html>");
Object.defineProperty(globalThis, "window", { configurable: true, value: browserEnvironment.window });
Object.defineProperty(globalThis, "document", { configurable: true, value: browserEnvironment.window.document });

const { ZIndex, ZIndexRegistry } = await import("../../browser/zIndexRegistry.js");

test("ZIndexRegistry projects named layers as CSS variables", () => {
	const registry = new ZIndexRegistry();
	const variable = registry.registerZIndex(ZIndex.Sash, 1, "layout-test");
	assert.equal(variable, "--ash-z-index-layout-test");
	assert.match(
		[...browserEnvironment.window.document.head.querySelectorAll("style")]
			.map((style) => style.textContent ?? "")
			.join("\n"),
		/--ash-z-index-layout-test:\s*36;/,
	);

	assert.throws(() => registry.registerZIndex(ZIndex.Sash, 0, "layout-test"), /already been registered/);
	assert.throws(() => registry.registerZIndex(ZIndex.Sash, 0, "LayoutTest"), /must start/);
	assert.throws(() => registry.registerZIndex(ZIndex.Sash, 5, "layout-test-overflow"), /exceeded/);

	registry.dispose();
	assert.doesNotMatch(
		[...browserEnvironment.window.document.head.querySelectorAll("style")]
			.map((style) => style.textContent ?? "")
			.join("\n"),
		/--ash-z-index-layout-test:/,
	);
});
