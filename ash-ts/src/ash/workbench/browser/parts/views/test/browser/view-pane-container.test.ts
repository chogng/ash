import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import type { IInstantiationService } from "../../../../../../platform/instantiation/common/instantiation.js";
import type { IViewContainerDescriptor, IViewContainerModel } from "../../../../../../workbench/common/views.js";

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
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
const { ContextKeyService } = await import("../../../../../../platform/contextkey/common/contextkey.js");
const { ViewContainerLocation } = await import("../../../../../../workbench/common/views.js");
const { ViewPaneContainer } = await import("../../../../../../workbench/browser/parts/views/viewPaneContainer.js");

test("ViewPaneContainer opens a fixed visible view without toggling its visibility", () => {
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
	using container = new ViewPaneContainer(browserEnvironment.window.document.body, {
		viewContainer,
		model,
		contextKeyService: contextKeys,
		instantiationService: {} as IInstantiationService,
	});

	assert.doesNotThrow(() => container.openView("test.fixed-view"));
	assert.equal(visibilityChanges, 0);

});


suiteTeardown(() => {
	browserEnvironment.window.close();
	for (const name of ["window", "document", "Node", "Element", "HTMLElement", "Event", "navigator"]) Reflect.deleteProperty(globalThis, name);
});

test("ViewPaneContainer opens a collapsed view and focuses only when requested", async () => {
	const { ViewPane } = await import("../../../../../../workbench/browser/parts/views/viewPane.js");
	const { ServiceContainer, ServiceConstructionDescriptor } = await import("../../../../../../platform/instantiation/common/instantiation.js");
	class TestView extends ViewPane {
		constructor(container: HTMLElement, options: import("../../../../../../workbench/browser/parts/views/viewPane.js").IViewPaneOptions) {
			super(container, options);
		}
	}
	using services = new ServiceContainer();
	using contextKeys = new ContextKeyService();
	const viewContainer: IViewContainerDescriptor = { id: "test", title: "Test", location: ViewContainerLocation.Panel };
	const descriptor = { id: "test.view", title: "Test View", collapsed: true, ctorDescriptor: new ServiceConstructionDescriptor(TestView) };
	const views = [descriptor];
	using container = new ViewPaneContainer(browserEnvironment.window.document.body, {
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
