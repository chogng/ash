import { h } from '../../../../base/browser/dom.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Checkbox } from '../../../../base/browser/ui/toggle/toggle.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import Severity from '../../../../base/common/severity.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { defaultButtonStyles, defaultCheckboxStyles, defaultInputBoxStyles } from '../../../theme/browser/defaultStyles.js';
import { QuickInputType, type IQuickTree, type IQuickTreeItem, type QuickPickFocus } from '../../common/quickInput.js';
import { QuickInput, type BrowserQuickInputHostOptions } from '../quickInput.js';
import { QuickInputTreeController } from './quickInputTreeController.js';
import { IOpenerService } from '../../../opener/common/opener.js';
import { IContextMenuService } from '../../../contextview/browser/contextView.js';

export class QuickTree<T extends IQuickTreeItem> extends QuickInput implements IQuickTree<T> {
	readonly type = QuickInputType.QuickTree;
	private readonly controller: QuickInputTreeController;
	private readonly input: InputBox;
	private readonly checkAll: Checkbox;
	private readonly mixedMark: HTMLElement;
	private readonly count: HTMLSpanElement;
	private readonly message: HTMLDivElement;
	private readonly messageLinks = this._register(new DisposableStore());
	private validationValue: string | undefined;
	private severityValue = Severity.Ignore;
	private ariaLabelValue: string | undefined;
	private placeholderValue: string | undefined;
	private readonly empty: HTMLDivElement;
	private readonly accepted = this._register(new Emitter<void>());
	private readonly applyButton: Button;
	readonly onDidAccept = this.accepted.event;
	readonly onDidChangeValue;
	readonly onDidChangeActive;
	readonly onDidChangeCheckedLeafItems;
	readonly onDidChangeCheckboxState;
	readonly onDidTriggerItemButton;

	constructor(
		host: HTMLElement,
		options: BrowserQuickInputHostOptions,
		@IInstantiationService instantiation: IInstantiationService,
		@IOpenerService opener: IOpenerService,
		@IContextMenuService menus: IContextMenuService,
	) {
		super(host, options, opener, menus, 'ash-quick-pick ash-quick-tree');
		const document = host.ownerDocument;
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-label', localize('quickTree.title', 'Quick Tree'));
		this.input = this._register(new InputBox(this.element, {
			inputBoxStyles: defaultInputBoxStyles,
			role: 'combobox',
			ariaAutoComplete: 'list',
			ariaExpanded: true,
			ariaLabel: localize('quickTree.title', 'Quick Tree'),
		}));
		this.input.element.classList.add('ash-quick-pick-input', 'ash-quick-pick-filter');
		this.element.append(this.descriptionElement, this.progress);
		const header = h(document, 'div', { className: 'ash-quick-tree-header' });
		this.checkAll = this._register(new Checkbox(header, {
			...defaultCheckboxStyles,
			label: localize('quickTree.selectAll', 'Select all'),
			onChange: checked => this.controller.checkAll(checked),
		}));
		this.mixedMark = appendIcon(Lxicon.remove, this.checkAll.element);
		this.mixedMark.classList.add('ash-checkbox-checkmark');
		this.count = h(document, 'span');
		this.count.setAttribute('role', 'status');
		header.append(this.count);
		this.element.append(header);
		try {
			this.controller = this._register(instantiation.createInstance(QuickInputTreeController, this.element));
		} catch (error) {
			this.dispose();
			throw error;
		}
		this.input.inputElement.setAttribute('aria-controls', this.controller.tree.element.id);
		this.empty = h(document, 'div', { className: 'ash-quick-pick-empty' });
		this.empty.textContent = localize('quickInput.empty', 'No matching results');
		this.empty.setAttribute('role', 'status');
		this.message = h(document, 'div', { className: 'ash-quick-tree-message' });
		this.message.setAttribute('role', 'alert');
		this.message.hidden = true;
		this.message.dataset.severity = String(this.severityValue);
		const footer = h(document, 'div', { className: 'ash-quick-tree-footer' });
		this.applyButton = this._register(new Button(footer, {
			...defaultButtonStyles,
			label: localize('quickTree.apply', 'Apply'),
			presentation: 'primary',
			onClick: () => this.accept(),
		}));
		this.element.append(this.empty, this.message, footer);
		this.onDidChangeValue = this.input.onDidChange;
		this.onDidChangeActive = this.controller.onDidChangeActive as IQuickTree<T>['onDidChangeActive'];
		this.onDidChangeCheckedLeafItems = this.controller.onDidChangeCheckedLeafItems as IQuickTree<T>['onDidChangeCheckedLeafItems'];
		this.onDidTriggerItemButton = this.controller.onDidTriggerButton as IQuickTree<T>['onDidTriggerItemButton'];
		const changed = this._register(new Emitter<T>());
		this.onDidChangeCheckboxState = changed.event;
		this._register(this.controller.onDidChangeCheckboxState(({ item }) => changed.fire(item as T)));
		this._register(this.controller.onDidChangeCheckedLeafItems(() => this.updateState()));
		this._register(this.controller.onDidAccept(() => this.accept()));
		this._register(this.controller.onLeave(() => this.focusOnInput()));
		this._register(this.controller.renderer.onDidDisposeFocusedElement(() => this.focusOnInput()));
		this._register(this.controller.onDidChangeActiveDescendant(id => { this.input.ariaActiveDescendant = id; }));
		this._register(this.input.onDidChange(value => {
			this.controller.filter(value);
			this.updateState();
		}));
		this.updateState();
		this.updateAriaLabel();
	}

	get value(): string { return this.input.value; }
	set value(value: string) { this.input.value = value; }
	get ariaLabel(): string | undefined { return this.ariaLabelValue; }
	set ariaLabel(value: string | undefined) {
		this.ariaLabelValue = value;
		this.updateAriaLabel();
	}
	private updateAriaLabel(): void {
		const label = this.ariaLabelValue || this.placeholder || localize('quickTree.title', 'Quick Tree');
		this.element.setAttribute('aria-label', label);
		this.input.inputElement.setAttribute('aria-label', label);
		this.controller.tree.element.setAttribute('aria-label', label);
	}
	get placeholder(): string | undefined { return this.placeholderValue; }
	set placeholder(value: string | undefined) {
		this.placeholderValue = value;
		this.input.placeholder = value ?? '';
		this.updateAriaLabel();
	}
	get severity(): Severity { return this.severityValue; }
	set severity(value: Severity) {
		this.severityValue = value;
		this.message.dataset.severity = String(value);
		this.message.setAttribute('role', value === Severity.Error ? 'alert' : 'status');
	}
	get validationMessage(): string | undefined { return this.validationValue; }
	set validationMessage(value: string | undefined) {
		this.validationValue = value;
		this.renderDescription(value, this.message, this.messageLinks);
	}
	get matchOnLabel(): boolean { return this.controller.filterOptions.matchOnLabel; }
	set matchOnLabel(value: boolean) {
		this.controller.updateFilterOptions({ matchOnLabel: value });
		this.updateState();
	}
	get matchOnDescription(): boolean { return this.controller.filterOptions.matchOnDescription; }
	set matchOnDescription(value: boolean) {
		this.controller.updateFilterOptions({ matchOnDescription: value });
		this.updateState();
	}
	get sortByLabel(): boolean { return this.controller.sortByLabel; }
	set sortByLabel(value: boolean) {
		this.controller.sortByLabel = value;
	}
	get activeItems(): readonly T[] { return this.controller.getActiveItems() as readonly T[]; }
	set activeItems(items: readonly T[]) { if (items[0]) this.reveal(items[0]); }
	get itemTree(): readonly T[] { return this.controller.itemTree as readonly T[]; }
	get checkedLeafItems(): readonly T[] { return this.controller.getCheckedLeafItems() as readonly T[]; }
	setItemTree(items: T[]): void {
		this.controller.setTreeData(items);
		this.updateState();
	}
	getParent(item: T): T | undefined { return this.controller.getParent(item) as T | undefined; }
	expand(item: T): void { this.controller.tree.expand(this.nodeId(item)); }
	collapse(item: T): void { this.controller.tree.collapse(this.nodeId(item)); }
	isCollapsed(item: T): boolean { return this.controller.tree.isCollapsed(this.nodeId(item)) ?? false; }
	reveal(item: T): void {
		const id = this.nodeId(item);
		this.controller.tree.expandTo(id);
		this.controller.tree.setFocus(id);
		this.controller.tree.reveal(id);
	}
	private nodeId(item: T): string {
		const visit = (nodes: typeof this.controller.tree.model.rootNodes): string | undefined => {
			for (const node of nodes) {
				if (node.element === item) return node.id;
				const found = visit(node.children);
				if (found) return found;
			}
			return undefined;
		};
		const id = visit(this.controller.tree.model.rootNodes);
		if (!id) throw new RangeError('Unknown Quick Tree item');
		return id;
	}
	focusOnInput(): void { this.input.focus(); }
	focus(what?: QuickPickFocus): void {
		if (what === undefined) this.focusOnInput();
		else {
			this.controller.tree.domFocus();
			this.controller.focus(what);
		}
	}
	toggle(): void { if (this.enabled) this.controller.toggleCheckbox(); }
	accept(_inBackground?: boolean): void { if (this.enabled) this.accepted.fire(); }
	protected override updateEnabled(): void {
		this.input.enabled = this.enabled;
		this.controller.tree.element.inert = !this.enabled;
		this.applyButton.enabled = this.enabled;
		this.updateState();
	}
	protected override layoutContents(availableHeight?: number): void {
		if (!this.visible) return;
		const room = this.host.getBoundingClientRect().bottom - this.element.getBoundingClientRect().top;
		const chrome = [...this.element.children]
			.filter(child => child !== this.controller.tree.domNode)
			.reduce((sum, child) => sum + child.getBoundingClientRect().height, 0);
		this.controller.layout(Math.max(0, Math.min(360, (availableHeight ?? room - 16) - chrome)));
	}
	private updateState(): void {
		const checked = this.checkedLeafItems.length;
		this.count.textContent = localize('quickTree.selectedCount', '{0} selected', checked);
		const selectable = (items: readonly IQuickTreeItem[]): IQuickTreeItem[] => items.flatMap(item => {
			if (item.disabled) return [];
			if (item.children?.length) return selectable(item.children);
			return item.pickable === false ? [] : [item];
		});
		const total = selectable(this.itemTree).length;
		this.checkAll.checked = total > 0 && checked === total;
		this.checkAll.input.indeterminate = checked > 0 && checked < total;
		this.mixedMark.style.visibility = this.checkAll.input.indeterminate ? 'visible' : 'hidden';
		this.checkAll.enabled = this.enabled && total > 0;
		this.empty.hidden = this.controller.tree.getVisibleElements().length > 0;
		this.layout();
	}
}
