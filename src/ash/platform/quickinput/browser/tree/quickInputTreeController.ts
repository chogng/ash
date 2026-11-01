import { addDisposableListener, stopEvent } from '../../../../base/browser/dom.js';
import { ObjectTree } from '../../../../base/browser/ui/tree/objectTree.js';
import type { ObjectTreeElement } from '../../../../base/browser/ui/tree/objectTreeModel.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { defaultListStyles } from '../../../theme/browser/defaultStyles.js';
import { QuickPickFocus, type IQuickTreeCheckboxEvent, type IQuickTreeItem } from '../../common/quickInput.js';
import { QuickInputTreeDelegate } from './quickInputDelegate.js';
import { getParentNodeState } from './quickInputTree.js';
import { QuickTreeAccessibilityProvider } from './quickInputTreeAccessibilityProvider.js';
import { QuickInputTreeFilter } from './quickInputTreeFilter.js';
import { QuickInputCheckboxStateHandler, QuickInputTreeRenderer } from './quickInputTreeRenderer.js';
import { QuickInputTreeSorter } from './quickInputTreeSorter.js';

/** Owns hierarchy and checkbox transactions, using the shared ObjectTree for rendering and navigation. */
export class QuickInputTreeController extends Disposable {
	readonly tree: ObjectTree<IQuickTreeItem>;
	readonly filterOptions = new QuickInputTreeFilter();
	private readonly sorter = this._register(new QuickInputTreeSorter());
	private readonly _renderer: QuickInputTreeRenderer;
	private readonly checkboxState = this._register(new QuickInputCheckboxStateHandler());
	private readonly checkboxChanged = this._register(new Emitter<IQuickTreeCheckboxEvent<IQuickTreeItem>>());
	private readonly checkedChanged = this._register(new Emitter<readonly IQuickTreeItem[]>());
	private readonly activeChanged = this._register(new Emitter<readonly IQuickTreeItem[]>());
	private readonly accepted = this._register(new Emitter<void>());
	private readonly descendantChanged = this._register(new Emitter<string | undefined>());
	private readonly leave = this._register(new Emitter<void>());
	readonly onLeave = this.leave.event;
	readonly onDidChangeCheckboxState = this.checkboxChanged.event;
	readonly onDidChangeCheckedLeafItems = this.checkedChanged.event;
	readonly onDidChangeActive = this.activeChanged.event;
	readonly onDidAccept = this.accepted.event;
	readonly onDidChangeActiveDescendant = this.descendantChanged.event;
	readonly onDidTriggerButton;
	private readonly ids = new WeakMap<IQuickTreeItem, string>();
	private nextId = 0;
	private items: readonly IQuickTreeItem[] = [];
	private maxHeight = 360;

	constructor(container: HTMLElement, @IInstantiationService instantiation: IInstantiationService) {
		super();
		try {
			const renderer = this._register(instantiation.createInstance(QuickInputTreeRenderer, this.checkboxState));
			this._renderer = renderer;
			const delegate = new QuickInputTreeDelegate();
			this.onDidTriggerButton = renderer.onDidTriggerItemButton;
			this.tree = this._register(new ObjectTree(container, {
				styles: defaultListStyles,
				accessibilityProvider: new QuickTreeAccessibilityProvider(),
				scrolling: 'managed',
				multipleSelectionSupport: false,
				expandOnlyOnTwistieClick: true,
				expandOnDoubleClick: false,
				virtualDelegate: delegate,
				renderers: [renderer],
				modelOptions: { identityProvider: { getId: item => this.id(item) }, filter: this.filterOptions, sorter: this.sorter },
			}));
			this.tree.element.classList.add('ash-quick-tree-items');
			this._register(this.checkboxState.onDidChangeCheckboxState(({ item, checked }) => this.setChecked(item, checked)));
			this._register(this.tree.onPointer(event => {
				if (event.target === 'twistie' || event.browserEvent.button !== 0 || event.element.disabled) return;
				if (event.element.pickable === false) this.accepted.fire();
				else this.setChecked(event.element, event.element.checked !== true);
			}));
			this._register(this.tree.onDidAccept(({ element, browserEvent }) => {
				if (element.disabled) return;
				if (browserEvent.key === ' ') this.setChecked(element, element.checked !== true);
				else this.accepted.fire();
			}));
			this._register(addDisposableListener(this.tree.element, 'keydown', event => {
				// Composition and nested controls retain their own Enter/Space behavior.
				if (event.isComposing || (event.key === 'Enter' || event.key === ' ') && (event.target as HTMLElement).closest('button, input')) event.stopPropagation();
				if (event.defaultPrevented || event.isComposing || event.target !== this.tree.element) return;
				const items = this.tree.getVisibleElements();
				if (event.key === 'ArrowDown' && this.tree.focus === items.at(-1)
					|| event.key === 'ArrowUp' && this.tree.focus === items[0]) {
					stopEvent(event);
					this.leave.fire();
				}
			}, true));
			this._register(this.tree.onDidChangeFocus(() => {
				this.tree.setSelection(this.tree.focus ? [this.id(this.tree.focus)] : []);
				this.activeChanged.fire(this.getActiveItems());
			}));
			this._register(this.tree.onDidChangeCollapseState(({ element, collapsed }) => {
				if (!this.filterOptions.filterValue.trim()) element.collapsed = collapsed;
				this.layout();
			}));
			const observer = new container.ownerDocument.defaultView!.MutationObserver(() => this.descendantChanged.fire(this.getActiveDescendant()));
			observer.observe(this.tree.element, { attributes: true, attributeFilter: ['aria-activedescendant'] });
			this._register(toDisposable(() => observer.disconnect()));
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	private id(item: IQuickTreeItem): string {
		if (item.id !== undefined) return `id:${item.id}`;
		let id = this.ids.get(item);
		if (!id) {
			id = `quick-tree-item-${++this.nextId}`;
			this.ids.set(item, id);
		}
		return id;
	}

	get itemTree(): readonly IQuickTreeItem[] { return this.items; }
	get renderer(): QuickInputTreeRenderer { return this._renderer; }
	get sortByLabel(): boolean { return this.sorter.sortByLabel; }
	set sortByLabel(value: boolean) { this.sorter.sortByLabel = value; this.refresh(); }
	updateFilterOptions(options: { matchOnLabel?: boolean; matchOnDescription?: boolean; }): void {
		if (options.matchOnLabel !== undefined) this.filterOptions.matchOnLabel = options.matchOnLabel;
		if (options.matchOnDescription !== undefined) this.filterOptions.matchOnDescription = options.matchOnDescription;
		this.refresh();
	}
	getActiveDescendant(): string | undefined { return this.tree.element.getAttribute('aria-activedescendant') ?? undefined; }
	getActiveItems(): readonly IQuickTreeItem[] { return this.tree.focus ? [this.tree.focus] : []; }
	getCheckedLeafItems(): readonly IQuickTreeItem[] {
		const collect = (items: readonly IQuickTreeItem[]): IQuickTreeItem[] => items.flatMap(item => {
			if (item.disabled) return [];
			if (item.children?.length) return collect(item.children);
			return item.checked === true && item.pickable !== false ? [item] : [];
		});
		return collect(this.items);
	}
	getParent(item: IQuickTreeItem): IQuickTreeItem | undefined { return this.tree.model.getParent(this.id(item))?.element; }

	setTreeData(items: readonly IQuickTreeItem[]): void {
		const previous = this.getCheckedLeafItems();
		this.items = items;
		this.aggregateParents();
		this.refresh();
		const checked = this.getCheckedLeafItems();
		if (previous.length !== checked.length || previous.some((item, index) => checked[index] !== item)) this.checkedChanged.fire(checked);
	}

	filter(value: string): void {
		this.filterOptions.filterValue = value;
		this.refresh();
	}

	refresh(): void {
		const activeId = this.tree.focus && this.id(this.tree.focus);
		this.filterOptions.prepare(this.items);
		const build = (items: readonly IQuickTreeItem[]): ObjectTreeElement<IQuickTreeItem>[] => items.map(element => {
			const previous = this.tree.model.getNode(this.id(element));
			// Catalog replacements inherit the user's collapse choice. During search,
			// the previous item retains that choice while the model is temporarily expanded.
			if (element.collapsed === undefined && previous) element.collapsed = previous.element.collapsed ?? previous.collapsed;
			return { element, collapsed: element.collapsed, children: element.children ? build(element.children) : undefined };
		});
		this.tree.setChildren(build(this.items));
		const searching = !!this.filterOptions.filterValue.trim();
		for (const item of this.allItems()) {
			if (!item.children?.length) continue;
			if (searching || !item.collapsed) this.tree.expand(this.id(item));
			else this.tree.collapse(this.id(item));
		}
		const visible = this.tree.getVisibleElements();
		for (const item of visible) this.tree.rerender(this.id(item));
		const active = visible.find(item => this.id(item) === activeId) ?? visible[0];
		if (active) this.tree.setFocus(this.id(active));
		this.layout();
		this.descendantChanged.fire(this.getActiveDescendant());
	}

	layout(maxHeight = this.maxHeight): void {
		this.maxHeight = maxHeight;
		this.tree.layout(Math.min(maxHeight, this.tree.getVisibleElements().length * 34));
	}

	focus(what: QuickPickFocus): void {
		const items = this.tree.getVisibleElements();
		if (!items.length) return;
		const current = items.indexOf(this.tree.focus!);
		const page = Math.max(1, Math.floor(this.maxHeight / 34));
		let index: number;
		switch (what) {
			case QuickPickFocus.First: index = 0; break;
			case QuickPickFocus.Second: index = Math.min(1, items.length - 1); break;
			case QuickPickFocus.Last: index = items.length - 1; break;
			case QuickPickFocus.Next: index = Math.min(current + 1, items.length - 1); break;
			case QuickPickFocus.Previous: index = Math.max(current - 1, 0); break;
			case QuickPickFocus.NextPage: index = Math.min(items.length - 1, current + page); break;
			case QuickPickFocus.PreviousPage: index = Math.max(0, current - page); break;
		}
		if ((what === QuickPickFocus.Next || what === QuickPickFocus.Previous) && current === index) {
			this.leave.fire();
			return;
		}
		this.tree.setFocus(this.id(items[index]));
		this.tree.reveal(this.id(items[index]));
	}

	toggleCheckbox(): void { if (this.tree.focus) this.setChecked(this.tree.focus, this.tree.focus.checked !== true); }
	checkAll(checked: boolean | 'mixed'): void { this.changeChecked(this.items, checked); }

	private setChecked(item: IQuickTreeItem, checked: boolean | 'mixed'): void {
		if (item.pickable === false || item.disabled) return;
		this.changeChecked([item], checked, item);
	}

	private changeChecked(items: readonly IQuickTreeItem[], checked: boolean | 'mixed', source?: IQuickTreeItem): void {
		const previousLeaves = this.getCheckedLeafItems();
		const previous = new Map(this.allItems().map(item => [item, item.checked ?? false]));
		const focused = this.tree.element.contains(this.tree.element.ownerDocument.activeElement);
		const visit = (item: IQuickTreeItem): void => {
			if (item.disabled) return;
			if (item.pickable !== false) item.checked = checked;
			item.children?.forEach(visit);
		};
		items.forEach(visit);
		this.aggregateParents();
		for (const item of this.tree.getVisibleElements()) {
			if (previous.get(item) !== (item.checked ?? false)) this.tree.rerender(this.id(item));
		}
		if (focused) this.tree.domFocus();
		const changed = [...previous].filter(([item, value]) => value !== (item.checked ?? false));
		if (source) {
			if (changed.length) this.checkboxChanged.fire({ item: source, checked: source.checked ?? false });
		} else {
			for (const [item] of changed) this.checkboxChanged.fire({ item, checked: item.checked ?? false });
		}
		const leaves = this.getCheckedLeafItems();
		if (leaves.length !== previousLeaves.length || leaves.some((item, index) => previousLeaves[index] !== item)) this.checkedChanged.fire(leaves);
	}

	private aggregateParents(): void {
		const visit = (item: IQuickTreeItem): void => {
			if (!item.children?.length) return;
			item.children.forEach(visit);
			if (!item.disabled) item.checked = getParentNodeState(item.children.map(element => ({ element })));
		};
		this.items.forEach(visit);
	}

	private allItems(): IQuickTreeItem[] {
		const result: IQuickTreeItem[] = [];
		const visit = (item: IQuickTreeItem): void => {
			result.push(item);
			item.children?.forEach(visit);
		};
		this.items.forEach(visit);
		return result;
	}
}
