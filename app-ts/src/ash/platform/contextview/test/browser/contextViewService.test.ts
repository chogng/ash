import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { h } from "../../../../base/browser/dom.js";
import type { IRectangle } from "../../../../base/common/layout.js";

const environment = new JSDOM(
	"<!doctype html><html><head></head><body><main></main></body></html>",
);
for (const [name, value] of Object.entries({
	window: environment.window,
	document: environment.window.document,
	Node: environment.window.Node,
})) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}

const {
	BrowserContextViewService,
} = await import(
	"../../../../platform/contextview/browser/contextViewService.js"
);

test("context view service hosts overlays inside its Workbench container", () => {
	const container = environment.window.document.querySelector("main");
	assert.ok(container);
	const service = new BrowserContextViewService(container);
	const content = h(environment.window.document, "div");
	content.textContent = "Menu";

	assert.equal(
		service.show({
			anchor: { left: 8, top: 12, width: 0, height: 0 },
			content,
		}),
		true,
	);

	const contextView = container.querySelector(":scope > .ash-context-view");
	assert.ok(contextView);
	assert.equal(contextView.contains(content), true);

	service.hide();
	assert.equal(contextView.hasAttribute("hidden"), true);
	service.dispose();
	assert.equal(container.querySelector(".ash-context-view"), null);
});

test("point anchors render in the window that owns their viewport coordinates", () => {
	const auxiliary = new JSDOM("<!doctype html><body></body>");
	const container = environment.window.document.querySelector("main");
	assert.ok(container);
	const service = new BrowserContextViewService(container);
	const content = h(environment.window.document, "div");
	const anchor: IRectangle & { readonly targetWindow: Window } = {
		left: 24,
		top: 36,
		width: 0,
		height: 0,
		targetWindow: auxiliary.window as unknown as Window,
	};

	assert.equal(service.show({ anchor, content }), true);
	assert.ok(auxiliary.window.document.body.querySelector(".ash-context-view"));
	assert.equal(container.querySelector(".ash-context-view"), null);

	service.dispose();
	auxiliary.window.close();
});
