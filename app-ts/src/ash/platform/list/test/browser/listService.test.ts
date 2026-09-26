import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { InMemoryConfigurationService } from "../../../configuration/common/inMemoryConfigurationService.js";
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from "../../../configuration/common/configurationRegistry.js";
import { Registry } from "../../../registry/common/platform.js";
import { WorkbenchObjectTree, type ResourceOpenEvent } from "../../browser/listService.js";
import { ListConfiguration } from "../../common/listConfiguration.js";
import { h } from "../../../../base/browser/dom.js";

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

interface TestItem {
	readonly id: string;
}

test("Platform List owns and validates the shared open-mode configuration", () => {
	assert.equal(configurationRegistry.owns(ListConfiguration.openMode), true);
	const configuration = configurationRegistry.getConfiguration(ListConfiguration.openMode);
	assert.ok(configuration);
	assert.equal(configuration.defaultValue, "singleClick");
	assert.equal(configuration.parse("doubleClick"), "doubleClick");
	assert.throws(() => configuration.parse("hover"), /Unknown list open mode/);
});

test("WorkbenchObjectTree derives preview, pinned, and side-by-side open intent", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	using configuration = new InMemoryConfigurationService();
	using tree = new WorkbenchObjectTree<TestItem>(dom.window.document.body, {
		ariaLabel: "Resources",
		configurationService: configuration,
		modelOptions: { identityProvider: { getId: (item) => item.id } },
		renderElement: (item) => {
			const label = h(dom.window.document, "span");
			label.textContent = item.id;
			return label;
		},
	});
	const first = { id: "readme" };
	const second = { id: "source" };
	tree.setChildren([{ element: first }, { element: second }]);
	const opens: ResourceOpenEvent<TestItem>[] = [];
	using listener = tree.onDidOpen((event) => opens.push(event));
	const firstRow = tree.element.querySelector<HTMLElement>('[data-tree-id="readme"]')!;

	firstRow.dispatchEvent(mouse(dom, "click", { detail: 1 }));
	assertOpen(opens[0], first, false, true, false);

	firstRow.dispatchEvent(mouse(dom, "click", { detail: 1, ctrlKey: true }));
	assertOpen(opens[1], first, false, true, true);

	firstRow.dispatchEvent(mouse(dom, "auxclick", { detail: 1, button: 1 }));
	assertOpen(opens[2], first, true, true, false);

	firstRow.dispatchEvent(mouse(dom, "click", { detail: 2 }));
	assert.equal(opens.length, 3);
	firstRow.dispatchEvent(mouse(dom, "dblclick", { detail: 2 }));
	assertOpen(opens[3], first, true, false, false);

	tree.setFocus("readme");
	tree.element.dispatchEvent(keyboard(dom, "Enter", { metaKey: true }));
	assertOpen(opens[4], first, true, false, true);
	tree.element.dispatchEvent(keyboard(dom, " "));
	assertOpen(opens[5], first, false, true, false);

	tree.setSelection(["source"], keyboard(dom, "ArrowDown"));
	assertOpen(opens[6], second, false, true, false);

	await configuration.updateValue(ListConfiguration.openMode, "doubleClick");
	firstRow.dispatchEvent(mouse(dom, "click", { detail: 1 }));
	assert.equal(opens.length, 7);
	dom.window.close();
});

function assertOpen(event: ResourceOpenEvent<TestItem> | undefined, element: TestItem, pinned: boolean, preserveFocus: boolean, sideBySide: boolean): void {
	assert.equal(event?.element, element);
	assert.deepEqual(event?.editorOptions, { pinned, preserveFocus });
	assert.equal(event?.sideBySide, sideBySide);
}

function mouse(dom: JSDOM, type: string, init: MouseEventInit): MouseEvent {
	return new dom.window.MouseEvent(type, { bubbles: true, ...init }) as unknown as MouseEvent;
}

function keyboard(dom: JSDOM, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
	return new dom.window.KeyboardEvent("keydown", { bubbles: true, key, ...init }) as unknown as KeyboardEvent;
}
