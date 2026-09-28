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
const { WorkbenchWindowBarHeight } = await import("../../../workbench/browser/parts/workbenchPartDimensions.js");
const { BrowserStorageService } = await import("../../../workbench/services/storage/browser/storageService.js");
const { WillSaveStateReason } = await import("../../../platform/storage/common/storage.js");
const { SessionsWorkbenchLayout, sessionsPartIds } = await import("../../../sessions/browser/layoutPolicy.js");
const { SessionsModernUIContribution } = await import('../../../sessions/contrib/modernUI/browser/modernUI.contribution.js');
const { SessionsConfiguration } = await import('../../../sessions/common/configuration.js');
const { ActivityBarPosition, WorkbenchConfiguration } = await import('../../../workbench/common/configuration.js');
const { WorkbenchConfigurationService } = await import('../../../workbench/services/configuration/browser/configurationService.js');

type SessionsPartId = import("../../../sessions/browser/layoutPolicy.js").SessionsPartId;
type WorkbenchPartInstance = import("../../../workbench/browser/part.js").WorkbenchPart;

class TestSessionsPart extends WorkbenchPart {
	constructor(readonly id: SessionsPartId, container: HTMLElement) {
		super(container, id);
	}

	override get minimumWidth(): number {
		if (this.id === 'activitybar') return 44;
		if (this.id === "sidebar") return 180;
		if (this.id === "sessions") return 320;
		if (this.id === "auxiliarybar") return 180;
		return 0;
	}

	override get maximumWidth(): number {
		if (this.id === 'activitybar') return 44;
		return this.id === "sidebar" || this.id === "auxiliarybar" ? 640 : Number.POSITIVE_INFINITY;
	}

	override get minimumHeight(): number { return this.id === "titlebar" ? WorkbenchWindowBarHeight : 0; }
	override get maximumHeight(): number { return this.id === "titlebar" ? WorkbenchWindowBarHeight : Number.POSITIVE_INFINITY; }
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

	assert.deepEqual(layout.getPartSize("titlebar"), new Dimension(1_200, WorkbenchWindowBarHeight));
	assert.equal(Math.abs(layout.getPartSize('activitybar').width - 50) <= 1, true);
	assert.equal(Math.abs(layout.getPartSize("sidebar").width - 260) <= 1, true);
	assert.equal(Math.abs(layout.getPartSize("auxiliarybar").width - 200) <= 1, true);
	assert.equal(layout.getPartSize("sessions").height, 800 - WorkbenchWindowBarHeight);
	assert.equal(layout.getPartSize("sessions").width > 400, true);
	assert.equal(container.querySelectorAll(".ash-sash").length, 2);
	assert.equal(container.querySelector("[data-part='editor']"), null);
	assert.ok(container.querySelector("[data-part='sessions']"));

	layout.dispose();
	for (const part of parts.values()) part.dispose();
	dom.window.close();
});

test('Sessions layout style changes without changing the IDE preference or visible Parts', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const container = h(dom.window.document, 'main');
	dom.window.document.body.append(container);
	const parts = createParts(dom.window.document);
	const configuration = new WorkbenchConfigurationService();
	const layout = new SessionsWorkbenchLayout(container, parts, { initialDimension: new Dimension(1_200, 800) });
	const appearance = new SessionsModernUIContribution(container, layout, configuration);
	const sessionsFrame = parts.get('sessions')!.domNode.parentElement as HTMLElement;
	const surface = () => ({
		style: container.dataset.layoutStyle,
		leftInset: sessionsFrame.style.paddingLeft,
		rightInset: sessionsFrame.style.paddingRight,
	});
	try {
		layout.layout(new Dimension(1_200, 800));
		assert.deepEqual(surface(), { style: 'modern', leftInset: '', rightInset: '' });
		await configuration.updateValue(SessionsConfiguration.layoutStyle, 'flat');
		assert.deepEqual(surface(), { style: 'flat', leftInset: '', rightInset: '' });
		assert.equal(container.classList.contains('modern-ui'), false);
		assert.equal(configuration.getValue(WorkbenchConfiguration.layoutStyle), 'modern');
		assert.equal(layout.isPartVisible('auxiliarybar'), true);
		await configuration.updateValue(WorkbenchConfiguration.layoutStyle, 'flat');
		assert.equal(container.dataset.layoutStyle, 'flat');
		await configuration.updateValue(SessionsConfiguration.layoutStyle, 'modern');
		layout.hidePart('auxiliarybar');
		assert.equal(sessionsFrame.style.paddingRight, '8px');
	} finally {
		appearance.dispose();
		layout.dispose();
		configuration.dispose();
		for (const part of parts.values()) part.dispose();
		dom.window.close();
	}
});

test("Sessions layout toggles the sidebar and auxiliary Part while keeping the primary Part visible", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const container = h(dom.window.document, "main");
	dom.window.document.body.append(container);
	const parts = createParts(dom.window.document);
	const layout = new SessionsWorkbenchLayout(container, parts, { initialDimension: new Dimension(1_000, 700) });
	const changes: Array<{ partId: SessionsPartId; visible: boolean }> = [];
	const subscription = layout.onDidChangePartVisibility(change => changes.push(change));

	layout.layout(new Dimension(1_000, 700));
	const sidebarWidth = layout.getPartSize('sidebar').width;
	const sessionsWidth = layout.getPartSize('sessions').width;
	layout.hidePart('sidebar');
	assert.equal(layout.isPartVisible('sidebar'), false);
	assert.equal(layout.getPartSize('sidebar').width, sidebarWidth);
	assert.equal(layout.getPartSize('sessions').width > sessionsWidth, true);
	layout.showPart('sidebar');
	assert.equal(layout.isPartVisible('sidebar'), true);
	assert.equal(layout.getPartSize('sidebar').width, sidebarWidth);
	layout.hidePart("auxiliarybar");

	assert.equal(layout.isPartVisible("auxiliarybar"), false);
	assert.equal(layout.getPartSize("sessions").width > 500, true);
	assert.equal(changes.at(-1)?.partId, "auxiliarybar");
	assert.equal(changes.at(-1)?.visible, false);
	assert.throws(() => layout.hidePart("sessions"), /Required Sessions Part/);
	assert.throws(() => layout.hidePart('activitybar'), /Required Sessions Part/);

	subscription.dispose();
	layout.dispose();
	for (const part of parts.values()) part.dispose();
	dom.window.close();
});

test('Sessions Activity Bar position changes the grid visibility and frame edge', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const container = h(dom.window.document, 'main');
	dom.window.document.body.append(container);
	const parts = createParts(dom.window.document);
	const layout = new SessionsWorkbenchLayout(container, parts, {
		initialDimension: new Dimension(1_200, 800),
		activityBarLocation: ActivityBarPosition.TOP,
	});
	try {
		layout.layout(new Dimension(1_200, 800));
		assert.equal(layout.isPartVisible('activitybar'), false);
		assert.equal(parts.get('sidebar')!.domNode.parentElement?.style.paddingLeft, '6px');
		const expandedWidth = layout.getPartSize('sessions').width;
		layout.setActivityBarLocation(ActivityBarPosition.DEFAULT);
		assert.equal(layout.isPartVisible('activitybar'), true);
		assert.equal(Math.abs(layout.getPartSize('activitybar').width - 50) <= 1, true);
		assert.equal(parts.get('activitybar')!.domNode.parentElement?.style.paddingLeft, '6px');
		assert.equal(parts.get('sidebar')!.domNode.parentElement?.style.paddingLeft, '0px');
		assert.equal(layout.getPartSize('sessions').width < expandedWidth, true);
		layout.setActivityBarLocation(ActivityBarPosition.HIDDEN);
		assert.equal(layout.isPartVisible('activitybar'), false);
		assert.equal(parts.get('sidebar')!.domNode.parentElement?.style.paddingLeft, '6px');
	} finally {
		layout.dispose();
		for (const part of parts.values()) part.dispose();
		dom.window.close();
	}
});

test("Sessions layout validates its complete Part set", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const container = h(dom.window.document, "main");
	const parts = createParts(dom.window.document);
	parts.delete("auxiliarybar");

	assert.throws(() => new SessionsWorkbenchLayout(container, parts), /missing Parts: auxiliarybar/);
	parts.set('auxiliarybar', new TestSessionsPart('auxiliarybar', dom.window.document.body));
	parts.delete('activitybar');
	assert.throws(() => new SessionsWorkbenchLayout(container, parts), /missing Parts: activitybar/);

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
	first.hidePart('sidebar');
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
	assert.equal(restored.isPartVisible('sidebar'), false);
	assert.equal(Math.abs(restored.getPartSize("auxiliarybar").width - 360) <= 1, true);
	assert.equal(restored.isPartVisible("auxiliarybar"), false);

	restored.dispose();
	for (const part of restoredParts.values()) part.dispose();
	restoredStorage.dispose();
	dom.window.close();
});
