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

const { toDisposable, DisposableStore } = await import("../../../../../../base/common/lifecycle.js");
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
	const options = {
		viewContainer,
		model,
		contextKeyService: contextKeys,
		instantiationService: services,
	};
	registerTestComponentServices(services);
	assert.throws(() => services.createInstance(ViewPaneContainer, browserEnvironment.window.document.body, options), /Unknown service:.*menuService/i);
	using container = registerContainerServices(services).createInstance(ViewPaneContainer, browserEnvironment.window.document.body, options);

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
	using container = registerContainerServices(services).createInstance(ViewPaneContainer, browserEnvironment.window.document.body, {
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
	using container = registerContainerServices(services).createInstance(ViewPaneContainer, browserEnvironment.window.document.body, {
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
	const container = registerContainerServices(services).createInstance(ViewPaneContainer, browserEnvironment.window.document.body, options);
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
	using restored = registerContainerServices(services).createInstance(ViewPaneContainer, browserEnvironment.window.document.body, options);
	const restoredSecond = restored.getView(second.id)!;
	restored.layout({ height: 600, width: 280 });
	assert.equal(restoredSecond.isExpanded(), false);
	restoredSecond.setExpanded(true);
	assert.equal(restored.getViewSize(restoredSecond), 270);
	using otherStorage = createStorage("other");
	using otherServices = services.createChild();
	otherServices.registerInstance(IStorageService, otherStorage);
	using otherWorkspace = registerContainerServices(otherServices).createInstance(ViewPaneContainer, browserEnvironment.window.document.body, { ...options, instantiationService: otherServices });
	otherWorkspace.layout({ height: 600, width: 280 });
	const otherSecond = otherWorkspace.getView(second.id)!;
	assert.equal(otherSecond.isExpanded(), false);
	otherSecond.setExpanded(true);
	assert.equal(otherWorkspace.getViewSize(otherSecond), 200);
	views.dispose();
	assert.equal(restored.panes.length, 0);
	assert.equal(disposed, 6);
});

const { IMenuService } = await import('../../../../../../platform/actions/common/actions.js');
const { MenuService } = await import('../../../../../../platform/actions/common/menuService.js');
const { CommandService } = await import('../../../../../../workbench/services/commands/common/commandService.js');
const titleMenuResources = new DisposableStore();
suiteTeardown(() => titleMenuResources.dispose());

function registerContainerServices(services: InstanceType<typeof InstantiationService>): InstanceType<typeof InstantiationService> {
	registerTestComponentServices(services);
	if (!services.has(IMenuService)) {
		const context = titleMenuResources.add(new ContextKeyService());
		const commands = titleMenuResources.add(new CommandService(services));
		services.registerInstance(IMenuService, new MenuService(commands, context));
	}
	return services;
}


test('Pane Composite combines scoped container and View actions while retaining the global title menu', async () => {
	const { WorkbenchViewRegistry, IViewDescriptorService } = await import('../../../../../../workbench/common/views.js');
	const { ViewDescriptorService } = await import('../../../../../../workbench/services/views/browser/viewDescriptorService.js');
	const { ViewPane } = await import('../../viewPane.js');
	const { PaneComposite } = await import('../../paneComposite.js');
	const { SidebarPart } = await import('../../../../../../workbench/browser/parts/sidebar/sidebarPart.js');
	const { SyncDescriptor } = await import('../../../../../../platform/instantiation/common/descriptors.js');
	const { MenusRegistry, MenuId } = await import('../../../../../../platform/actions/common/actions.js');
	const { ContextKeyExpr } = await import('../../../../../../platform/contextkey/common/contextkey.js');
	using resources = new DisposableStore();
	const services = resources.add(new InstantiationService());
	const context = resources.add(new ContextKeyService());
	const registry = new WorkbenchViewRegistry();
	let runs = 0;
	class ActionView extends ViewPane {
		constructor(container: HTMLElement, options: import('../../viewPane.js').IViewPaneOptions) {
			super(container, options);
			this.headerActionsElement.setAttribute('aria-label', 'View title actions');
		}
		public override getActions(): readonly import('../../../../../../base/common/actions.js').IAction[] { return [{ id: 'fixture.viewAction', label: 'View action', tooltip: '', enabled: true, run: () => { runs++; } }]; }
	}
	const active = { id: 'fixture.title-actions', title: 'Actions', location: ViewContainerLocation.Sidebar, mergeViewWithContainerWhenSingleView: true };
	const empty = { id: 'fixture.empty-title', title: 'Empty', location: ViewContainerLocation.Sidebar };
	const registration = resources.add(registry.registerViewContainer(active));
	resources.add(registry.registerViewContainer(empty));
	resources.add(registry.registerViews(active.id, [{ id: 'fixture.action-view', title: 'View', canToggleVisibility: false, ctorDescriptor: new SyncDescriptor(ActionView) }]));
	const descriptors = resources.add(new ViewDescriptorService({ registry }, context));
	services.registerInstance(IViewDescriptorService, descriptors);
	const menus = registerContainerServices(services).get(IMenuService);
	resources.add(MenusRegistry.appendMenuItem(MenuId.ViewContainerTitle, { command: { id: 'fixture.containerAction', title: 'Container action' }, group: 'navigation', when: ContextKeyExpr.equals('viewContainer', active.id) }));
	resources.add(MenusRegistry.appendMenuItem(MenuId.ViewContainerTitleContext, { command: { id: 'fixture.containerContext', title: 'Container context' }, when: ContextKeyExpr.equals('viewContainer', active.id) }));
	resources.add(MenusRegistry.appendMenuItem(MenuId.SidebarTitle, { command: { id: 'fixture.globalAction', title: 'Global action' }, group: 'navigation' }));
	let shown: readonly import('../../../../../../base/common/actions.js').IAction[] = [];
	const part = resources.add(services.createInstance(SidebarPart, browserEnvironment.window.document.body, {
		openComposite: async () => null, viewDescriptorService: descriptors, contextKeyService: context,
		titleActions: { menuService: menus, contextMenuProvider: { showContextMenu: (delegate: import('../../../../../../base/browser/contextmenu.js').IContextMenuDelegate) => { shown = delegate.getActions?.() ?? []; } }, menuId: MenuId.SidebarTitle, primaryGroup: 'navigation' },
	}));
	const create = (descriptor: typeof active | typeof empty) => services.createInstance(PaneComposite, part.domNode, {
		viewContainer: descriptor, model: descriptors.getViewContainerModel(descriptor.id), instantiationService: services, contextKeyService: context,
		mergeViewWithContainerWhenSingleView: descriptor === active,
	});
	const composite = create(active);
	part.addComposite(composite);
	part.addComposite(create(empty));
	part.showComposite(active.id);
	const titleToolbar = part.domNode.querySelector<HTMLElement>('[role="toolbar"][aria-label="View title actions"]')!;
	assert.ok(titleToolbar);
	assert.deepEqual(composite.getActions().map(action => action.id), ['fixture.containerAction', 'fixture.viewAction']);
	assert.deepEqual(composite.getSecondaryActions(), [], 'A disabled sole-view toggle does not create a Views menu');
	assert.equal(part.domNode.querySelectorAll('.ash-pane-composite-title [data-action-id="fixture.viewAction"]').length, 1);
	part.domNode.querySelector<HTMLButtonElement>('[data-action-id="fixture.viewAction"] button')!.click();
	assert.equal(runs, 1);
	part.setVisible(false);
	part.setVisible(true);
	part.showComposite(active.id);
	assert.equal(part.domNode.querySelectorAll('.ash-pane-composite-title [data-action-id="fixture.viewAction"]').length, 1, 'Reopening the retained Composite keeps its title actions attached');
	part.domNode.querySelector('.ash-workbench-part-title')!.dispatchEvent(new browserEnvironment.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
	assert.ok(shown.some(action => action.id === 'fixture.containerContext'));
	assert.equal(shown.some(action => action.id === 'fixture.globalAction'), false);
	resources.add(registry.registerViews(active.id, [{ id: 'fixture.toggleable', title: 'Toggleable', canToggleVisibility: true, hideByDefault: true, ctorDescriptor: new SyncDescriptor(ActionView) }]));
	const viewActions = composite.getSecondaryActions();
	assert.deepEqual(viewActions.map(action => action.id), ['fixture.toggleable.toggleVisibility', 'fixture.action-view.toggleVisibility'], 'A sole Views submenu becomes direct title actions in menu order');
	await viewActions.find(action => action.id === 'fixture.toggleable.toggleVisibility')!.run();
	assert.equal(descriptors.getViewContainerModel(active.id).isVisible('fixture.toggleable'), true);
	await composite.getSecondaryActions().find(action => action.id === 'fixture.toggleable.toggleVisibility')!.run();
	assert.equal(descriptors.getViewContainerModel(active.id).isVisible('fixture.toggleable'), false);
	part.showComposite(empty.id);
	assert.equal(titleToolbar.getAttribute('aria-label'), 'Empty', 'The retained renderer releases the previous View accessible name');
	assert.equal(part.domNode.querySelector('[data-action-id="fixture.viewAction"]'), null);
	assert.equal(part.domNode.querySelectorAll('[data-action-id="fixture.globalAction"]').length, 1);
	shown = [];
	part.domNode.querySelector('.ash-workbench-part-title')!.dispatchEvent(new browserEnvironment.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
	assert.equal(shown.some(action => action.id === 'fixture.containerContext'), false);
	part.showComposite(active.id);
	assert.equal(part.getComposite(active.id), composite);
	let titleChanges = 0;
	resources.add(composite.onTitleAreaUpdate(() => titleChanges++));
	registration.dispose();
	assert.equal(part.activeCompositeId, undefined);
	assert.equal(part.domNode.querySelector('[data-action-id="fixture.viewAction"]'), null);
	const before = titleChanges;
	resources.add(MenusRegistry.appendMenuItem(MenuId.ViewContainerTitle, { command: { id: 'fixture.afterDispose', title: 'After disposal' }, group: 'navigation' }));
	assert.equal(titleChanges, before, 'Removed containers release their menu subscriptions');
});
