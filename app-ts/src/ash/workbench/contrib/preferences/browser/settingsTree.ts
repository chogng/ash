import "./media/settingsTree.css";
import type { ObjectTreeNode } from "../../../../base/browser/ui/tree/objectTreeModel.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import type { SettingsTreeElement, SettingsTreeGroup, SettingsTreeItem, SettingsTreeModel } from "./settingsTreeModels.js";
import { h } from "../../../../base/browser/dom.js";

export interface SettingsTreeOptions<T> {
	readonly model: SettingsTreeModel<T>;
	readonly rootClassName: string;
	readonly groupClassName: string;
	readonly groupDescriptionClassName: string;
	readonly itemsClassName: string;
	readonly renderItem: (item: SettingsTreeItem<T>) => HTMLElement;
	readonly updateItem?: (item: SettingsTreeItem<T>, element: HTMLElement) => void;
	readonly disposeItem?: (item: SettingsTreeItem<T>, element: HTMLElement) => void;
}

interface RenderedSettingsGroup<T> {
	readonly kind: "group";
	readonly element: HTMLElement;
	readonly heading: HTMLHeadingElement;
	readonly description: HTMLParagraphElement;
	readonly items: HTMLDivElement;
	group: SettingsTreeGroup;
}

interface RenderedSettingsItem<T> {
	readonly kind: "item";
	readonly element: HTMLElement;
	item: SettingsTreeItem<T>;
}

type RenderedSettingsNode<T> = RenderedSettingsGroup<T> | RenderedSettingsItem<T>;

/**
 * Keyed Settings renderer that leaves interactive item content to its domain.
 *
 * Stable model IDs retain item DOM, focus, and control-local state across
 * filtering, sorting, and structural updates. This specialized renderer does
 * not nest Settings inputs, selects, or buttons inside an interactive tree row.
 */
export class SettingsTree<T> extends Disposable {
	readonly element: HTMLDivElement;
	readonly model: SettingsTreeModel<T>;
	private readonly options: SettingsTreeOptions<T>;
	private readonly rendered = new Map<string, RenderedSettingsNode<T>>();

	constructor(container: HTMLElement, options: SettingsTreeOptions<T>) {
		super();
		this.options = options;
		this.model = options.model;
		this.element = h(container.ownerDocument, "div");
		this.element.className = `ash-settings-tree ${options.rootClassName}`;
		container.append(this.element);
		this._register(options.model.onDidChange(() => this.render()));
		this._register(toDisposable(() => {
			for (const rendered of this.rendered.values()) this.disposeRenderedNode(rendered);
			this.rendered.clear();
			this.element.remove();
		}));
		this.render();
	}

	getItemElement(id: string): HTMLElement | undefined {
		const rendered = this.rendered.get(id);
		return rendered?.kind === "item" ? rendered.element : undefined;
	}

	setNavigationTarget(targetId: string | undefined): void {
		this.model.setNavigationTarget(targetId);
		this.element.classList.toggle("has-navigation-target", targetId !== undefined);
		if (targetId === undefined) delete this.element.dataset.settingsNavigationTargetId;
		else this.element.dataset.settingsNavigationTargetId = targetId;
	}

	setQuery(query: string): void {
		this.model.setQuery(query);
	}

	private render(): void {
		const children = this.options.model.visibleChildren.map((node) => this.renderNode(node));
		reconcileSettingsChildren(this.element, children);
		for (const [id, rendered] of this.rendered) {
			if (this.options.model.has(id)) continue;
			this.disposeRenderedNode(rendered);
			this.rendered.delete(id);
		}
	}

	private renderNode(node: ObjectTreeNode<SettingsTreeElement<T>>): HTMLElement {
		return node.element.kind === "item"
			? this.renderItem(node.element)
			: this.renderGroup(node, node.element);
	}

	private renderItem(item: SettingsTreeItem<T>): HTMLElement {
		const previous = this.rendered.get(item.id);
		if (previous?.kind === "item") {
			previous.item = item;
			this.options.updateItem?.(item, previous.element);
			return previous.element;
		}
		if (previous) this.disposeRenderedNode(previous);
		const element = this.options.renderItem(item);
		element.dataset.settingsTreeItemId = item.id;
		if (element.dataset.settingsItemId && element.dataset.settingsItemId !== item.id) {
			throw new TypeError(`Rendered Settings item '${item.id}' has conflicting identity '${element.dataset.settingsItemId}'`);
		}
		if (!element.dataset.settingsItemId) {
			element.dataset.settingsItemId = item.id;
			element.dataset.settingsItemKind = "setting";
		}
		this.rendered.set(item.id, { kind: "item", element, item });
		return element;
	}

	private renderGroup(node: ObjectTreeNode<SettingsTreeElement<T>>, group: SettingsTreeGroup): HTMLElement {
		const previous = this.rendered.get(group.id);
		let rendered: RenderedSettingsGroup<T>;
		if (previous?.kind === "group") {
			rendered = previous;
			rendered.group = group;
		} else {
			if (previous) this.disposeRenderedNode(previous);
			rendered = this.createGroup(node, group);
			this.rendered.set(group.id, rendered);
		}
		rendered.heading.textContent = group.title;
		rendered.description.textContent = group.description;
		rendered.element.classList.toggle("collapsed", node.collapsed);
		rendered.element.classList.toggle("is-navigation-target", this.model.navigationTarget === group.id);
		rendered.element.dataset.settingsTreeGroupId = group.id;
		const children = node.collapsed
			? []
			: node.children.filter((child) => child.visible).map((child) => this.renderNode(child));
		reconcileSettingsChildren(rendered.items, children);
		return rendered.element;
	}

	private createGroup(node: ObjectTreeNode<SettingsTreeElement<T>>, group: SettingsTreeGroup): RenderedSettingsGroup<T> {
		const document = this.element.ownerDocument;
		const element = h(document, "section");
		element.className = `ash-settings-tree-group ${this.options.groupClassName}`;
		const heading = h(document, "h4");
		heading.className = "ash-settings-tree-group-title";
		const description = h(document, "p");
		description.className = `ash-settings-tree-group-description ${this.options.groupDescriptionClassName}`;
		const items = h(document, "div");
		items.className = this.options.itemsClassName;
		const rootId = settingsRootId(node);
		if (!node.parent || node.parent.element === undefined) {
			element.classList.add("is-settings-root", `ash-${rootId}-settings`, "ash-configuration-settings");
		} else {
			element.classList.add(`ash-${rootId}-settings-group`);
			description.classList.add(`ash-${rootId}-settings-group-description`);
			items.classList.add(`ash-${rootId}-settings-list`);
		}
		element.append(heading, description, items);
		return { kind: "group", element, heading, description, items, group };
	}

	private disposeRenderedNode(rendered: RenderedSettingsNode<T>): void {
		if (rendered.kind === "item") this.options.disposeItem?.(rendered.item, rendered.element);
		rendered.element.remove();
	}
}

function settingsRootId<T>(node: ObjectTreeNode<SettingsTreeElement<T>>): string {
	let current = node;
	while (current.parent?.element !== undefined) current = current.parent;
	return current.element.id;
}

function reconcileSettingsChildren(container: HTMLElement, children: readonly HTMLElement[]): void {
	let current = container.firstChild;
	for (const child of children) {
		if (child === current) {
			current = current.nextSibling;
			continue;
		}
		container.insertBefore(child, current);
	}
	while (current) {
		const next = current.nextSibling;
		current.remove();
		current = next;
	}
}
