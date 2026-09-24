import { Separator, type IAction } from "../../../common/actions.js";
import type { Icon } from "../../../common/icon.js";
import { Disposable, toDisposable } from "../../../common/lifecycle.js";
import { assertDefined } from "../../../common/types.js";
import { addDisposableListener, h } from "../../dom.js";
import { setAriaAttribute } from "../aria/aria.js";
import { Button, type ButtonOptions } from "../button/button.js";
import type { AnchorPosition } from "../contextview/contextview.js";
import { getHoverDelegate, type IManagedHover } from "../hover/hoverDelegate.js";
import { appendIcon } from "../icon/icon.js";

const ActionHoverGroupId = "actions";

/** Presentation options shared by every ActionBar item representation. */
export interface ActionViewItemOptions {
	/** Allows the host ActionBar to expose this item as a native drag source. */
	readonly draggable?: boolean;
	/** Places the item's managed tooltip relative to its trigger. */
	readonly hoverAnchorPosition?: AnchorPosition;
}

/**
 * Browser representation of one action inside an ActionBar.
 *
 * Implementations render into the container owned by their host and own the
 * resources they create for that representation.
 */
export abstract class ActionViewItem extends Disposable {
	protected constructor(
		readonly action: IAction,
		private readonly actionViewItemOptions: ActionViewItemOptions = {},
	) {
		super();
	}

	get draggable(): boolean {
		return this.actionViewItemOptions.draggable === true;
	}

	abstract render(container: HTMLElement): void;

	/** Controls whether this item is the ActionBar's page-level Tab stop. */
	abstract setTabbable(tabbable: boolean): void;

	focus(): void {}

	/** Creates a Button using the shared delay group for adjacent actions. */
	protected createButton(container: HTMLElement, options: ButtonOptions): Button {
		return this._register(new Button(container, {
			...options,
			hoverGroupId: options.hoverGroupId ?? ActionHoverGroupId,
			hoverAnchorPosition: options.hoverAnchorPosition ?? this.actionViewItemOptions.hoverAnchorPosition,
		}));
	}

	/** Installs an action tooltip for view items that render a custom target. */
	protected setupHover(target: HTMLElement, content: string): IManagedHover {
		return this._register(getHoverDelegate().setupHover({
			target,
			content,
			groupId: ActionHoverGroupId,
			anchorPosition: this.actionViewItemOptions.hoverAnchorPosition,
		}));
	}
}

/** Default button representation for a runnable action. */
export class ButtonActionViewItem extends ActionViewItem {
	private _button: Button | undefined;

	constructor(action: IAction, options: ActionViewItemOptions = {}) {
		super(action, options);
	}

	override render(container: HTMLElement): void {
		if (this._button) {
			throw new Error(`Action view item is already rendered: ${this.action.id}`);
		}
		this._button = this.createButton(container, {
			label: this.action.label,
			icon: this.action.icon,
			ariaLabel: this.action.label,
			title: this.action.tooltip,
			enabled: this.action.enabled,
			checked: this.action.checked,
			onClick: () => this.runAction(),
		});
	}

	override focus(): void {
		this.button.focus();
	}

	override setTabbable(tabbable: boolean): void {
		this.button.domNode.tabIndex = tabbable ? 0 : -1;
	}

	protected get button(): Button {
		assertDefined(this._button, `Action view item is not rendered: ${this.action.id}`);
		return this._button;
	}

	protected runAction(): unknown {
		return this.action.run();
	}
}

export interface LabelActionViewItemOptions extends ActionViewItemOptions {
	readonly label?: string;
	readonly icon?: Icon;
	readonly ariaLabel?: string;
	readonly tooltip?: string;
}

/** Compact icon-and-text representation owned by an ActionBar. */
export class LabelActionViewItem extends ActionViewItem {
	private button: HTMLButtonElement | undefined;

	constructor(action: IAction, private readonly options: LabelActionViewItemOptions = {}) {
		super(action, options);
	}

	override render(container: HTMLElement): void {
		if (this.button) {
			throw new Error(`Action view item is already rendered: ${this.action.id}`);
		}
		const button = h(container.ownerDocument, "button");
		const label = h(container.ownerDocument, "span");
		button.className = "ash-action-label";
		button.type = "button";
		button.disabled = !this.action.enabled;
		if (this.action.checked !== undefined) {
			button.classList.toggle("checked", this.action.checked);
			setAriaAttribute(button, "pressed", this.action.checked);
		}
		if (this.options.ariaLabel) {
			setAriaAttribute(button, "label", this.options.ariaLabel);
		}
		const icon = this.options.icon ?? this.action.icon;
		if (icon) {
			const iconContainer = h(container.ownerDocument, "span");
			iconContainer.className = "ash-action-label-icon";
			appendIcon(icon, iconContainer);
			button.append(iconContainer);
		}
		label.className = "ash-action-label-text";
		label.textContent = this.options.label ?? this.action.label;
		button.append(label);
		this._register(addDisposableListener(button, "click", () => this.action.run()));
		this.setupHover(button, this.options.tooltip ?? this.action.tooltip);
		this._register(toDisposable(() => button.remove()));
		this.button = button;
		container.append(button);
	}

	override focus(): void {
		this.button?.focus();
	}

	override setTabbable(tabbable: boolean): void {
		if (this.button) this.button.tabIndex = tabbable ? 0 : -1;
	}
}

/** Non-interactive visual representation of a separator action. */
export class SeparatorActionViewItem extends ActionViewItem {
	private rendered = false;

	constructor(action: Separator) {
		super(action);
	}

	override render(container: HTMLElement): void {
		if (this.rendered) {
			throw new Error(`Action view item is already rendered: ${this.action.id}`);
		}
		this.rendered = true;
		container.classList.add("ash-action-view-item-separator");
		container.setAttribute("role", "separator");
	}

	override setTabbable(_tabbable: boolean): void {}
}

/** Creates the base representation used when a platform has no override. */
export function createActionViewItem(action: IAction, options: ActionViewItemOptions = {}): ActionViewItem {
	return action instanceof Separator
		? new SeparatorActionViewItem(action)
		: new ButtonActionViewItem(action, options);
}
