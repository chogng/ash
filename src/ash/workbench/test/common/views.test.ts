import { MenuId } from '../../../platform/actions/common/actions.js';
import { MenuService } from '../../../platform/actions/common/menuService.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { CommandService } from '../../services/commands/common/commandService.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { ContextKeyExpr } from "../../../platform/contextkey/common/contextkey.js";
import { ContextKeyService } from "../../../platform/contextkey/browser/contextKeyService.js";
import { SyncDescriptor } from "../../../platform/instantiation/common/descriptors.js";
import {
	IViewDescriptorService,
	type IView,
	type IViewDescriptor,
	ViewContainerLocation,
	WorkbenchViewRegistry,
} from "../../../workbench/common/views.js";
import { ViewDescriptorService } from "../../../workbench/services/views/browser/viewDescriptorService.js";

test("view descriptor models project registry and context visibility", () => {
	using contextKeys = new ContextKeyService();
	using registry = new WorkbenchViewRegistry();
	using descriptors = new ViewDescriptorService({
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
	using descriptors = new ViewDescriptorService({
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
	using descriptors = new ViewDescriptorService({ registry }, contextKeys);
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
	using firstContext = new ContextKeyService();
	using secondContext = new ContextKeyService();
	using registry = new WorkbenchViewRegistry();
	using container = registry.registerViewContainer({ id: 'test.visibility', title: 'Visibility', location: ViewContainerLocation.Sidebar });
	using first = new ViewDescriptorService({ registry }, firstContext);
	using second = new ViewDescriptorService({ registry }, secondContext);
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
	const items = () => menus.getMenuActions(MenuId.SidebarTitle).flatMap(([, actions]) => actions).filter(action => action.id.startsWith('test.visibility.'));
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
	assert.equal(items().length, 0);
	registrations.dispose();
	assert.equal(CommandsRegistry.getCommand('test.visibility.first.toggleVisibility'), undefined);
	assert.equal(menus.getMenuActions(MenuId.SidebarTitle).flatMap(([, actions]) => actions).some(action => action.id.startsWith('test.visibility.')), false);
	registry.registerStaticViews('test.visibility', [testView('test.visibility.static', 'Static')]);
	registry.dispose();
	assert.equal(CommandsRegistry.getCommand('test.visibility.static.toggleVisibility'), undefined);
	assert.equal(first.getViewContainerById('test.visibility'), null);
	assert.equal(second.getViewContainerById('test.visibility'), null);
	assert.throws(() => registry.registerStaticViews('test.visibility', []), /disposed/i);
});
