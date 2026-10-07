import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { InMemoryConfigurationService } from "../../../configuration/common/inMemoryConfigurationService.js";
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from "../../../configuration/common/configurationRegistry.js";
import { Registry } from "../../../registry/common/platform.js";
import { ListConfiguration, WorkbenchObjectTree, type ResourceOpenEvent } from "../../browser/listService.js";
import { h } from "../../../../base/browser/dom.js";

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

interface TestItem {
	readonly id: string;
}

test("Platform List owns and validates its shared interaction configuration", () => {
	assert.equal(configurationRegistry.owns(ListConfiguration.openMode), true);
	const openMode = configurationRegistry.getConfiguration(ListConfiguration.openMode);
	assert.ok(openMode);
	assert.equal(openMode.defaultValue, "singleClick");
	assert.equal(openMode.parse("doubleClick"), "doubleClick");
	assert.throws(() => openMode.parse("hover"), /Unknown list open mode/);
	assert.equal(configurationRegistry.owns(ListConfiguration.treeExpandMode), true);
	const treeExpandMode = configurationRegistry.getConfiguration(ListConfiguration.treeExpandMode);
	assert.ok(treeExpandMode);
	assert.equal(treeExpandMode.defaultValue, "singleClick");
	assert.equal(treeExpandMode.parse("doubleClick"), "doubleClick");
	assert.throws(() => treeExpandMode.parse("hover"), /Unknown tree expand mode/);
	const indent = configurationRegistry.getConfiguration(ListConfiguration.treeIndent)!;
	assert.equal(indent.defaultValue, 8);
	for (const invalid of [3, 41, NaN, Infinity, "8"]) assert.throws(() => indent.parse(invalid), /between 4 and 40/);
	const guides = configurationRegistry.getConfiguration(ListConfiguration.treeRenderIndentGuides)!;
	assert.equal(guides.defaultValue, "onHover");
	assert.throws(() => guides.parse("hover"), /Unknown tree indent guide mode/);
	const smoothScrolling = configurationRegistry.getConfiguration(ListConfiguration.smoothScrolling)!;
	assert.equal(smoothScrolling.defaultValue, false);
	assert.equal(smoothScrolling.parse(true), true);
	assert.equal(smoothScrolling.parse(false), false);
	for (const invalid of [0, 1, 'true', null]) assert.throws(() => smoothScrolling.parse(invalid), /must be a boolean/);
});

test("Workbench tree settings update retained rows and highlight only the selected branch", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	using configuration = new InMemoryConfigurationService();
	using tree = new WorkbenchObjectTree<TestItem>(dom.window.document.body, {
		configurationService: configuration,
		modelOptions: { identityProvider: { getId: item => item.id } },
		reuseRows: true,
		renderElement: item => {
			const label = h(dom.window.document, "span");
			label.textContent = item.id;
			return label;
		},
	});
	tree.setChildren([
		{ element: { id: "first" }, collapsed: false, children: [{ element: { id: "child" } }] },
		{ element: { id: "second" }, collapsed: false, children: [{ element: { id: "other" } }] },
	]);
	const child = tree.domNode.querySelector<HTMLElement>('[data-tree-id="child"].ash-tree-row')!;
	tree.setSelection(["child"]);
	assert.deepEqual([...tree.domNode.querySelectorAll<HTMLElement>('.ash-tree-indent-guide.active')].map(guide => guide.dataset.treeParentId), ["first"]);
	await configuration.updateValue(ListConfiguration.treeIndent, 20);
	await configuration.updateValue(ListConfiguration.treeRenderIndentGuides, "none");
	assert.equal(tree.domNode.style.getPropertyValue("--ash-tree-indent"), "20px");
	assert.ok(tree.domNode.classList.contains("ash-tree-indent-guides-none"));
	assert.equal(tree.domNode.querySelector('[data-tree-id="child"].ash-tree-row'), child);
	assert.equal(tree.selection[0]?.id, "child");
	tree.setFocus("second");
	assert.equal(tree.domNode.querySelectorAll('.ash-tree-indent-guide.active').length, 2);
	tree.collapse("second");
	assert.deepEqual([...tree.domNode.querySelectorAll<HTMLElement>('.ash-tree-indent-guide.active')].map(guide => guide.dataset.treeParentId), ["first"]);
	dom.window.close();
});

test('Workbench trees apply smooth scrolling at creation and on setting changes while respecting a widget override', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using configuration = new InMemoryConfigurationService();
	await configuration.updateValue(ListConfiguration.smoothScrolling, true);
	const options = {
		configurationService: configuration,
		scrolling: 'managed' as const,
		getHeight: () => 22,
		modelOptions: { identityProvider: { getId: (item: TestItem) => item.id } },
		renderElement: (item: TestItem) => { const label = h(dom.window.document, 'span'); label.textContent = item.id; return label; },
	};
	using configured = new WorkbenchObjectTree<TestItem>(dom.window.document.body, options);
	using overridden = new WorkbenchObjectTree<TestItem>(dom.window.document.body, { ...options, smoothScrolling: false });
	const viewports = [configured, overridden].map(tree => {
		const viewport = tree.domNode.querySelector<HTMLElement>('.ash-scrollbar-viewport')!;
		Object.defineProperties(viewport, { clientWidth: { value: 100 }, clientHeight: { value: 100 }, scrollHeight: { value: 2_200 } });
		tree.setChildren(Array.from({ length: 100 }, (_, index) => ({ element: { id: String(index) } })));
		return viewport;
	});
	const wheel = () => new dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
	for (const viewport of viewports) viewport.dispatchEvent(wheel());
	assert.deepEqual(viewports.map(viewport => viewport.scrollTop), [0, 120]);
	await configuration.updateValue(ListConfiguration.smoothScrolling, false);
	for (const viewport of viewports) viewport.dispatchEvent(wheel());
	assert.deepEqual(viewports.map(viewport => viewport.scrollTop), [120, 240]);
	await configuration.updateValue(ListConfiguration.smoothScrolling, true);
	for (const viewport of viewports) viewport.dispatchEvent(wheel());
	assert.deepEqual(viewports.map(viewport => viewport.scrollTop), [120, 360]);
	dom.window.close();
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
