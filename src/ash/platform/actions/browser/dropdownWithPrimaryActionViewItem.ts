import type { IContextMenuProvider } from "../../../base/browser/contextmenu.js";
import { addDisposableListener, stopEvent, h } from "../../../base/browser/dom.js";
import { ActionViewItem, ButtonActionViewItem, type ActionViewItemOptions } from "../../../base/browser/ui/actionbar/actionViewItems.js";
import { DropdownMenuActionViewItem, type DropdownMenuActions } from "../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js";
import type { IAction } from "../../../base/common/actions.js";
import { Emitter } from "../../../base/common/event.js";
import { DisposableStore, MutableDisposable } from "../../../base/common/lifecycle.js";
import { assertDefined } from "../../../base/common/types.js";

export type IDropdownWithPrimaryActionViewItemOptions = ActionViewItemOptions;

/**
 * Presents one primary action and its related menu as a single split action.
 *
 * The primary trigger runs the supplied action. The compact dropdown trigger
 * opens the related menu, and left/right navigation moves between both parts
 * before the containing ActionBar resumes navigation between items.
 */
export class DropdownWithPrimaryActionViewItem extends ActionViewItem {
	private readonly primaryItem: ButtonActionViewItem;
	private readonly dropdownItem = this._register(new MutableDisposable<DropdownMenuActionViewItem>());
	private readonly dropdownVisibilityListener = this._register(new MutableDisposable());
	private readonly dropdownRenderStore = this._register(new MutableDisposable<DisposableStore>());
	private readonly changeDropdownVisibilityEmitter = this._register(new Emitter<boolean>());
	readonly onDidChangeDropdownVisibility = this.changeDropdownVisibilityEmitter.event;
	private readonly contextMenuProvider: IContextMenuProvider;
	private readonly viewItemOptions: ActionViewItemOptions;
	private primaryButton: HTMLButtonElement | undefined;
	private dropdownButton: HTMLButtonElement | undefined;
	private dropdownContainer: HTMLElement | undefined;
	private dropdownVisible = false;

	constructor(
		primaryAction: IAction,
		dropdownAction: IAction,
		dropdownActions: DropdownMenuActions,
		contextMenuProvider: IContextMenuProvider,
		options: IDropdownWithPrimaryActionViewItemOptions = {},
	) {
		super(primaryAction, options);
		this.contextMenuProvider = contextMenuProvider;
		this.viewItemOptions = options;
		this.primaryItem = this._register(new ButtonActionViewItem(primaryAction, options));
		this.setDropdownItem(dropdownAction, dropdownActions);
	}

	override render(container: HTMLElement): void {
		if (this.primaryButton || this.dropdownButton) {
			throw new Error(`Action view item is already rendered: ${this.action.id}`);
		}
		container.classList.add("ash-dropdown-with-primary-action-view-item");
		container.classList.toggle("disabled", !this.action.enabled);

		const primaryContainer = h(container.ownerDocument, "div");
		primaryContainer.className = "ash-dropdown-with-primary-primary";
		primaryContainer.classList.toggle("icon", this.action.icon !== undefined);
		this.primaryItem.render(primaryContainer);

		const dropdownContainer = h(container.ownerDocument, "div");
		dropdownContainer.className = "ash-dropdown-with-primary-dropdown";
		this.dropdownContainer = dropdownContainer;
		this.renderDropdownItem();

		const primaryButton = primaryContainer.querySelector<HTMLButtonElement>("button");
		assertDefined(primaryButton, `Primary action button was not rendered: ${this.action.id}`);
		this.primaryButton = primaryButton;
		container.append(primaryContainer, dropdownContainer);
		this._register(this.onDidChangeDropdownVisibility((visible) => {
			container.classList.toggle("active", visible);
		}));

		this._register(addDisposableListener(primaryButton, "keydown", (event) => {
			const dropdownButton = this.dropdownButton;
			if (event.key !== "ArrowRight" || !dropdownButton || dropdownButton.disabled) return;
			stopEvent(event);
			primaryButton.tabIndex = -1;
			dropdownButton.tabIndex = 0;
			dropdownButton.focus();
		}));
	}

	override focus(fromRight = false): void {
		if (fromRight) {
			this.dropdownItem.value?.focus();
			return;
		}
		this.primaryButton?.focus();
	}

	blur(): void {
		this.primaryButton?.blur();
		this.dropdownButton?.blur();
	}

	override setTabbable(tabbable: boolean): void {
		this.primaryItem.setTabbable(tabbable);
		this.dropdownItem.value?.setTabbable(false);
	}

	setFocusable(focusable: boolean): void {
		this.setTabbable(focusable);
	}

	update(dropdownAction: IAction, dropdownActions: DropdownMenuActions): void {
		this.setDropdownItem(dropdownAction, dropdownActions);
		if (this.dropdownContainer) this.renderDropdownItem();
	}

	showDropdown(): void {
		this.dropdownItem.value?.show();
	}

	private setDropdownItem(dropdownAction: IAction, dropdownActions: DropdownMenuActions): void {
		if (this.dropdownVisible) {
			this.dropdownVisible = false;
			this.changeDropdownVisibilityEmitter.fire(false);
		}
		this.dropdownVisibilityListener.clear();
		const item = new DropdownMenuActionViewItem(
			dropdownAction,
			dropdownActions,
			this.contextMenuProvider,
			this.viewItemOptions,
		);
		this.dropdownItem.value = item;
		this.dropdownVisibilityListener.value = item.onDidChangeVisibility((visible) => {
			this.dropdownVisible = visible;
			this.changeDropdownVisibilityEmitter.fire(visible);
		});
	}

	private renderDropdownItem(): void {
		const container = this.dropdownContainer;
		const item = this.dropdownItem.value;
		assertDefined(container, `Dropdown container is not rendered: ${this.action.id}`);
		assertDefined(item, `Dropdown action view item is not available: ${this.action.id}`);
		container.replaceChildren();
		item.render(container);
		const dropdownButton = container.querySelector<HTMLButtonElement>("button");
		assertDefined(dropdownButton, `Dropdown action button was not rendered: ${this.action.id}`);
		this.dropdownButton = dropdownButton;
		dropdownButton.setAttribute("aria-label", dropdownActionLabel(item.action));
		item.setTabbable(false);

		const renderStore = new DisposableStore();
		renderStore.add(addDisposableListener(dropdownButton, "keydown", (event) => {
			const primaryButton = this.primaryButton;
			if (event.key !== "ArrowLeft" || !primaryButton || primaryButton.disabled) return;
			stopEvent(event);
			dropdownButton.tabIndex = -1;
			primaryButton.tabIndex = 0;
			primaryButton.focus();
		}));
		this.dropdownRenderStore.value = renderStore;
	}
}

function dropdownActionLabel(action: IAction): string {
	return action.label || action.tooltip;
}
