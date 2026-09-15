import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { h } from "../../../../../base/browser/dom.js";

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
	PointerEvent: browserEnvironment.window.MouseEvent,
})) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}

const { ServiceContainer } = await import("../../../../../platform/instantiation/common/instantiation.js");
const { IConfigurationService } = await import("../../../../../platform/configuration/common/configuration.js");
const { ConfigurationRegistry, Extensions: ConfigurationExtensions } = await import("../../../../../platform/configuration/common/configurationRegistry.js");
const { ILayoutService } = await import("../../../../../platform/layout/common/layoutService.js");
const { Registry } = await import("../../../../../platform/registry/common/platform.js");
const { WorkbenchContributionsRegistry, WorkbenchPhase } = await import("../../../../../workbench/common/contributions.js");
const { SashConfiguration } = await import("../../../../../workbench/contrib/sash/common/sash.js");
const { SashSettingsController } = await import("../../../../../workbench/contrib/sash/browser/sash.js");
const { WorkbenchConfigurationService } = await import("../../../../../workbench/services/configuration/browser/configurationService.js");
const configurationRegistry = Registry.as<InstanceType<typeof ConfigurationRegistry>>(ConfigurationExtensions.Configuration);
await import("../../../../../workbench/contrib/sash/browser/sash.contribution.js");

type LayoutService = import("../../../../../platform/layout/common/layoutService.js").ILayoutService;

test("Sash configuration validates its public range", () => {
	const size = configurationRegistry.getConfiguration(SashConfiguration.size);
	const hoverDelay = configurationRegistry.getConfiguration(SashConfiguration.hoverDelay);
	assert.ok(size);
	assert.ok(hoverDelay);
	assert.equal(size.defaultValue, 4);
	assert.equal(hoverDelay.defaultValue, 300);
	assert.equal(size.parse(1), 1);
	assert.equal(size.parse(20), 20);
	assert.equal(hoverDelay.parse(0), 0);
	assert.equal(hoverDelay.parse(2_000), 2_000);
	assert.throws(() => size.parse(0), /between 1 and 20/);
	assert.throws(
		() => hoverDelay.parse(2_001),
		/between 0 and 2000/,
	);
});

test("Sash settings controller projects live configuration and restores styles", async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const root = dom.window.document.querySelector("main");
	assert.ok(root);
	const sash = appendSash(root);
	using configuration = new WorkbenchConfigurationService();

	{
		using controller = new SashSettingsController(configuration, root);
		assertSashStyles(sash, "4px", "4px", "300ms");

		await configuration.updateValue(SashConfiguration.size, 12);
		await configuration.updateValue(SashConfiguration.hoverDelay, 0);
		assertSashStyles(sash, "12px", "8px", "0ms");

		await configuration.updateValue(SashConfiguration.size, 1);
		assertSashStyles(sash, "4px", "1px", "0ms");
	}

	assertSashStyles(sash, "", "", "");
	dom.window.close();
});

test("Sash contribution starts after restoration", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const root = dom.window.document.querySelector("main");
	assert.ok(root);
	const sash = appendSash(root);
	using configuration = new WorkbenchConfigurationService();
	const services = new ServiceContainer();
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(ILayoutService, { mainContainer: root } as LayoutService);

	using host = WorkbenchContributionsRegistry.createHost(services);
	host.advance(WorkbenchPhase.BlockRestore);
	assertSashStyles(sash, "", "", "");
	host.advance(WorkbenchPhase.AfterRestored);
	assertSashStyles(sash, "4px", "4px", "300ms");
	host.dispose();
	assertSashStyles(sash, "", "", "");
	dom.window.close();
});

function assertSashStyles(
	sash: HTMLElement,
	dragAreaSize: string,
	hoverFeedbackSize: string,
	hoverDelay: string,
): void {
	const targetWindow = sash.ownerDocument.defaultView;
	assert.ok(targetWindow);
	const style = targetWindow.getComputedStyle(sash);
	assert.equal(
		style.getPropertyValue("--ash-sash-drag-area-size"),
		dragAreaSize,
	);
	assert.equal(
		style.getPropertyValue("--ash-sash-hover-feedback-size"),
		hoverFeedbackSize,
	);
	assert.equal(
		style.getPropertyValue("--ash-sash-hover-delay"),
		hoverDelay,
	);
}

function appendSash(root: HTMLElement): HTMLDivElement {
	const sash = h(root.ownerDocument, "div");
	sash.className = "ash-sash";
	root.append(sash);
	return sash;
}
