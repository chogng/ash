import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { DragAndDropDataKind } from "../../browser/ui/dnd/dnd.js";
import { AsyncDataTree, CompressibleAsyncDataTree } from "../../browser/ui/tree/asyncDataTree.js";
import { CompressibleObjectTreeModel, compressTreeElement, decompressTreeElement } from "../../browser/ui/tree/compressedObjectTreeModel.js";
import { DataTree } from "../../browser/ui/tree/dataTree.js";
import { IndexTree } from "../../browser/ui/tree/indexTree.js";
import { IndexTreeModel } from "../../browser/ui/tree/indexTreeModel.js";
import { CompressibleObjectTree, ObjectTree } from "../../browser/ui/tree/objectTree.js";
import { ObjectTreeModel } from "../../browser/ui/tree/objectTreeModel.js";
import { TreeVisibility } from "../../browser/ui/tree/tree.js";
import { h, svg } from "../../browser/dom.js";

interface TestNode {
	readonly id: string;
	readonly label: string;
	expanded: boolean;
	readonly children?: readonly TestNode[];
	readonly collapsible?: boolean;
	readonly collapsed?: boolean;
}

test("IndexTreeModel owns index locations and atomic splice", () => {
	const model = new IndexTreeModel<TestNode>({ id: "root", label: "Root", expanded: true });
	model.setChildren([
		{ element: { id: "parent", label: "Parent", expanded: false }, children: [{ element: { id: "child", label: "Child", expanded: false } }] },
		{ element: { id: "sibling", label: "Sibling", expanded: false } },
	]);
	assert.equal(model.getNode([0]).element.id, "parent");
	assert.equal(model.getNode([0, 0]).element.id, "child");
	assert.deepEqual(model.getNode([0, 0]).location, [0, 0]);
	model.splice([1], 0, [{ element: { id: "inserted", label: "Inserted", expanded: false } }]);
	assert.deepEqual(model.rootNodes.map((node) => node.element.id), ["parent", "inserted", "sibling"]);
	assert.deepEqual(model.getNode([2]).location, [2]);
	assert.equal(model.collapse([0]), true);
	assert.deepEqual(model.visibleNodes.map((node) => node.element.id), ["parent", "inserted", "sibling"]);
	assert.throws(() => model.splice([], 0), /child position/);
	assert.equal(model.getNode([2]).element.id, "sibling");
	model.dispose();
});

test("IndexTree renders splice results through the shared flat AbstractTree", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const tree = new IndexTree<TestNode>(dom.window.document.body, { id: "root", label: "Root", expanded: true }, {
		ariaLabel: "Index tree",
		renderElement: (element) => {
			const label = h(dom.window.document, "span");
			label.textContent = element.label;
			return label;
		},
	});
	tree.splice([0], 0, [{ element: { id: "first", label: "First", expanded: false } }]);
	tree.splice([1], 0, [{ element: { id: "second", label: "Second", expanded: false } }]);
	assert.deepEqual([...tree.element.querySelectorAll<HTMLElement>(":scope > .ash-tree-row")].map((row) => row.textContent), ["First", "Second"]);
	assert.equal(tree.element.querySelector(".ash-tree-row")?.getAttribute("aria-posinset"), "1");
	tree.dispose();
	dom.window.close();
});

test("DataTree materializes and refreshes a synchronous data source", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const root: TestNode = { id: "root", label: "Root", expanded: true };
	const group: TestNode = { id: "group", label: "Group", expanded: false };
	const first: TestNode = { id: "first", label: "First", expanded: false };
	const second: TestNode = { id: "second", label: "Second", expanded: false };
	const children = new Map<TestNode, readonly TestNode[]>([[root, [group]], [group, [first]], [first, []], [second, []]]);
	const tree = new DataTree<TestNode, TestNode>(dom.window.document.body, {
		hasChildren: (element) => (children.get(element as TestNode)?.length ?? 0) > 0,
		getChildren: (element) => children.get(element as TestNode) ?? [],
	}, {
		identityProvider: { getId: (element) => element.id },
		collapseByDefault: (element) => element === group,
		renderElement: (element) => {
			const label = h(dom.window.document, "span");
			label.textContent = element.label;
			return label;
		},
	});
	tree.setInput(root);
	assert.deepEqual([...tree.element.querySelectorAll<HTMLElement>(".ash-tree-row")].map((row) => row.textContent), ["Group"]);
	tree.expand(group);
	assert.deepEqual([...tree.element.querySelectorAll<HTMLElement>(".ash-tree-row")].map((row) => row.textContent), ["Group", "First"]);
	children.set(group, [second]);
	tree.updateChildren(group);
	assert.deepEqual([...tree.element.querySelectorAll<HTMLElement>(".ash-tree-row")].map((row) => row.textContent), ["Group", "Second"]);
	tree.dispose();
	dom.window.close();
});

test("AsyncDataTree loads on expansion and rejects stale refresh results", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const root: TestNode = { id: "root", label: "Root", expanded: true };
	const group: TestNode = { id: "group", label: "Group", expanded: false };
	const stale: TestNode = { id: "stale", label: "Stale", expanded: false };
	const current: TestNode = { id: "current", label: "Current", expanded: false };
	const pending: Array<(children: readonly TestNode[]) => void> = [];
	const tree = new AsyncDataTree<TestNode, TestNode>(dom.window.document.body, {
		hasChildren: (element) => element === root || element === group,
		getChildren: (element) => {
			if (element === root) return [group];
			return new Promise<readonly TestNode[]>((resolve) => pending.push(resolve));
		},
	}, {
		identityProvider: { getId: (element) => element.id },
		renderElement: (element) => {
			const label = h(dom.window.document, "span");
			label.textContent = element.label;
			return label;
		},
	});
	await tree.setInput(root);
	assert.equal(tree.expand(group), true);
	assert.equal(pending.length, 1);
	const latest = tree.updateChildren(group);
	assert.equal(pending.length, 2);
	pending[1]!([current]);
	await latest;
	pending[0]!([stale]);
	await Promise.resolve();
	assert.deepEqual([...tree.element.querySelectorAll<HTMLElement>(".ash-tree-row")].map((row) => row.textContent), ["Group", "Current"]);
	tree.dispose();
	dom.window.close();
});

test("CompressibleObjectTreeModel round-trips chains and honors incompressible boundaries", () => {
	const leaf: TestNode = { id: "leaf", label: "Leaf", expanded: false };
	const boundary: TestNode = { id: "boundary", label: "Boundary", expanded: false };
	const middle: TestNode = { id: "middle", label: "Middle", expanded: false };
	const root: TestNode = { id: "root", label: "Root", expanded: false };
	const source = { element: root, children: [{ element: middle, children: [{ element: boundary, incompressible: true, children: [{ element: leaf }] }] }] };
	const compressed = compressTreeElement(source);
	assert.deepEqual(compressed.element.elements.map((node) => node.id), ["root", "middle"]);
	assert.deepEqual(compressed.children?.[0]?.element.elements.map((node) => node.id), ["boundary", "leaf"]);
	const decompressed = decompressTreeElement(compressed);
	assert.equal(decompressed.element, root);
	assert.equal(decompressed.children?.[0]?.element, middle);
	assert.equal(decompressed.children?.[0]?.children?.[0]?.element, boundary);
	assert.equal(decompressed.children?.[0]?.children?.[0]?.incompressible, true);
	assert.equal(decompressed.children?.[0]?.children?.[0]?.children?.[0]?.element, leaf);

	const model = new CompressibleObjectTreeModel<TestNode>({ identityProvider: { getId: (node) => node.id } });
	model.setChildren([source]);
	assert.deepEqual(model.visibleNodes.map((node) => node.element.elements.map((element) => element.id)), [["root", "middle"], ["boundary", "leaf"]]);
	assert.equal(model.getCompressedNode(root), model.getCompressedNode(middle));
	model.setCompressionEnabled(false);
	assert.deepEqual(model.visibleNodes.map((node) => node.element.elements.map((element) => element.id)), [["root"], ["middle"], ["boundary"], ["leaf"]]);
	model.dispose();
});

test("CompressibleObjectTree renders one row per compressed chain", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const root: TestNode = { id: "root", label: "Root", expanded: false };
	const middle: TestNode = { id: "middle", label: "Middle", expanded: false };
	const leaf: TestNode = { id: "leaf", label: "Leaf", expanded: false };
	const tree = new CompressibleObjectTree<TestNode>(dom.window.document.body, {
		modelOptions: { identityProvider: { getId: (node) => node.id } },
		renderCompressedElements: (elements) => {
			const label = h(dom.window.document, "span");
			label.textContent = elements.map((element) => element.label).join(" / ");
			return label;
		},
	});
	tree.setChildren([{ element: root, children: [{ element: middle, children: [{ element: leaf }] }] }]);
	assert.deepEqual([...tree.element.querySelectorAll<HTMLElement>(":scope > .ash-tree-row")].map((row) => row.textContent), ["Root / Middle / Leaf"]);
	assert.deepEqual(tree.getCompressedTreeNode(middle)?.elements.map((element) => element.id), ["root", "middle", "leaf"]);
	tree.dispose();
	dom.window.close();
});

test("CompressibleAsyncDataTree lazily expands compressed branches", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const root: TestNode = { id: "root", label: "Root", expanded: false };
	const first: TestNode = { id: "first", label: "First", expanded: false };
	const middle: TestNode = { id: "middle", label: "Middle", expanded: false };
	const left: TestNode = { id: "left", label: "Left", expanded: false };
	const right: TestNode = { id: "right", label: "Right", expanded: false };
	const children = new Map<TestNode, readonly TestNode[]>([[root, [first]], [first, [middle]], [middle, [left, right]], [left, []], [right, []]]);
	const tree = new CompressibleAsyncDataTree<TestNode, TestNode>(dom.window.document.body, {
		hasChildren: (element) => (children.get(element as TestNode)?.length ?? 0) > 0,
		getChildren: (element) => children.get(element as TestNode) ?? [],
	}, {
		identityProvider: { getId: (node) => node.id },
		renderCompressedElements: (elements) => {
			const label = h(dom.window.document, "span");
			label.textContent = elements.map((element) => element.label).join(" / ");
			return label;
		},
	});
	const pointers: string[] = [];
	tree.onPointer(({ element, elements }) => pointers.push(`${element.id}:${elements.map((candidate) => candidate.id).join("/")}`));
	await tree.setInput(root);
	assert.deepEqual([...tree.element.querySelectorAll<HTMLElement>(":scope > .ash-tree-row")].map((row) => row.textContent), ["First"]);
	tree.element.querySelector<HTMLElement>(":scope > .ash-tree-row")?.click();
	assert.deepEqual(pointers, ["first:first"]);
	assert.equal(tree.expand(first), true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual([...tree.element.querySelectorAll<HTMLElement>(":scope > .ash-tree-row")].map((row) => row.textContent), ["First / Middle"]);
	tree.element.querySelector<HTMLElement>(":scope > .ash-tree-row")?.click();
	assert.deepEqual(pointers, ["first:first", "middle:first/middle"]);
	assert.equal(tree.expand(middle), true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual([...tree.element.querySelectorAll<HTMLElement>(":scope > .ash-tree-row")].map((row) => row.textContent), ["First / Middle", "Left", "Right"]);
	tree.dispose();
	dom.window.close();
});

test("ObjectTreeModel owns hierarchy, local replacement, and collapse state", () => {
	const child: TestNode = { id: "child", label: "Child", expanded: false };
	const parent: TestNode = { id: "parent", label: "Parent", expanded: false, children: [child] };
	const model = new ObjectTreeModel<TestNode>({ identityProvider: { getId: (node) => node.id } });
	const changes: string[] = [];
	const collapseChanges: string[] = [];
	model.onDidChange((event) => changes.push(event.kind));
	model.onDidChangeCollapseState(({ node, collapsed }) => collapseChanges.push(`${node.id}:${collapsed}`));

	model.setChildren([{ element: parent, children: [{ element: child }] }]);
	assert.equal(model.getNode("child")?.element, child);
	assert.equal(model.getParent("child")?.element, parent);
	assert.equal(model.getNode("child")?.depth, 2);
	assert.deepEqual(model.visibleNodes.map((node) => node.id), ["parent", "child"]);
	assert.equal(model.collapse("parent"), true);
	assert.deepEqual(model.visibleNodes.map((node) => node.id), ["parent"]);
	model.setChildren([{ element: { id: "parent", label: "Updated parent", expanded: false }, children: [{ element: child }] }]);
	assert.equal(model.getNode("parent")?.collapsed, true);
	model.setNodeChildren("parent", [{ element: { id: "replacement", label: "Replacement", expanded: false } }]);
	assert.equal(model.getNode("child"), undefined);
	assert.equal(model.getParent("replacement")?.id, "parent");
	assert.throws(() => model.setChildren([
		{ element: { id: "duplicate", label: "First", expanded: false } },
		{ element: { id: "duplicate", label: "Second", expanded: false } },
	]), /Duplicate tree node ID/);
	assert.equal(model.getNode("replacement")?.element.label, "Replacement");
	assert.deepEqual(changes, ["structure", "collapse", "structure", "structure"]);
	assert.deepEqual(collapseChanges, ["parent:true"]);
	model.dispose();
});

test("ObjectTreeModel keeps local updates atomic and expands ancestors", () => {
	const model = new ObjectTreeModel<TestNode>({
		defaultCollapseState: "collapsed",
		identityProvider: { getId: (node) => node.id },
	});
	model.setChildren([{
		element: { id: "root", label: "Root", expanded: false },
		children: [{
			element: { id: "parent", label: "Parent", expanded: false },
			children: [{ element: { id: "leaf", label: "Leaf", expanded: false } }],
		}],
	}]);

	assert.deepEqual(model.visibleNodes.map((node) => node.id), ["root"]);
	assert.equal(model.expandTo("leaf"), true);
	assert.deepEqual(model.visibleNodes.map((node) => node.id), ["root", "parent", "leaf"]);
	assert.equal(model.collapseRecursive("root"), true);
	assert.deepEqual(model.visibleNodes.map((node) => node.id), ["root"]);
	assert.throws(() => model.setNodeChildren("parent", [
		{ element: { id: "duplicate", label: "First", expanded: false } },
		{ element: { id: "duplicate", label: "Second", expanded: false } },
	]), /Duplicate tree node ID/);
	assert.equal(model.getNode("leaf")?.element.label, "Leaf");
	model.dispose();
});

test("ObjectTreeModel filters recursively and sorts every level", () => {
	const model = new ObjectTreeModel<TestNode>({
		identityProvider: { getId: (node) => node.id },
		sorter: { compare: (left, right) => left.label.localeCompare(right.label) },
		filter: {
			filter: (node) => node.id.endsWith("-group") ? TreeVisibility.Recurse : node.label.includes("Match"),
		},
	});
	model.setChildren([
		{ element: { id: "z-group", label: "Z group", expanded: false }, children: [{ element: { id: "match-b", label: "Match B", expanded: false } }] },
		{ element: { id: "a-group", label: "A group", expanded: false }, children: [{ element: { id: "hidden", label: "Hidden", expanded: false } }, { element: { id: "match-a", label: "Match A", expanded: false } }] },
	]);

	assert.deepEqual(model.visibleNodes.map((node) => node.id), ["a-group", "match-a", "z-group", "match-b"]);
	assert.equal(model.getNode("hidden")?.visible, false);
	assert.equal(model.getNode("hidden")?.visibleChildIndex, -1);
	assert.equal(model.getNode("hidden")?.visibleChildrenCount, 1);
	assert.equal(model.getNode("match-a")?.visibleChildIndex, 0);
	assert.equal(model.getNode("match-a")?.visibleChildrenCount, 1);
	model.setFilter(undefined);
	assert.deepEqual(model.visibleNodes.map((node) => node.id), ["a-group", "hidden", "match-a", "z-group", "match-b"]);
	model.dispose();
});

test("ObjectTree projects the model as flat list rows with tree ARIA", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const tree = new ObjectTree<TestNode>(dom.window.document.body, {
		ariaLabel: "Object tree",
		scrolling: "external",
		modelOptions: { identityProvider: { getId: (node) => node.id } },
		renderElement: (element) => {
			const label = h(dom.window.document, "span");
			label.textContent = element.label;
			return label;
		},
	});
	const activated: string[] = [];
	const pointers: string[] = [];
	const collapsed: string[] = [];
	tree.onDidActivate(({ element }) => activated.push(element.id));
	tree.onPointer(({ element, target }) => pointers.push(`${element.id}:${target}`));
	tree.onDidChangeCollapseState(({ element, collapsed: isCollapsed }) => collapsed.push(`${element.id}:${isCollapsed}`));
	tree.setChildren([{
		element: { id: "parent", label: "Parent", expanded: false },
		collapsed: true,
		children: [{ element: { id: "child", label: "Child", expanded: false } }],
	}, { element: { id: "sibling", label: "Sibling", expanded: false } }]);

	assert.equal(tree.element.tagName, "DIV");
	assert.equal(tree.element.getAttribute("role"), "tree");
	assert.equal(tree.element.getAttribute("aria-label"), "Object tree");
	assert.equal(tree.element.style.overflow, "visible");
	assert.equal(tree.element.classList.contains("ash-tree-selection-active"), true);
	assert.equal(tree.element.tabIndex, 0);
	assert.equal(tree.element.querySelectorAll(".ash-tree-group, .ash-tree-node").length, 0);
	assert.equal(tree.element.querySelectorAll(":scope > .ash-tree-row").length, 2);
	const parent = tree.element.querySelector<HTMLElement>("[data-tree-id='parent']");
	const sibling = tree.element.querySelector<HTMLElement>("[data-tree-id='sibling']");
	assert.ok(parent);
	assert.ok(sibling);
	assert.equal(parent.getAttribute("role"), "treeitem");
	assert.equal(parent.getAttribute("aria-level"), "1");
	assert.equal(parent.getAttribute("aria-posinset"), "1");
	assert.equal(parent.getAttribute("aria-setsize"), "2");
	assert.equal(parent.getAttribute("aria-expanded"), "false");
	assert.equal(parent.querySelectorAll(".ash-tree-twistie .ash-icon").length, 1);
	assert.equal(sibling.getAttribute("aria-posinset"), "2");
	assert.equal(tree.expand("parent"), true);
	assert.deepEqual(collapsed, ["parent:false"]);
	assert.deepEqual([...tree.element.querySelectorAll<HTMLElement>(":scope > .ash-tree-row")].map((row) => row.dataset.treeId), ["parent", "child", "sibling"]);
	const child = tree.element.querySelector<HTMLElement>("[data-tree-id='child']");
	assert.equal(child?.getAttribute("aria-level"), "2");
	assert.equal(child?.getAttribute("aria-posinset"), "1");
	assert.equal(child?.getAttribute("aria-setsize"), "1");
	assert.equal(child?.querySelectorAll(".ash-tree-indent-guide").length, 1);
	tree.element.querySelector<HTMLElement>("[data-tree-id='parent'] .ash-tree-twistie")?.click();
	assert.deepEqual(collapsed, ["parent:false", "parent:true"]);
	assert.equal(tree.element.querySelectorAll(".ash-tree-row").length, 2);
	tree.expand("parent");
	assert.deepEqual(collapsed, ["parent:false", "parent:true", "parent:false"]);
	const parentRow = tree.element.querySelector<HTMLElement>("[data-tree-id='parent']");
	assert.ok(parentRow);
	const parentIcon = svg(dom.window.document, "svg");
	const parentIconPath = svg(dom.window.document, "path");
	parentIcon.append(parentIconPath);
	parentRow.querySelector(".ash-tree-contents")?.prepend(parentIcon);
	parentIconPath.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	assert.deepEqual(activated, ["parent"]);
	assert.deepEqual(pointers, ["parent:contents"]);
	assert.deepEqual(collapsed, ["parent:false", "parent:true", "parent:false"]);
	assert.equal(tree.element.querySelectorAll(".ash-tree-row").length, 3);

	tree.dispose();
	dom.window.close();
});

test("ObjectTree delegates focus, selection, and keyboard navigation to List", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const tree = createObjectTree(dom);
	tree.setChildren([
		{ element: { id: "first", label: "First", expanded: false } },
		{ element: { id: "second", label: "Second", expanded: false } },
	]);
	const focusChanges: string[] = [];
	const selectionChanges: string[] = [];
	const accepted: string[] = [];
	tree.onDidChangeFocus(({ element }) => focusChanges.push(element?.id ?? "none"));
	tree.onDidChangeSelection(({ elements }) => selectionChanges.push(elements.map((element) => element.id).join(",")));
	tree.onDidAccept(({ element }) => accepted.push(element.id));
	dom.window.document.body.append(tree.element);
	const firstRow = tree.element.querySelector<HTMLElement>("[data-tree-id='first']");
	const secondRow = tree.element.querySelector<HTMLElement>("[data-tree-id='second']");
	assert.ok(firstRow);
	assert.ok(secondRow);
	assert.equal(tree.element.tabIndex, 0);
	assert.equal(firstRow.tabIndex, -1);
	assert.equal(secondRow.tabIndex, -1);

	tree.domFocus();
	tree.element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
	assert.equal(dom.window.document.activeElement, tree.element);
	assert.equal(tree.focus?.id, "second");
	assert.deepEqual(tree.selection.map((element) => element.id), ["second"]);
	assert.equal(tree.element.getAttribute("aria-activedescendant"), secondRow.id);
	assert.equal(secondRow.getAttribute("aria-selected"), "true");
	assert.ok(secondRow.classList.contains("selected"));

	tree.element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Home" }));
	tree.element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
	assert.deepEqual(focusChanges, ["second", "first"]);
	assert.deepEqual(selectionChanges, ["second", "first"]);
	assert.deepEqual(accepted, ["first"]);

	tree.dispose();
	dom.window.close();
});

test("ObjectTree keyboard expansion operates on model nodes", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const tree = createObjectTree(dom);
	tree.setChildren([{
		element: { id: "parent", label: "Parent", expanded: false },
		collapsed: true,
		children: [{ element: { id: "child", label: "Child", expanded: false } }],
	}]);
	const collapseChanges: string[] = [];
	tree.onDidChangeCollapseState(({ element, collapsed }) => collapseChanges.push(`${element.id}:${collapsed}`));
	tree.setFocus("parent");
	tree.element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
	assert.deepEqual(tree.model.visibleNodes.map((node) => node.id), ["parent", "child"]);
	tree.element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
	assert.equal(tree.focus?.id, "child");
	tree.element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
	assert.equal(tree.focus?.id, "parent");
	tree.element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
	assert.deepEqual(tree.model.visibleNodes.map((node) => node.id), ["parent"]);
	assert.deepEqual(collapseChanges, ["parent:false", "parent:true"]);
	tree.dispose();
	dom.window.close();
});

test("ObjectTree find filters with ancestors and supports dynamic heights and sticky rows", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const group: TestNode = { id: "group", label: "Group", expanded: false };
	const needle: TestNode = { id: "needle", label: "Needle", expanded: false };
	const other: TestNode = { id: "other", label: "Other", expanded: false };
	const tree = new ObjectTree<TestNode>(dom.window.document.body, {
		enableStickyScroll: true,
		keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: (element) => element.label },
		findMode: "filter",
		modelOptions: { identityProvider: { getId: (node) => node.id } },
		renderElement: (element) => {
			const label = h(dom.window.document, "span");
			label.textContent = element.label;
			return label;
		},
	});
	tree.setChildren([{ element: group, collapsed: true, children: [{ element: needle }] }, { element: other }]);
	assert.deepEqual([...tree.element.querySelectorAll<HTMLElement>(":scope > .ash-tree-row")].map((row) => row.dataset.treeId), ["group", "other"]);
	tree.setFindPattern("ndl");
	tree.updateElementHeight("group", 30);
	tree.updateElementHeight("needle", 40);
	assert.equal(tree.getElementTop("needle"), 30);
	assert.deepEqual([...tree.element.querySelectorAll<HTMLElement>(":scope > .ash-tree-row")].map((row) => row.dataset.treeId), ["group", "needle"]);
	assert.equal(tree.element.querySelector("[data-tree-id='group']")?.getAttribute("aria-expanded"), "true");
	assert.equal(tree.element.querySelector("[data-tree-id='needle']")?.classList.contains("find-match"), true);
	tree.clearFind();
	assert.equal(tree.element.querySelectorAll(":scope > .ash-tree-row").length, 2);
	tree.expand("group");
	tree.element.scrollTop = 31;
	tree.element.dispatchEvent(new dom.window.Event("scroll"));
	assert.deepEqual([...tree.element.querySelectorAll<HTMLElement>(".ash-tree-sticky-row")].map((row) => row.dataset.treeId), ["group"]);
	tree.dispose();
	dom.window.close();
});

test("ObjectTree routes HTML drag and drop through hierarchy-aware policy", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const events: string[] = [];
	const tree = new ObjectTree<TestNode>(dom.window.document.body, {
		modelOptions: { identityProvider: { getId: (node) => node.id } },
		dnd: {
			getDragURI: (element) => `ash://${element.id}`,
			onDragStart: ({ elements }) => events.push(`start:${elements.map((element) => element.id).join(",")}`),
			onDragOver: (_data, target) => {
				events.push(`over:${target?.id ?? "root"}`);
				return { accept: true, effect: "move" };
			},
			drop: ({ elements }, target) => events.push(`drop:${elements[0]?.id}->${target?.id}`),
			onDragEnd: () => events.push("end"),
		},
		renderElement: (element) => {
			const label = h(dom.window.document, "span");
			label.textContent = element.label;
			return label;
		},
	});
	tree.setChildren([{ element: { id: "first", label: "First", expanded: false } }, { element: { id: "second", label: "Second", expanded: false } }]);
	const first = tree.element.querySelector<HTMLElement>("[data-tree-id='first']")!;
	const second = tree.element.querySelector<HTMLElement>("[data-tree-id='second']")!;
	assert.equal(first.draggable, true);
	first.dispatchEvent(new dom.window.Event("dragstart", { bubbles: true, cancelable: true }));
	second.dispatchEvent(new dom.window.Event("dragover", { bubbles: true, cancelable: true }));
	second.dispatchEvent(new dom.window.Event("drop", { bubbles: true, cancelable: true }));
	first.dispatchEvent(new dom.window.Event("dragend", { bubbles: true }));
	assert.deepEqual(events, ["start:first", "over:second", "drop:first->second", "end"]);
	tree.dispose();
	dom.window.close();
});

test("ObjectTree drag feedback bubbles up without changing the raw drop target", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const events: string[] = [];
	const tree = new ObjectTree<TestNode>(dom.window.document.body, {
		modelOptions: { identityProvider: { getId: (node) => node.id } },
		dnd: {
			getDragURI: (element) => `ash://${element.id}`,
			onDragOver: (_data, target) => {
				events.push(`over:${target?.id}`);
				return target?.id === "child" ? { accept: true, bubble: "up" } : { accept: true, effect: "move" };
			},
			drop: (_data, target) => events.push(`drop:${target?.id}`),
		},
		renderElement: (element) => {
			const label = h(dom.window.document, "span");
			label.textContent = element.label;
			return label;
		},
	});
	tree.setChildren([{ element: { id: "source", label: "Source", expanded: false } }, {
		element: { id: "parent", label: "Parent", expanded: false },
		children: [{ element: { id: "child", label: "Child", expanded: false } }],
	}]);
	const source = tree.element.querySelector<HTMLElement>("[data-tree-id='source']")!;
	const parent = tree.element.querySelector<HTMLElement>("[data-tree-id='parent']")!;
	const child = tree.element.querySelector<HTMLElement>("[data-tree-id='child']")!;
	source.dispatchEvent(new dom.window.Event("dragstart", { bubbles: true }));
	child.dispatchEvent(new dom.window.Event("dragover", { bubbles: true, cancelable: true }));
	assert.equal(parent.classList.contains("drag-over"), true);
	assert.equal(child.classList.contains("drag-over"), false);
	child.dispatchEvent(new dom.window.Event("drop", { bubbles: true }));
	assert.deepEqual(events, ["over:child", "over:parent", "drop:child"]);
	tree.dispose();
	dom.window.close();
});

test("ObjectTree preserves cross-tree drag origin while projecting domain elements", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const observed: string[] = [];
	const renderElement = (element: TestNode) => {
		const label = h(dom.window.document, "span");
		label.textContent = element.label;
		return label;
	};
	const source = new ObjectTree<TestNode>(dom.window.document.body, {
		modelOptions: { identityProvider: { getId: (node) => node.id } },
		dnd: { getDragURI: (element) => `ash://${element.id}`, onDragOver: () => false, drop: () => {} },
		renderElement,
	});
	const target = new ObjectTree<TestNode>(dom.window.document.body, {
		modelOptions: { identityProvider: { getId: (node) => node.id } },
		dnd: {
			getDragURI: (element) => `ash://${element.id}`,
			onDragOver: (data, element) => {
				observed.push(`over:${data.kind}:${data.elements[0]?.id}:${element?.id}`);
				return true;
			},
			drop: (data, element) => observed.push(`drop:${data.kind}:${data.elements[0]?.id}:${element?.id}`),
		},
		renderElement,
	});
	source.setChildren([{ element: { id: "source", label: "Source", expanded: false } }]);
	target.setChildren([{ element: { id: "target", label: "Target", expanded: false } }]);
	const sourceRow = source.element.querySelector<HTMLElement>("[data-tree-id='source']")!;
	const targetRow = target.element.querySelector<HTMLElement>("[data-tree-id='target']")!;
	sourceRow.dispatchEvent(new dom.window.Event("dragstart", { bubbles: true }));
	targetRow.dispatchEvent(new dom.window.Event("dragover", { bubbles: true, cancelable: true }));
	targetRow.dispatchEvent(new dom.window.Event("drop", { bubbles: true, cancelable: true }));
	sourceRow.dispatchEvent(new dom.window.Event("dragend", { bubbles: true }));
	assert.deepEqual(observed, [
		`over:${DragAndDropDataKind.External}:source:target`,
		`drop:${DragAndDropDataKind.External}:source:target`,
	]);
	source.dispose();
	target.dispose();
	dom.window.close();
});

function createObjectTree(dom: JSDOM): ObjectTree<TestNode> {
	return new ObjectTree<TestNode>(dom.window.document.body, {
		ariaLabel: "Test tree",
		indentGuides: "always",
		modelOptions: { identityProvider: { getId: (node) => node.id } },
		renderElement: (element) => {
			const label = h(dom.window.document, "span");
			label.textContent = element.label;
			return label;
		},
	});
}
