import { ObjectTreeModel, type ObjectTreeElement, type ObjectTreeNode } from "../../../../base/browser/ui/tree/objectTreeModel.js";
import { TreeVisibility } from "../../../../base/browser/ui/tree/tree.js";
import { PreferencesSearchQuery } from "./preferencesSearch.js";

export interface SettingsTreeItem<T> {
	readonly kind: "item";
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly keywords?: readonly string[];
	readonly value: T;
}

export interface SettingsTreeGroup {
	readonly kind: "group";
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly keywords?: readonly string[];
}

export type SettingsTreeElement<T> = SettingsTreeGroup | SettingsTreeItem<T>;
export type SettingsTreeNode<T> = ObjectTreeElement<SettingsTreeElement<T>>;

/** Settings group/item model with query filtering over canonical item metadata. */
export class SettingsTreeModel<T> extends ObjectTreeModel<SettingsTreeElement<T>> {
	private navigationScopeIds: ReadonlySet<string> | undefined;
	private navigationTargetId: string | undefined;
	private searchQuery = new PreferencesSearchQuery("");

	constructor() {
		super({ identityProvider: { getId: (node) => node.id } });
		this.setFilter({ filter: (node) => this.filterNode(node) });
	}

	get query(): string {
		return this.searchQuery.text;
	}

	get navigationTarget(): string | undefined {
		return this.navigationTargetId;
	}

	get visibleItems(): readonly SettingsTreeItem<T>[] {
		return this.visibleNodes
			.map((node) => node.element)
			.filter((node): node is SettingsTreeItem<T> => node.kind === "item");
	}

	setChildren(children: readonly SettingsTreeNode<T>[]): void {
		validateSettingsNodes(children);
		super.setChildren(asNonCollapsibleSettingsTree(children));
	}

	setNodeChildren(parentId: string, children: readonly SettingsTreeNode<T>[]): void {
		validateSettingsNodes(children);
		super.setNodeChildren(parentId, asNonCollapsibleSettingsTree(children));
		this.refreshNavigationScope();
	}

	setQuery(query: string | PreferencesSearchQuery): void {
		const next = typeof query === "string" ? new PreferencesSearchQuery(query) : query;
		if (next.key === this.searchQuery.key) return;
		this.searchQuery = next;
		this.refilter();
	}

	refreshQuery(): void {
		this.refilter();
	}

	setNavigationTarget(targetId: string | undefined): void {
		if (targetId === this.navigationTargetId) return;
		if (targetId !== undefined && !this.has(targetId)) throw new RangeError(`Unknown Settings navigation target '${targetId}'`);
		this.navigationTargetId = targetId;
		this.navigationScopeIds = targetId === undefined ? undefined : collectNavigationScopeIds(this.getNode(targetId)!);
		this.refilter();
	}

	private refreshNavigationScope(): void {
		if (this.navigationTargetId === undefined) return;
		const target = this.getNode(this.navigationTargetId);
		if (!target) return;
		this.navigationScopeIds = collectNavigationScopeIds(target);
		this.refilter();
	}

	getGroup(id: string): SettingsTreeGroup | undefined {
		const node = this.getElement(id);
		return node?.kind === "group" ? node : undefined;
	}

	getItem(id: string): SettingsTreeItem<T> | undefined {
		const node = this.getElement(id);
		return node?.kind === "item" ? node : undefined;
	}

	countVisibleItems(groupId?: string): number {
		const roots = groupId === undefined
			? this.visibleChildren
			: this.getNode(groupId)?.children.filter((node) => node.visible) ?? [];
		return roots.reduce((count, node) => count + countVisibleItems(node), 0);
	}

	private filterNode(node: SettingsTreeElement<T>): boolean | TreeVisibility {
		if (this.navigationScopeIds && !this.navigationScopeIds.has(node.id)) return false;
		if (this.searchQuery.isEmpty) return TreeVisibility.Visible;
		if (node.kind === "group") return TreeVisibility.Recurse;
		return this.searchQuery.matches(node);
	}
}

function collectNavigationScopeIds<T>(target: ObjectTreeNode<SettingsTreeElement<T>>): ReadonlySet<string> {
	const ids = new Set<string>();
	let ancestor: ObjectTreeNode<SettingsTreeElement<T>> | undefined = target;
	while (ancestor) {
		if (ancestor.element === undefined) break;
		ids.add(ancestor.element.id);
		ancestor = ancestor.parent;
	}
	const visit = (node: ObjectTreeNode<SettingsTreeElement<T>>): void => {
		ids.add(node.element.id);
		for (const child of node.children) visit(child);
	};
	visit(target);
	return ids;
}

function countVisibleItems<T>(node: ObjectTreeNode<SettingsTreeElement<T>>): number {
	if (!node.visible) return 0;
	if (node.element.kind === "item") return 1;
	return node.children.reduce((count, child) => count + countVisibleItems(child), 0);
}

function validateSettingsNodes<T>(nodes: readonly SettingsTreeNode<T>[]): void {
	const visit = (node: SettingsTreeNode<T>): void => {
		const element = node.element;
		if (!element.title.trim()) throw new TypeError(`Settings tree ${element.kind} '${element.id}' must have a title`);
		if (element.kind === "item" && (node.children?.length ?? 0) > 0) {
			throw new TypeError(`Settings tree item '${element.id}' must not have children`);
		}
		for (const child of node.children ?? []) visit(child);
	};
	for (const node of nodes) visit(node);
}

function asNonCollapsibleSettingsTree<T>(nodes: readonly SettingsTreeNode<T>[]): readonly SettingsTreeNode<T>[] {
	return nodes.map((node) => ({
		element: node.element,
		collapsible: false,
		children: asNonCollapsibleSettingsTree(node.children ?? []),
	}));
}
