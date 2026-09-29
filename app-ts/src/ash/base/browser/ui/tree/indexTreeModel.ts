import { Emitter, type Event } from "../../../common/event.js";
import { Disposable } from "../../../common/lifecycle.js";
import { TreeVisibility, type AbstractTreeNode, type IndexTreeLocation, type TreeElement, type TreeFilter, type TreeFilterResult, type TreeVisibleSplice } from "./tree.js";

export type IndexTreeModelChangeKind = "structure" | "collapse" | "filter" | "rerender";

export interface IndexTreeNode<T> extends AbstractTreeNode<T> {
	readonly parent: IndexTreeNode<T> | undefined;
	readonly children: readonly IndexTreeNode<T>[];
	readonly location: IndexTreeLocation;
}

export interface IndexTreeIdentityProvider<T> {
	getId(element: T): string;
}

export interface IndexTreeModelOptions<T> {
	readonly defaultCollapseState?: "collapsed" | "expanded";
	readonly filter?: TreeFilter<T>;
	readonly identityProvider?: IndexTreeIdentityProvider<T>;
	readonly preserveCollapseStateByIdentity?: boolean;
}

export interface IndexTreeModelChangeEvent<T> {
	readonly kind: IndexTreeModelChangeKind;
	readonly node: IndexTreeNode<T> | undefined;
	readonly visibleSplice?: TreeVisibleSplice<IndexTreeNode<T>>;
}

export interface IndexTreeModelCollapseStateChangeEvent<T> {
	readonly node: IndexTreeNode<T>;
	readonly collapsed: boolean;
}

interface MutableIndexTreeNode<T> {
	readonly id: string;
	element: T;
	parent: MutableIndexTreeNode<T> | undefined;
	children: MutableIndexTreeNode<T>[];
	depth: number;
	location: number[];
	declaredCollapsible: boolean | undefined;
	collapsible: boolean;
	collapsed: boolean;
	visible: boolean;
	visibleChildIndex: number;
	visibleChildrenCount: number;
}

interface PreparedTreeElement<T> extends TreeElement<T> {
	readonly id: string;
	readonly children: readonly PreparedTreeElement<T>[];
}

/** Canonical index-addressed hierarchy and flattened visible-node projection. */
export class IndexTreeModel<T> extends Disposable {
	private readonly _onDidChange = this._register(new Emitter<IndexTreeModelChangeEvent<T>>());
	private readonly _onDidChangeCollapseState = this._register(new Emitter<IndexTreeModelCollapseStateChangeEvent<T>>());
	private readonly root: MutableIndexTreeNode<T>;
	private readonly defaultCollapseState: "collapsed" | "expanded";
	private readonly identityProvider: IndexTreeIdentityProvider<T> | undefined;
	private readonly preserveCollapseStateByIdentity: boolean;
	private filter: TreeFilter<T> | undefined;
	private nodesById = new Map<string, MutableIndexTreeNode<T>>();
	private visible: readonly IndexTreeNode<T>[] = [];
	private generatedId = 0;

	readonly onDidChange: Event<IndexTreeModelChangeEvent<T>> = this._onDidChange.event;
	readonly onDidChangeCollapseState: Event<IndexTreeModelCollapseStateChangeEvent<T>> = this._onDidChangeCollapseState.event;

	constructor(rootElement: T, options: IndexTreeModelOptions<T> = {}) {
		super();
		this.defaultCollapseState = options.defaultCollapseState ?? "expanded";
		this.filter = options.filter;
		this.identityProvider = options.identityProvider;
		this.preserveCollapseStateByIdentity = options.preserveCollapseStateByIdentity ?? false;
		this.root = {
			id: "__ash_index_tree_root__",
			element: rootElement,
			parent: undefined,
			children: [],
			depth: 0,
			location: [],
			declaredCollapsible: true,
			collapsible: true,
			collapsed: false,
			visible: true,
			visibleChildIndex: 0,
			visibleChildrenCount: 1,
		};
		this.rebuildIndexAndProjection();
	}

	get rootNode(): IndexTreeNode<T> { return this.root; }
	get rootNodes(): readonly IndexTreeNode<T>[] { return this.root.children; }
	get visibleNodes(): readonly IndexTreeNode<T>[] { return this.visible; }
	get size(): number { return this.nodesById.size - 1; }

	has(location: IndexTreeLocation): boolean {
		return this.findNode(location) !== undefined;
	}

	getNode(location: IndexTreeLocation = []): IndexTreeNode<T> {
		return this.requireNode(location);
	}

	getNodeById(id: string): IndexTreeNode<T> | undefined {
		return this.nodesById.get(id);
	}

	getLocation(node: IndexTreeNode<T>): IndexTreeLocation {
		return [...node.location];
	}

	getParentLocation(location: IndexTreeLocation): IndexTreeLocation | undefined {
		return location.length === 0 ? undefined : location.slice(0, -1);
	}

	setChildren(children: readonly TreeElement<T>[]): void {
		this.splice([0], this.root.children.length, children);
	}

	setNodeChildren(location: IndexTreeLocation, children: readonly TreeElement<T>[]): void {
		const parent = this.requireMutableNode(location);
		this.splice([...location, 0], parent.children.length, children);
	}

	splice(location: IndexTreeLocation, deleteCount: number, toInsert: readonly TreeElement<T>[] = []): void {
		if (location.length === 0) throw new RangeError("IndexTree splice location must address a child position");
		if (!Number.isInteger(deleteCount) || deleteCount < 0) throw new RangeError("IndexTree deleteCount must be a non-negative integer");
		const parentLocation = location.slice(0, -1);
		const parent = this.requireMutableNode(parentLocation);
		const start = location[location.length - 1]!;
		if (!Number.isInteger(start) || start < 0 || start > parent.children.length) throw new RangeError(`Invalid IndexTree splice position: ${location.join("/")}`);
		const boundedDeleteCount = Math.min(deleteCount, parent.children.length - start);
		const deleted = parent.children.slice(start, start + boundedDeleteCount);
		const oldVisibleRange = this.visibleDescendantRange(parent);
		const deletedById = collectNodesById(deleted);
		const previous = this.preserveCollapseStateByIdentity ? deletedById : new Map<string, MutableIndexTreeNode<T>>();
		const insertedIds = new Set<string>();
		const prepare = (element: TreeElement<T>): PreparedTreeElement<T> => {
			const id = this.identityProvider?.getId(element.element) ?? `index-tree-node-${++this.generatedId}`;
			if (!id.trim()) throw new TypeError("Tree node IDs must not be empty");
			if (insertedIds.has(id) || this.nodesById.has(id) && !deletedById.has(id)) throw new Error(`Duplicate tree node ID: ${id}`);
			insertedIds.add(id);
			return { ...element, id, children: (element.children ?? []).map(prepare) };
		};
		const prepared = toInsert.map(prepare);
		const inserted = this.buildNodes(prepared, parent, previous);
		for (const id of deletedById.keys()) this.nodesById.delete(id);
		parent.children.splice(start, boundedDeleteCount, ...inserted);
		for (const node of inserted) this.registerSubtree(node);
		for (let index = start; index < parent.children.length; index += 1) this.updateLocation(parent.children[index]!, parent, [...parent.location, index]);
		parent.collapsible = parent.declaredCollapsible ?? parent.children.length > 0;
		if (!parent.collapsible) parent.collapsed = false;
		let visibleSplice: TreeVisibleSplice<IndexTreeNode<T>> | undefined;
		if (this.filter) {
			const before = this.visible;
			this.recomputeVisibleNodes();
			visibleSplice = changedVisibleRange(before, this.visible);
		} else {
			this.updateVisibleChildMetadataAtLevel(parent.children);
			for (const node of inserted) this.markSubtreeVisible(node);
			visibleSplice = this.refreshVisibleBranch(parent, oldVisibleRange);
		}
		this._onDidChange.fire({ kind: "structure", node: parent === this.root ? undefined : parent, visibleSplice });
	}

	collapse(location: IndexTreeLocation): boolean { return this.updateCollapsed(location, true); }
	expand(location: IndexTreeLocation): boolean { return this.updateCollapsed(location, false); }

	toggleCollapsed(location: IndexTreeLocation): boolean {
		const node = this.requireMutableNode(location);
		return this.updateCollapsed(location, !node.collapsed);
	}

	collapseRecursive(location: IndexTreeLocation): boolean { return this.updateCollapsedRecursive(location, true); }
	expandRecursive(location: IndexTreeLocation): boolean { return this.updateCollapsedRecursive(location, false); }

	expandTo(location: IndexTreeLocation): boolean {
		let node = this.requireMutableNode(location).parent;
		const changed: MutableIndexTreeNode<T>[] = [];
		while (node && node !== this.root) {
			if (node.collapsible && node.collapsed) {
				node.collapsed = false;
				changed.push(node);
			}
			node = node.parent;
		}
		if (changed.length === 0) return false;
		const visibleSplice = this.refreshVisibleBranch(changed[changed.length - 1]!);
		this._onDidChange.fire({ kind: "collapse", node: this.requireNode(location), visibleSplice });
		for (const changedNode of changed) this._onDidChangeCollapseState.fire({ node: changedNode, collapsed: false });
		return true;
	}

	setFilter(filter: TreeFilter<T> | undefined): void {
		if (filter === this.filter) return;
		this.filter = filter;
		this.refilter();
	}

	refilter(): void {
		this.recomputeVisibleNodes();
		this._onDidChange.fire({ kind: "filter", node: undefined });
	}

	rerender(location?: IndexTreeLocation): void {
		this._onDidChange.fire({ kind: "rerender", node: location === undefined ? undefined : this.requireNode(location) });
	}

	private buildNodes(elements: readonly PreparedTreeElement<T>[], parent: MutableIndexTreeNode<T>, previous: ReadonlyMap<string, MutableIndexTreeNode<T>>): MutableIndexTreeNode<T>[] {
		return elements.map((treeElement) => {
			const id = treeElement.id;
			const oldNode = previous.get(id);
			const node: MutableIndexTreeNode<T> = oldNode ?? {
				id,
				element: treeElement.element,
				parent,
				children: [],
				depth: parent.depth + 1,
				location: [],
				declaredCollapsible: treeElement.collapsible,
				collapsible: false,
				collapsed: false,
				visible: true,
				visibleChildIndex: 0,
				visibleChildrenCount: 0,
			};
			node.element = treeElement.element;
			node.parent = parent;
			node.depth = parent.depth + 1;
			node.location = [];
			node.declaredCollapsible = treeElement.collapsible;
			node.children = this.buildNodes(treeElement.children, node, previous);
			node.collapsible = treeElement.collapsible ?? node.children.length > 0;
			node.collapsed = node.collapsible ? oldNode?.collapsed ?? treeElement.collapsed ?? this.defaultCollapseState === "collapsed" : false;
			return node;
		});
	}

	private updateCollapsed(location: IndexTreeLocation, collapsed: boolean): boolean {
		const node = this.requireMutableNode(location);
		if (node === this.root || !node.collapsible || node.collapsed === collapsed) return false;
		node.collapsed = collapsed;
		const visibleSplice = this.refreshVisibleBranch(node);
		this._onDidChange.fire({ kind: "collapse", node, visibleSplice });
		this._onDidChangeCollapseState.fire({ node, collapsed });
		return true;
	}

	private updateCollapsedRecursive(location: IndexTreeLocation, collapsed: boolean): boolean {
		const root = this.requireMutableNode(location);
		const changed: MutableIndexTreeNode<T>[] = [];
		const visit = (node: MutableIndexTreeNode<T>): void => {
			if (node !== this.root && node.collapsible && node.collapsed !== collapsed) {
				node.collapsed = collapsed;
				changed.push(node);
			}
			for (const child of node.children) visit(child);
		};
		visit(root);
		if (changed.length === 0) return false;
		const visibleSplice = this.refreshVisibleBranch(root);
		this._onDidChange.fire({ kind: "collapse", node: root === this.root ? undefined : root, visibleSplice });
		for (const node of changed) this._onDidChangeCollapseState.fire({ node, collapsed });
		return true;
	}

	private rebuildIndexAndProjection(): void {
		this.nodesById = new Map([[this.root.id, this.root]]);
		const visit = (node: MutableIndexTreeNode<T>, parent: MutableIndexTreeNode<T>, location: number[]): void => {
			node.parent = parent;
			node.depth = parent.depth + 1;
			node.location = location;
			if (this.nodesById.has(node.id)) throw new Error(`Duplicate tree node ID: ${node.id}`);
			this.nodesById.set(node.id, node);
			for (let index = 0; index < node.children.length; index += 1) visit(node.children[index]!, node, [...location, index]);
		};
		for (let index = 0; index < this.root.children.length; index += 1) visit(this.root.children[index]!, this.root, [index]);
		this.recomputeVisibleNodes();
	}

	private registerSubtree(node: MutableIndexTreeNode<T>): void {
		this.nodesById.set(node.id, node);
		for (const child of node.children) this.registerSubtree(child);
	}

	private updateLocation(node: MutableIndexTreeNode<T>, parent: MutableIndexTreeNode<T>, location: number[]): void {
		node.parent = parent;
		node.depth = parent.depth + 1;
		node.location = location;
		for (let index = 0; index < node.children.length; index += 1) this.updateLocation(node.children[index]!, node, [...location, index]);
	}

	private markSubtreeVisible(node: MutableIndexTreeNode<T>): void {
		node.visible = true;
		this.updateVisibleChildMetadataAtLevel(node.children);
		for (const child of node.children) this.markSubtreeVisible(child);
	}

	private visibleDescendantRange(parent: MutableIndexTreeNode<T>): { readonly start: number; readonly deleteCount: number } | undefined {
		const parentIndex = parent === this.root ? -1 : this.visible.indexOf(parent);
		if (parent !== this.root && parentIndex < 0) return undefined;
		const start = parentIndex + 1;
		let end = start;
		while (end < this.visible.length && this.visible[end]!.depth > parent.depth) end += 1;
		return { start, deleteCount: end - start };
	}

	private refreshVisibleBranch(parent: MutableIndexTreeNode<T>, oldRange = this.visibleDescendantRange(parent)): TreeVisibleSplice<IndexTreeNode<T>> | undefined {
		if (!oldRange) return undefined;
		const { start, deleteCount } = oldRange;
		const elements: IndexTreeNode<T>[] = [];
		const append = (node: MutableIndexTreeNode<T>): void => {
			if (!node.visible) return;
			elements.push(node);
			if (!node.collapsed) for (const child of node.children) append(child);
		};
		if (!parent.collapsed) for (const child of parent.children) append(child);
		this.visible = [...this.visible.slice(0, start), ...elements, ...this.visible.slice(start + deleteCount)];
		return { start, deleteCount, elements };
	}

	private recomputeVisibleNodes(): void {
		for (const child of this.root.children) this.updateFilterVisibility(child, TreeVisibility.Visible);
		this.updateVisibleChildMetadata(this.root.children);
		this.flattenVisibleNodes();
	}

	private flattenVisibleNodes(): void {
		const visible: IndexTreeNode<T>[] = [];
		const append = (node: MutableIndexTreeNode<T>): void => {
			if (!node.visible) return;
			visible.push(node);
			if (!node.collapsed) for (const child of node.children) append(child);
		};
		for (const child of this.root.children) append(child);
		this.visible = visible;
	}

	private updateFilterVisibility(node: MutableIndexTreeNode<T>, parentVisibility: TreeVisibility): boolean {
		const visibility = normalizeFilterResult(this.filter?.filter(node.element, parentVisibility) ?? TreeVisibility.Visible);
		if (visibility === TreeVisibility.Hidden) {
			this.hideSubtree(node);
			return false;
		}
		let visibleDescendants = false;
		for (const child of node.children) if (this.updateFilterVisibility(child, visibility)) visibleDescendants = true;
		node.visible = visibility === TreeVisibility.Visible || visibleDescendants;
		return node.visible;
	}

	private hideSubtree(node: MutableIndexTreeNode<T>): void {
		node.visible = false;
		node.visibleChildIndex = -1;
		node.visibleChildrenCount = 0;
		for (const child of node.children) this.hideSubtree(child);
	}

	private updateVisibleChildMetadata(nodes: readonly MutableIndexTreeNode<T>[]): void {
		this.updateVisibleChildMetadataAtLevel(nodes);
		for (const node of nodes) this.updateVisibleChildMetadata(node.children);
	}

	private updateVisibleChildMetadataAtLevel(nodes: readonly MutableIndexTreeNode<T>[]): void {
		const visible = nodes.filter((node) => node.visible);
		for (const node of nodes) {
			node.visibleChildIndex = -1;
			node.visibleChildrenCount = visible.length;
		}
		for (let index = 0; index < visible.length; index += 1) visible[index]!.visibleChildIndex = index;
	}

	private findNode(location: IndexTreeLocation): MutableIndexTreeNode<T> | undefined {
		let node = this.root;
		for (const index of location) {
			if (!Number.isInteger(index) || index < 0) return undefined;
			const child = node.children[index];
			if (!child) return undefined;
			node = child;
		}
		return node;
	}

	private requireNode(location: IndexTreeLocation): IndexTreeNode<T> {
		return this.requireMutableNode(location);
	}

	private requireMutableNode(location: IndexTreeLocation): MutableIndexTreeNode<T> {
		const node = this.findNode(location);
		if (!node) throw new RangeError(`Unknown IndexTree location: ${location.join("/")}`);
		return node;
	}
}

function collectNodesById<T>(roots: readonly MutableIndexTreeNode<T>[]): Map<string, MutableIndexTreeNode<T>> {
	const result = new Map<string, MutableIndexTreeNode<T>>();
	const visit = (node: MutableIndexTreeNode<T>): void => {
		result.set(node.id, node);
		for (const child of node.children) visit(child);
	};
	for (const root of roots) visit(root);
	return result;
}

function changedVisibleRange<T>(before: readonly IndexTreeNode<T>[], after: readonly IndexTreeNode<T>[]): TreeVisibleSplice<IndexTreeNode<T>> {
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
	let beforeEnd = before.length;
	let afterEnd = after.length;
	while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
		beforeEnd -= 1;
		afterEnd -= 1;
	}
	return { start, deleteCount: beforeEnd - start, elements: after.slice(start, afterEnd) };
}

function normalizeFilterResult(result: TreeFilterResult): TreeVisibility {
	if (result === true) return TreeVisibility.Visible;
	if (result === false) return TreeVisibility.Hidden;
	return result;
}
