import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { h } from "../../../base/browser/dom.js";

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	MouseEvent: browserEnvironment.window.MouseEvent,
	navigator: browserEnvironment.window.navigator,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { Dimension } = await import("../../../base/browser/dom.js");
const { WorkbenchPart } = await import("../../../workbench/browser/part.js");
const { BrowserStorageService } = await import("../../../workbench/services/storage/browser/storageService.js");
const { WillSaveStateReason } = await import("../../../platform/storage/common/storage.js");
const { SessionsWorkbenchLayout } = await import("../../../sessions/browser/layout.js");
const { sessionsPartIds } = await import("../../../sessions/services/layout/browser/sessionsLayoutService.js");

type SessionsPartId = import("../../../sessions/services/layout/browser/sessionsLayoutService.js").SessionsPartId;
type WorkbenchPartInstance = import("../../../workbench/browser/part.js").WorkbenchPart;

class TestSessionsPart extends WorkbenchPart {
	constructor(readonly id: SessionsPartId, container: HTMLElement) {
		super(container, id);
	}

	override get minimumWidth(): number {
		if (this.id === "sidebar") return 180;
		if (this.id === "sessions") return 320;
		if (this.id === "auxiliarybar") return 220;
		return 0;
	}

	override get maximumWidth(): number {
		return this.id === "sidebar" || this.id === "auxiliarybar" ? 640 : Number.POSITIVE_INFINITY;
	}

	override get minimumHeight(): number { return this.id === "titlebar" ? 46 : 0; }
	override get maximumHeight(): number { return this.id === "titlebar" ? 46 : Number.POSITIVE_INFINITY; }
}

function createParts(ownerDocument: Document): Map<SessionsPartId, WorkbenchPartInstance> {
	return new Map(sessionsPartIds.map(partId => [partId, new TestSessionsPart(partId, ownerDocument.body)]));
}

test("Sessions layout owns a fixed Sessions-first Part topology", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const container = h(dom.window.document, "main");
	dom.window.document.body.append(container);
	const parts = createParts(dom.window.document);
	const layout = new SessionsWorkbenchLayout(container, parts, { initialDimension: new Dimension(1_200, 800) });

	layout.layout(new Dimension(1_200, 800));

	assert.deepEqual(layout.getPartSize("titlebar"), new Dimension(1_200, 46));
	assert.equal(Math.abs(layout.getPartSize("sidebar").width - 260) <= 1, true);
	assert.equal(Math.abs(layout.getPartSize("auxiliarybar").width - 292) <= 1, true);
	assert.equal(layout.getPartSize("sessions").height, 754);
	assert.equal(layout.getPartSize("sessions").width > 640, true);
	assert.equal(container.querySelectorAll(".ash-sash").length, 2);
	assert.equal(container.querySelector("[data-part='editor']"), null);
	assert.ok(container.querySelector("[data-part='sessions']"));

	layout.dispose();
	for (const part of parts.values()) part.dispose();
	dom.window.close();
});

test("Sessions layout only permits the optional auxiliary Part to hide", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const container = h(dom.window.document, "main");
	dom.window.document.body.append(container);
	const parts = createParts(dom.window.document);
	const layout = new SessionsWorkbenchLayout(container, parts, { initialDimension: new Dimension(1_000, 700) });
	const changes: Array<{ partId: SessionsPartId; visible: boolean }> = [];
	const subscription = layout.onDidChangePartVisibility(change => changes.push(change));

	layout.layout(new Dimension(1_000, 700));
	layout.hidePart("auxiliarybar");

	assert.equal(layout.isPartVisible("auxiliarybar"), false);
	assert.equal(layout.getPartSize("sessions").width > 700, true);
	assert.equal(changes.at(-1)?.partId, "auxiliarybar");
	assert.equal(changes.at(-1)?.visible, false);
	assert.throws(() => layout.hidePart("sessions"), /Required Sessions Part/);

	subscription.dispose();
	layout.dispose();
	for (const part of parts.values()) part.dispose();
	dom.window.close();
});

test("Sessions layout validates its complete Part set", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const container = h(dom.window.document, "main");
	const parts = createParts(dom.window.document);
	parts.delete("auxiliarybar");

	assert.throws(() => new SessionsWorkbenchLayout(container, parts), /missing Parts: auxiliarybar/);

	for (const part of parts.values()) part.dispose();
	dom.window.close();
});

test("Sessions layout restores its profile-scoped geometry and auxiliary visibility", async () => {
	const dom = new JSDOM("<!doctype html><body></body>", { url: "https://ash.test" });
	const createStorage = () => new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		applicationId: "code",
		workspaceId: "sessions",
		profileId: "code-sessions",
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	const firstStorage = createStorage();
	const firstContainer = h(dom.window.document, "main");
	const firstParts = createParts(dom.window.document);
	const first = new SessionsWorkbenchLayout(firstContainer, firstParts, { initialDimension: new Dimension(1_100, 700), storageService: firstStorage });
	first.layout(new Dimension(1_100, 700));
	first.resizePart("sidebar", new Dimension(320, first.getPartSize("sidebar").height));
	first.resizePart("auxiliarybar", new Dimension(360, first.getPartSize("auxiliarybar").height));
	first.hidePart("auxiliarybar");
	await firstStorage.flush(WillSaveStateReason.SHUTDOWN);
	first.dispose();
	for (const part of firstParts.values()) part.dispose();
	firstStorage.dispose();

	const restoredStorage = createStorage();
	const restoredContainer = h(dom.window.document, "main");
	const restoredParts = createParts(dom.window.document);
	const restored = new SessionsWorkbenchLayout(restoredContainer, restoredParts, { initialDimension: new Dimension(1_100, 700), storageService: restoredStorage });
	restored.layout(new Dimension(1_100, 700));

	assert.equal(Math.abs(restored.getPartSize("sidebar").width - 320) <= 1, true);
	assert.equal(Math.abs(restored.getPartSize("auxiliarybar").width - 360) <= 1, true);
	assert.equal(restored.isPartVisible("auxiliarybar"), false);

	restored.dispose();
	for (const part of restoredParts.values()) part.dispose();
	restoredStorage.dispose();
	dom.window.close();
});
