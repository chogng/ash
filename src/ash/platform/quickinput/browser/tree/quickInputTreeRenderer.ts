import { addDisposableListener, h, stopEvent } from '../../../../base/browser/dom.js';
import { Checkbox } from '../../../../base/browser/ui/toggle/toggle.js';
import { ToolBar } from '../../../../base/browser/ui/toolbar/toolbar.js';
import { LabelActionViewItem, type LabelActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import type { IAction } from '../../../../base/common/actions.js';
import { IconLabel } from '../../../../base/browser/ui/iconlabel/iconlabel.js';
import type { ITreeNode, ITreeRenderer } from '../../../../base/browser/ui/tree/tree.js';
import type { IListElementRenderDetails } from '../../../../base/browser/ui/list/list.js';
import { appendIcon, getRegisteredIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { stripIcons } from '../../../../base/common/iconLabels.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../contextview/browser/contextView.js';
import { defaultCheckboxStyles } from '../../../theme/browser/defaultStyles.js';
import type { IQuickInputButton, IQuickTreeCheckboxEvent, IQuickTreeItem, IQuickTreeItemButtonEvent } from '../../common/quickInput.js';
import { quickInputButtonsToActionArrays } from '../quickInputUtils.js';
import type { IQuickTreeFilterData } from './quickInputTree.js';

export interface IQuickTreeTemplateData {
	readonly entry: HTMLElement;
	readonly checkbox: Checkbox;
	readonly icon: HTMLElement;
	readonly label: IconLabel;
	readonly actionBar: ToolBar;
	readonly toDisposeElement: DisposableStore;
	readonly toDisposeTemplate: DisposableStore;
}

/** The renderer emits intent; only the controller mutates item checkbox state. */
export class QuickInputCheckboxStateHandler<T extends IQuickTreeItem = IQuickTreeItem> extends Disposable {
	private readonly changed = this._register(new Emitter<IQuickTreeCheckboxEvent<T>>());
	readonly onDidChangeCheckboxState = this.changed.event;
	setCheckboxState(item: T, checked: boolean | 'mixed'): void { this.changed.fire({ item, checked }); }
}

export class QuickInputTreeRenderer<T extends IQuickTreeItem = IQuickTreeItem> extends Disposable implements ITreeRenderer<T, IQuickTreeFilterData, IQuickTreeTemplateData> {
	static readonly ID = 'quickInputTreeElement';
	readonly templateId = QuickInputTreeRenderer.ID;
	private readonly bindings = new WeakMap<IQuickTreeTemplateData, T>();
	private readonly focusedElementDisposed = this._register(new Emitter<void>());
	readonly onDidDisposeFocusedElement = this.focusedElementDisposed.event;
	private readonly triggered = this._register(new Emitter<IQuickTreeItemButtonEvent<T>>());
	readonly onDidTriggerItemButton = this.triggered.event;

	constructor(
		private readonly checkboxState: QuickInputCheckboxStateHandler<T>,
		@IContextMenuService private readonly menus: IContextMenuService,
	) { super(); }

	renderTemplate(container: HTMLElement): IQuickTreeTemplateData {
		const toDisposeTemplate = new DisposableStore();
		const toDisposeElement = new DisposableStore();
		const entry = h(container.ownerDocument, 'span', { className: 'ash-quick-tree-row' });
		container.append(entry);
		let data: IQuickTreeTemplateData;
		const checkbox = toDisposeTemplate.add(new Checkbox(entry, {
			...defaultCheckboxStyles,
			onChange: checked => {
				const item = this.bindings.get(data);
				if (item) this.checkboxState.setCheckboxState(item, checked);
			},
		}));
		checkbox.input.tabIndex = -1;
		checkbox.element.setAttribute('aria-hidden', 'true');
		const mixed = appendIcon(Lxicon.remove, checkbox.element);
		mixed.classList.add('ash-checkbox-checkmark', 'ash-quick-tree-mixed-mark');
		toDisposeTemplate.add(addDisposableListener(checkbox.element, 'click', event => event.stopPropagation()));
		const icon = h(container.ownerDocument, 'span');
		icon.setAttribute('aria-hidden', 'true');
		entry.append(icon);
		const label = toDisposeTemplate.add(new IconLabel(entry, { label: '', supportIcons: true }));
		label.element.classList.add('ash-quick-tree-text');
		const actionBar = toDisposeTemplate.add(new ToolBar(entry, {
			contextMenuProvider: this.menus,
			actionViewItemProvider: action => {
				const button = this.bindings.get(data)?.buttons?.[Number(action.id.split('-').at(-1))];
				if (!button) return undefined;
				const iconId = button.iconClass?.split(/\s+/).find(name => name.startsWith('ash-icon-'))?.slice(9);
				return new QuickTreeButtonActionViewItem(action, button, {
					icon: iconId ? getRegisteredIcon(iconId, container.ownerDocument) : undefined,
					label: button.iconClass || button.iconPath ? '' : action.label,
					ariaLabel: action.label || action.tooltip,
				});
			},
		}));
		toDisposeTemplate.add(addDisposableListener(actionBar.element, 'click', stopEvent));
		data = { entry, checkbox, icon, label, actionBar, toDisposeElement, toDisposeTemplate };
		return data;
	}

	renderElement(node: ITreeNode<T, IQuickTreeFilterData>, _index: number, data: IQuickTreeTemplateData, _details?: IListElementRenderDetails): void {
		const item = node.element;
		const document = data.entry.ownerDocument;
		this.bindings.set(data, item);
		data.checkbox.element.hidden = item.pickable === false;
		data.checkbox.checked = item.checked === true;
		data.checkbox.enabled = !item.disabled;
		data.checkbox.input.indeterminate = item.checked === 'mixed';
		data.checkbox.input.setAttribute('aria-label', stripIcons(item.label));
		const mixed = data.checkbox.element.querySelector<HTMLElement>('.ash-quick-tree-mixed-mark')!;
		mixed.style.visibility = item.checked === 'mixed' ? 'visible' : 'hidden';
		const mark = data.checkbox.element.querySelector<HTMLElement>('.ash-checkbox-checkmark')!;
		mark.style.visibility = item.checked === 'mixed' ? 'hidden' : '';
		data.icon.replaceChildren();
		data.icon.className = '';
		data.icon.hidden = !item.iconClass && !item.iconClasses?.length;
		if (item.iconClass) {
			const id = item.iconClass.split(/\s+/).find(name => name.startsWith('ash-icon-'))?.slice(9);
			const icon = id && getRegisteredIcon(id, document);
			if (icon) appendIcon(icon, data.icon);
		} else if (item.iconClasses?.length) {
			data.icon.classList.add('ash-themed-file-icon', ...item.iconClasses);
		}
		data.label.setLabel(item.label, item.description, {
			title: item.tooltip ?? [stripIcons(item.label), item.description, item.detail].filter(Boolean).join('\n'),
			matches: node.filterData?.labelHighlights,
			descriptionMatches: node.filterData?.descriptionHighlights,
		});
		data.actionBar.element.setAttribute('aria-label', localize('quickInput.itemActions', 'Actions for {0}', stripIcons(item.label)));
		const actions = quickInputButtonsToActionArrays(item.buttons ?? [], 'quickTree', button => this.triggered.fire({ item, button }));
		data.actionBar.setActions(actions.primary, actions.secondary);
		data.actionBar.element.hidden = !item.buttons?.length;
		data.toDisposeElement.add(toDisposable(() => data.actionBar.setActions([], [])));
	}

	disposeElement(_node: ITreeNode<T, IQuickTreeFilterData>, _index: number, data: IQuickTreeTemplateData, _details?: IListElementRenderDetails): void {
		if (!this.isDisposed && data.entry.contains(data.entry.ownerDocument.activeElement)) this.focusedElementDisposed.fire();
		this.bindings.delete(data);
		data.toDisposeElement.clear();
		data.label.setLabel('');
	}
	disposeTemplate(data: IQuickTreeTemplateData): void {
		this.bindings.delete(data);
		data.toDisposeElement.dispose();
		data.toDisposeTemplate.dispose();
		data.entry.remove();
	}
}

class QuickTreeButtonActionViewItem extends LabelActionViewItem {
	constructor(action: IAction, private readonly descriptor: IQuickInputButton, options: LabelActionViewItemOptions) { super(action, options); }

	override render(container: HTMLElement): void {
		super.render(container);
		const path = this.descriptor.iconPath;
		if (!path) return;
		const button = container.querySelector<HTMLButtonElement>('button')!;
		for (const [theme, uri] of [['dark', path.dark], ['light', path.light ?? path.dark]] as const) {
			const image = h(container.ownerDocument, 'img');
			image.className = `ash-quick-input-button-image-${theme}`;
			image.src = uri.toString();
			image.alt = '';
			button.prepend(image);
		}
	}
}
