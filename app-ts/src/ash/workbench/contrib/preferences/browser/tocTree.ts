import { h } from '../../../../base/browser/dom.js';
import { ObjectTree, type ObjectTreeCollapseStateChangeEvent, type ObjectTreeFindResult } from '../../../../base/browser/ui/tree/objectTree.js';
import type { ObjectTreeElement } from '../../../../base/browser/ui/tree/objectTreeModel.js';
import { TreeFindMatchType, TreeFindMode } from '../../../../base/browser/ui/tree/tree.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { ISetting } from '../../../services/preferences/common/preferences.js';
import { SettingsLayout, SettingsNavigation, type SettingsCategoryDescriptor, type SettingsCategoryGroupDescriptor, type SettingsLayoutCategory, type SettingsNavigationDescriptor } from './settingsLayout.js';
import type { SettingsTreeNode } from './settingsTreeModels.js';

export interface SettingsTOCTarget {
	readonly id: string;
	readonly label: string;
	readonly targetId: string;
	readonly keywords?: readonly string[];
}

export type SettingsTOCEntry =
	| { readonly kind: 'group'; readonly id: string; readonly group: SettingsCategoryGroupDescriptor }
	| { readonly kind: 'category'; readonly id: string; readonly category: SettingsCategoryDescriptor }
	| { readonly kind: 'target'; readonly id: string; readonly category: SettingsCategoryDescriptor; readonly target: SettingsTOCTarget };

export type SettingsTOCOpenEntry = Exclude<SettingsTOCEntry, { readonly kind: 'group' }>;

export interface TOCTreeOptions {
	readonly ariaLabel: string;
	readonly categoryLabel: (category: SettingsCategoryDescriptor) => string;
	readonly categoryDescription: (category: SettingsCategoryDescriptor) => string;
	readonly groupLabel: (group: SettingsCategoryGroupDescriptor) => string;
	readonly groupDescription: (group: SettingsCategoryGroupDescriptor) => string;
}

/** Projects the product hierarchy and contributed layout groups into Settings TOC entries. */
export class TOCTreeModel {
	constructor(private readonly layout: readonly SettingsLayoutCategory[]) {}

	public get children(): readonly ObjectTreeElement<SettingsTOCEntry>[] {
		return SettingsNavigation.map(entry => this.navigationElement(entry));
	}

	private navigationElement(entry: SettingsNavigationDescriptor): ObjectTreeElement<SettingsTOCEntry> {
		if ('categories' in entry) {
			return {
				element: { kind: 'group', id: `group.${entry.id}`, group: entry },
				children: entry.categories.map(category => this.categoryElement(category)),
				collapsible: true,
				collapsed: true,
			};
		}
		return this.categoryElement(entry);
	}

	private categoryElement(category: SettingsCategoryDescriptor): ObjectTreeElement<SettingsTOCEntry> {
		const groups = this.layout.find(candidate => candidate.id === category.id)?.groups ?? [];
		const targets = new SettingsLayout(category.id, groups).nodes.map(node => ({
			id: node.element.id,
			label: node.element.title,
			targetId: node.element.id,
			keywords: tocSearchKeywords(node),
		}));
		const children = targets.map((target): ObjectTreeElement<SettingsTOCEntry> => ({
			element: { kind: 'target', id: target.id, category, target },
		}));
		return {
			element: { kind: 'category', id: category.id, category },
			children,
			collapsible: children.length > 0,
			collapsed: children.length > 0,
		};
	}
}

function tocSearchKeywords(node: SettingsTreeNode<ISetting>): readonly string[] {
	const keywords: string[] = [];
	const visit = (candidate: SettingsTreeNode<ISetting>): void => {
		keywords.push(candidate.element.title, candidate.element.description, ...(candidate.element.keywords ?? []));
		for (const child of candidate.children ?? []) visit(child);
	};
	visit(node);
	return keywords;
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
		if (entry.kind === 'category') {
			return [
				this.options.categoryLabel(entry.category),
				this.options.categoryDescription(entry.category),
				...(entry.category.keywords ?? []),
			].join(' ');
		}
		return [entry.target.label, ...(entry.target.keywords ?? [])].join(' ');
	}

	private renderEntry(document: Document, entry: SettingsTOCEntry): HTMLElement {
		const label = h(document, 'span');
		label.className = 'ash-settings-navigation-label';
		if (entry.kind === 'group') label.dataset.settingsGroupId = entry.group.id;
		else if (entry.kind === 'category') label.dataset.settingsCategoryId = entry.category.id;
		else label.dataset.settingsTargetId = entry.target.targetId;
		label.textContent = entry.kind === 'group'
			? this.options.groupLabel(entry.group)
			: entry.kind === 'category' ? this.options.categoryLabel(entry.category) : entry.target.label;
		return label;
	}
}
