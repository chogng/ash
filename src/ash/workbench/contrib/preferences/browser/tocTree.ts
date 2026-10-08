import { h } from '../../../../base/browser/dom.js';
import { ObjectTree, type ObjectTreeCollapseStateChangeEvent, type ObjectTreeFindResult } from '../../../../base/browser/ui/tree/objectTree.js';
import type { ObjectTreeElement } from '../../../../base/browser/ui/tree/objectTreeModel.js';
import { TreeFindMatchType, TreeFindMode } from '../../../../base/browser/ui/tree/tree.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { ISetting } from '../../../services/preferences/common/preferences.js';
import { SettingsNavigation, type SettingsCategoryDescriptor, type SettingsCategoryGroupDescriptor, type SettingsNavigationDescriptor } from './settingsLayout.js';
import type { SettingsContentItem, SettingsTreeModel } from './settingsTreeModels.js';

export type SettingsTOCEntry =
	| { readonly kind: 'group'; readonly id: string; readonly group: SettingsCategoryGroupDescriptor; }
	| { readonly kind: 'category'; readonly id: string; readonly category: SettingsCategoryDescriptor; readonly searchKeywords: readonly string[]; };

export type SettingsTOCOpenEntry = Extract<SettingsTOCEntry, { readonly kind: 'category'; }>;

export interface TOCTreeOptions {
	readonly ariaLabel: string;
	readonly categoryLabel: (category: SettingsCategoryDescriptor) => string;
	readonly categoryDescription: (category: SettingsCategoryDescriptor) => string;
	readonly groupLabel: (group: SettingsCategoryGroupDescriptor) => string;
	readonly groupDescription: (group: SettingsCategoryGroupDescriptor) => string;
}

/** Projects the product hierarchy and contributed layout groups into Settings TOC entries. */
export class TOCTreeModel {
	constructor(private readonly content: SettingsTreeModel<ISetting | SettingsContentItem>) { }

	public get hasModifiedFilter(): boolean {
		return this.content.hasModifiedFilter;
	}

	public get children(): readonly ObjectTreeElement<SettingsTOCEntry>[] {
		return SettingsNavigation.flatMap(entry => {
			const node = this.navigationElement(entry);
			return node ? [node] : [];
		});
	}

	private navigationElement(entry: SettingsNavigationDescriptor): ObjectTreeElement<SettingsTOCEntry> | undefined {
		if ('categories' in entry) {
			const children = entry.categories.flatMap(category => {
				const node = this.categoryElement(category);
				return node ? [node] : [];
			});
			if (children.length === 0) return undefined;
			return {
				element: { kind: 'group', id: `group.${entry.id}`, group: entry },
				children,
				collapsible: true,
				collapsed: entry.id !== 'general',
			};
		}
		return this.categoryElement(entry);
	}

	private contentSearchKeywords(categoryId: string): readonly string[] {
		const keywords: string[] = [];
		const visit = (id: string): void => {
			const node = this.content.getNode(id);
			if (!node) return;
			keywords.push(node.element.id, node.element.title, node.element.description, ...node.element.keywords ?? []);
			for (const child of node.children) visit(child.element.id);
		};
		visit(categoryId);
		return keywords;
	}

	private categoryElement(category: SettingsCategoryDescriptor): ObjectTreeElement<SettingsTOCEntry> | undefined {
		if (this.content.hasModifiedFilter && this.content.countVisibleItems(category.id) === 0) return undefined;
		// Page sections stay in the content pane; the sidebar stops at categories.
		return {
			element: { kind: 'category', id: category.id, category, searchKeywords: this.contentSearchKeywords(category.id) },
			collapsible: false,
		};
	}
}

/** Settings table of contents backed exclusively by TOCTreeModel/layout identities. */
export class TOCTree extends Disposable {
	public readonly element: HTMLDivElement;
	private readonly openEmitter = this._register(new Emitter<SettingsTOCOpenEntry>());
	private readonly tree: ObjectTree<SettingsTOCEntry>;

	public readonly onDidOpen: Event<SettingsTOCOpenEntry> = this.openEmitter.event;
	public readonly onDidChangeCollapseState: Event<ObjectTreeCollapseStateChangeEvent<SettingsTOCEntry>>;
	public readonly onDidChangeFind: Event<ObjectTreeFindResult<SettingsTOCEntry>>;

	constructor(container: HTMLElement, private readonly model: TOCTreeModel, private readonly options: TOCTreeOptions) {
		super();
		const document = container.ownerDocument;
		this.tree = this._register(new ObjectTree(container, {
			ariaLabel: options.ariaLabel,
			scrolling: 'external',
			expandOnlyOnTwistieClick: false,
			findMatchType: TreeFindMatchType.Contiguous,
			findMode: TreeFindMode.Filter,
			getHeight: () => 26,
			indent: 12,
			keyboardNavigationLabelProvider: {
				getKeyboardNavigationLabel: entry => this.keyboardLabel(entry),
			},
			modelOptions: {
				defaultCollapseState: 'collapsed',
				identityProvider: { getId: entry => entry.id },
			},
			selectionPresentation: 'subtle',
			renderElement: entry => this.renderEntry(document, entry),
		}));
		this.element = this.tree.element;
		this.element.classList.add('ash-settings-navigation-tree', 'ash-settings-toc-tree');
		this.tree.setChildren(model.children);
		this.onDidChangeCollapseState = this.tree.onDidChangeCollapseState;
		this.onDidChangeFind = this.tree.onDidChangeFind;
		this._register(this.tree.onDidChangeSelection(({ elements, browserEvent }) => {
			const entry = elements[0];
			if (entry && entry.kind !== 'group' && browserEvent) this.openEmitter.fire(entry);
		}));
		this._register(this.tree.onDidAccept(({ element, node }) => {
			if (node.collapsible) this.tree.toggleCollapsed(element.id);
			if (element.kind !== 'group') this.openEmitter.fire(element);
		}));
	}

	public get focus(): SettingsTOCEntry | undefined {
		return this.tree.focus;
	}

	public refresh(): void {
		const selection = this.tree.selection.map(entry => entry.id);
		const focus = this.tree.focus?.id;
		this.tree.setChildren(this.model.children);
		this.tree.setSelection(selection.filter(id => this.tree.model.has(id)));
		if (focus && this.tree.model.has(focus)) this.tree.setFocus(focus);
	}

	public expandTo(id: string): boolean {
		return this.tree.expandTo(id);
	}

	public setSelection(ids: readonly string[]): void {
		this.tree.setSelection(ids);
	}

	public setFindPattern(pattern: string): void {
		// Modified results own visibility; ordinary searches still discover category-only keywords and empty pages.
		this.tree.findMode = this.model.hasModifiedFilter ? TreeFindMode.Highlight : TreeFindMode.Filter;
		this.tree.setFindPattern(pattern);
	}

	public domFocus(): void {
		this.tree.domFocus();
	}

	public rerender(): void {
		this.tree.rerender();
	}

	private keyboardLabel(entry: SettingsTOCEntry): string {
		if (entry.kind === 'group') return `${this.options.groupLabel(entry.group)} ${this.options.groupDescription(entry.group)}`;
		return [
			this.options.categoryLabel(entry.category),
			this.options.categoryDescription(entry.category),
			...(entry.category.keywords ?? []),
			...entry.searchKeywords,
		].join(' ');
	}

	private renderEntry(document: Document, entry: SettingsTOCEntry): HTMLElement {
		const label = h(document, 'span');
		label.className = 'ash-settings-navigation-label';
		if (entry.kind === 'group') label.dataset.settingsGroupId = entry.group.id;
		else label.dataset.settingsCategoryId = entry.category.id;
		label.textContent = entry.kind === 'group'
			? this.options.groupLabel(entry.group)
			: this.options.categoryLabel(entry.category);
		return label;
	}
}
