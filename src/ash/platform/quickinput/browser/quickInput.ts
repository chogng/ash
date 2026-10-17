import { defaultInputBoxStyles } from '../../theme/browser/defaultStyles.js';
import { addDisposableListener, stopEvent, h, isHTMLElement } from "../../../base/browser/dom.js";
import { TabList } from '../../../base/browser/ui/tablist/tabList.js';
import { getViewport } from '../../../base/browser/geometry.js';
import { AnchorPosition, layout2d } from '../../../base/common/layout.js';
import {
	setAriaAttribute,
	setRole,
} from "../../../base/browser/ui/aria/aria.js";
import {
	InputBox,
	type InputSelection,
} from "../../../base/browser/ui/inputbox/inputbox.js";
import { Emitter, type Event } from "../../../base/common/event.js";
import { Disposable, MutableDisposable, toDisposable } from "../../../base/common/lifecycle.js";
import type {
	IQuickPick,
	IQuickPickItem,
	IQuickPickItemButton,
	IQuickPickSeparator,
	IQuickInputNavigation,
	IKeyMods,
	IQuickInput,
	IQuickPickDidAcceptEvent,
} from "../common/quickInput.js";
import { QuickInputList } from "./quickInputList.js";
import { QuickInputType, QuickPickFocus } from '../common/quickInput.js';
import { localize } from '../../../nls.js';
import { RawContextKey } from '../../contextkey/common/contextkey.js';

export const inQuickInputContext = new RawContextKey<boolean>('inQuickInput', false);
export const quickInputTypeContextKey = new RawContextKey<string>('quickInputType', '');
export const endOfQuickInputBoxContext = new RawContextKey<boolean>('cursorAtEndOfQuickInputBox', false);
export const quickInputFocusContext = new RawContextKey<boolean>('quickInputFocus', false);

export interface BrowserQuickInputHostOptions {
	readonly onShow: (quickInput: IBrowserQuickInputHost) => void;
	readonly onHide: (quickInput: IBrowserQuickInputHost) => void;
	readonly onDispose: (quickInput: IBrowserQuickInputHost) => void;
}

/** Narrow controller used by the shared Workbench host. */
export interface IBrowserQuickInputHost extends IQuickInput {
	readonly element: HTMLDivElement;
	focus(): void;
	hide(): void;
	dispose(): void;
}

/** DOM implementation of one searchable Quick Pick controller. */
export class QuickPick<TItem extends IQuickPickItem>
	extends Disposable
	implements IQuickPick<TItem>, IBrowserQuickInputHost {
	readonly element: HTMLDivElement;
	public readonly type = QuickInputType.QuickPick;
	public anchor?: unknown;
	public anchorPosition?: 'above' | 'below';
	private readonly inputBox: InputBox;
	private readonly list: QuickInputList<TItem>;
	private readonly progress: HTMLDivElement;
	private readonly navigationHost: HTMLDivElement;
	private readonly navigationTabs = this._register(new MutableDisposable<TabList<string>>());
	private navigationValue: IQuickInputNavigation | undefined;
	public get navigation(): IQuickInputNavigation | undefined { return this.navigationValue; }
	public set navigation(value: IQuickInputNavigation | undefined) {
		this.navigationValue = value;
		this.navigationHost.hidden = !value;
		if (!value) {
			this.navigationTabs.clear();
			this.list.element.removeAttribute('role');
			this.list.element.removeAttribute('aria-labelledby');
		} else {
			if (!this.navigationTabs.value) {
				this.navigationTabs.value = new TabList(this.navigationHost, {
					ariaLabel: localize('quickInput.searchModes', 'Search modes'),
					presentation: 'inset',
					onActivate: id => this.navigationValue?.onSelect(id),
				});
				this.navigationTabs.value.setSizing({ mode: 'fixed', minWidth: 0, maxWidth: 600 });
			}
			const tabs = value.items.map(item => ({
				...item, value: item.id,
				tabId: `${this.list.listId}-tab-${encodeURIComponent(item.id)}`,
				panelId: this.list.element.id,
			}));
			this.navigationTabs.value.setTabs(tabs, value.selectedId);
			this.list.element.setAttribute('role', 'tabpanel');
			const selected = tabs.find(tab => tab.id === value.selectedId);
			if (selected) { this.list.element.setAttribute('aria-labelledby', selected.tabId); }
			else { this.list.element.removeAttribute('aria-labelledby'); }
		}
		if (this.visible) this.layout();
	}
	public canAcceptInBackground = false;
	private _busy = false;
	public get keyMods() { return this.list.keyMods; }
	public set keyMods(value: IKeyMods) { this.list.keyMods = value; }
	public get busy(): boolean { return this._busy; }
	public set busy(value: boolean) {
		this._busy = value;
		this.progress.hidden = !value;
		this.element.classList.toggle('busy', value);
		this.element.setAttribute('aria-busy', String(value));
		if (this.visible) this.layout();
	}
	private readonly _onDidAccept = this._register(new Emitter<IQuickPickDidAcceptEvent>());
	private acceptingInBackground = false;
	private readonly _onDidChangeValue = this._register(new Emitter<string>());
	private readonly _onDidHide = this._register(new Emitter<void>());
	private readonly _onDidBlur = this._register(new Emitter<void>());
	private readonly _onDidTriggerItemButton = this._register(new Emitter<{ readonly item: TItem; readonly button: IQuickPickItemButton; }>());
	private readonly options: BrowserQuickInputHostOptions;
	private visible = false;
	private _ariaLabel = localize('quickInput.title', 'Quick Pick');
	private _placeholder = "";
	private _filterValue = (value: string): string => value;

	readonly onDidAccept: Event<IQuickPickDidAcceptEvent> = this._onDidAccept.event;
	public get activeItems(): readonly TItem[] { return this.list.activeItem ? [this.list.activeItem] : []; }
	public set activeItems(items: readonly TItem[]) { if (items[0]) this.list.setActiveItem(items[0]); }
	readonly onDidChangeValue: Event<string> =
		this._onDidChangeValue.event;
	readonly onDidHide: Event<void> = this._onDidHide.event;
	readonly onDidBlur: Event<void> = this._onDidBlur.event;
	readonly onDidTriggerItemButton = this._onDidTriggerItemButton.event;
	public get canSelectMany(): boolean { return this.list.canSelectMany; }
	public set canSelectMany(value: boolean) { this.list.canSelectMany = value; }
	public get selectedItems(): readonly TItem[] { return this.list.selectedItems; }
	public set selectedItems(items: readonly TItem[]) { this.list.selectedItems = items; }
	public get onDidChangeSelection(): Event<readonly TItem[]> { return this.list.onDidChangeSelection; }

	constructor(private readonly host: HTMLElement, options: BrowserQuickInputHostOptions) {
		super();
		this.options = options;
		const ownerDocument = host.ownerDocument;
		this.element = h(ownerDocument, "div");
		this.element.className = "ash-quick-pick";
		setRole(this.element, "dialog");
		setAriaAttribute(this.element, "label", this._ariaLabel);
		this.list = this._register(new QuickInputList<TItem>(this.element));
		this.list.element.id = `${this.list.listId}-panel`;
		this.inputBox = this._register(new InputBox(this.element, {
			inputBoxStyles: defaultInputBoxStyles,
			type: "search",
			ariaLabel: localize('quickInput.title', 'Quick Pick'),
			role: "combobox",
			ariaAutoComplete: "list",
			ariaControls: this.list.listId,
			ariaExpanded: true,
		}));
		this.inputBox.element.classList.add("ash-quick-pick-input");
		this.navigationHost = h(ownerDocument, 'div');
		this.navigationHost.className = 'ash-quick-pick-navigation';
		this.navigationHost.hidden = true;
		this._register(addDisposableListener(this.navigationHost, 'keydown', event => {
			if (event.key === 'ArrowDown') {
				stopEvent(event);
				this.inputBox.focus();
			}
		}));
		this.progress = h(ownerDocument, 'div');
		this.progress.className = 'ash-quick-pick-progress';
		this.progress.setAttribute('role', 'status');
		this.progress.textContent = localize('quickInput.searching', 'Searching…');
		this.progress.hidden = true;
		this.element.append(
			this.inputBox.element,
			this.navigationHost,
			this.progress,
			this.list.element,
		);

		this._register(this.inputBox.onDidChange(
			(value) => this.handleValueChange(value),
		));
		this._register(this.inputBox.onDidBlur(() => {
			queueMicrotask(() => {
				if (this.visible && !this.element.contains(this.element.ownerDocument.activeElement)) {
					this._onDidBlur.fire();
				}
			});
		}));
		this._register(this.list.onDidAccept((item) => {
			if (!this.canSelectMany) this.list.selectedItems = [item];
			this._onDidAccept.fire({ inBackground: this.acceptingInBackground || this.canAcceptInBackground && this.keyMods.ctrlCmd });
		}));
		this._register(this.list.onDidChangeActive(({ rowId }) => {
			this.inputBox.ariaActiveDescendant = rowId;
		}));
		this._register(this.list.onDidTriggerItemButton(event => this._onDidTriggerItemButton.fire(event)));
		this._register(toDisposable(() => {
			if (this.visible) this.hide();
			options.onDispose(this);
			this.element.remove();
		}));
	}

	get items(): readonly (TItem | IQuickPickSeparator)[] {
		return this.list.items;
	}

	public get sortByLabel(): boolean { return this.list.sortByLabel; }
	public set sortByLabel(value: boolean) { this.list.sortByLabel = value; }

	get ariaLabel(): string {
		return this._ariaLabel;
	}

	set ariaLabel(value: string) {
		this._ariaLabel = value;
		setAriaAttribute(this.element, "label", value);
		setAriaAttribute(this.inputBox.inputElement, "label", value);
	}

	set items(items: readonly (TItem | IQuickPickSeparator)[]) {
		this.list.items = items;
		if (this.visible) this.layout();
	}

	get placeholder(): string {
		return this._placeholder;
	}

	set placeholder(value: string) {
		this._placeholder = value;
		this.inputBox.placeholder = value;
	}

	get value(): string {
		return this.inputBox.value;
	}

	set value(value: string) {
		this.inputBox.value = value;
	}

	get valueSelection(): InputSelection {
		return {
			start: this.inputBox.inputElement.selectionStart ?? 0,
			end: this.inputBox.inputElement.selectionEnd ?? 0,
		};
	}

	set valueSelection(value: InputSelection) {
		this.inputBox.select(value);
	}

	get filterValue(): (value: string) => string {
		return this._filterValue;
	}

	set filterValue(value: (value: string) => string) {
		this._filterValue = value;
		this.list.filter(value(this.inputBox.value));
	}

	show(): void {
		if (this.visible) {
			this.focus();
			return;
		}
		this.visible = true;
		this.options.onShow(this);
		this.layout();
		this.focus();
	}

	layout(): void {
		const ownerWindow = this.element.ownerDocument.defaultView!;
		if (isHTMLElement(this.anchor)) {
			if (!this.anchor.isConnected) { this.hide(); return; }
			const viewport = getViewport(ownerWindow);
			const margin = 8;
			const gap = 4;
			const bounds = {
				left: viewport.left + margin, top: viewport.top + margin,
				width: Math.max(0, viewport.width - margin * 2), height: Math.max(0, viewport.height - margin * 2),
			};
			const anchor = this.anchor.getBoundingClientRect();
			this.element.style.width = `${Math.min(380, bounds.width)}px`;
			const style = ownerWindow.getComputedStyle(this.element);
			const listStyle = ownerWindow.getComputedStyle(this.list.element);
			const reservedHeight = this.inputBox.element.getBoundingClientRect().height
				+ this.navigationHost.getBoundingClientRect().height
				+ (this.busy ? this.progress.getBoundingClientRect().height : 0)
				+ Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth)
				+ Number.parseFloat(listStyle.paddingTop) + Number.parseFloat(listStyle.paddingBottom);
			// Size the list before placing the surface so a short search stays next to its button.
			const roomAbove = anchor.top - bounds.top - gap;
			const roomBelow = bounds.top + bounds.height - anchor.bottom - gap;
			const availableHeight = Math.max(0, roomAbove, roomBelow);
			this.list.layout(Math.max(0, Math.min(360, availableHeight) - reservedHeight));
			const picker = this.element.getBoundingClientRect();
			const position = layout2d(bounds, picker, anchor, {
				anchorPosition: this.anchorPosition === 'below' ? AnchorPosition.Below : AnchorPosition.Above,
				gap,
			});
			this.element.style.left = `${position.left}px`;
			this.element.style.top = `${position.top}px`;
			return;
		}
		const hostBounds = this.host.getBoundingClientRect();
		const pickerBounds = this.element.getBoundingClientRect();
		const inputHeight = this.inputBox.element.getBoundingClientRect().height;
		const pickerStyle = ownerWindow.getComputedStyle(this.element);
		const maxPickerHeight = Number.parseFloat(pickerStyle.maxHeight);
		if (!Number.isFinite(maxPickerHeight) || hostBounds.height === 0) return;
		const hostStyle = ownerWindow.getComputedStyle(this.host);
		const listStyle = ownerWindow.getComputedStyle(this.list.element);
		const roomBelow = hostBounds.bottom - pickerBounds.top - Number.parseFloat(hostStyle.paddingBottom);
		const reservedHeight = inputHeight
			+ this.navigationHost.getBoundingClientRect().height
			+ (this.busy ? this.progress.getBoundingClientRect().height : 0)
			+ Number.parseFloat(pickerStyle.borderTopWidth)
			+ Number.parseFloat(pickerStyle.borderBottomWidth)
			+ Number.parseFloat(listStyle.paddingTop)
			+ Number.parseFloat(listStyle.paddingBottom);
		const availableHeight = Math.min(maxPickerHeight, roomBelow) - reservedHeight;
		// Keep results proportional to the host while leaving room for the editor below.
		this.list.layout(Math.max(0, Math.min(hostBounds.height * 0.4, availableHeight)));
	}

	hide(): void {
		if (!this.visible) return;
		this.visible = false;
		this.options.onHide(this);
		this._onDidHide.fire();
	}

	focus(what?: QuickPickFocus): void {
		if (what !== undefined) this.list.focus(what);
		else {
			this.inputBox.focus();
			this.inputBox.select();
		}
	}

	public accept(inBackground = false): void {
		if (inBackground && !this.canAcceptInBackground) return;
		this.acceptingInBackground = inBackground || this.canAcceptInBackground && this.keyMods.ctrlCmd;
		try { this.list.acceptActive(); }
		finally { this.acceptingInBackground = false; }
	}

	public toggle(): void {
		if (this.canSelectMany) this.list.toggleActive();
	}

	private handleValueChange(value: string): void {
		this.list.filter(this._filterValue(value));
		if (this.visible) this.layout();
		this._onDidChangeValue.fire(value);
	}

}
