import type {
	IContextMenuDelegate,
	IContextMenuProvider,
} from "../../contextmenu.js";
import { addDisposableListener, stopEvent, h } from "../../dom.js";
import type { IAction } from "../../../common/actions.js";
import { Emitter } from "../../../common/event.js";
import { lxiconsLibrary } from "../../../common/lxiconsLibrary.js";
import { ActionViewItem, type ActionViewItemOptions } from "../actionbar/actionViewItems.js";
import { Button } from "../button/button.js";
import { appendIcon } from "../icon/icon.js";

export type DropdownMenuActions =
	| readonly IAction[]
	| (() => readonly IAction[]);

/**
 * ActionBar item that delegates a dropdown action menu to the host provider.
 *
 * The provider owns menu rendering, positioning, native/browser selection, and
 * dismissal. This item owns only its trigger and expanded accessibility state.
 */
export class DropdownMenuActionViewItem extends ActionViewItem {
	private readonly actions: DropdownMenuActions;
	private readonly contextMenuProvider: IContextMenuProvider;
	private readonly _onDidChangeVisibility = this._register(new Emitter<boolean>());
	readonly onDidChangeVisibility = this._onDidChangeVisibility.event;
	private button: Button | undefined;
	private visible = false;

	constructor(
		action: IAction,
		actions: DropdownMenuActions,
		contextMenuProvider: IContextMenuProvider,
		options: ActionViewItemOptions = {},
	) {
		super(action, options);
		this.actions = actions;
		this.contextMenuProvider = contextMenuProvider;
	}

	override render(container: HTMLElement): void {
		if (this.button) {
			throw new Error(`Action view item is already rendered: ${this.action.id}`);
		}
		const button = this.createButton(container, {
			label: this.action.label,
			icon: this.action.icon,
			ariaLabel: this.action.label,
			title: this.action.tooltip,
			enabled: this.action.enabled,
			onClick: () => this.show(),
		});
		this.button = button;
		container.classList.add("ash-dropdown-menu-action-view-item");
		button.domNode.setAttribute("aria-haspopup", "menu");
		button.domNode.setAttribute("aria-expanded", "false");
		const indicator = h(container.ownerDocument, "span");
		indicator.className = "ash-dropdown-menu-indicator";
		appendIcon(lxiconsLibrary.chevronDown, indicator);
		button.domNode.append(indicator);
		this._register(addDisposableListener(button.domNode, "keydown", (event) => {
			if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
			stopEvent(event);
			this.show();
		}));
	}

	override focus(): void {
		this.button?.focus();
	}

	override setTabbable(tabbable: boolean): void {
		if (this.button) this.button.domNode.tabIndex = tabbable ? 0 : -1;
	}

	show(): void {
		const button = this.button;
		if (!button?.enabled || this.visible) return;
		const actions = typeof this.actions === "function"
			? this.actions()
			: this.actions;
		if (actions.length === 0) return;

		this.setVisible(true);
		const options: IContextMenuDelegate = {
			getAnchor: () => button.domNode,
			getActions: () => actions,
			onHide: () => this.setVisible(false),
		};
		try {
			this.contextMenuProvider.showContextMenu(options);
		} catch (error) {
			this.setVisible(false);
			throw error;
		}
	}

	private setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.button?.domNode.setAttribute("aria-expanded", String(visible));
		this._onDidChangeVisibility.fire(visible);
	}
}
