import assert from "node:assert/strict";
import { test } from "mocha";
import { ContextKeyExpr } from "../../../platform/contextkey/common/contextkey.js";
import { ContextKeyService } from "../../../platform/contextkey/browser/contextKeyService.js";
import {
	ServiceConstructionDescriptor,
} from "../../../platform/instantiation/common/instantiation.js";
import {
	type IView,
	type IViewDescriptor,
	ViewContainerLocation,
	WorkbenchViewRegistry,
} from "../../../workbench/common/views.js";
import {
	ViewDescriptorService,
} from "../../../workbench/services/views/common/viewDescriptorService.js";

test("view descriptor models project registry and context visibility", () => {
	using contextKeys = new ContextKeyService();
	const registry = new WorkbenchViewRegistry();
	using descriptors = new ViewDescriptorService({
		contextKeyService: contextKeys,
		registry,
	});
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
	const registry = new WorkbenchViewRegistry();
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
		contextKeyService: contextKeys,
		registry,
	});

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
	const registry = new WorkbenchViewRegistry();
	using first = registry.registerViewContainer({ id: "test.first", title: "First", location: ViewContainerLocation.Panel, order: 10 });
	using second = registry.registerViewContainer({ id: "test.second", title: "Second", location: ViewContainerLocation.Panel, order: 20 });
	using third = registry.registerViewContainer({ id: "test.third", title: "Third", location: ViewContainerLocation.Panel, order: 30 });
	using descriptors = new ViewDescriptorService({ contextKeyService: contextKeys, registry });
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
		ctorDescriptor: new ServiceConstructionDescriptor(TestView, {
			staticArguments: [id],
		}),
		...options,
	};
}

class TestView implements IView {
	private visible = true;

	constructor(readonly id: string) {}

	focus(): void {}

	isVisible(): boolean {
		return this.visible;
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
	}
}
