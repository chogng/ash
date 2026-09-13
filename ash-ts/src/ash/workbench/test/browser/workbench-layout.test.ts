import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import type { IContextMenuProvider } from "../../../base/browser/contextmenu.js";
import type { IAction } from "../../../base/common/actions.js";
import { Emitter } from "../../../base/common/event.js";
import { DisposableStore, toDisposable } from "../../../base/common/lifecycle.js";
import type { IViewPaneOptions, PartTitleProjection } from "../../../workbench/browser/parts/views/viewPane.js";
import {
	ContextKeyService,
} from "../../../platform/contextkey/common/contextkey.js";
import { h } from "../../../base/browser/dom.js";
import type { ILocalizationService } from "../../../workbench/services/localization/common/localizationService.js";

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
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}

const { Dimension } = await import("../../../base/browser/dom.js");
const { bindResizableLayout } = await import("../../../base/browser/ui/resizable/resizable.js");
const { lxiconsLibrary } = await import("../../../base/common/lxiconsLibrary.js");
const { StorageScope, WillSaveStateReason } = await import("../../../platform/storage/common/storage.js");
const { MenuId } = await import(
	"../../../platform/actions/common/actions.js"
);
const { MenuService } = await import(
	"../../../platform/actions/common/menuService.js"
);
const {
	WorkbenchLayout,
} = await import("../../../workbench/browser/layout.js");
const { createTestWorkbenchContextKeysHandler } = await import('../../../workbench/test/common/testWorkbenchContextKeys.js');
const { BrowserLayoutService } = await import("../../../platform/layout/browser/layoutService.js");
const { IWorkbenchLayoutService, workbenchPartIds } = await import("../../../workbench/services/layout/browser/layoutService.js");
const { BrowserStorageService } = await import("../../../workbench/services/storage/browser/storageService.js");
const { WorkbenchPart } = await import("../../../workbench/browser/part.js");
const { SidebarPart } = await import(
	"../../../workbench/browser/parts/sidebar/sidebarPart.js"
);
const { PanelPart } = await import(
	"../../../workbench/browser/parts/panel/panelPart.js"
);
const { CompositeBar } = await import("../../../workbench/browser/parts/compositebar/compositeBar.js");
const { AuxiliarybarPart } = await import(
	"../../../workbench/browser/parts/auxiliarybar/auxiliarybarPart.js"
);
const { PaneComposite } = await import(
	"../../../workbench/browser/parts/views/paneComposite.js"
);
const { ViewPane } = await import(
	"../../../workbench/browser/parts/views/viewPane.js"
);
const { EditorPart } = await import(
	"../../../workbench/browser/parts/editor/editorPart.js"
);
const { ViewDescriptorService } = await import(
	"../../../workbench/services/views/common/viewDescriptorService.js"
);
const {
	ViewContainerLocation,
	WorkbenchViewRegistry,
} = await import("../../../workbench/common/views.js");
const {
	ToggleAuxiliaryBarCommandId,
	ToggleMaximizedPanelCommandId,
	TogglePanelCommandId,
	ToggleSideBarCommandId,
} = await import(
	"../../../workbench/browser/parts/titlebar/titlebarActions.js"
);
const { CommandService } = await import(
	"../../../workbench/services/commands/common/commandService.js"
);
const { ServiceContainer, ServiceConstructionDescriptor } = await import(
	"../../../platform/instantiation/common/instantiation.js"
);
type WorkbenchPartId =
	import("../../../workbench/services/layout/browser/layoutService.js").WorkbenchPartId;
type WorkbenchLayoutInstance =
	import("../../../workbench/browser/layout.js").WorkbenchLayout;
type WorkbenchLayoutOptions =
	import("../../../workbench/browser/layout.js").WorkbenchLayoutOptions;
type WorkbenchPartInstance =
	import("../../../workbench/browser/part.js").WorkbenchPart;
type EditorPartInstance =
	import("../../../workbench/browser/parts/editor/editorPart.js").EditorPart;
class TestPart extends WorkbenchPart {
	constructor(
		readonly id: WorkbenchPartId,
		container: HTMLElement,
	) {
		super(container, id);
	}

	override get minimumWidth(): number {
		return this.id === "sidebar" || this.id === "auxiliarybar" || this.id === "agentSidebar"
			? 180
			: this.id === "editor"
			? 120
			: 0;
	}

	override get maximumWidth(): number {
		return this.id === "sidebar" || this.id === "auxiliarybar" || this.id === "agentSidebar"
			? 600
			: Number.POSITIVE_INFINITY;
	}

	override get minimumHeight(): number {
		if (this.id === "titlebar") return 35;
		if (this.id === "statusbar") return 35;
		if (this.id === "editor") return 84;
		if (this.id === "panel") return 80;
		return 0;
	}

	override get maximumHeight(): number {
		if (this.id === "titlebar") return 35;
		if (this.id === "statusbar") return 35;
		return Number.POSITIVE_INFINITY;
	}
}

function createLayoutHarness(
	ownerDocument: Document,
	options: WorkbenchLayoutOptions = {},
	existingContainer?: HTMLElement,
): {
	readonly disposables: DisposableStore;
	readonly container: HTMLElement;
	readonly editor: EditorPartInstance;
	readonly layout: WorkbenchLayoutInstance;
} {
	const disposables = new DisposableStore();
	const container = existingContainer ?? h(ownerDocument, "main");
	ownerDocument.body.append(container);
	disposables.add(toDisposable(() => container.remove()));

	const parts = new Map<WorkbenchPartId, WorkbenchPartInstance>();
	let editor: EditorPartInstance | undefined;
	for (const partId of workbenchPartIds) {
		const part = partId === "editor"
			? new EditorPart(container)
			: new TestPart(partId, container);
		disposables.add(part);
		parts.set(partId, part);
		if (part instanceof EditorPart) editor = part;
	}
	if (!editor) throw new Error("Test layout requires an editor Part");

	const layout = disposables.add(new WorkbenchLayout(container, parts, options));
	return { disposables, container, editor, layout };
}

test("Workbench layout hides and restores Parts with context keys", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const contextKeys = new ContextKeyService();
	const harness = createLayoutHarness(dom.window.document);
	harness.disposables.add(contextKeys);
	harness.disposables.add(createTestWorkbenchContextKeysHandler(contextKeys, { layoutService: harness.layout }));
	const overlay = h(dom.window.document, "div");
	overlay.className = "persistent-overlay";
	harness.container.append(overlay);

	harness.layout.layout(new Dimension(1_000, 700));
	assert.equal(
		harness.container.querySelectorAll(".ash-sash").length,
		4,
	);
	assert.equal(overlay.parentElement, harness.container);
	assert.ok(overlay.isConnected);
	assert.ok(harness.container.querySelector("[data-part='sidebar']"));
	assert.equal(contextKeys.getValue("sideBarVisible"), true);
	assert.equal(contextKeys.getValue("auxiliaryBarVisible"), true);
	assert.equal(contextKeys.getValue("agentSidebarVisible"), false);
	assert.equal(contextKeys.getValue("panelVisible"), true);
	assert.equal(contextKeys.getValue('panelMaximized'), false);
	const editorElement = harness.container.querySelector<HTMLElement>(
		"[data-part='editor']",
	);
	const panelElement = harness.container.querySelector<HTMLElement>(
		"[data-part='panel']",
	);
	const editorFrame = editorElement?.parentElement as HTMLElement | undefined;
	const panelFrame = panelElement?.parentElement as HTMLElement | undefined;
	const sidebarFrame = harness.container.querySelector<HTMLElement>(
		"[data-part='sidebar']",
	)?.parentElement as HTMLElement | undefined;
	const auxiliarybarFrame = harness.container.querySelector<HTMLElement>(
		"[data-part='auxiliarybar']",
	)?.parentElement as HTMLElement | undefined;
	assert.equal(editorFrame?.className, "ash-workbench-part-frame");
	assert.equal(editorFrame?.style.paddingLeft, "3px");
	assert.equal(editorFrame?.style.paddingRight, "3px");
	assert.equal(editorFrame?.style.paddingBottom, "3px");
	assert.equal(panelFrame?.style.paddingTop, "3px");
	assert.equal(sidebarFrame?.style.paddingLeft, "6px");
	assert.equal(sidebarFrame?.style.paddingRight, "3px");
	assert.equal(auxiliarybarFrame?.style.paddingLeft, "3px");
	assert.equal(auxiliarybarFrame?.style.paddingRight, "8px");
	for (const sash of harness.container.querySelectorAll<HTMLElement>(".ash-sash")) {
		assert.equal(sash.classList.contains("ash-sash-inset"), true);
		assert.equal(sash.style.getPropertyValue("--ash-sash-inset-gap"), "6px");
	}
	harness.layout.hideParts(["sidebar", "auxiliarybar", "panel"]);
	assert.ok(overlay.isConnected);
	assert.equal(
		harness.container.querySelector<HTMLElement>(
			"[data-part='sidebar']",
		)?.hidden,
		true,
	);
	assert.equal(
		harness.container.querySelector<HTMLElement>(
			"[data-part='auxiliarybar']",
		)?.hidden,
		true,
	);
	assert.ok(harness.container.querySelector("[data-part='editor']"));
	assert.equal(
		harness.container.querySelector("[data-part='session']"),
		null,
	);
	assert.equal(contextKeys.getValue("sideBarVisible"), false);
	assert.equal(contextKeys.getValue("auxiliaryBarVisible"), false);
	assert.equal(contextKeys.getValue("panelVisible"), false);
	assert.equal(contextKeys.getValue("editorAreaVisible"), true);
	assert.equal(editorFrame?.style.paddingLeft, "6px");
	assert.equal(editorFrame?.style.paddingRight, "8px");
	assert.equal(editorFrame?.style.paddingBottom, "0px");
	assert.equal(panelFrame?.style.paddingLeft, "6px");
	assert.equal(panelFrame?.style.paddingRight, "8px");
	harness.layout.showPart("agentSidebar");
	assert.equal(contextKeys.getValue("agentSidebarVisible"), true);
	harness.layout.hidePart("agentSidebar");
	assert.equal(contextKeys.getValue("agentSidebarVisible"), false);
	harness.layout.showPart("sidebar");
	assert.equal(
		harness.container.querySelector<HTMLElement>(
			"[data-part='sidebar']",
		)?.hidden,
		false,
	);
	assert.equal(contextKeys.getValue("sideBarVisible"), true);
	assert.equal(editorFrame?.style.paddingLeft, "3px");
	assert.equal(editorFrame?.style.paddingRight, "8px");
	harness.layout.showPart('panel');
	harness.layout.hidePart('editor');
	assert.equal(contextKeys.getValue('panelMaximized'), true);
	harness.layout.showPart('editor');
	assert.equal(contextKeys.getValue('panelMaximized'), false);

	harness.disposables.dispose();
	dom.window.close();
});

test("Workbench layout switches between modern and flat geometry without replacing Parts", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const harness = createLayoutHarness(dom.window.document, {
		initialDimension: new Dimension(1_200, 800),
		layoutStyle: "modern",
	});
	harness.layout.layout(new Dimension(1_200, 800));
	const state = harness.layout.state;
	const editor = harness.container.querySelector<HTMLElement>("[data-part='editor']");
	const editorFrame = editor?.parentElement as HTMLElement | undefined;
	const sidebarFrame = harness.container.querySelector<HTMLElement>("[data-part='sidebar']")?.parentElement as HTMLElement | undefined;
	assert.equal(editorFrame?.style.paddingLeft, "3px");
	assert.equal(sidebarFrame?.style.paddingLeft, "6px");
	assert.equal(harness.container.querySelectorAll(".ash-sash-inset").length, 4);

	harness.layout.setLayoutStyle("flat");

	assert.equal(editorFrame?.style.paddingLeft, "0px");
	assert.equal(editorFrame?.style.paddingRight, "0px");
	assert.equal(editorFrame?.style.paddingBottom, "0px");
	assert.equal(sidebarFrame?.style.paddingLeft, "0px");
	assert.equal(sidebarFrame?.style.paddingRight, "0px");
	assert.equal(harness.container.querySelectorAll(".ash-sash-inset").length, 0);
	assert.deepEqual(harness.layout.state, state);
	assert.equal(harness.container.querySelector("[data-part='editor']"), editor);

	harness.layout.setLayoutStyle("modern");

	assert.equal(editorFrame?.style.paddingLeft, "3px");
	assert.equal(sidebarFrame?.style.paddingLeft, "6px");
	assert.equal(harness.container.querySelectorAll(".ash-sash-inset").length, 4);
	assert.deepEqual(harness.layout.state, state);

	harness.disposables.dispose();
	dom.window.close();
});

test("Workbench pane sashes snap closed and remain available for drag restore", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const contextKeys = new ContextKeyService();
	const harness = createLayoutHarness(dom.window.document, {
		initialDimension: new Dimension(1_200, 800),
	});
	harness.disposables.add(contextKeys);
	harness.disposables.add(createTestWorkbenchContextKeysHandler(contextKeys, { layoutService: harness.layout }));
	harness.layout.layout(new Dimension(1_200, 800));

	dragWorkbenchSash(dom.window, harness.container, "sidebar", 0, -140);
	assert.equal(harness.layout.isPartVisible("sidebar"), false);
	assert.equal(contextKeys.getValue("sideBarVisible"), false);
	dragWorkbenchSash(dom.window, harness.container, "sidebar", 0, 110);
	assert.equal(harness.layout.isPartVisible("sidebar"), true);

	dragWorkbenchSash(dom.window, harness.container, "auxiliarybar", 1, 320);
	assert.equal(harness.layout.isPartVisible("auxiliarybar"), false);
	assert.equal(contextKeys.getValue("auxiliaryBarVisible"), false);
	dragWorkbenchSash(dom.window, harness.container, "auxiliarybar", 1, -110);
	assert.equal(harness.layout.isPartVisible("auxiliarybar"), true);

	dragWorkbenchSash(dom.window, harness.container, "panel", 0, 170);
	assert.equal(harness.layout.isPartVisible("panel"), false);
	assert.equal(contextKeys.getValue("panelVisible"), false);
	dragWorkbenchSash(dom.window, harness.container, "panel", 0, -50);
	assert.equal(harness.layout.isPartVisible("panel"), true);

	dragWorkbenchSash(dom.window, harness.container, "agentSidebar", 2, -110);
	assert.equal(harness.layout.isPartVisible("agentSidebar"), true);
	assert.equal(contextKeys.getValue("agentSidebarVisible"), true);
	dragWorkbenchSash(dom.window, harness.container, "agentSidebar", 2, 120);
	assert.equal(harness.layout.isPartVisible("agentSidebar"), false);
	dragWorkbenchSash(dom.window, harness.container, "agentSidebar", 2, -110);
	assert.equal(harness.layout.isPartVisible("agentSidebar"), true);

	harness.disposables.dispose();
	dom.window.close();
});

test("platform layout service drives Workbench Part geometry", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const container = h(dom.window.document, "main");
	const layoutService = new BrowserLayoutService({ root: container });
	const harness = createLayoutHarness(dom.window.document, {
		initialDimension: layoutService.mainContainerDimension,
	}, container);
	harness.disposables.add(layoutService);
	harness.disposables.add(bindResizableLayout(layoutService.onDidLayoutMainContainer, harness.layout));

	layoutService.layout(new Dimension(1_200, 800));

	assert.deepEqual(layoutService.mainContainerDimension, new Dimension(1_200, 800));
	assert.equal(harness.layout.getPartSize("titlebar").height, 35);
	assert.equal(harness.layout.getPartSize("statusbar").height, 35);
	assert.ok(harness.editor.domNode.isConnected);

	harness.disposables.dispose();
	dom.window.close();
});

test("Workbench layout state is versioned and excludes topology", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const harness = createLayoutHarness(dom.window.document);
	harness.layout.layout(new Dimension(1_000, 700));
	harness.layout.resizePart(
		"sidebar",
		harness.layout.getPartSize("sidebar").with(250),
	);
	harness.layout.hidePart("auxiliarybar");
	harness.layout.resizePart(
		"agentSidebar",
		harness.layout.getPartSize("agentSidebar").with(300),
	);
	harness.layout.showPart("agentSidebar");
	harness.layout.resizePart(
		"panel",
		new Dimension(harness.layout.getPartSize("panel").width, 180),
	);
	const state = harness.layout.state;

	assert.deepEqual(state, {
		version: 3,
		sidebar: { width: 250, visible: true },
		auxiliarybar: { width: 380, visible: false },
		agentSidebar: { width: 300, visible: true },
		panel: { height: 180, visible: true },
	});
	assert.equal("children" in state, false);

	harness.disposables.dispose();
	dom.window.close();
});

test("Workbench layout derives flexible editor size from the container", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const harness = createLayoutHarness(dom.window.document, {
		initialDimension: new Dimension(1_200, 800),
	});
	harness.layout.layout(new Dimension(1_200, 800));

	assert.deepEqual(
		harness.layout.getPartSize("sidebar"),
		new Dimension(220, 730),
	);
	assert.deepEqual(
		harness.layout.getPartSize("auxiliarybar"),
		new Dimension(380, 730),
	);
	assert.deepEqual(
		harness.layout.getPartSize("editor"),
		new Dimension(600, 530),
	);
	assert.equal(harness.layout.getPartSize("panel").height, 200);

	harness.layout.layout(new Dimension(1_300, 800));
	assert.equal(harness.layout.getPartSize("sidebar").width, 220);
	assert.equal(harness.layout.getPartSize("auxiliarybar").width, 380);
	assert.equal(harness.layout.getPartSize("editor").width, 700);

	harness.disposables.dispose();
	dom.window.close();
});

test("Workbench sash reset keeps unrelated sidebars at their current widths", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const harness = createLayoutHarness(dom.window.document, {
		initialDimension: new Dimension(1_200, 800),
	});
	harness.layout.layout(new Dimension(1_200, 800));
	harness.layout.resizePart(
		"sidebar",
		harness.layout.getPartSize("sidebar").with(260),
	);
	harness.layout.resizePart(
		"auxiliarybar",
		harness.layout.getPartSize("auxiliarybar").with(320),
	);
	const sidebarWidth = harness.layout.getPartSize("sidebar").width;

	resetWorkbenchSash(dom.window, harness.container, "auxiliarybar", 1);

	assert.equal(harness.layout.getPartSize("sidebar").width, sidebarWidth);
	assert.equal(
		harness.layout.getPartSize("editor").width,
		harness.layout.getPartSize("auxiliarybar").width,
	);

	harness.disposables.dispose();
	dom.window.close();
});

test("Workbench layout applies host defaults without exposing persisted state", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const harness = createLayoutHarness(dom.window.document, {
		initialDimension: new Dimension(1_200, 800),
		defaultLayout: {
			parts: {
				sidebar: false,
				auxiliarybar: false,
				agentSidebar: false,
				panel: false,
			},
		},
	});
	harness.layout.layout(new Dimension(1_200, 800));

	assert.equal(harness.layout.getPartSize("sidebar").width, 220);
	assert.equal(harness.layout.getPartSize("auxiliarybar").width, 380);
	assert.equal(harness.layout.getPartSize("panel").height, 200);
	assert.equal(harness.layout.isPartVisible("auxiliarybar"), false);
	assert.equal(harness.layout.isPartVisible("sidebar"), false);
	assert.equal(harness.layout.isPartVisible("panel"), false);

	harness.disposables.dispose();
	dom.window.close();
});

test("Workbench default layout applies to new workspaces unless forced", async () => {
	const dom = new JSDOM("<!doctype html><body></body>", {
		url: "https://ash.test",
	});
	const createStorage = (workspaceId: string) => new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		applicationId: "code",
		workspaceId,
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	const initialDimension = new Dimension(1_000, 700);
	const seedStorage = createStorage("workspace-a");
	const seed = createLayoutHarness(dom.window.document, {
		initialDimension,
		storageService: seedStorage,
	});
	assert.equal(seed.layout.isPartVisible("sidebar"), true);
	await seedStorage.flush(WillSaveStateReason.SHUTDOWN);
	seed.disposables.dispose();
	seedStorage.dispose();

	const storage = createStorage("workspace-a");
	const restored = createLayoutHarness(dom.window.document, {
		initialDimension,
		defaultLayout: { parts: { sidebar: false } },
		storageService: storage,
	});
	assert.equal(storage.isNew(StorageScope.WORKSPACE), false);
	assert.equal(restored.layout.isPartVisible("sidebar"), true);
	storage.switchWorkspace("workspace-b");
	restored.layout.restoreWorkspaceState();
	assert.equal(storage.isNew(StorageScope.WORKSPACE), true);
	assert.equal(restored.layout.isPartVisible("sidebar"), false);
	storage.switchWorkspace("workspace-a");
	restored.layout.restoreWorkspaceState();
	assert.equal(restored.layout.isPartVisible("sidebar"), true);
	restored.disposables.dispose();
	storage.dispose();

	const forcedStorage = createStorage("workspace-a");
	const forced = createLayoutHarness(dom.window.document, {
		initialDimension,
		defaultLayout: { parts: { sidebar: false }, force: true },
		storageService: forcedStorage,
	});
	assert.equal(forced.layout.isPartVisible("sidebar"), false);
	assert.equal(forced.layout.isPartVisible("panel"), true);
	forced.disposables.dispose();
	forcedStorage.dispose();
	dom.window.close();
});

test("Workbench layout validates and restores mutable state only", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const harness = createLayoutHarness(dom.window.document);
	harness.layout.layout(new Dimension(1_000, 700));
	harness.layout.restoreState({
		version: 2,
		sidebar: { width: 260, visible: true },
		auxiliarybar: { width: 240, visible: false },
		panel: { height: 160, visible: false },
	});

	assert.equal(harness.layout.getPartSize("sidebar").width, 260);
	assert.equal(harness.layout.isPartVisible("auxiliarybar"), false);
	assert.equal(harness.layout.isPartVisible("panel"), false);
	harness.layout.restoreState({
		version: 1,
		sidebar: { width: 250, visible: true },
		auxiliarybar: { width: 230, visible: true },
	});
	assert.equal(harness.layout.getPartSize("panel").height, 200);
	assert.equal(harness.layout.isPartVisible("panel"), true);
	assert.throws(
		() => harness.layout.restoreState({
			version: 3,
			sidebar: { width: 260, visible: true },
			auxiliarybar: { width: 240, visible: false },
			panel: { height: 160, visible: false },
		}),
		/invalid or unsupported/,
	);

	harness.disposables.dispose();
	dom.window.close();
});

test("Workbench layout restores scoped state through the storage service", async () => {
	const dom = new JSDOM("<!doctype html><body></body>", {
		url: "https://ash.test",
	});
	const createStorage = (workspaceId: string) => new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		applicationId: "code",
		workspaceId,
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	const firstStorage = createStorage("workspace-a");
	const first = createLayoutHarness(dom.window.document, {
		initialDimension: new Dimension(1_000, 700),
		storageService: firstStorage,
	});
	first.layout.layout(new Dimension(1_000, 700));
	first.layout.resizePart(
		"auxiliarybar",
		first.layout.getPartSize("auxiliarybar").with(310),
	);
	first.layout.hidePart("auxiliarybar");
	first.layout.resizePart(
		"panel",
		new Dimension(first.layout.getPartSize("panel").width, 175),
	);
	await firstStorage.flush(WillSaveStateReason.SHUTDOWN);
	first.disposables.dispose();
	firstStorage.dispose();

	const restoredStorage = createStorage("workspace-a");
	const restored = createLayoutHarness(dom.window.document, {
		initialDimension: new Dimension(1_000, 700),
		storageService: restoredStorage,
	});
	restored.layout.layout(new Dimension(1_000, 700));
	assert.equal(restored.layout.getPartSize("auxiliarybar").width, 310);
	assert.equal(restored.layout.isPartVisible("auxiliarybar"), false);
	assert.equal(restored.layout.getPartSize("panel").height, 175);
	restored.disposables.dispose();
	restoredStorage.dispose();

	const otherWorkspaceStorage = createStorage("workspace-b");
	const otherWorkspace = createLayoutHarness(dom.window.document, {
		initialDimension: new Dimension(1_000, 700),
		storageService: otherWorkspaceStorage,
	});
	otherWorkspace.layout.layout(new Dimension(1_000, 700));
	assert.equal(otherWorkspace.layout.getPartSize("auxiliarybar").width, 310);
	assert.equal(otherWorkspace.layout.isPartVisible("auxiliarybar"), true);
	assert.equal(otherWorkspace.layout.getPartSize("panel").height, 175);

	otherWorkspace.disposables.dispose();
	otherWorkspaceStorage.dispose();
	dom.window.close();
});

test("Workbench layout re-applies the active workspace state after storage switches", async () => {
	const dom = new JSDOM("<!doctype html><body></body>", {
		url: "https://ash.test",
	});
	const storage = new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		applicationId: "code",
		workspaceId: "workspace-a",
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	const harness = createLayoutHarness(dom.window.document, {
		initialDimension: new Dimension(1_000, 700),
		storageService: storage,
	});
	harness.layout.layout(new Dimension(1_000, 700));
	harness.layout.hidePart("auxiliarybar");
	await storage.flush(WillSaveStateReason.SHUTDOWN);

	storage.switchWorkspace("workspace-b");
	harness.layout.restoreWorkspaceState();
	assert.equal(harness.layout.isPartVisible("auxiliarybar"), true);

	storage.switchWorkspace("workspace-a");
	harness.layout.restoreWorkspaceState();
	assert.equal(harness.layout.isPartVisible("auxiliarybar"), false);

	harness.disposables.dispose();
	storage.dispose();
	dom.window.close();
});

test("Workbench layout retains resized Part dimensions across visibility", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const harness = createLayoutHarness(dom.window.document);
	harness.layout.layout(new Dimension(1_000, 700));
	harness.layout.resizePart(
		"sidebar",
		harness.layout.getPartSize("sidebar").with(250),
	);
	assert.equal(harness.layout.getPartSize("sidebar").width, 250);
	harness.layout.hidePart("sidebar");
	harness.layout.showPart("sidebar");
	assert.equal(harness.layout.getPartSize("sidebar").width, 250);
	const restoredSidebarPane = harness.container.querySelector<HTMLElement>(
		"[data-part='sidebar']",
	)?.parentElement?.parentElement;
	assert.equal(restoredSidebarPane?.style.width, "250px");

	harness.disposables.dispose();
	dom.window.close();
});

test("Sidebar hosts its Composite Bar before content", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const disposables = new DisposableStore();
	const registry = new WorkbenchViewRegistry();
	disposables.add(registry.registerViewContainer({
		id: "ash.explorer",
		title: "Explorer",
		location: ViewContainerLocation.Sidebar,
		order: 1,
		isDefault: true,
	}));
	disposables.add(registry.registerViewContainer({
		id: "ash.search",
		title: "Search",
		location: ViewContainerLocation.Sidebar,
		order: 2,
	}));
	disposables.add(registry.registerViewContainer({
		id: "ash.git",
		title: "Git",
		location: ViewContainerLocation.Sidebar,
		order: 3,
	}));
	const contextKeys = disposables.add(new ContextKeyService());
	const viewDescriptors = disposables.add(new ViewDescriptorService({
		contextKeyService: contextKeys,
		registry,
	}));
	const sidebar = disposables.add(new SidebarPart(dom.window.document.body, {
		viewDescriptorService: viewDescriptors,
		contextKeyService: contextKeys,
	}));
	dom.window.document.body.append(sidebar.domNode);
	const compositeBar = sidebar.compositeBar;
	const selections: string[] = [];
	disposables.add(sidebar.onDidSelectComposite(
		({ compositeId }) => selections.push(compositeId),
	));

	assert.equal(
		compositeBar.domNode.querySelectorAll(".ash-action-view-item").length,
		3,
	);
	assert.deepEqual(
		[...compositeBar.domNode.querySelectorAll<HTMLElement>(
			".ash-action-view-item",
		)].map((item) => item.dataset.actionId),
		["ash.explorer", "ash.search", "ash.git"],
	);
	const title = sidebar.domNode.querySelector(
		":scope > .ash-workbench-part-title.ash-pane-composite-title",
	);
	assert.ok(title);
	assert.equal(compositeBar.domNode.parentElement?.parentElement, title);
	assert.equal(sidebar.domNode.firstElementChild, title);
	assert.equal(
		compositeBar.domNode.className,
		"ash-composite-bar ash-composite-bar-icon",
	);
	const content = sidebar.domNode.querySelector(
		":scope > .ash-composite-content",
	);
	assert.ok(content);
	assert.equal(title.nextElementSibling, content);
	const actionbar = compositeBar.domNode.querySelector(
		":scope > .ash-action-bar",
	);
	assert.equal(actionbar?.classList.contains("ash-action-bar"), true);
	assert.equal(actionbar?.classList.contains("horizontal"), true);
	assert.equal(actionbar?.getAttribute("role"), "tablist");
	assert.equal(actionbar?.getAttribute("aria-orientation"), "horizontal");
	assert.deepEqual(
		[...(actionbar?.children ?? [])].map(
			(item) => item.classList.contains("ash-tab"),
		),
		[false, false, false],
	);
	assert.deepEqual(
		[...(actionbar?.children ?? [])].map(
			(item) => item.classList.contains("ash-composite-bar-item"),
		),
		[true, true, true],
	);
	assert.deepEqual(
		[...(actionbar?.children ?? [])].map((item) => item.getAttribute("role")),
		["tab", "tab", "tab"],
	);
	assert.deepEqual(
		[...(actionbar?.children ?? [])].map((item) => item.firstElementChild?.getAttribute("role")),
		[null, null, null],
	);
	assert.equal(
		compositeBar.domNode.querySelectorAll(
			".ash-action-bar > .ash-action-view-item",
		).length,
		3,
	);
	assert.equal(
		compositeBar.domNode.querySelectorAll(
			".ash-action-view-item > .ash-composite-bar-action",
		).length,
		3,
	);
	assert.equal(compositeBar.domNode.querySelectorAll("button").length, 0);
	assert.equal(compositeBar.domNode.querySelector(".ash-tab-list"), null);
	assert.equal(compositeBar.domNode.hasAttribute("data-part"), false);
	assert.equal(
		compositeBar.domNode.querySelector(".ash-workbench-part-content"),
		null,
	);
	compositeBar.setActiveComposite("ash.explorer");
	const explorerTab = compositeBar.domNode.querySelector<HTMLElement>(
		"[data-action-id='ash.explorer'][role='tab']",
	);
	const searchTab = compositeBar.domNode.querySelector<HTMLElement>(
		"[data-action-id='ash.search'][role='tab']",
	);
	assert.ok(explorerTab);
	assert.ok(searchTab);
	assert.equal(
		explorerTab.getAttribute("aria-selected"),
		"true",
	);
	explorerTab.focus();
	explorerTab.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key: "ArrowRight",
	}));
	assert.equal(dom.window.document.activeElement, searchTab);
	assert.deepEqual(selections, []);
	explorerTab.click();
	assert.deepEqual(selections, []);
	searchTab.click();
	assert.deepEqual(selections, ["ash.search"]);
	assert.equal(compositeBar.activeCompositeId, "ash.explorer");

	const instantiationService = new ServiceContainer();
	const explorerContainer = viewDescriptors.getViewContainers(
		ViewContainerLocation.Sidebar,
	)[0];
	const searchContainer = viewDescriptors.getViewContainers(
		ViewContainerLocation.Sidebar,
	)[1];
	const explorerComposite = new PaneComposite(dom.window.document.body, {
		viewContainer: explorerContainer,
		model: viewDescriptors.getViewContainerModel(explorerContainer.id),
		instantiationService,
		contextKeyService: contextKeys,
	});
	const searchComposite = new PaneComposite(dom.window.document.body, {
		viewContainer: searchContainer,
		model: viewDescriptors.getViewContainerModel(searchContainer.id),
		instantiationService,
		contextKeyService: contextKeys,
	});
	sidebar.addComposite(explorerComposite);
	sidebar.addComposite(searchComposite);
	sidebar.showComposite(explorerComposite.id);
	assert.equal(sidebar.activeCompositeId, explorerComposite.id);
	assert.equal(contextKeys.getValue('activeViewlet'), explorerComposite.id);
	assert.equal(explorerComposite.element.hidden, false);
	assert.equal(searchComposite.element.hidden, true);
	sidebar.showComposite(searchComposite.id);
	assert.equal(sidebar.activeCompositeId, searchComposite.id);
	assert.equal(contextKeys.getValue('activeViewlet'), searchComposite.id);
	assert.equal(explorerComposite.element.hidden, true);
	assert.equal(searchComposite.element.hidden, false);
	sidebar.showComposite(explorerComposite.id);
	assert.equal(
		sidebar.getComposite(explorerComposite.id),
		explorerComposite,
	);
	assert.equal(explorerComposite.element.hidden, false);
	assert.equal(contextKeys.getValue('activeViewlet'), explorerComposite.id);

	disposables.dispose();
	dom.window.close();
});

test("Pane Composite Parts restore workspace selections with Registry fallback", () => {
	const dom = new JSDOM("<!doctype html><body></body>", {
		url: "https://ash.test",
	});
	const disposables = new DisposableStore();
	const registry = new WorkbenchViewRegistry();
	disposables.add(registry.registerViewContainer({
		id: "ash.explorer",
		title: "Explorer",
		location: ViewContainerLocation.Sidebar,
		isDefault: true,
	}));
	disposables.add(registry.registerViewContainer({
		id: "ash.search",
		title: "Search",
		location: ViewContainerLocation.Sidebar,
	}));
	const contextKeys = disposables.add(new ContextKeyService());
	const viewDescriptors = disposables.add(new ViewDescriptorService({
		contextKeyService: contextKeys,
		registry,
	}));
	const createStorage = (workspaceId: string) => new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		applicationId: "code",
		workspaceId,
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	const createComposite = (containerId: string) => {
		const descriptor = viewDescriptors
			.getViewContainers(ViewContainerLocation.Sidebar)
			.find((candidate) => candidate.id === containerId);
		assert.ok(descriptor);
		return new PaneComposite(dom.window.document.body, {
			viewContainer: descriptor,
			model: viewDescriptors.getViewContainerModel(descriptor.id),
			instantiationService: new ServiceContainer(),
			contextKeyService: contextKeys,
		});
	};

	const firstStorage = createStorage("workspace-a");
	const first = new SidebarPart(dom.window.document.body, {
		viewDescriptorService: viewDescriptors,
		storageService: firstStorage,
	});
	assert.equal(first.getCompositeIdToRestore(), "ash.explorer");
	const search = createComposite("ash.search");
	first.addComposite(search);
	first.showComposite(search.id);
	first.dispose();
	firstStorage.dispose();

	const restoredStorage = createStorage("workspace-a");
	const restored = new SidebarPart(dom.window.document.body, {
		viewDescriptorService: viewDescriptors,
		storageService: restoredStorage,
	});
	assert.equal(restored.getCompositeIdToRestore(), "ash.search");
	restoredStorage.switchWorkspace("workspace-b");
	assert.equal(restored.getCompositeIdToRestore(), "ash.explorer");
	restoredStorage.switchWorkspace("workspace-a");
	assert.equal(restored.getCompositeIdToRestore(), "ash.search");
	const explorer = createComposite("ash.explorer");
	restored.addComposite(explorer);
	restored.showComposite(explorer.id);
	restored.dispose();
	restoredStorage.dispose();

	const defaultStorage = createStorage("workspace-a");
	const fallback = new SidebarPart(dom.window.document.body, {
		viewDescriptorService: viewDescriptors,
		storageService: defaultStorage,
	});
	assert.equal(fallback.getCompositeIdToRestore(), "ash.explorer");
	fallback.dispose();
	defaultStorage.dispose();
	disposables.dispose();
	dom.window.close();
});

test("Sidebar can host Agent Sidebar composites", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const disposables = new DisposableStore();
	const registry = new WorkbenchViewRegistry();
	disposables.add(registry.registerViewContainer({
		id: "ash.chat",
		title: "Chat",
		location: ViewContainerLocation.AgentSidebar,
		isDefault: true,
	}));
	const contextKeys = disposables.add(new ContextKeyService());
	const viewDescriptors = disposables.add(new ViewDescriptorService({
		contextKeyService: contextKeys,
		registry,
	}));
	const agentSidebar = disposables.add(new SidebarPart(dom.window.document.body, {
		viewDescriptorService: viewDescriptors,
		contextKeyService: contextKeys,
		id: "agentSidebar",
		location: ViewContainerLocation.AgentSidebar,
		ariaLabel: "Agent sidebar",
		viewsAriaLabel: "Agent sidebar views",
		compositeBarContainerFilter: () => false,
	}));

	assert.equal(agentSidebar.domNode.dataset.part, "agentSidebar");
	assert.equal(agentSidebar.domNode.getAttribute("aria-label"), "Agent sidebar");
	assert.equal(agentSidebar.compositeBar.domNode.hidden, false);
	assert.equal(
		agentSidebar.compositeBar.domNode.querySelector(
			"[data-action-id='ash.chat']",
		),
		null,
	);
	const descriptor = viewDescriptors.getDefaultViewContainer(ViewContainerLocation.AgentSidebar);
	assert.ok(descriptor);
	const composite = new PaneComposite(dom.window.document.body, {
		viewContainer: descriptor,
		model: viewDescriptors.getViewContainerModel(descriptor.id),
		instantiationService: new ServiceContainer(),
		contextKeyService: contextKeys,
	});
	agentSidebar.addComposite(composite);
	agentSidebar.showComposite(composite.id);
	assert.equal(contextKeys.getValue('activeAgentSidebar'), composite.id);

	disposables.dispose();
	dom.window.close();
});

test("Panel presents its destinations as tabs and active commands as a toolbar", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const disposables = new DisposableStore();
	const registry = new WorkbenchViewRegistry();
	const panels = [
		["ash.panel.problems", "Problems"],
		["ash.panel.output", "Output"],
		["ash.panel.terminal", "Terminal"],
		["ash.panel.ports", "Ports"],
	] as const;
	for (const [id, title] of panels) {
		disposables.add(registry.registerViewContainer({
			id,
			title,
			location: ViewContainerLocation.Panel,
			order: panels.findIndex(([candidate]) => candidate === id),
			isDefault: title === "Terminal",
		}));
	}
	disposables.add(registry.registerViews("ash.panel.terminal", [{
		id: "ash.terminal",
		title: "Terminal",
		ctorDescriptor: new ServiceConstructionDescriptor(TestPanelView),
	}]));
	const contextKeys = disposables.add(new ContextKeyService());
	const commands = disposables.add(new CommandService(new ServiceContainer()));
	const menuService = new MenuService(commands, contextKeys);
	const contextMenuProvider: IContextMenuProvider = { showContextMenu() {} };
	const viewDescriptors = disposables.add(new ViewDescriptorService({
		contextKeyService: contextKeys,
		registry,
	}));
	const panel = disposables.add(new PanelPart(dom.window.document.body, {
		viewDescriptorService: viewDescriptors,
		contextKeyService: contextKeys,
		titleActions: {
			menuService,
			contextMenuProvider,
			menuId: MenuId.PanelTitle,
		},
	}));
	dom.window.document.body.append(panel.domNode);

	const tablist = panel.domNode.querySelector(".ash-panel-title-control [role='tablist']");
	assert.equal(panel.compositeBar.domNode.className, "ash-composite-bar ash-composite-bar-label");
	assert.equal(tablist?.getAttribute("aria-label"), "Panel views");
	assert.deepEqual(
		[...(tablist?.querySelectorAll("[role='tab']") ?? [])].map((tab) => tab.textContent),
		["Problems", "Output", "Terminal", "Ports"],
	);
	const panelToolbar = panel.domNode.querySelector(".ash-pane-composite-title-part-actions [role='toolbar']");
	assert.ok(panelToolbar);
	const maximizePanel = [...panelToolbar.querySelectorAll("button")].find((button) => button.textContent === "Maximize Panel");
	const closePanel = [...panelToolbar.querySelectorAll("button")].find((button) => button.textContent === "Close Panel");
	assert.ok(maximizePanel);
	assert.ok(closePanel);
	assert.ok(maximizePanel.querySelector("svg.ash-icon"));
	assert.ok(closePanel.querySelector("svg.ash-icon"));
	assert.equal(maximizePanel.compareDocumentPosition(closePanel) & browserEnvironment.window.Node.DOCUMENT_POSITION_FOLLOWING, browserEnvironment.window.Node.DOCUMENT_POSITION_FOLLOWING);

	const terminalDescriptor = viewDescriptors.getViewContainers(ViewContainerLocation.Panel).find((container) => container.id === "ash.panel.terminal");
	assert.ok(terminalDescriptor);
	const terminal = new PaneComposite(dom.window.document.body, {
		viewContainer: terminalDescriptor,
		model: viewDescriptors.getViewContainerModel(terminalDescriptor.id),
		instantiationService: new ServiceContainer(),
		contextKeyService: contextKeys,
		paneHeaders: "hidden",
		paneLayout: "fill",
	});
	panel.addComposite(terminal);
	panel.showComposite(terminal.id);
	assert.equal(contextKeys.getValue('activePanel'), terminal.id);

	const toolbar = panel.domNode.querySelector(".ash-pane-composite-title-view-actions [role='toolbar']");
	const terminalTab = panel.domNode.querySelector("[role='tab'][aria-selected='true']");
	assert.equal(toolbar?.getAttribute("aria-label"), "Test panel actions");
	assert.equal(toolbar?.querySelector("button")?.textContent, "Run");
	assert.equal(panel.domNode.querySelectorAll(".ash-panel-title-control [role='tablist']").length, 1);
	assert.equal(terminal.element.getAttribute("role"), "tabpanel");
	assert.equal(terminal.element.classList.contains("ash-pane-composite-pane-headers-hidden"), true);
	assert.equal(terminal.element.classList.contains("ash-pane-composite-pane-layout-fill"), true);
	assert.equal(terminalTab?.getAttribute("aria-controls"), terminal.element.id);
	assert.equal(terminal.element.getAttribute("aria-labelledby"), terminalTab?.id);

	for (const panelId of ["ash.panel.problems", "ash.panel.output", "ash.panel.ports"]) {
		const descriptor = viewDescriptors.getViewContainers(ViewContainerLocation.Panel).find((container) => container.id === panelId);
		assert.ok(descriptor);
		const composite = new PaneComposite(dom.window.document.body, {
			viewContainer: descriptor,
			model: viewDescriptors.getViewContainerModel(descriptor.id),
			instantiationService: new ServiceContainer(),
			contextKeyService: contextKeys,
			paneHeaders: "hidden",
			paneLayout: "fill",
		});
		panel.addComposite(composite);
		panel.showComposite(composite.id);
		assert.equal(panel.domNode.querySelector(".ash-pane-composite-title-view-actions [aria-label='Test panel actions']"), null);
		assert.equal(panelToolbar.isConnected, true);
		assert.ok([...panelToolbar.querySelectorAll("button")].some((button) => button.textContent === "Maximize Panel"));
		assert.ok([...panelToolbar.querySelectorAll("button")].some((button) => button.textContent === "Close Panel"));
	}

	disposables.dispose();
	dom.window.close();
});

test("CompositeBar moves non-fitting label tabs into its overflow menu", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const disposables = new DisposableStore();
	const registry = new WorkbenchViewRegistry();
	const panels = [
		["ash.panel.problems", "Problems"],
		["ash.panel.output", "Output"],
		["ash.panel.terminal", "Terminal"],
	] as const;
	for (const [id, title] of panels) {
		disposables.add(registry.registerViewContainer({
			id,
			title,
			location: ViewContainerLocation.Panel,
		}));
	}
	const contextKeys = disposables.add(new ContextKeyService());
	const viewDescriptors = disposables.add(new ViewDescriptorService({
		contextKeyService: contextKeys,
		registry,
	}));
	const selections: string[] = [];
	let overflowActions: readonly IAction[] = [];
	let hideOverflowMenu: (() => void) | undefined;
	const contextMenuProvider: IContextMenuProvider = {
		showContextMenu(options): void {
			overflowActions = options.getActions();
			hideOverflowMenu = () => options.onHide?.(true);
		},
	};
	const compositeBar = disposables.add(new CompositeBar(dom.window.document.body, {
		viewDescriptorService: viewDescriptors,
		location: ViewContainerLocation.Panel,
		ariaLabel: "Panel views",
		presentation: "label",
		contextMenuProvider,
	}));
	disposables.add(compositeBar.onDidSelectComposite(
		({ compositeId }) => selections.push(compositeId),
	));
	dom.window.document.body.append(compositeBar.domNode);
	Object.defineProperty(compositeBar.domNode, "clientWidth", {
		configurable: true,
		value: 110,
	});
	compositeBar.setActiveComposite("ash.panel.terminal");
	const tabs = [...compositeBar.domNode.querySelectorAll<HTMLElement>(".ash-composite-bar-destination")];
	for (const [index, tab] of tabs.entries()) {
		tab.getBoundingClientRect = () => ({ left: index * 50, right: (index + 1) * 50, width: 50 } as DOMRect);
	}
	compositeBar.layout();

	assert.deepEqual(
		[...compositeBar.domNode.querySelectorAll("[role='tab']")]
			.map((tab) => tab.textContent),
		["Terminal", "Additional views"],
	);
	const overflowItem = compositeBar.domNode.querySelector<HTMLElement>(
		".ash-composite-bar-overflow",
	);
	assert.ok(overflowItem);
	assert.equal(overflowItem.getAttribute("role"), "tab");
	assert.equal(
		compositeBar.domNode.querySelector(".ash-composite-bar-item")?.nextElementSibling,
		overflowItem,
	);
	overflowItem.click();
	assert.equal(overflowItem.getAttribute("aria-expanded"), "true");
	assert.deepEqual(
		overflowActions.map((action) => action.label),
		["Problems", "Output"],
	);
	const problems = overflowActions[0];
	assert.ok(problems);
	problems.run();
	assert.deepEqual(selections, ["ash.panel.problems"]);
	assert.ok(hideOverflowMenu);
	hideOverflowMenu();
	assert.equal(overflowItem.getAttribute("aria-expanded"), "false");
	assert.equal(overflowItem.isConnected, true);

	disposables.dispose();
	dom.window.close();
});

test("CompositeBar refreshes localized View Container labels", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const disposables = new DisposableStore();
	const registry = new WorkbenchViewRegistry();
	disposables.add(registry.registerViewContainer({
		id: "ash.panel.terminal.localized",
		title: "Terminal",
		localizationKey: { bundle: "ash.views", key: "terminal" },
		location: ViewContainerLocation.Panel,
	}));
	const contextKeys = disposables.add(new ContextKeyService());
	const viewDescriptors = disposables.add(new ViewDescriptorService({ contextKeyService: contextKeys, registry }));
	const localeChanges = new Emitter<string>();
	let locale = "en";
	const localization = {
		onDidChange: localeChanges.event,
		translate: (_bundle: string, key: string, fallback: string) => key === "terminal" && locale === "zh-CN" ? "终端" : fallback,
	} as unknown as ILocalizationService;
	const compositeBar = disposables.add(new CompositeBar(dom.window.document.body, {
		viewDescriptorService: viewDescriptors,
		localizationService: localization,
		location: ViewContainerLocation.Panel,
		ariaLabel: "Panel views",
	}));

	assert.equal(compositeBar.domNode.querySelector("[role='tab']")?.textContent, "Terminal");
	locale = "zh-CN";
	localeChanges.fire(locale);
	assert.equal(compositeBar.domNode.querySelector("[role='tab']")?.textContent, "终端");

	localeChanges.dispose();
	disposables.dispose();
	dom.window.close();
});

test("Auxiliary Bar retains its fixed View as a standard Pane Composite", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const disposables = new DisposableStore();
	const registry = new WorkbenchViewRegistry();
	disposables.add(registry.registerViewContainer({
		id: "ash.chat",
		title: "Chat",
		location: ViewContainerLocation.AuxiliaryBar,
		isDefault: true,
	}));
	const contextKeys = disposables.add(new ContextKeyService());
	const viewDescriptors = disposables.add(new ViewDescriptorService({
		contextKeyService: contextKeys,
		registry,
	}));
	const descriptor = viewDescriptors.getDefaultViewContainer(
		ViewContainerLocation.AuxiliaryBar,
	);
	assert.ok(descriptor);
	const instantiationService = new ServiceContainer();
	const composite = new PaneComposite(dom.window.document.body, {
		viewContainer: descriptor,
		model: viewDescriptors.getViewContainerModel(descriptor.id),
		instantiationService,
		contextKeyService: contextKeys,
		paneHeaders: "hidden",
		paneLayout: "fill",
	});
	const auxiliarybar = disposables.add(
		new AuxiliarybarPart(dom.window.document.body, {
			viewDescriptorService: viewDescriptors,
			contextKeyService: contextKeys,
		}),
	);
	auxiliarybar.addComposite(composite);
	auxiliarybar.showComposite(descriptor.id);
	const content = auxiliarybar.domNode.querySelector(
		":scope > .ash-auxiliarybar-content",
	);

	assert.ok(content);
	assert.equal(content.firstElementChild, composite.element);
	assert.equal(auxiliarybar.activeCompositeId, descriptor.id);
	assert.equal(contextKeys.getValue('activeAuxiliary'), descriptor.id);
	const compositeBar = auxiliarybar.domNode.querySelector<HTMLElement>(".ash-composite-bar");
	assert.ok(compositeBar);
	assert.equal(compositeBar.hidden, true);

	disposables.dispose();
	dom.window.close();
});

class TestPanelView extends ViewPane {
	private readonly actions: HTMLDivElement;

	constructor(container: HTMLElement, options: IViewPaneOptions) {
		super(container, options);
		this.actions = h(container.ownerDocument, "div");
		this.actions.setAttribute("role", "toolbar");
		this.actions.setAttribute("aria-label", "Test panel actions");
		const button = h(container.ownerDocument, "button");
		button.textContent = "Run";
		this.actions.append(button);
	}

	override get partTitleProjection(): PartTitleProjection {
		return { actions: this.actions };
	}
}

class ContentProjectionView extends ViewPane {
	private readonly titleContent: HTMLDivElement;

	constructor(container: HTMLElement, options: IViewPaneOptions) {
		super(container, options);
		this.titleContent = h(container.ownerDocument, "div");
		this.titleContent.dataset.projectionOwner = "content";
	}

	override get partTitleProjection(): PartTitleProjection {
		return { content: this.titleContent };
	}
}

class ActionsProjectionView extends ViewPane {
	private readonly titleActions: HTMLDivElement;

	constructor(container: HTMLElement, options: IViewPaneOptions) {
		super(container, options);
		this.titleActions = h(container.ownerDocument, "div");
		this.titleActions.dataset.projectionOwner = "actions";
	}

	override get partTitleProjection(): PartTitleProjection {
		return { actions: this.titleActions };
	}
}

test("PaneComposite rejects ambiguous title projections from multiple Views", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const disposables = new DisposableStore();
	const registry = new WorkbenchViewRegistry();
	disposables.add(registry.registerViewContainer({
		id: "ash.test.projection",
		title: "Projection test",
		location: ViewContainerLocation.Panel,
		isDefault: true,
	}));
	disposables.add(registry.registerViews("ash.test.projection", [
		{ id: "ash.test.content", title: "Content", ctorDescriptor: new ServiceConstructionDescriptor(ContentProjectionView) },
		{ id: "ash.test.actions", title: "Actions", ctorDescriptor: new ServiceConstructionDescriptor(ActionsProjectionView) },
	]));
	const contextKeys = disposables.add(new ContextKeyService());
	const viewDescriptors = disposables.add(new ViewDescriptorService({
		contextKeyService: contextKeys,
		registry,
	}));
	const descriptor = viewDescriptors.getDefaultViewContainer(ViewContainerLocation.Panel);
	assert.ok(descriptor);
	const composite = new PaneComposite(dom.window.document.body, {
		viewContainer: descriptor,
		model: viewDescriptors.getViewContainerModel(descriptor.id),
		instantiationService: new ServiceContainer(),
		contextKeyService: contextKeys,
	});

	assert.throws(
		() => composite.partTitleProjection,
		/only one visible View/,
	);

	composite.dispose();
	disposables.dispose();
	dom.window.close();
});

test("CompositeBar reorders view container tabs through drag and drop", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const disposables = new DisposableStore();
	const registry = new WorkbenchViewRegistry();
	for (const [id, title, order] of [
		["ash.panel.problems", "Problems", 10],
		["ash.panel.output", "Output", 20],
		["ash.panel.terminal", "Terminal", 30],
	] as const) {
		disposables.add(registry.registerViewContainer({ id, title, order, location: ViewContainerLocation.Panel }));
	}
	const contextKeys = disposables.add(new ContextKeyService());
	const viewDescriptors = disposables.add(new ViewDescriptorService({ contextKeyService: contextKeys, registry }));
	const compositeBar = disposables.add(new CompositeBar(dom.window.document.body, {
		viewDescriptorService: viewDescriptors,
		location: ViewContainerLocation.Panel,
		ariaLabel: "Panel views",
		presentation: "label",
	}));
	dom.window.document.body.append(compositeBar.domNode);
	const [problems, output] = compositeBar.domNode.querySelectorAll<HTMLElement>(".ash-composite-bar-destination");
	assert.ok(problems);
	assert.ok(output);
	output.getBoundingClientRect = () => ({ left: 100, width: 100 } as DOMRect);

	problems.dispatchEvent(compositeBarDragEvent(dom.window, "dragstart"));
	output.dispatchEvent(compositeBarDragEvent(dom.window, "dragover", 175));
	output.dispatchEvent(compositeBarDragEvent(dom.window, "drop", 175));

	assert.deepEqual(
		[...compositeBar.domNode.querySelectorAll<HTMLElement>("[role='tab']")].map((tab) => tab.textContent),
		["Output", "Problems", "Terminal"],
	);
	disposables.dispose();
	dom.window.close();
});

test("titlebar layout commands toggle shell regions", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const harness = createLayoutHarness(dom.window.document);
	const services = new ServiceContainer();
	services.registerInstance(IWorkbenchLayoutService, harness.layout);
	const commands = harness.disposables.add(new CommandService(services));

	assert.equal(harness.layout.isPartVisible("sidebar"), true);
	await commands.executeCommand(ToggleSideBarCommandId);
	assert.equal(harness.layout.isPartVisible("sidebar"), false);
	await commands.executeCommand(ToggleSideBarCommandId);
	assert.equal(harness.layout.isPartVisible("sidebar"), true);

	assert.equal(harness.layout.isPartVisible("auxiliarybar"), true);
	await commands.executeCommand(ToggleAuxiliaryBarCommandId);
	assert.equal(harness.layout.isPartVisible("auxiliarybar"), false);
	await commands.executeCommand(ToggleAuxiliaryBarCommandId);
	assert.equal(harness.layout.isPartVisible("auxiliarybar"), true);

	assert.equal(harness.layout.isPartVisible("panel"), true);
	await commands.executeCommand(TogglePanelCommandId);
	assert.equal(harness.layout.isPartVisible("panel"), false);
	await commands.executeCommand(TogglePanelCommandId);
	assert.equal(harness.layout.isPartVisible("panel"), true);

	assert.equal(harness.layout.isPartVisible("editor"), true);
	await commands.executeCommand(ToggleMaximizedPanelCommandId);
	assert.equal(harness.layout.isPartVisible("panel"), true);
	assert.equal(harness.layout.isPartVisible("editor"), false);
	await commands.executeCommand(ToggleMaximizedPanelCommandId);
	assert.equal(harness.layout.isPartVisible("editor"), true);

	await commands.executeCommand(ToggleMaximizedPanelCommandId);
	await commands.executeCommand(TogglePanelCommandId);
	assert.equal(harness.layout.isPartVisible("panel"), false);
	assert.equal(harness.layout.isPartVisible("editor"), true);

	harness.disposables.dispose();
	dom.window.close();
});

test("panel layout actions use state icons", () => {
	using disposables = new DisposableStore();
	const contextKeys = disposables.add(new ContextKeyService());
	const commands = disposables.add(
		new CommandService(new ServiceContainer()),
	);
	const menuService = new MenuService(commands, contextKeys);
	const panelAction = () => menuService
		.getMenuActions(MenuId.TitleBar)
		.flatMap(([, actions]) => actions)
		.find((action) => action.id === TogglePanelCommandId);
	const maximizePanelAction = () => menuService
		.getMenuActions(MenuId.PanelTitle)
		.flatMap(([, actions]) => actions)
		.find((action) => action.id === ToggleMaximizedPanelCommandId);

	assert.equal(panelAction()?.icon, lxiconsLibrary.layoutPanelOff);
	contextKeys.setContext("panelVisible", true);
	assert.equal(panelAction()?.icon, lxiconsLibrary.layoutPanel);
	assert.equal(maximizePanelAction()?.icon, lxiconsLibrary.screenFull);
	assert.equal(maximizePanelAction()?.checked, false);
	contextKeys.setContext('panelMaximized', true);
	assert.equal(maximizePanelAction()?.icon, lxiconsLibrary.screenNormal);
	assert.equal(maximizePanelAction()?.checked, true);
});

function dragWorkbenchSash(
	targetWindow: typeof browserEnvironment.window,
	container: HTMLElement,
	partId: WorkbenchPartId,
	boundaryIndex: number,
	delta: number,
): void {
	const part = container.querySelector<HTMLElement>(`[data-part='${partId}']`);
	assert.ok(part);
	const splitView = part.parentElement?.parentElement?.parentElement;
	if (!splitView?.classList.contains("ash-split-view")) {
		throw new Error(`Workbench Part ${partId} is not hosted by a SplitView`);
	}
	const sashes = [...splitView.querySelectorAll<HTMLElement>(":scope > .ash-sash")];
	const sash = sashes[boundaryIndex];
	assert.ok(sash);
	const vertical = sash.classList.contains("ash-sash-vertical");
	const event = (type: string, coordinate: number) =>
		new targetWindow.MouseEvent(type, {
			bubbles: true,
			button: 0,
			clientX: vertical ? coordinate : 0,
			clientY: vertical ? 0 : coordinate,
		});
	sash.dispatchEvent(event("pointerdown", 0));
	targetWindow.dispatchEvent(event("pointermove", delta));
	targetWindow.dispatchEvent(event("pointerup", delta));
}

function resetWorkbenchSash(
	targetWindow: typeof browserEnvironment.window,
	container: HTMLElement,
	partId: WorkbenchPartId,
	boundaryIndex: number,
): void {
	const part = container.querySelector<HTMLElement>(`[data-part='${partId}']`);
	assert.ok(part);
	const splitView = part.parentElement?.parentElement?.parentElement;
	if (!splitView?.classList.contains("ash-split-view")) {
		throw new Error(`Workbench Part ${partId} is not hosted by a SplitView`);
	}
	const sash = splitView.querySelectorAll<HTMLElement>(":scope > .ash-sash")[boundaryIndex];
	assert.ok(sash);
	sash.dispatchEvent(new targetWindow.MouseEvent("dblclick", { bubbles: true, detail: 2 }));
}

function compositeBarDragEvent(targetWindow: { readonly Event: typeof Event }, type: string, clientX = 0): DragEvent {
	const event = new targetWindow.Event(type, { bubbles: true, cancelable: true }) as DragEvent;
	Object.defineProperty(event, "clientX", { value: clientX });
	return event;
}
