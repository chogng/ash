import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { h } from "../../../../base/browser/dom.js";

const browserEnvironment = new JSDOM("<!doctype html><html><head></head><body></body></html>");
Object.defineProperty(globalThis, "window", { configurable: true, value: browserEnvironment.window });
Object.defineProperty(globalThis, "document", { configurable: true, value: browserEnvironment.window.document });
Object.defineProperty(globalThis, "Node", { configurable: true, value: browserEnvironment.window.Node });

const { Dimension } = await import("../../../../base/browser/dom.js");
const { BrowserLayoutService } = await import("../../browser/layoutService.js");

test("BrowserLayoutService publishes root geometry and container offsets", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const root = h(dom.window.document, "main");
	dom.window.document.body.append(root);
	const primaryWindow = dom.window as unknown as Window;
	let focused = 0;
	const service = new BrowserLayoutService({
		root,
		getContainerOffset: () => ({ top: 36, quickInputTop: 48 }),
		focus: () => focused++,
	});
	const layoutEvents: string[] = [];
	service.onDidLayoutContainer(({ container, dimension }) => {
		assert.equal(container, root);
		assert.deepEqual(dimension, new Dimension(800, 600));
		layoutEvents.push("container");
	});
	service.onDidLayoutMainContainer((dimension) => {
		assert.deepEqual(dimension, new Dimension(800, 600));
		layoutEvents.push("main");
	});
	service.onDidLayoutActiveContainer((dimension) => {
		assert.deepEqual(dimension, new Dimension(800, 600));
		layoutEvents.push("active");
	});

	service.layout(new Dimension(800, 600));

	assert.deepEqual(layoutEvents, ["container", "main", "active"]);
	assert.deepEqual(service.mainContainerDimension, new Dimension(800, 600));
	assert.deepEqual(service.activeContainerDimension, new Dimension(800, 600));
	assert.equal(service.mainContainer, root);
	assert.equal(service.activeContainer, root);
	assert.deepEqual([...service.containers], [root]);
	assert.deepEqual(service.mainContainerOffset, { top: 36, quickInputTop: 48 });
	assert.deepEqual(service.activeContainerOffset, { top: 36, quickInputTop: 48 });
	assert.equal(service.getContainer(primaryWindow), root);
	assert.equal(service.whenContainerStylesLoaded(primaryWindow), undefined);
	service.focus();
	assert.equal(focused, 1);

	const otherWindow = new JSDOM("<!doctype html><body></body>").window;
	const otherBrowserWindow = otherWindow as unknown as Window;
	assert.throws(() => service.getContainer(otherBrowserWindow), /not registered/);
	assert.throws(() => service.whenContainerStylesLoaded(otherBrowserWindow), /not registered/);

	service.dispose();
	otherWindow.close();
	dom.window.close();
});

test("BrowserLayoutService rejects invalid dimensions", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const root = h(dom.window.document, "main");
	const service = new BrowserLayoutService({ root });

	assert.throws(() => service.layout(new Dimension(-1, 10)), RangeError);
	assert.throws(() => service.layout({ width: Number.NaN, height: 10 }), RangeError);

	service.dispose();
	dom.window.close();
});
