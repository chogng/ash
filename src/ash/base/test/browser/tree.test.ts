import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { DragAndDropDataKind } from "../../browser/ui/dnd/dnd.js";
import { AbstractTree } from "../../browser/ui/tree/abstractTree.js";
import { AsyncDataTree, CompressibleAsyncDataTree } from "../../browser/ui/tree/asyncDataTree.js";
import { CompressibleObjectTreeModel, compressTreeElement, decompressTreeElement } from "../../browser/ui/tree/compressedObjectTreeModel.js";
import { DataTree } from "../../browser/ui/tree/dataTree.js";
import { IndexTree } from "../../browser/ui/tree/indexTree.js";
import { IndexTreeModel } from "../../browser/ui/tree/indexTreeModel.js";
import { CompressibleObjectTree, ObjectTree } from "../../browser/ui/tree/objectTree.js";
import { ObjectTreeModel } from "../../browser/ui/tree/objectTreeModel.js";
import { TreeVisibility } from "../../browser/ui/tree/tree.js";
import { h, svg } from "../../browser/dom.js";
import { isMacintosh } from "../../common/platform.js";
import { DeferredPromise } from "../../common/async.js";

test('Compact async reads stay bounded and release capacity after failures', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const root = { id: 'root', directory: true };
		const folders = Array.from({ length: 120 }, (_, index) => ({ id: `folder-${index}`, directory: true }));
		const firstBatch = new DeferredPromise<void>();
		const release = new DeferredPromise<void>();
		let active = 0;
		let peak = 0;
		let reads = 0;
		using tree = new CompressibleAsyncDataTree<typeof root, typeof root>(dom.window.document.body, {
			hasChildren: item => item.directory,
			getChildren: async item => {
				if (item === root) return folders;
				reads++;
				peak = Math.max(peak, ++active);
				if (active === 8) void firstBatch.complete();
				try {
					await release.p;
					if (item === folders[0]) throw new Error('unreadable directory');
					return [{ id: `${item.id}/file`, directory: false }];
				} finally { active--; }
			},
		}, {
			identityProvider: { getId: item => item.id },
			isIncompressible: item => !item.directory,
			collapseByDefault: () => true,
			renderCompressedElements: items => h(dom.window.document, 'span', items.map(item => item.id).join('/')),
		});
		const loaded = tree.setInput(root);
		await firstBatch.p;
		assert.equal(reads, 8);
		void release.complete();
		await loaded;
		assert.equal(reads, 120);
		assert.equal(peak, 8);
		assert.equal(active, 0);
		assert.equal(tree.getNode(folders[119]!).children?.length, 1);
	} finally { dom.window.close(); }
});

test('Compact async reads discard queued work on input replacement and disposal', async () => {
	for (const action of ['replace', 'dispose'] as const) {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			const root = { id: 'root', directory: true };
			const replacement = { id: 'replacement', directory: true };
			const folders = Array.from({ length: 120 }, (_, index) => ({ id: `folder-${index}`, directory: true }));
			const firstBatch = new DeferredPromise<void>();
			const release = new DeferredPromise<void>();
			const reads: string[] = [];
			using tree = new CompressibleAsyncDataTree<typeof root, typeof root>(dom.window.document.body, {
				hasChildren: item => item.directory,
				getChildren: async item => {
					if (item === root) return folders;
					if (item === replacement) return [];
					reads.push(item.id);
					if (reads.length === 8) void firstBatch.complete();
					await release.p;
					return [{ id: `${item.id}/file`, directory: false }];
				},
			}, {
				identityProvider: { getId: item => item.id },
				isIncompressible: item => !item.directory,
				renderCompressedElements: items => h(dom.window.document, 'span', items.map(item => item.id).join('/')),
			});
			const oldRead = tree.setInput(root);
			await firstBatch.p;
			const newRead = action === 'replace' ? tree.setInput(replacement) : Promise.resolve(tree.dispose());
			void release.complete();
			await Promise.all([oldRead, newRead]);
			assert.equal(reads.length, 8, action);
			if (action === 'replace') assert.deepEqual(tree.getNode().children, []);
		} finally { dom.window.close(); }
	}
});

interface TestNode {
	readonly id: string;
	readonly label: string;
	expanded: boolean;
	readonly children?: readonly TestNode[];
	readonly collapsible?: boolean;
	readonly collapsed?: boolean;
}

test('Async trees preserve modifier-click selection when multiple selection is enabled', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const root: TestNode = { id: 'root', label: 'Root', expanded: false };
		const first: TestNode = { id: 'first', label: 'First', expanded: false };
		const second: TestNode = { id: 'second', label: 'Second', expanded: false };
		const source = {
			hasChildren: (item: TestNode) => item === root,
			getChildren: () => [first, second],
		};
		const options = {
			multipleSelectionSupport: true,
			identityProvider: { getId: (item: TestNode) => item.id },
		};
		using ordinary = new AsyncDataTree(dom.window.document.body, source, {
			...options,
			renderElement: item => h(dom.window.document, 'span', item.label),
		});
		using compressed = new CompressibleAsyncDataTree(dom.window.document.body, source, {
			...options,
			renderCompressedElements: items => h(dom.window.document, 'span', items.map(item => item.label).join('/')),
		});
		for (const tree of [ordinary, compressed]) {
			await tree.setInput(root);
			assert.equal(tree.element.getAttribute('aria-multiselectable'), 'true');
			const rows = tree.domNode.querySelectorAll<HTMLElement>('.ash-tree-row');
			rows[0]!.click();
			rows[1]!.dispatchEvent(new dom.window.MouseEvent('click', {
				bubbles: true,
				ctrlKey: !isMacintosh,
				metaKey: isMacintosh,
			}));
			assert.deepEqual(tree.selection, [first, second]);
		}
	} finally {
		dom.window.close();
	}
});

test('AsyncDataTree restores lazy expansion and selection without scrolling programmatic focus', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const root: TestNode = { id: 'root', label: 'Root', expanded: false };
	const folder: TestNode = { id: 'folder', label: 'Folder', expanded: false };
	const files = Array.from({ length: 50 }, (_, index) => ({ id: `file-${index}`, label: `File ${index}`, expanded: false }));
	const source = { hasChildren: (item: TestNode) => item === root || item === folder, getChildren: async (item: TestNode) => item === root ? [folder] : files };
	const options = { ariaLabel: 'Files', scrolling: 'managed' as const, identityProvider: { getId: (item: TestNode) => item.id }, collapseByDefault: () => true, getHeight: () => 22, renderElement: (item: TestNode) => { const label = dom.window.document.createElement('span'); label.textContent = item.label; return label; } };
	using first = new AsyncDataTree(dom.window.document.body, source, options);
	const viewport = first.domNode.querySelector<HTMLElement>('.ash-scrollbar-viewport')!;
	Object.defineProperties(viewport, { clientHeight: { value: 66 }, clientWidth: { value: 200 }, scrollHeight: { value: 1122 } });
	await first.setInput(root);
	await first.expand(folder);
	first.setFocus(files[40]!);
	first.setSelection([files[40]!]);
	assert.equal(first.scrollTop, 0);
	assert.equal(first.getRelativeTop(files[40]!), null);
	first.reveal(files[40]!, 0.5);
	assert.ok(first.scrollTop > 0);
	const saved = first.getViewState();
	using second = new AsyncDataTree(dom.window.document.body, source, options);
	const restoredViewport = second.domNode.querySelector<HTMLElement>('.ash-scrollbar-viewport')!;
	Object.defineProperties(restoredViewport, { clientHeight: { value: 66 }, clientWidth: { value: 200 }, scrollHeight: { value: 1122 } });
	await second.setInput(root, saved);
	assert.deepEqual(second.getViewState(), saved);
	second.setFocus(files[0]!);
	second.setSelection([files[0]!]);
	assert.equal(second.scrollTop, saved.scrollTop);
	dom.window.close();
});

test('Compact async chains retain selection and loaded expansion across branching and configuration changes', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const root = { id: 'root', label: 'root', directory: true };
		const a = { id: 'a', label: 'a', directory: true };
		const b = { id: 'b', label: 'b', directory: true };
		const c = { id: 'c', label: 'c', directory: true };
		const file = { id: 'file', label: 'file.txt', directory: false };
		const sibling = { id: 'sibling', label: 'sibling.txt', directory: false };
		let branched = false;
		const reads: string[] = [];
		using tree = new CompressibleAsyncDataTree<typeof root, typeof root>(dom.window.document.body, {
			hasChildren: item => item.directory,
			getChildren: item => {
				reads.push(item.id);
				if (item === root) return [a];
				if (item === a) return branched ? [b, sibling] : [b];
				if (item === b) return [c];
				if (item === c) return [file];
				return [];
			},
		}, {
			compressionEnabled: true,
			identityProvider: { getId: item => item.id },
			isIncompressible: item => !item.directory,
			collapseByDefault: () => true,
			renderCompressedElements: items => h(dom.window.document, 'span', items.map(item => item.label).join('/')),
		});
		await tree.setInput(root);
		assert.deepEqual(tree.getCompressedTreeNode(a)?.elements, [a, b, c]);
		assert.deepEqual(reads, ['root', 'a', 'b', 'c']);
		await tree.updateChildren(root, { recursive: true, deferIfCollapsed: true });
		assert.deepEqual(tree.getCompressedTreeNode(a)?.elements, [a, b, c]);
		assert.equal(tree.isCollapsed(c), true);
		assert.deepEqual(reads.slice(4), ['root', 'a', 'b']);
		await tree.expand(c);
		tree.setFocus(file);
		tree.setSelection([file]);
		const before = tree.getViewState();
		branched = true;
		await tree.updateChildren(root, { recursive: true });
		assert.deepEqual(tree.selection, [file]);
		assert.equal(tree.focus, file);
		assert.equal(tree.isCollapsed(c), false);
		assert.deepEqual(tree.getCompressedTreeNode(b)?.elements, [b, c]);
		tree.updateOptions({ compressionEnabled: false });
		assert.deepEqual(tree.selection, [file]);
		assert.equal(tree.focus, file);
		assert.ok(tree.getVisibleElements().includes(file));
		tree.updateOptions({ compressionEnabled: true });
		assert.deepEqual(tree.getViewState().focus, before.focus);
		assert.deepEqual(tree.getViewState().selection, before.selection);
	} finally { dom.window.close(); }
});

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

test("IndexTreeModel reports the changed visible range and keeps unrelated branches intact", () => {
	const model = new IndexTreeModel<TestNode>({ id: "root", label: "Root", expanded: true }, {
		identityProvider: { getId: node => node.id },
		preserveCollapseStateByIdentity: true,
	});
	model.setChildren([
		{ element: { id: "left", label: "Left", expanded: false }, children: [{ element: { id: "child", label: "Child", expanded: false } }] },
		{ element: { id: "right", label: "Right", expanded: false }, children: [{ element: { id: "stable", label: "Stable", expanded: false } }] },
	]);
	const stable = model.getNodeById("stable");
	const changes: Array<{ start: number; deleteCount: number; ids: string[]; }> = [];
	model.onDidChange(({ visibleSplice }) => {
		if (visibleSplice) changes.push({ start: visibleSplice.start, deleteCount: visibleSplice.deleteCount, ids: visibleSplice.elements.map(node => node.id) });
	});
	model.setNodeChildren([0], [{
		element: { id: "wrapper", label: "Wrapper", expanded: false },
		children: [{ element: { id: "child", label: "Child", expanded: false } }],
	}]);
	assert.deepEqual(changes, [{ start: 1, deleteCount: 1, ids: ["wrapper", "child"] }]);
	assert.deepEqual(model.getNodeById("child")?.location, [0, 0, 0]);
	assert.equal(model.getNodeById("stable"), stable);
	assert.deepEqual(model.getNodeById("stable")?.location, [1, 0]);
	model.collapse([0]);
	assert.deepEqual(changes.at(-1), { start: 1, deleteCount: 2, ids: [] });
	model.expand([0]);
	assert.deepEqual(changes.at(-1), { start: 1, deleteCount: 0, ids: ["wrapper", "child"] });
	assert.deepEqual(model.visibleNodes.map(node => node.id), ["left", "wrapper", "child", "right", "stable"]);
	model.dispose();
});

test("IndexTreeModel preserves filtered visibility while toggling collapsed branches", () => {
	let filterCalls = 0;
	const model = new IndexTreeModel<TestNode>({ id: "root", label: "Root", expanded: true }, {
		filter: { filter: () => { filterCalls += 1; return TreeVisibility.Visible; } },
	});
	model.setChildren([{
		element: { id: "folder", label: "Folder", expanded: false },
		children: [{
			element: { id: "nested", label: "Nested", expanded: false },
			children: [{ element: { id: "file", label: "File", expanded: false } }],
		}],
	}, { element: { id: "sibling", label: "Sibling", expanded: false } }]);
	const callsAfterStructure = filterCalls;

	assert.equal(model.collapseRecursive([0]), true);
	assert.deepEqual(model.visibleNodes.map(node => node.element.id), ["folder", "sibling"]);
	assert.equal(model.expandTo([0, 0, 0]), true);
	assert.deepEqual(model.visibleNodes.map(node => node.element.id), ["folder", "nested", "file", "sibling"]);
	assert.equal(model.collapse([0]), true);
	assert.equal(model.expand([0]), true);
	assert.deepEqual(model.visibleNodes.map(node => node.element.id), ["folder", "nested", "file", "sibling"]);
	assert.equal(filterCalls, callsAfterStructure);
	model.refilter();
	assert.ok(filterCalls > callsAfterStructure);
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

test("AbstractTree loads collapsed find candidates only while searching", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const node = {
		id: "item",
		element: { id: "item", label: "Item", expanded: false },
		parent: undefined,
		children: [],
		depth: 1,
		collapsible: false,
		collapsed: false,
		visible: true,
		visibleChildIndex: 0,
		visibleChildrenCount: 1,
	};
	const tree = new AbstractTree<TestNode, typeof node>(dom.window.document.body, {
		keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: element => element.label },
		renderElement: element => {
			const label = h(dom.window.document, "span");
			label.textContent = element.element.label;
			return label;
		},
	});
	let candidateReads = 0;
	tree.setFindCandidates(() => { candidateReads += 1; return [node]; });
	tree.items = [node];
	assert.equal(candidateReads, 0);
	tree.setFindPattern("Item");
	assert.equal(tree.findNext(), node);
	assert.equal(candidateReads, 1);
	tree.clearFind();
	tree.items = [node];
	assert.equal(candidateReads, 1);
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

test('AsyncDataTree collapses loaded descendants even when their parent is already hidden', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const leaf: TestNode = { id: 'leaf', label: 'Leaf', expanded: false };
	const inner: TestNode = { id: 'inner', label: 'Inner', expanded: false, children: [leaf] };
	const outer: TestNode = { id: 'outer', label: 'Outer', expanded: false, children: [inner] };
	const root: TestNode = { id: 'root', label: 'Root', expanded: true, children: [outer] };
	try {
		using tree = new AsyncDataTree<TestNode, TestNode>(dom.window.document.body, {
			hasChildren: element => !!element.children?.length,
			getChildren: element => element.children ?? [],
		}, {
			identityProvider: { getId: element => element.id },
			collapseByDefault: () => true,
			renderElement: element => {
				const label = h(dom.window.document, 'span');
				label.textContent = element.label;
				return label;
			},
		});
		await tree.setInput(root);
		await tree.updateChildren(outer, { recursive: false });
		tree.expand(outer);
		await tree.updateChildren(inner, { recursive: false });
		tree.expand(inner);
		assert.deepEqual(tree.getVisibleElements().map(element => element.id), ['outer', 'inner', 'leaf']);
		tree.collapse(outer);
		tree.collapseAll();
		tree.expand(outer);
		assert.deepEqual(tree.getVisibleElements().map(element => element.id), ['outer', 'inner']);
	} finally {
		dom.window.close();
	}
});

test('AsyncDataTree defers invalidated folded branches until expansion, including a recursive refresh', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const root: TestNode = { id: 'root', label: 'Root', expanded: true };
	const group: TestNode = { id: 'group', label: 'Group', expanded: false };
	const child: TestNode = { id: 'old', label: 'Old', expanded: false };
	const replacement: TestNode = { id: 'new', label: 'New', expanded: false };
	let children = [child];
	const reads: string[] = [];
	try {
		using tree = new AsyncDataTree<TestNode, TestNode>(dom.window.document.body, {
			hasChildren: element => element === root || element === group,
			getChildren: element => { reads.push(element.id); return element === root ? [group] : children; },
		}, {
			identityProvider: { getId: element => element.id },
			collapseByDefault: () => true,
			renderElement: element => h(dom.window.document, 'span', element.label),
		});
		await tree.setInput(root);
		await tree.updateChildren(group);
		const row = tree.element.querySelector('[data-tree-id="group"]');
		children = [replacement];
		await tree.updateChildren(group, { deferIfCollapsed: true });
		assert.deepEqual(reads, ['root', 'group']);
		tree.expand(group);
		await tree.updateChildren(group);
		assert.deepEqual(tree.getVisibleElements().map(element => element.id), ['group', 'new']);
		assert.equal(tree.element.querySelector('[data-tree-id="group"]'), row);
		tree.collapse(group);
		children = [child];
		await tree.updateChildren(root, { recursive: true, deferIfCollapsed: true });
		assert.deepEqual(reads, ['root', 'group', 'group', 'root']);
		tree.expand(group);
		await tree.updateChildren(group);
		assert.deepEqual(tree.getVisibleElements().map(element => element.id), ['group', 'old']);
	} finally {
		dom.window.close();
	}
});

test('Compact async trees defer folded directory changes and read fresh children on expansion', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const root = { id: 'root', directory: true };
		const build = { id: '.build', directory: true };
		const first = { id: 'first', directory: false };
		const second = { id: 'second', directory: false };
		const replacement = { id: 'replacement', directory: false };
		let children = [first, second];
		const reads: string[] = [];
		using tree = new CompressibleAsyncDataTree<typeof root, typeof root>(dom.window.document.body, {
			hasChildren: item => item.directory,
			getChildren: item => { reads.push(item.id); return item === root ? [build] : children; },
		}, {
			identityProvider: { getId: item => item.id },
			compressionEnabled: true,
			isIncompressible: item => !item.directory,
			collapseByDefault: () => true,
			renderCompressedElements: items => h(dom.window.document, 'span', items.map(item => item.id).join('/')),
		});
		await tree.setInput(root);
		assert.deepEqual(reads, ['root', '.build']);
		children = [replacement];
		for (let i = 0; i < 3; i++) await tree.updateChildren(build, { deferIfCollapsed: true });
		await tree.updateChildren(root, { recursive: true, deferIfCollapsed: true });
		assert.deepEqual(reads, ['root', '.build', 'root']);
		assert.deepEqual(tree.getVisibleElements(), [build]);
		assert.equal(tree.isLoading(build), false);
		assert.equal(tree.element.getAttribute('aria-busy'), 'false');
		await tree.expand(build);
		assert.deepEqual(reads, ['root', '.build', 'root', '.build']);
		assert.deepEqual(tree.getVisibleElements(), [build, replacement]);
	} finally { dom.window.close(); }
});

test('AsyncDataTree rereads after a change arrives during an expanded branch load', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const root: TestNode = { id: 'root', label: 'Root', expanded: true };
	const group: TestNode = { id: 'group', label: 'Group', expanded: false };
	const child: TestNode = { id: 'new', label: 'New', expanded: false };
	let completeFirstRead: (children: readonly TestNode[]) => void = () => { };
	let resolveSecondRead = (): void => { };
	const secondRead = new Promise<void>(resolve => { resolveSecondRead = resolve; });
	let reads = 0;
	try {
		using tree = new AsyncDataTree<TestNode, TestNode>(dom.window.document.body, {
			hasChildren: element => element === root || element === group,
			getChildren: element => {
				if (element === root) return [group];
				if (++reads === 1) return new Promise<readonly TestNode[]>(resolve => { completeFirstRead = resolve; });
				resolveSecondRead();
				return [child];
			},
		}, {
			identityProvider: { getId: element => element.id },
			collapseByDefault: () => true,
			renderElement: element => h(dom.window.document, 'span', element.label),
		});
		await tree.setInput(root);
		tree.expand(group);
		await Promise.resolve();
		const refresh = tree.updateChildren(group, { deferIfCollapsed: true });
		completeFirstRead([]);
		await secondRead;
		await refresh;
		assert.deepEqual({ reads, visible: tree.getVisibleElements().map(element => element.id), busy: tree.element.getAttribute('aria-busy') }, { reads: 2, visible: ['group', 'new'], busy: 'false' });
	} finally {
		dom.window.close();
	}
});

test('AsyncDataTree discards a pending read invalidated while folded', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const root: TestNode = { id: 'root', label: 'Root', expanded: true };
	const group: TestNode = { id: 'group', label: 'Group', expanded: false };
	const oldChild: TestNode = { id: 'old', label: 'Old', expanded: false };
	const newChild: TestNode = { id: 'new', label: 'New', expanded: false };
	let completeRead: (children: readonly TestNode[]) => void = () => { };
	let reads = 0;
	try {
		using tree = new AsyncDataTree<TestNode, TestNode>(dom.window.document.body, {
			hasChildren: element => element === root || element === group,
			getChildren: element => {
				if (element === root) return [group];
				if (++reads === 1) return new Promise<readonly TestNode[]>(resolve => { completeRead = resolve; });
				return [newChild];
			},
		}, {
			identityProvider: { getId: element => element.id },
			collapseByDefault: () => true,
			renderElement: element => h(dom.window.document, 'span', element.label),
		});
		await tree.setInput(root);
		tree.expand(group);
		await Promise.resolve();
		const firstRead = tree.updateChildren(group);
		tree.collapse(group);
		await tree.updateChildren(group, { deferIfCollapsed: true });
		completeRead([oldChild]);
		await firstRead;
		assert.deepEqual({ reads, visible: tree.getVisibleElements().map(element => element.id), busy: tree.element.getAttribute('aria-busy') }, { reads: 1, visible: ['group'], busy: 'false' });
		tree.expand(group);
		await tree.updateChildren(group);
		assert.deepEqual({ reads, visible: tree.getVisibleElements().map(element => element.id) }, { reads: 2, visible: ['group', 'new'] });
	} finally {
		dom.window.close();
	}
});

test("AsyncDataTree loads on expansion and coalesces refresh requests", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const root: TestNode = { id: "root", label: "Root", expanded: true };
	const group: TestNode = { id: "group", label: "Group", expanded: false };
	const sibling: TestNode = { id: "sibling", label: "Sibling", expanded: false };
	const child: TestNode = { id: "child", label: "Child", expanded: false };
	const pending: Array<(children: readonly TestNode[]) => void> = [];
	const twistieRenders: string[] = [];
	const tree = new AsyncDataTree<TestNode, TestNode>(dom.window.document.body, {
		hasChildren: (element) => element === root || element === group,
		getChildren: (element) => {
			if (element === root) return [group, sibling];
			return new Promise<readonly TestNode[]>((resolve) => pending.push(resolve));
		},
	}, {
		identityProvider: { getId: (element) => element.id },
		reuseRows: true,
		renderTwistie: (element, state, container) => {
			twistieRenders.push(element.id);
			container.dataset.loading = String(state.loading);
		},
		renderElement: (element) => {
			const label = h(dom.window.document, "span");
			label.textContent = element.label;
			return label;
		},
	});
	const initialization = tree.setInput(root);
	assert.equal(tree.isLoading(root), true);
	await initialization;
	assert.equal(tree.isLoading(root), false);
	assert.deepEqual(tree.getNode().children?.map(node => node.element), [group, sibling]);
	assert.equal(tree.getNode(group).children, undefined);
	assert.equal(pending.length, 0);
	twistieRenders.length = 0;
	const siblingRow = tree.element.querySelector('[data-tree-id="sibling"]');
	const groupRow = tree.element.querySelector('[data-tree-id="group"]');
	const expansion = tree.expand(group);
	assert.equal(tree.element.querySelector('[data-tree-id="sibling"]'), siblingRow);
	assert.equal(tree.element.querySelector('[data-tree-id="group"]'), groupRow);
	assert.equal(tree.element.getAttribute("aria-busy"), "true");
	assert.equal(groupRow?.querySelector<HTMLElement>(".ash-tree-twistie")?.dataset.loading, "true");
	assert.equal(twistieRenders.includes("sibling"), false);
	await Promise.resolve();
	assert.equal(pending.length, 1);
	const latest = tree.updateChildren(group);
	await Promise.resolve();
	assert.equal(pending.length, 1);
	pending[0]!([child]);
	await latest;
	assert.equal(await expansion, true);
	assert.equal(tree.element.getAttribute("aria-busy"), "false");
	assert.deepEqual([...tree.element.querySelectorAll<HTMLElement>(".ash-tree-row")].map((row) => row.textContent), ["Group", "Child", "Sibling"]);
	assert.equal(tree.element.querySelector('[data-tree-id="sibling"]'), siblingRow);
	assert.equal(tree.collapse(group), true);
	assert.equal(tree.element.querySelector('[data-tree-id="group"]'), groupRow);
	assert.equal(groupRow?.getAttribute('aria-expanded'), 'false');
	assert.deepEqual(tree.getNode(group).children?.map(node => node.element), [child]);
	await tree.updateChildren(group, { deferIfCollapsed: true });
	assert.equal(tree.getNode(group).children, undefined);
	assert.equal(pending.length, 1);
	tree.dispose();
	dom.window.close();
});

test("AsyncDataTree discards an old child load when a branch becomes a leaf", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const root: TestNode = { id: 'root', label: 'Root', expanded: true };
	const folder: TestNode = { id: 'folder', label: 'Folder', expanded: false };
	const group: TestNode = { id: 'group', label: 'Group', expanded: false };
	const child: TestNode = { id: 'child', label: 'Child', expanded: false };
	let hasGroupChildren = true;
	let completeRead: ((children: readonly TestNode[]) => void) | undefined;
	const tree = new AsyncDataTree<TestNode, TestNode>(dom.window.document.body, {
		hasChildren: element => element === root || element === folder || element === group && hasGroupChildren,
		getChildren: element => element === root ? [folder] : element === folder ? [group] : new Promise<readonly TestNode[]>(resolve => { completeRead = resolve; }),
	}, {
		identityProvider: { getId: element => element.id },
		reuseRows: true,
		renderElement: element => {
			const label = h(dom.window.document, 'span');
			label.textContent = element.label;
			return label;
		},
	});
	try {
		await tree.setInput(root);
		await tree.expand(folder);
		const oldExpansion = tree.expand(group);
		await Promise.resolve();
		assert.ok(completeRead);
		assert.equal(tree.isLoading(group), true);
		hasGroupChildren = false;
		await tree.updateChildren(folder, { recursive: false });
		completeRead([child]);
		await oldExpansion;
		assert.deepEqual(tree.getVisibleElements(), [folder, group]);
		assert.equal(tree.getNode(group).collapsible, false);
		assert.equal(tree.getNode(group).children, undefined);
		assert.equal(tree.isLoading(group), false);
		assert.throws(() => tree.getNode(child), /Unknown AsyncDataTree state/);
	} finally {
		tree.dispose();
		dom.window.close();
	}
});

test("AsyncDataTree does not restart a lazy load when a node is collapsed and expanded", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const root: TestNode = { id: "root", label: "Root", expanded: true };
	const group: TestNode = { id: "group", label: "Group", expanded: false };
	const child: TestNode = { id: "child", label: "Child", expanded: false };
	let reads = 0;
	let resolveChildren: ((children: readonly TestNode[]) => void) | undefined;
	const tree = new AsyncDataTree<TestNode, TestNode>(dom.window.document.body, {
		hasChildren: (element) => element === root || element === group,
		getChildren: (element) => {
			if (element === root) return [group];
			reads += 1;
			return new Promise<readonly TestNode[]>((resolve) => { resolveChildren = resolve; });
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
	const loaded = new Promise<void>((resolve) => {
		const listener = tree.onDidChangeLoadState(({ element, loading }) => {
			if (element !== group || loading) return;
			listener.dispose();
			resolve();
		});
	});

	const firstExpansion = tree.expand(group);
	assert.equal(tree.collapse(group), true);
	const secondExpansion = tree.expand(group);
	await Promise.resolve();
	assert.equal(reads, 1);
	resolveChildren?.([child]);
	await loaded;
	assert.deepEqual(await Promise.all([firstExpansion, secondExpansion]), [true, true]);
	assert.deepEqual([...tree.element.querySelectorAll<HTMLElement>(".ash-tree-row")].map((row) => row.textContent), ["Group", "Child"]);
	tree.collapse(group);
	assert.equal(await tree.expand(group), true);
	assert.equal(reads, 1);
	assert.equal(tree.element.getAttribute('aria-busy'), 'false');

	tree.dispose();
	dom.window.close();
});

test("AsyncDataTree refreshes expanded descendants while preserving rows", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const root: TestNode = { id: "root", label: "Root", expanded: true };
	const firstGroup: TestNode = { id: "group", label: "Group", expanded: false };
	const refreshedGroup: TestNode = { id: "group", label: "Refreshed group", expanded: false };
	const child: TestNode = { id: "child", label: "Child", expanded: false };
	let rootChildren: readonly TestNode[] = [firstGroup];
	let groupReads = 0;
	const tree = new AsyncDataTree<TestNode, TestNode>(dom.window.document.body, {
		hasChildren: (element) => element.id === "root" || element.id === "group",
		getChildren: (element) => {
			if (element.id === "root") return rootChildren;
			groupReads += 1;
			return [child];
		},
	}, {
		identityProvider: { getId: (element) => element.id },
		reuseRows: true,
		collapseByDefault: (element) => element.id === "group",
		renderElement: (element) => {
			const label = h(dom.window.document, "span");
			label.textContent = element.label;
			return label;
		},
	});
	await tree.setInput(root);
	tree.expand(firstGroup);
	await new Promise<void>((resolve) => {
		const listener = tree.onDidChangeLoadState(({ element, loading }) => {
			if (element?.id !== "group" || loading) return;
			listener.dispose();
			resolve();
		});
	});
	const groupRow = tree.element.querySelector('[data-tree-id="group"]');
	const childRow = tree.element.querySelector('[data-tree-id="child"]');
	rootChildren = [refreshedGroup];
	await tree.updateChildren(root);
	assert.deepEqual(
		[...tree.element.querySelectorAll<HTMLElement>(".ash-tree-row")].map((row) => row.textContent),
		["Refreshed group", "Child"],
	);
	assert.equal(tree.element.querySelector('[data-tree-id="group"]'), groupRow);
	assert.equal(tree.element.querySelector('[data-tree-id="child"]'), childRow);
	assert.equal(groupReads, 2);
	tree.dispose();
	dom.window.close();
});

test("AsyncDataTree preserves loaded children after an invalid refresh", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const root: TestNode = { id: "root", label: "Root", expanded: true };
	const child: TestNode = { id: "child", label: "Child", expanded: false };
	let children: readonly TestNode[] = [child];
	const tree = new AsyncDataTree<TestNode, TestNode>(dom.window.document.body, {
		hasChildren: element => element === root,
		getChildren: () => children,
	}, {
		identityProvider: { getId: element => element.id },
		renderElement: element => {
			const label = h(dom.window.document, "span");
			label.textContent = element.label;
			return label;
		},
	});
	await tree.setInput(root);
	children = [child, child];
	await assert.rejects(tree.updateChildren(root), /Duplicate tree node ID/);
	assert.deepEqual(tree.getVisibleElements().map(element => element.id), ["child"]);
	children = [{ id: "replacement", label: "Replacement", expanded: false }];
	await tree.updateChildren(root);
	assert.deepEqual(tree.getVisibleElements().map(element => element.id), ["replacement"]);
	tree.dispose();
	dom.window.close();
});

test("AsyncDataTree collapses a failed expansion and can retry it", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const root: TestNode = { id: "root", label: "Root", expanded: true };
	const group: TestNode = { id: "group", label: "Group", expanded: false };
	const child: TestNode = { id: "child", label: "Child", expanded: false };
	let reads = 0;
	const tree = new AsyncDataTree<TestNode, TestNode>(dom.window.document.body, {
		hasChildren: (element) => element === root || element === group,
		getChildren: (element) => {
			if (element === root) return [group];
			reads += 1;
			if (reads === 1) throw new Error("Directory unavailable");
			return [child];
		},
	}, {
		identityProvider: { getId: (element) => element.id },
		collapseByDefault: (element) => element === group,
		renderElement: (element) => {
			const label = h(dom.window.document, "span");
			label.textContent = element.label;
			return label;
		},
	});
	await tree.setInput(root);
	const failed = new Promise<void>((resolve) => {
		const listener = tree.onDidError(() => {
			listener.dispose();
			resolve();
		});
	});
	await assert.rejects(tree.expand(group), /Directory unavailable/);
	await failed;
	assert.equal(tree.element.querySelector('[data-tree-id="group"]')?.getAttribute("aria-expanded"), "false");
	const loaded = new Promise<void>((resolve) => {
		const listener = tree.onDidChangeLoadState(({ element, loading }) => {
			if (element !== group || loading) return;
			listener.dispose();
			resolve();
		});
	});
	tree.expand(group);
	await loaded;
	assert.deepEqual([...tree.element.querySelectorAll<HTMLElement>(".ash-tree-row")].map((row) => row.textContent), ["Group", "Child"]);
	assert.equal(reads, 2);
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
	assert.equal(await tree.expand(first), true);
	assert.deepEqual([...tree.element.querySelectorAll<HTMLElement>(":scope > .ash-tree-row")].map((row) => row.textContent), ["First / Middle"]);
	tree.element.querySelector<HTMLElement>(":scope > .ash-tree-row")?.click();
	assert.deepEqual(pointers, ["first:first", "middle:first/middle"]);
	assert.equal(await tree.expand(middle), true);
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
	const parentNode = model.getNode("parent");
	model.setChildren([{ element: { id: "parent", label: "Updated parent", expanded: false }, children: [{ element: child }] }]);
	assert.equal(model.getNode("parent")?.collapsed, true);
	assert.equal(model.getNode("parent"), parentNode);
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

test("ObjectTreeModel keeps node identity without reindexing on collapse and rerender", () => {
	let identityReads = 0;
	const model = new ObjectTreeModel<TestNode>({
		identityProvider: { getId: (node) => { identityReads++; return node.id; } },
	});
	model.setChildren([{
		element: { id: "parent", label: "Parent", expanded: false },
		children: Array.from({ length: 100 }, (_, index) => ({ element: { id: `child-${index}`, label: `Child ${index}`, expanded: false } })),
	}]);
	const child = model.getNode("child-99");
	const readsAfterStructure = identityReads;

	assert.equal(model.collapse("parent"), true);
	model.rerender("parent");
	assert.equal(model.expand("parent"), true);
	assert.equal(identityReads, readsAfterStructure);
	assert.equal(model.getNode("child-99"), child);
	model.dispose();
});

test("ObjectTree avoids remeasuring unchanged children during a directory refresh", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	let heightReads = 0;
	const tree = new ObjectTree<TestNode>(dom.window.document.body, {
		modelOptions: { identityProvider: { getId: node => node.id } },
		getHeight: () => { heightReads += 1; return 22; },
		reuseRows: true,
		renderElement: element => {
			const label = h(dom.window.document, "span");
			label.textContent = element.label;
			return label;
		},
	});
	const children = Array.from({ length: 100 }, (_, index) => ({ element: { id: `child-${index}`, label: `Child ${index}`, expanded: false } }));
	tree.setChildren([{ element: { id: "folder", label: "Folder", expanded: false }, children }]);
	const firstRow = tree.element.querySelector('[data-tree-id="child-0"]');
	heightReads = 0;
	tree.setNodeChildren("folder", children);
	assert.ok(heightReads < 10);
	assert.equal(tree.element.querySelector('[data-tree-id="child-0"]'), firstRow);
	tree.dispose();
	dom.window.close();
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
	model.setNodeChildren("a-group", [
		{ element: { id: "hidden", label: "Hidden", expanded: false } },
		{ element: { id: "match-a", label: "Match A", expanded: false } },
		{ element: { id: "match-new", label: "Match new", expanded: false } },
	]);
	assert.deepEqual(model.visibleNodes.map((node) => node.id), ["a-group", "match-a", "match-new", "z-group", "match-b"]);
	model.setFilter(undefined);
	assert.deepEqual(model.visibleNodes.map((node) => node.id), ["a-group", "hidden", "match-a", "match-new", "z-group", "match-b"]);
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

test("ObjectTree applies double-click expansion policy to row contents", () => {
	for (const scenario of [
		{ name: "default", expandOnlyOnTwistieClick: false, expandOnDoubleClick: undefined, expected: [false, true] },
		{ name: "disabled", expandOnlyOnTwistieClick: false, expandOnDoubleClick: false, expected: [false] },
		{ name: "twistie only", expandOnlyOnTwistieClick: true, expandOnDoubleClick: undefined, expected: [false] },
		{ name: "twistie only and disabled", expandOnlyOnTwistieClick: true, expandOnDoubleClick: false, expected: [] },
	]) {
		const dom = new JSDOM("<!doctype html><body></body>");
		const tree = new ObjectTree<TestNode>(dom.window.document.body, {
			expandOnDoubleClick: scenario.expandOnDoubleClick,
			expandOnlyOnTwistieClick: scenario.expandOnlyOnTwistieClick,
			modelOptions: { identityProvider: { getId: node => node.id } },
			renderElement: element => {
				const label = h(dom.window.document, "span");
				label.textContent = element.label;
				return label;
			},
		});
		tree.setChildren([{
			element: { id: "folder", label: "Folder", expanded: false },
			collapsed: true,
			children: [{ element: { id: "child", label: "Child", expanded: false } }],
		}]);
		const collapsed: boolean[] = [];
		tree.onDidChangeCollapseState(event => collapsed.push(event.collapsed));
		for (const detail of [1, 2]) {
			const folder = tree.element.querySelector<HTMLElement>("[data-tree-id='folder'] .ash-tree-contents");
			assert.ok(folder);
			folder.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0, detail }));
		}
		const folder = tree.element.querySelector<HTMLElement>("[data-tree-id='folder'] .ash-tree-contents");
		assert.ok(folder);
		folder.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, button: 0, detail: 2 }));
		assert.deepEqual(collapsed, scenario.expected, scenario.name);
		tree.dispose();
		dom.window.close();
	}
});

test("ObjectTree releases hidden rows when its hierarchy is replaced", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const removed: string[] = [];
	const tree = new ObjectTree<TestNode>(dom.window.document.body, {
		modelOptions: { identityProvider: { getId: node => node.id } },
		reuseRows: true,
		onDidRemoveRow: row => removed.push(row.dataset.treeId!),
		renderElement: element => {
			const label = h(dom.window.document, "span");
			label.textContent = element.label;
			return label;
		},
	});
	tree.setChildren([{
		element: { id: "folder", label: "Folder", expanded: false }, children: [
			{ element: { id: "child", label: "Child", expanded: false } },
		]
	}]);
	tree.collapse("folder");
	assert.deepEqual(removed, []);
	tree.setChildren([{ element: { id: "replacement", label: "Replacement", expanded: false } }]);
	assert.deepEqual(removed.sort(), ["child", "folder"]);
	tree.dispose();
	assert.deepEqual(removed.sort(), ["child", "folder", "replacement"]);
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

test('ObjectTree find preserves subsequence order, contiguous matching and Unicode labels', () => {
	for (const matchType of ['fuzzy', 'contiguous'] as const) {
		const dom = new JSDOM('<!doctype html><body></body>');
		const nodes: TestNode[] = [
			{ id: 'first', label: 'Alpha Tree', expanded: false },
			{ id: 'second', label: 'Another Task', expanded: false },
			{ id: 'emoji', label: '🌲 Trail', expanded: false },
			{ id: 'other', label: 'Elsewhere', expanded: false },
		];
		const tree = new ObjectTree<TestNode>(dom.window.document.body, {
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: node => node.label },
			findMode: 'filter',
			findMatchType: matchType,
			modelOptions: { identityProvider: { getId: node => node.id } },
			renderElement: node => {
				const label = h(dom.window.document, 'span');
				label.textContent = node.label;
				return label;
			},
		});
		const visible = (): (string | undefined)[] => [...tree.element.querySelectorAll<HTMLElement>(':scope > .ash-tree-row')].map(row => row.dataset.treeId);
		try {
			tree.setChildren(nodes.map(element => ({ element })));
			tree.setFindPattern('aT');
			assert.deepEqual(visible(), matchType === 'fuzzy' ? ['first', 'second'] : []);
			if (matchType === 'fuzzy') {
				assert.equal(tree.findNext()?.id, 'second');
				assert.equal(tree.findNext()?.id, 'first');
			}
			tree.setFindPattern('🌲');
			assert.deepEqual(visible(), ['emoji']);
			assert.equal(tree.element.querySelector('[data-tree-id="emoji"]')?.classList.contains('find-match'), true);
			tree.clearFind();
			assert.deepEqual(visible(), nodes.map(node => node.id));
		} finally {
			tree.dispose();
			dom.window.close();
		}
	}
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
	tree.findMode = 'highlight';
	assert.deepEqual([...tree.element.querySelectorAll<HTMLElement>(":scope > .ash-tree-row")].map(row => row.dataset.treeId), ['group', 'other']);
	tree.findMode = 'filter';
	assert.deepEqual([...tree.element.querySelectorAll<HTMLElement>(":scope > .ash-tree-row")].map(row => row.dataset.treeId), ['group', 'needle']);
	tree.clearFind();
	assert.equal(tree.element.querySelectorAll(":scope > .ash-tree-row").length, 2);
	tree.openFind();
	const input = tree.element.querySelector<HTMLInputElement>('input[type="search"]')!;
	assert.equal(dom.window.document.activeElement, input);
	input.value = 'needle';
	input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	assert.equal(dom.window.document.activeElement, input, 'filtering retains focus in the find controls');
	assert.equal(tree.element.querySelectorAll('.ash-tree-find-widget').length, 1);
	input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	assert.equal(dom.window.document.activeElement, tree.element);
	assert.equal(tree.element.querySelector<HTMLElement>('.ash-tree-find-widget')?.hidden, true);
	assert.equal(tree.element.querySelectorAll(':scope > .ash-tree-row').length, 2);
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
		dnd: { getDragURI: (element) => `ash://${element.id}`, onDragOver: () => false, drop: () => { } },
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
