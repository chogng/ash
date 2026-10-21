import { ViewDescriptorService } from '../../services/views/browser/viewDescriptorService.js';
import { BrowserStorageService } from '../../services/storage/browser/storageService.js';
import { StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { TestViewDescriptorService } from '../browser/workbenchTestServices.js';
import { MenuId } from '../../../platform/actions/common/actions.js';
import { MenuService } from '../../../platform/actions/common/menuService.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { CommandService } from '../../services/commands/common/commandService.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from 'jsdom';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { ContextKeyExpr } from "../../../platform/contextkey/common/contextkey.js";
import { ContextKeyService, IContextKeyService } from "../../../platform/contextkey/browser/contextKeyService.js";
import { SyncDescriptor } from "../../../platform/instantiation/common/descriptors.js";
import {
	IViewDescriptorService,
	type IView,
	type IViewDescriptor,
	ViewContainerLocation,
	WorkbenchViewRegistry,
} from "../../../workbench/common/views.js";
import { IViewsService } from '../../services/views/common/viewsService.js';

test('container commands open in the invoking window and expire with their declaration', async () => {
	using registry = new WorkbenchViewRegistry();
	using registration = registry.registerViewContainer({ id: 'test.openContainer', title: 'Open container', location: ViewContainerLocation.Sidebar });
	using services = new InstantiationService();
	const opened: unknown[] = [];
	services.registerInstance(IViewsService, { openViewContainer: async (id, focus) => { opened.push([id, focus]); return null; } } as IViewsService);
	using commands = new CommandService(services);
	await commands.executeCommand('test.openContainer');
	assert.deepEqual(opened, [['test.openContainer', true]]);
	registration.dispose();
	assert.equal(CommandsRegistry.getCommand('test.openContainer'), undefined);
});

test('moving a container changes routing while retaining its model and independent window defaults', () => {
	using registry = new WorkbenchViewRegistry();
	using registration = registry.registerViewContainer({ id: 'test.movable', title: 'Movable', location: ViewContainerLocation.Sidebar, isDefault: true });
	using contexts = new ContextKeyService();
	using first = new TestViewDescriptorService({ registry }, contexts);
	using other = new TestViewDescriptorService({ registry }, contexts);
	using views = registry.registerViews('test.movable', [testView('test.movable.view', 'View')]);
	const model = first.getViewContainerModel('test.movable');
	model.setVisible('test.movable.view', false);
	const events: string[] = [];
	using listener = first.onDidChangeViewContainers(event => events.push(`${event.removed[0]?.location}->${event.added[0]?.location}`));
	const container = first.getViewContainerById('test.movable')!;
	first.moveViewContainerToLocation(container, ViewContainerLocation.Panel);
	assert.equal(first.getViewContainers(ViewContainerLocation.Sidebar).length, 0);
	assert.equal(first.getViewContainerForView('test.movable.view')?.location, ViewContainerLocation.Panel);
	assert.equal(first.getDefaultViewContainer(ViewContainerLocation.Sidebar), undefined);
	assert.equal(first.getViewContainerLocation(container), ViewContainerLocation.Panel);
	assert.equal(first.getViewContainerModel(container.id), model);
	assert.equal(model.isVisible('test.movable.view'), false);
	assert.equal(other.getViewContainerLocation(container), ViewContainerLocation.Sidebar);
	assert.equal(first.getDefaultViewContainerLocation(container), ViewContainerLocation.Sidebar);
	first.moveViewContainerToLocation(container, ViewContainerLocation.Panel);
	assert.deepEqual(events, ['sidebar->panel']);
	using restored = new TestViewDescriptorService({ registry, viewContainerLocations: { 'test.movable': ViewContainerLocation.Panel } }, contexts);
	assert.equal(restored.getViewContainerLocation(container), ViewContainerLocation.Panel);
	first.moveViewContainerToLocation(container, ViewContainerLocation.Sidebar);
	assert.deepEqual(events, ['sidebar->panel', 'panel->sidebar']);
	registration.dispose();
	assert.equal(first.getViewContainerById(container.id), null);
});

test("view descriptor models project registry and context visibility", () => {
	using contextKeys = new ContextKeyService();
	using registry = new WorkbenchViewRegistry();
	using descriptors = new TestViewDescriptorService({
		registry,
	}, contextKeys);
	using containerRegistration = registry.registerViewContainer({
		id: "test.sidebar",
		title: "Test",
		location: ViewContainerLocation.Sidebar,
		isDefault: true,
	});
	const model = descriptors.getViewContainerModel("test.sidebar");
	const changes: string[] = [];
	using listener = model.onDidChangeVisibleViewDescriptors((event) => {
		changes.push(
			`+${event.added.map((view) => view.id).join(",")}` +
			` -${event.removed.map((view) => view.id).join(",")}`,
		);
	});
	using viewRegistrations = registry.registerViews("test.sidebar", [
		testView("test.always", "Always", {
			order: 10,
		}),
		testView("test.conditional", "Conditional", {
			order: 20,
			when: ContextKeyExpr.has("test.featureEnabled"),
		}),
		testView("test.hidden", "Hidden", {
			order: 30,
			hideByDefault: true,
		}),
	]);

	assert.deepEqual(
		model.visibleViewDescriptors.map((view) => view.id),
		["test.always"],
	);
	assert.equal(contextKeys.getValue("view.test.always.visible"), true);
	assert.equal(
		contextKeys.getValue("view.test.conditional.visible"),
		false,
	);

	contextKeys.setContext("test.featureEnabled", true);
	assert.deepEqual(
		model.visibleViewDescriptors.map((view) => view.id),
		["test.always", "test.conditional"],
	);
	model.setVisible("test.hidden", true);
	assert.deepEqual(
		model.visibleViewDescriptors.map((view) => view.id),
		["test.always", "test.conditional", "test.hidden"],
	);
	model.setVisible("test.always", false);
	assert.equal(contextKeys.getValue("view.test.always.visible"), false);
	assert.deepEqual(changes, [
		"+test.always -",
		"+test.conditional -",
		"+test.hidden -",
		"+ -test.always",
	]);
});

test("view descriptor service resolves default containers by location", () => {
	using contextKeys = new ContextKeyService();
	using registry = new WorkbenchViewRegistry();
	using first = registry.registerViewContainer({
		id: "test.first",
		title: "First",
		location: ViewContainerLocation.Sidebar,
		order: 20,
	});
	using defaultContainer = registry.registerViewContainer({
		id: "test.default",
		title: "Default",
		location: ViewContainerLocation.Sidebar,
		order: 30,
		isDefault: true,
	});
	using descriptors = new TestViewDescriptorService({
		registry,
	}, contextKeys);

	assert.equal(
		descriptors.getDefaultViewContainer(
			ViewContainerLocation.Sidebar,
		)?.id,
		"test.default",
	);
	assert.deepEqual(
		descriptors.getViewContainers(ViewContainerLocation.Sidebar)
			.map((container) => container.id),
		["test.first", "test.default"],
	);
});

test("view descriptor service keeps a window-local container order", () => {
	using contextKeys = new ContextKeyService();
	using registry = new WorkbenchViewRegistry();
	using first = registry.registerViewContainer({ id: "test.first", title: "First", location: ViewContainerLocation.Panel, order: 10 });
	using second = registry.registerViewContainer({ id: "test.second", title: "Second", location: ViewContainerLocation.Panel, order: 20 });
	using third = registry.registerViewContainer({ id: "test.third", title: "Third", location: ViewContainerLocation.Panel, order: 30 });
	using descriptors = new TestViewDescriptorService({ registry }, contextKeys);
	const changes: ViewContainerLocation[] = [];
	using listener = descriptors.onDidChangeViewContainerOrder((location) => changes.push(location));

	descriptors.moveViewContainer(ViewContainerLocation.Panel, "test.third", "test.first", "before");
	assert.deepEqual(descriptors.getViewContainers(ViewContainerLocation.Panel).map((container) => container.id), ["test.third", "test.first", "test.second"]);
	assert.deepEqual(changes, [ViewContainerLocation.Panel]);

	descriptors.moveViewContainer(ViewContainerLocation.Panel, "test.third", undefined, "after");
	assert.deepEqual(descriptors.getViewContainers(ViewContainerLocation.Panel).map((container) => container.id), ["test.first", "test.second", "test.third"]);
});

type TestViewDescriptorOptions = Omit<
	IViewDescriptor,
	"id" | "title" | "ctorDescriptor"
>;

function testView(
	id: string,
	title: string,
	options: TestViewDescriptorOptions = {},
): IViewDescriptor {
	return {
		id,
		title,
		ctorDescriptor: new SyncDescriptor(TestView, [id]),
		...options,
	};
}

class TestView implements IView {
	private visible = true;
	public get paneTitle(): string { return this.id; }
	public hasFocus(): boolean { return false; }
	public isBodyVisible(): boolean { return this.visible; }
	public setExpanded(): boolean { return false; }

	constructor(readonly id: string) { }

	focus(): void { }

	isVisible(): boolean {
		return this.visible;
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
	}
}

test('view welcome registrations sort content and release each contribution independently', () => {
	using registry = new WorkbenchViewRegistry();
	const events: string[] = [];
	using listener = registry.onDidChangeViewWelcomeContent(id => events.push(id));
	using later = registry.registerViewWelcomeContent('welcome.test', { content: 'Later', group: '5_scm' });
	using first = registry.registerViewWelcomeContent('welcome.test', { content: 'First', group: '2_open', order: 1 });
	using second = registry.registerViewWelcomeContent('welcome.test', { content: 'Second', group: '2_open', order: 2 });
	assert.deepEqual(registry.getViewWelcomeContent('welcome.test').map(item => item.content), ['First', 'Second', 'Later']);
	second.dispose();
	assert.deepEqual(registry.getViewWelcomeContent('welcome.test').map(item => item.content), ['First', 'Later']);
	assert.deepEqual(events, ['welcome.test', 'welcome.test', 'welcome.test', 'welcome.test']);
});


test('view visibility menus execute in the invoking window and expire with declarations', async () => {
	const environment = new JSDOM('<!doctype html><body></body>');
	using environmentOwner = toDisposable(() => environment.window.close());
	using firstContext = new ContextKeyService();
	using secondContext = new ContextKeyService();
	using containerContext = firstContext.createScoped(environment.window.document.body);
	containerContext.setContext('viewContainer', 'test.visibility');
	using registry = new WorkbenchViewRegistry();
	using container = registry.registerViewContainer({ id: 'test.visibility', title: 'Visibility', location: ViewContainerLocation.Sidebar });
	using first = new TestViewDescriptorService({ registry }, firstContext);
	using second = new TestViewDescriptorService({ registry }, secondContext);
	using registrations = registry.registerViews('test.visibility', [
		testView('test.visibility.first', 'First'),
		testView('test.visibility.second', 'Second'),
		testView('test.visibility.conditional', 'Conditional', { when: ContextKeyExpr.has('test.visibility.feature') }),
	]);
	using services = new InstantiationService();
	services.registerInstance(IViewDescriptorService, first);
	using commands = new CommandService(services);
	firstContext.setContext('activeViewlet', 'test.visibility');
	const menus = new MenuService(commands, firstContext);
	const items = () => menus.getMenuActions(MenuId.ViewContainerTitleContext, undefined, containerContext).flatMap(([, actions]) => actions).filter(action => action.id.startsWith('test.visibility.'));
	assert.deepEqual(items().map(action => [action.label, action.checked, action.enabled]), [['First', true, true], ['Second', true, true]]);
	await items().find(action => action.label === 'Second')!.run();
	assert.equal(first.getViewContainerModel('test.visibility').isVisible('test.visibility.second'), false);
	assert.equal(second.getViewContainerModel('test.visibility').isVisible('test.visibility.second'), true);
	assert.deepEqual(items().map(action => [action.label, action.checked, action.enabled]), [['First', true, false], ['Second', false, true]]);
	// Direct dispatch must respect the last-view constraint too.
	await commands.executeCommand('test.visibility.first.toggleVisibility');
	assert.equal(first.getViewContainerModel('test.visibility').isVisible('test.visibility.first'), true);
	await items().find(action => action.label === 'Second')!.run();
	firstContext.setContext('test.visibility.feature', true);
	assert.deepEqual(items().map(action => action.label), ['Conditional', 'First', 'Second']);
	firstContext.setContext('activeViewlet', 'another.container');
	assert.deepEqual(items().map(action => action.label), ['Conditional', 'First', 'Second']);
	containerContext.setContext('viewContainer', 'another.container');
	assert.equal(items().length, 0);
	containerContext.setContext('viewContainer', 'test.visibility');
	assert.deepEqual(items().map(action => action.label), ['Conditional', 'First', 'Second']);
	registrations.dispose();
	assert.equal(CommandsRegistry.getCommand('test.visibility.first.toggleVisibility'), undefined);
	assert.equal(items().length, 0);
	registry.registerStaticViews('test.visibility', [testView('test.visibility.static', 'Static')]);
	registry.dispose();
	assert.equal(CommandsRegistry.getCommand('test.visibility.static.toggleVisibility'), undefined);
	assert.equal(first.getViewContainerById('test.visibility'), null);
	assert.equal(second.getViewContainerById('test.visibility'), null);
	assert.throws(() => registry.registerStaticViews('test.visibility', []), /disposed/i);
});

test('view visibility persists explicit profile choices across reconstruction without persisting when conditions', () => {
	using registry = new WorkbenchViewRegistry();
	registry.registerStaticViewContainer({ id: 'test.persist', title: 'Persist', location: ViewContainerLocation.Sidebar });
	registry.registerStaticViews('test.persist', [
		{ ...testView('test.persist.first', 'First'), when: ContextKeyExpr.has('enabled') },
		{ ...testView('test.persist.fixed', 'Fixed'), canToggleVisibility: false },
		{ ...testView('test.persist.hidden', 'Hidden'), hideByDefault: true },
	]);
	const browser = new JSDOM('', { url: 'https://views.test' });
	try {
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'first', flushInterval: 0 });
		using contexts = new ContextKeyService();
		const enabled = contexts.createKey<boolean>('enabled', true);
		using first = new TestViewDescriptorService({ registry }, contexts, storage);
		const model = first.getViewContainerModel('test.persist');
		model.setVisible('test.persist.first', false);
		model.setVisible('test.persist.hidden', true);
		const saved = storage.get('test.persist.state.hidden', StorageScope.PROFILE);
		enabled.set(false);
		enabled.set(true);
		assert.equal(model.isVisible('test.persist.first'), false);
		assert.equal(storage.get('test.persist.state.hidden', StorageScope.PROFILE), saved);
		storage.switchWorkspace('second');
		assert.equal(model.isVisible('test.persist.first'), false);
		first.dispose();
		using restoredStorage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'second', flushInterval: 0 });
		using restored = new TestViewDescriptorService({ registry }, contexts, restoredStorage);
		assert.equal(restored.getViewContainerModel('test.persist').isVisible('test.persist.first'), false);
		assert.equal(restored.getViewContainerModel('test.persist').isVisible('test.persist.fixed'), true);
		assert.equal(restored.getViewContainerModel('test.persist').isVisible('test.persist.hidden'), true);
		using otherProfile = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'second', profileId: 'other', flushInterval: 0 });
		using other = new TestViewDescriptorService({ registry }, contexts, otherProfile);
		assert.equal(other.getViewContainerModel('test.persist').isVisible('test.persist.first'), true);
	} finally { browser.window.close(); }
});

test('view visibility observes stored changes, retains late views and rejects malformed complete state', () => {
	using registry = new WorkbenchViewRegistry();
	registry.registerStaticViewContainer({ id: 'test.stored', title: 'Stored', location: ViewContainerLocation.Sidebar });
	registry.registerStaticViews('test.stored', [testView('test.stored.first', 'First')]);
	const browser = new JSDOM('', { url: 'https://views.test' });
	try {
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'stored', flushInterval: 0 });
		const key = 'test.stored.state.hidden';
		storage.store(key, JSON.stringify([{ id: 'test.stored.later', isHidden: true }]), StorageScope.PROFILE, StorageTarget.MACHINE);
		using contexts = new ContextKeyService();
		using descriptors = new TestViewDescriptorService({ registry }, contexts, storage);
		const model = descriptors.getViewContainerModel('test.stored');
		model.setVisible('test.stored.first', false);
		registry.registerStaticViews('test.stored', [testView('test.stored.later', 'Later')]);
		assert.equal(model.isVisible('test.stored.later'), false);
		for (const invalid of ['{', '[{"id":"test.stored.first","isHidden":"false"}]', '[{"id":"test.stored.first","isHidden":false},{"id":"test.stored.first","isHidden":true}]']) {
			storage.store(key, invalid, StorageScope.PROFILE, StorageTarget.MACHINE);
			assert.equal(model.isVisible('test.stored.first'), false);
		}
		storage.remove(key, StorageScope.PROFILE);
		assert.deepEqual(model.visibleViewDescriptors.map(view => view.id), ['test.stored.first', 'test.stored.later']);
	} finally { browser.window.close(); }
});

test('view models require storage at the production constructor and preserve reentrant visibility changes', () => {
	using registry = new WorkbenchViewRegistry();
	registry.registerStaticViewContainer({ id: 'test.required', title: 'Required', location: ViewContainerLocation.Sidebar });
	registry.registerStaticViews('test.required', [testView('test.required.first', 'First'), testView('test.required.second', 'Second')]);
	using contexts = new ContextKeyService();
	using incomplete = new InstantiationService();
	incomplete.registerInstance(IContextKeyService, contexts);
	assert.throws(() => incomplete.createInstance(ViewDescriptorService, { registry }), /storageService/);
	using descriptors = new TestViewDescriptorService({ registry }, contexts);
	const model = descriptors.getViewContainerModel('test.required');
	using subscription = model.onDidChangeVisibleViewDescriptors(event => {
		if (event.removed.some(view => view.id === 'test.required.first')) model.setVisible('test.required.second', false);
	});
	model.setVisible('test.required.first', false);
	assert.deepEqual(model.visibleViewDescriptors, []);
});
