import { registerTestComponentServices } from '../../../../../test/common/testEditorServices.js';
import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import type { IViewContainerDescriptor, IViewContainerModel } from "../../../../../../workbench/common/views.js";

const browserEnvironment = new JSDOM("<!doctype html><body></body>", { url: "http://localhost" });
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	navigator: browserEnvironment.window.navigator,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { toDisposable } = await import("../../../../../../base/common/lifecycle.js");
const { ContextKeyService, IContextKeyService } = await import("../../../../../../platform/contextkey/browser/contextKeyService.js");
const { ViewContainerLocation } = await import("../../../../../../workbench/common/views.js");
const { ViewPaneContainer } = await import("../../../../../../workbench/browser/parts/views/viewPaneContainer.js");
const { InstantiationService } = await import("../../../../../../platform/instantiation/common/instantiationService.js");
const { BrowserStorageService } = await import("../../../../../../workbench/services/storage/browser/storageService.js");
const { IStorageService } = await import("../../../../../../platform/storage/common/storage.js");

function createStorage(workspaceId: string) {
	return new BrowserStorageService({ ownerWindow: browserEnvironment.window as unknown as Window, workspaceId, backend: browserEnvironment.window.localStorage, flushInterval: 0 });
}

test("ViewPaneContainer opens a fixed visible view without toggling its visibility", () => {
	using storage = createStorage("fixed");
	using services = new InstantiationService();
	services.registerInstance(IStorageService, storage);
	using contextKeys = new ContextKeyService();
	const viewContainer: IViewContainerDescriptor = { id: "test.fixed", title: "Fixed", location: ViewContainerLocation.AuxiliaryBar };
	let visibilityChanges = 0;
	const model = {
		viewContainer,
		allViewDescriptors: [],
		activeViewDescriptors: [],
		visibleViewDescriptors: [],
		onDidChangeAllViewDescriptors: () => toDisposable(() => undefined),
		onDidChangeActiveViewDescriptors: () => toDisposable(() => undefined),
		onDidChangeVisibleViewDescriptors: () => toDisposable(() => undefined),
		isVisible: (viewId: string) => viewId === "test.fixed-view",
		setVisible: () => {
			visibilityChanges += 1;
			throw new Error("fixed view visibility cannot be changed");
		},
	} satisfies IViewContainerModel;
	using container = registerTestComponentServices(services).createInstance(ViewPaneContainer, browserEnvironment.window.document.body, {
		viewContainer,
		model,
		contextKeyService: contextKeys,
		instantiationService: services,
	});

	assert.doesNotThrow(() => container.openView("test.fixed-view"));
	assert.equal(visibilityChanges, 0);

});


suiteTeardown(() => {
	browserEnvironment.window.close();
	for (const name of ["window", "document", "Node", "Element", "HTMLElement", "Event", "navigator"]) Reflect.deleteProperty(globalThis, name);
});

test('ViewPaneContainer derives preferred width from visible view content', async () => {
	const { ViewPane } = await import('../../../../../../workbench/browser/parts/views/viewPane.js');
	const { SyncDescriptor } = await import('../../../../../../platform/instantiation/common/descriptors.js');
	const { WorkbenchViewRegistry } = await import('../../../../../../workbench/common/views.js');
	const { ViewDescriptorService } = await import('../../../../../../workbench/services/views/browser/viewDescriptorService.js');
	class SizedView extends ViewPane {
		constructor(container: HTMLElement, options: import('../../../../../../workbench/browser/parts/views/viewPane.js').IViewPaneOptions) { super(container, options); }
		override getOptimalWidth(): number { return this.id === 'wide' ? 360 : 180; }
	}
	const registry = new WorkbenchViewRegistry();
	const descriptor = { id: 'widths', title: 'Widths', location: ViewContainerLocation.Sidebar };
	using registration = registry.registerViewContainer(descriptor);
	using views = registry.registerViews(descriptor.id, [
		{ id: 'wide', title: 'Wide', canToggleVisibility: true, ctorDescriptor: new SyncDescriptor(SizedView) },
		{ id: 'narrow', title: 'Narrow', canToggleVisibility: true, ctorDescriptor: new SyncDescriptor(SizedView) },
	]);
	using services = new InstantiationService();
	using storage = createStorage('widths');
	services.registerInstance(IStorageService, storage);
	using contextKeys = new ContextKeyService();
	services.registerInstance(IContextKeyService, contextKeys);
	using descriptors = services.createInstance(ViewDescriptorService, { registry });
	const model = descriptors.getViewContainerModel(descriptor.id)!;
	using container = registerTestComponentServices(services).createInstance(ViewPaneContainer, browserEnvironment.window.document.body, {
		viewContainer: descriptor, model, contextKeyService: contextKeys, instantiationService: services,
	});
	assert.equal(container.getOptimalWidth(), 376);
	model.setVisible('wide', false);
	assert.equal(container.getOptimalWidth(), 196);
	model.setVisible('wide', true);
	assert.equal(container.getOptimalWidth(), 376);
});

test("ViewPaneContainer opens a collapsed view and focuses only when requested", async () => {
	const { ViewPane } = await import("../../../../../../workbench/browser/parts/views/viewPane.js");
	const { SyncDescriptor } = await import('../../../../../../platform/instantiation/common/descriptors.js');
	class TestView extends ViewPane {
		constructor(container: HTMLElement, options: import("../../../../../../workbench/browser/parts/views/viewPane.js").IViewPaneOptions) {
			super(container, options);
		}
	}
	using services = new InstantiationService();
	using storage = createStorage("collapsed");
	services.registerInstance(IStorageService, storage);
	using contextKeys = new ContextKeyService();
	const viewContainer: IViewContainerDescriptor = { id: "test", title: "Test", location: ViewContainerLocation.Panel };
	const descriptor = { id: "test.view", title: "Test View", collapsed: true, ctorDescriptor: new SyncDescriptor(TestView) };
	const views = [descriptor];
	using container = registerTestComponentServices(services).createInstance(ViewPaneContainer, browserEnvironment.window.document.body, {
		viewContainer,
		model: {
			viewContainer,
			allViewDescriptors: views,
			activeViewDescriptors: views,
			visibleViewDescriptors: views,
			onDidChangeAllViewDescriptors: () => toDisposable(() => undefined),
			onDidChangeActiveViewDescriptors: () => toDisposable(() => undefined),
			onDidChangeVisibleViewDescriptors: () => toDisposable(() => undefined),
			isVisible: () => true,
			setVisible: () => { throw new Error("View is already registered as visible"); },
		},
		contextKeyService: contextKeys,
		instantiationService: services,
	});
	const view = container.getView(descriptor.id)!;
	assert.equal(view.isBodyVisible(), false);
	const focusSource = browserEnvironment.window.document.activeElement;
	assert.equal(container.openView(descriptor.id), view);
	assert.equal(view.isBodyVisible(), true);
	assert.equal(browserEnvironment.window.document.activeElement, focusSource);
	view.setExpanded(false);
	container.openView(descriptor.id, true);
	assert.equal(view.isBodyVisible(), true);
	assert.equal(browserEnvironment.window.document.activeElement, view.element);
});

test("ViewPaneContainer retains hidden view instances and restores workspace sizes and collapse state", async () => {
	const { ViewPane } = await import("../../../../../../workbench/browser/parts/views/viewPane.js");
	const { SyncDescriptor } = await import("../../../../../../platform/instantiation/common/descriptors.js");
	const { WorkbenchViewRegistry } = await import("../../../../../../workbench/common/views.js");
	const { ViewDescriptorService } = await import("../../../../../../workbench/services/views/browser/viewDescriptorService.js");
	let created = 0;
	let disposed = 0;
	class TestView extends ViewPane {
		readonly input: HTMLInputElement;
		constructor(container: HTMLElement, options: import("../../../../../../workbench/browser/parts/views/viewPane.js").IViewPaneOptions) {
			super(container, options);
			created += 1;
			this.input = container.ownerDocument.createElement("input");
			this.contentElement.append(this.input);
			this._register(toDisposable(() => disposed += 1));
		}
	}
	using services = new InstantiationService();
	using contextKeys = new ContextKeyService();
	const registry = new WorkbenchViewRegistry();
	const viewContainer = { id: "test.multiple", title: "Multiple", location: ViewContainerLocation.Sidebar };
	using registration = registry.registerViewContainer(viewContainer);
	using views = registry.registerViews(viewContainer.id, [
		{ id: "test.first", title: "First", ctorDescriptor: new SyncDescriptor(TestView) },
		{ id: "test.second", title: "Second", collapsed: true, ctorDescriptor: new SyncDescriptor(TestView) },
	]);
	using descriptors = new ViewDescriptorService({ registry }, contextKeys);
	using storage = createStorage("test");
	const options = { viewContainer, model: descriptors.getViewContainerModel(viewContainer.id), instantiationService: services, contextKeyService: contextKeys };
	assert.throws(() => services.createInstance(ViewPaneContainer, browserEnvironment.window.document.body, options), /Unknown service: storageService/);
	services.registerInstance(IStorageService, storage);
	const container = registerTestComponentServices(services).createInstance(ViewPaneContainer, browserEnvironment.window.document.body, options);
	container.layout({ height: 600, width: 280 });
	const first = container.getView("test.first") as TestView;
	const second = container.getView("test.second") as TestView;
	second.setExpanded(true);
	container.resizeView(second, 270);
	second.input.value = "unsent expression";
	for (let attempt = 0; attempt < 3; attempt += 1) {
		options.model.setVisible(second.id, false);
		assert.equal(container.getView(second.id), undefined);
		assert.equal(second.isVisible(), false);
		assert.equal(second.element.isConnected, false);
		assert.equal(container.openView(second.id), second);
		assert.equal(second.input.value, "unsent expression");
		assert.equal(container.getViewSize(second), 270);
	}
	assert.equal(created, 2);
	assert.equal(disposed, 0);
	container.resizeView(second, 270);
	second.setExpanded(false);
	assert.deepEqual([container.getViewSize(first), container.getViewSize(second)], [572, 28]);
	container.dispose();
	assert.equal(disposed, 2);
	using restored = registerTestComponentServices(services).createInstance(ViewPaneContainer, browserEnvironment.window.document.body, options);
	const restoredSecond = restored.getView(second.id)!;
	restored.layout({ height: 600, width: 280 });
	assert.equal(restoredSecond.isExpanded(), false);
	restoredSecond.setExpanded(true);
	assert.equal(restored.getViewSize(restoredSecond), 270);
	using otherStorage = createStorage("other");
	using otherServices = services.createChild();
	otherServices.registerInstance(IStorageService, otherStorage);
	using otherWorkspace = otherServices.createInstance(ViewPaneContainer, browserEnvironment.window.document.body, { ...options, instantiationService: otherServices });
	otherWorkspace.layout({ height: 600, width: 280 });
	const otherSecond = otherWorkspace.getView(second.id)!;
	assert.equal(otherSecond.isExpanded(), false);
	otherSecond.setExpanded(true);
	assert.equal(otherWorkspace.getViewSize(otherSecond), 200);
	views.dispose();
	assert.equal(restored.panes.length, 0);
	assert.equal(disposed, 6);
});
