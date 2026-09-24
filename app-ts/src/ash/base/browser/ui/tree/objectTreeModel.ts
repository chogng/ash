import { Emitter, type Event } from "../../../common/event.js";
import { Disposable } from "../../../common/lifecycle.js";
import { IndexTreeModel, type IndexTreeNode } from "./indexTreeModel.js";
import type { TreeFilter, TreeSorter } from "./tree.js";

export type ObjectTreeDefaultCollapseState = "collapsed" | "expanded";
export type ObjectTreeModelChangeKind = "structure" | "collapse" | "filter" | "sort" | "rerender";

/** One structural entry supplied to `ObjectTreeModel`. */
export interface ObjectTreeElement<T> {
	readonly element: T;
	readonly children?: readonly ObjectTreeElement<T>[];
	readonly collapsible?: boolean;
	readonly collapsed?: boolean;
}

export interface ObjectTreeIdentityProvider<T> {
	getId(element: T): string;
}

/** Identity-addressed node projected by the underlying `IndexTreeModel`. */
export interface ObjectTreeNode<TNode> extends IndexTreeNode<TNode> {
	readonly parent: ObjectTreeNode<TNode> | undefined;
	readonly children: readonly ObjectTreeNode<TNode>[];
}

export interface ObjectTreeModelOptions<TNode> {
	readonly defaultCollapseState?: ObjectTreeDefaultCollapseState;
	readonly filter?: TreeFilter<TNode>;
	readonly identityProvider: ObjectTreeIdentityProvider<TNode>;
	readonly sorter?: TreeSorter<TNode>;
}

export interface ObjectTreeModelChangeEvent<TNode> {
	readonly kind: ObjectTreeModelChangeKind;
	readonly node: ObjectTreeNode<TNode> | undefined;
}

export interface ObjectTreeModelCollapseStateChangeEvent<TNode> {
	readonly node: ObjectTreeNode<TNode>;
	readonly collapsed: boolean;
}

/**
 * Maps stable object identities onto the canonical index-addressed model.
 *
 * Hierarchy, locations, filtering, collapse state, and the visible projection
 * remain owned by `IndexTreeModel`; this layer only translates object IDs and
 * applies object-level sorting before structural changes enter that model.
 */
export class ObjectTreeModel<TNode> extends Disposable {
	private readonly _onDidChange = this._register(new Emitter<ObjectTreeModelChangeEvent<TNode>>());
	private readonly _onDidChangeCollapseState = this._register(new Emitter<ObjectTreeModelCollapseStateChangeEvent<TNode>>());
	private readonly index: IndexTreeModel<TNode>;
	private readonly identityProvider: ObjectTreeIdentityProvider<TNode>;
	private nodesById = new Map<string, ObjectTreeNode<TNode>>();
	private sorter: TreeSorter<TNode> | undefined;
	private changeKindOverride: ObjectTreeModelChangeKind | undefined;

	readonly onDidChange: Event<ObjectTreeModelChangeEvent<TNode>> = this._onDidChange.event;
	readonly onDidChangeCollapseState: Event<ObjectTreeModelCollapseStateChangeEvent<TNode>> = this._onDidChangeCollapseState.event;

	constructor(options: ObjectTreeModelOptions<TNode>) {
		super();
		this.identityProvider = options.identityProvider;
		this.sorter = options.sorter;
		this.index = this._register(new IndexTreeModel<TNode>(undefined as TNode, {
			defaultCollapseState: options.defaultCollapseState,
			filter: options.filter,
			identityProvider: options.identityProvider,
			preserveCollapseStateByIdentity: true,
		}));
		this._register(this.index.onDidChange((event) => {
			this.rebuildIdentityIndex();
			this._onDidChange.fire({ kind: this.changeKindOverride ?? event.kind, node: event.node as ObjectTreeNode<TNode> | undefined });
		}));
		this._register(this.index.onDidChangeCollapseState(({ node, collapsed }) => {
			this._onDidChangeCollapseState.fire({ node: node as ObjectTreeNode<TNode>, collapsed });
		}));
		this.rebuildIdentityIndex();
	}

	get children(): readonly TNode[] { return this.index.rootNodes.map((node) => node.element); }
	get rootNodes(): readonly ObjectTreeNode<TNode>[] { return this.index.rootNodes as readonly ObjectTreeNode<TNode>[]; }
	get visibleChildren(): readonly ObjectTreeNode<TNode>[] { return this.rootNodes.filter((node) => node.visible); }
	get visibleNodes(): readonly ObjectTreeNode<TNode>[] { return this.index.visibleNodes as readonly ObjectTreeNode<TNode>[]; }
	get size(): number { return this.index.size; }

	has(id: string): boolean { return this.nodesById.has(id); }
	getNode(id: string): ObjectTreeNode<TNode> | undefined { return this.nodesById.get(id); }
	getElement(id: string): TNode | undefined { return this.nodesById.get(id)?.element; }
	getParent(id: string): ObjectTreeNode<TNode> | undefined { return this.nodesById.get(id)?.parent; }

	setChildren(children: readonly ObjectTreeElement<TNode>[]): void {
		this.withChangeKind("structure", () => this.index.setChildren(this.prepareElements(children)));
	}

	setNodeChildren(parentId: string, children: readonly ObjectTreeElement<TNode>[]): void {
		const parent = this.requireNode(parentId);
		this.withChangeKind("structure", () => this.index.setNodeChildren(parent.location, this.prepareElements(children)));
	}

	collapse(id: string): boolean { return this.index.collapse(this.requireNode(id).location); }
	expand(id: string): boolean { return this.index.expand(this.requireNode(id).location); }
	toggleCollapsed(id: string): boolean { return this.index.toggleCollapsed(this.requireNode(id).location); }
	collapseRecursive(id: string): boolean { return this.index.collapseRecursive(this.requireNode(id).location); }
	expandRecursive(id: string): boolean { return this.index.expandRecursive(this.requireNode(id).location); }
	expandTo(id: string): boolean { return this.index.expandTo(this.requireNode(id).location); }

	setFilter(filter: TreeFilter<TNode> | undefined): void {
		this.withChangeKind("filter", () => this.index.setFilter(filter));
	}

	refilter(): void {
		this.withChangeKind("filter", () => this.index.refilter());
	}

	setSorter(sorter: TreeSorter<TNode> | undefined): void {
		if (sorter === this.sorter) return;
		this.sorter = sorter;
		this.resort();
	}

	resort(): void {
		const current = this.rootNodes.map(toObjectTreeElement);
		this.withChangeKind("sort", () => this.index.setChildren(this.prepareElements(current)));
	}

	rerender(id?: string): void {
		this.withChangeKind("rerender", () => this.index.rerender(id === undefined ? undefined : this.requireNode(id).location));
	}

	private prepareElements(elements: readonly ObjectTreeElement<TNode>[]): readonly ObjectTreeElement<TNode>[] {
		const ordered = [...elements];
		if (this.sorter) ordered.sort((left, right) => this.sorter!.compare(left.element, right.element));
		return ordered.map((treeElement) => ({
			element: treeElement.element,
			collapsible: treeElement.collapsible,
			collapsed: treeElement.collapsed,
			children: this.prepareElements(treeElement.children ?? []),
		}));
	}

	private rebuildIdentityIndex(): void {
		const next = new Map<string, ObjectTreeNode<TNode>>();
		for (const node of this.index.rootNodes) {
			const visit = (candidate: IndexTreeNode<TNode>): void => {
				const id = this.identityProvider.getId(candidate.element);
				next.set(id, candidate as ObjectTreeNode<TNode>);
				for (const child of candidate.children) visit(child);
			};
			visit(node);
		}
		this.nodesById = next;
	}

	private requireNode(id: string): ObjectTreeNode<TNode> {
		const node = this.nodesById.get(id);
		if (!node) throw new RangeError(`Unknown tree node ID: ${id}`);
		return node;
	}

	private withChangeKind<T>(kind: ObjectTreeModelChangeKind, operation: () => T): T {
		const previous = this.changeKindOverride;
		this.changeKindOverride = kind;
		try {
			return operation();
		} finally {
			this.changeKindOverride = previous;
		}
	}
}

function toObjectTreeElement<T>(node: ObjectTreeNode<T>): ObjectTreeElement<T> {
	return {
		element: node.element,
		collapsible: node.collapsible,
		collapsed: node.collapsed,
		children: node.children.map(toObjectTreeElement),
	};
}
