import assert from "node:assert/strict";
import { test } from "mocha";
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
	browserEnvironment.window.close();
});
