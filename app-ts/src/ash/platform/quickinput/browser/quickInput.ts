import { stopEvent, h } from "../../../base/browser/dom.js";
import {
	setAriaAttribute,
	setRole,
} from "../../../base/browser/ui/aria/aria.js";
import {
	InputBox,
} from "../../../base/browser/ui/inputbox/inputbox.js";
import { Emitter, type Event } from "../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../base/common/lifecycle.js";
import type {
	IQuickPick,
	IQuickPickItem,
} from "../common/quickInput.js";
import { QuickInputList } from "./quickInputList.js";
import { localize } from '../../../nls.js';

export interface BrowserQuickPickOptions {
	readonly onShow: (quickPick: IBrowserQuickPickHost) => void;
	readonly onHide: (quickPick: IBrowserQuickPickHost) => void;
	readonly onDispose: (quickPick: IBrowserQuickPickHost) => void;
}

/** Narrow controller used by the shared Workbench host. */
export interface IBrowserQuickPickHost {
	readonly element: HTMLDivElement;
	focus(): void;
	hide(): void;
	dispose(): void;
}

/** DOM implementation of one searchable Quick Pick controller. */
export class QuickPick<TItem extends IQuickPickItem>
	extends Disposable
	implements IQuickPick<TItem> {
	readonly element: HTMLDivElement;
	private readonly inputBox: InputBox;
	private readonly list: QuickInputList<TItem>;
	private readonly _onDidAccept = this._register(new Emitter<TItem>());
	private readonly _onDidChangeValue = this._register(new Emitter<string>());
	private readonly _onDidHide = this._register(new Emitter<void>());
	private readonly _onDidBlur = this._register(new Emitter<void>());
	private readonly options: BrowserQuickPickOptions;
	private visible = false;
	private _ariaLabel = localize('quickInput.title', 'Quick Pick');
	private _placeholder = "";
	private _filterValue = (value: string): string => value;

	readonly onDidAccept: Event<TItem> = this._onDidAccept.event;
	readonly onDidChangeValue: Event<string> =
		this._onDidChangeValue.event;
	readonly onDidHide: Event<void> = this._onDidHide.event;
	readonly onDidBlur: Event<void> = this._onDidBlur.event;

	constructor(host: HTMLElement, options: BrowserQuickPickOptions) {
		super();
		this.options = options;
		const ownerDocument = host.ownerDocument;
		this.element = h(ownerDocument, "div");
		this.element.className = "ash-quick-pick";
		setRole(this.element, "dialog");
		setAriaAttribute(this.element, "label", this._ariaLabel);
		this.list = this._register(new QuickInputList<TItem>(this.element));
		this.inputBox = this._register(new InputBox(this.element, {
			type: "search",
			ariaLabel: localize('quickInput.title', 'Quick Pick'),
			role: "combobox",
			ariaAutoComplete: "list",
			ariaControls: this.list.listId,
			ariaExpanded: true,
		}));
		this.inputBox.element.classList.add("ash-quick-pick-input");
		this.element.append(
			this.inputBox.element,
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
			this._onDidAccept.fire(item);
		}));
		this._register(this.list.onDidChangeActive(({ rowId }) => {
			this.inputBox.ariaActiveDescendant = rowId;
		}));
		this._register(this.inputBox.onKeyDown(
			(event: KeyboardEvent) => this.handleKeyDown(event),
		));
		this._register(toDisposable(() => {
			if (this.visible) this.hide();
			options.onDispose(this);
			this.element.remove();
		}));
	}

	get items(): readonly TItem[] {
		return this.list.items;
	}

	get ariaLabel(): string {
		return this._ariaLabel;
	}

	set ariaLabel(value: string) {
		this._ariaLabel = value;
		setAriaAttribute(this.element, "label", value);
		setAriaAttribute(this.inputBox.inputElement, "label", value);
	}

	set items(items: readonly TItem[]) {
		this.list.items = items;
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
		this.focus();
	}

	hide(): void {
		if (!this.visible) return;
		this.visible = false;
		this.options.onHide(this);
		this._onDidHide.fire();
	}

	focus(): void {
		this.inputBox.focus();
		this.inputBox.select();
	}

	private handleValueChange(value: string): void {
		this.list.filter(this._filterValue(value));
		this._onDidChangeValue.fire(value);
	}

	private handleKeyDown(event: KeyboardEvent): void {
		switch (event.key) {
			case "ArrowDown":
				stopEvent(event);
				this.list.focusNext();
				break;
			case "ArrowUp":
				stopEvent(event);
				this.list.focusPrevious();
				break;
			case "Enter":
				stopEvent(event);
				this.list.acceptActive();
				break;
			case "Escape":
				stopEvent(event);
				this.hide();
				break;
		}
	}

}
