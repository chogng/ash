import type { Event } from '../../../../base/common/event.js';
import type { ISetting } from '../../../services/preferences/common/preferences.js';
import { ObjectTreeModel, type ObjectTreeElement, type ObjectTreeNode } from "../../../../base/browser/ui/tree/objectTreeModel.js";
import { TreeVisibility } from "../../../../base/browser/ui/tree/tree.js";
import { SettingsSearchQuery } from "./settingsSearch.js";

export interface SettingsTreeItem<T> {
	readonly kind: "item";
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly keywords?: readonly string[];
	readonly value: T;
}

export interface SettingsTreeGroup {
	/** Retained interactive heading content; its creator owns the controls and their disposal. */
	readonly titleDomNode?: HTMLElement;
	readonly kind: "group";
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly keywords?: readonly string[];
}

export type SettingsTreeElement<T> = SettingsTreeGroup | SettingsTreeItem<T>;
export type SettingsTreeNode<T> = ObjectTreeElement<SettingsTreeElement<T>>;

/** Domain-owned content uses the same keyed tree as registered settings, without inventing configuration keys. */
export interface SettingsContentItem {
	readonly domNode: HTMLElement;
}

export interface SettingsContent {
	readonly categoryId: string;
	/** Registered keys whose controls are composed by this content rather than the generic layout. */
	readonly settingIds?: readonly string[];
	readonly onDidChange: Event<void>;
	getNodes(query: SettingsSearchQuery): readonly SettingsTreeNode<ISetting | SettingsContentItem>[];
	setVisible(visible: boolean): void;
}

/** Non-configuration service state and actions; Preferences owns their DOM and widgets. */
export interface SettingsSectionModel {
	readonly categoryId: string;
	readonly title: string;
	readonly description: string;
	readonly help: string;
	readonly onDidChange: Event<void>;
	/** Field IDs and kinds remain stable for this section’s lifetime; values and actions may change. */
	readonly fields: readonly SettingsSectionField[];
	setVisible(visible: boolean): void;
}

export type SettingsSectionField =
	| { readonly id: string; readonly kind: 'status'; readonly text: string; }
	| { readonly id: string; readonly kind: 'boolean'; readonly label: string; readonly value: boolean; readonly enabled: boolean; readonly setValue: (value: boolean) => void; }
	| { readonly id: string; readonly kind: 'text'; readonly label: string; readonly value: string; readonly placeholder: string; readonly enabled: boolean; readonly setValue: (value: string) => void; }
	| { readonly id: string; readonly kind: 'select'; readonly label: string; readonly value: string | undefined; readonly options: readonly { readonly value: string; readonly label: string; }[]; readonly enabled: boolean; readonly setValue: (value: string) => void; }
	| { readonly id: string; readonly kind: 'action'; readonly label: string; readonly enabled: boolean; readonly run: () => Promise<void>; };

/** Settings group/item model with query filtering over canonical item metadata. */
export class SettingsTreeModel<T> extends ObjectTreeModel<SettingsTreeElement<T>> {
	private navigationScopeIds: ReadonlySet<string> | undefined;
	private navigationTargetId: string | undefined;
	private searchQuery = new SettingsSearchQuery("");

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
		this.refreshNavigationScope();
	}

	setNodeChildren(parentId: string, children: readonly SettingsTreeNode<T>[]): void {
		validateSettingsNodes(children);
		super.setNodeChildren(parentId, asNonCollapsibleSettingsTree(children));
		this.refreshNavigationScope();
	}

	setQuery(query: string | SettingsSearchQuery): void {
		const next = typeof query === "string" ? new SettingsSearchQuery(query) : query;
		if (next.key === this.searchQuery.key) return;
		this.searchQuery = next;
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
