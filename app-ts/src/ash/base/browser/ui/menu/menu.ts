import { type IAction, type IActionRunner, Separator, SubmenuAction } from "../../../common/actions.js";
import { addDisposableListener, isNode, h } from "../../dom.js";
import { FocusNavigationBoundary, FocusNavigationDirection, focusFirst, focusLast, moveFocus } from "../../focus.js";
import type { ResolvedKeybinding } from "../../../common/keybindings.js";
import { Disposable, toDisposable } from "../../../common/lifecycle.js";
import { lxiconsLibrary } from "../../../common/lxiconsLibrary.js";
import { ActionViewItem, ButtonActionViewItem, SeparatorActionViewItem } from "../actionbar/actionViewItems.js";
import { AnchorAxisAlignment, AnchorPosition, ContextView, ContextViewFocusRestore } from "../contextview/contextview.js";
import { appendIcon } from "../icon/icon.js";
import { KeybindingLabel } from "../keybindinglabel/keybindinglabel.js";

export interface MenuActionViewItemOptions {
	readonly onDidSelect?: () => void;
	readonly submenuLayer?: number;
	readonly contextViewContainer?: HTMLElement;
	readonly keybinding?: ResolvedKeybinding;
	readonly getKeybinding?: (
		action: IAction,
	) => ResolvedKeybinding | undefined;
	readonly actionRunner?: IActionRunner;
	readonly actionContext?: unknown;
	readonly checkedActionRepresentation?: "radio" | "checkbox";
}

function prependMenuLeadingSlot(
	button: HTMLButtonElement,
	checked: boolean | undefined,
): void {
	const slot = h(button.ownerDocument, "span");
	slot.className = "ash-menu-leading-slot";
	slot.setAttribute("aria-hidden", "true");
	const icon = button.querySelector<SVGElement>(":scope > .ash-icon");
	if (icon) slot.append(icon);
	else if (checked !== undefined) {
		slot.classList.add("ash-menu-leading-check");
		appendIcon(lxiconsLibrary.check, slot);
	}
	button.prepend(slot);
}

/** Button view item for an action presented inside a menu. */
class MenuActionViewItem extends ButtonActionViewItem {
	private readonly onDidSelect: (() => void) | undefined;
	private readonly keybinding: ResolvedKeybinding | undefined;
	private readonly actionRunner: IActionRunner | undefined;
	private readonly actionContext: unknown;
	private readonly checkedActionRepresentation: "radio" | "checkbox";

	constructor(
		action: IAction,
		options: MenuActionViewItemOptions = {},
	) {
		super(action);
		this.onDidSelect = options.onDidSelect;
		this.keybinding = options.keybinding;
		this.actionRunner = options.actionRunner;
		this.actionContext = options.actionContext;
		this.checkedActionRepresentation = options.checkedActionRepresentation ?? "checkbox";
	}

	override render(container: HTMLElement): void {
		super.render(container);
		prependMenuLeadingSlot(this.button.domNode, this.action.checked);
		if (this.action.checked === undefined) {
			this.button.domNode.setAttribute("role", "menuitem");
		} else {
			this.button.domNode.setAttribute(
				"role",
				this.checkedActionRepresentation === "radio"
					? "menuitemradio"
					: "menuitemcheckbox",
			);
			this.button.domNode.setAttribute(
				"aria-checked",
				String(this.action.checked),
			);
			this.button.domNode.removeAttribute("aria-pressed");
		}
		if (this.action.badge) {
			const badge = h(container.ownerDocument, "span");
			badge.className = "ash-menu-badge";
			badge.textContent = this.action.badge;
			this.button.domNode.append(badge);
		}
		if (!this.keybinding) return;
		const label = this._register(new KeybindingLabel(this.button.domNode, {
			keybinding: this.keybinding,
		}));
		label.element.classList.add("ash-menu-keybinding");
	}

	protected override runAction(): unknown {
		try {
			return this.actionRunner
				? this.actionRunner.run(this.action, this.actionContext)
				: super.runAction();
		} finally {
			this.onDidSelect?.();
		}
	}
}

/** Menu view item that owns the nested Menu for a submenu action. */
class SubmenuMenuActionViewItem extends ButtonActionViewItem {
	private readonly submenuAction: SubmenuAction;
	private readonly onDidSelect: (() => void) | undefined;
	private readonly submenuLayer: number;
	private readonly contextViewContainer: HTMLElement | undefined;
	private readonly getKeybinding:
		| ((action: IAction) => ResolvedKeybinding | undefined)
		| undefined;
	private readonly actionRunner: IActionRunner | undefined;
	private readonly actionContext: unknown;
	private contextView: ContextView | undefined;
	private menu: Menu | undefined;
	private open = false;

	constructor(
		action: SubmenuAction,
		options: MenuActionViewItemOptions = {},
	) {
		super(action);
		this.submenuAction = action;
		this.onDidSelect = options.onDidSelect;
		this.submenuLayer = options.submenuLayer ?? 20;
		this.contextViewContainer = options.contextViewContainer;
		this.getKeybinding = options.getKeybinding;
		this.actionRunner = options.actionRunner;
		this.actionContext = options.actionContext;
	}

	override render(container: HTMLElement): void {
		super.render(container);
		prependMenuLeadingSlot(this.button.domNode, undefined);
		const ownerDocument = container.ownerDocument;
		if (
			this.contextViewContainer &&
			this.contextViewContainer.ownerDocument !== ownerDocument
		) {
			throw new Error("Context view container belongs to another document");
		}
		this.contextView = this._register(new ContextView(
			this.contextViewContainer ?? ownerDocument.body,
		));
		this.menu = this._register(new Menu(this.contextView.element, {
			actions: this.submenuAction.actions,
			contextViewContainer: this.contextViewContainer,
			layer: this.submenuLayer,
			getKeybinding: this.getKeybinding,
			actionRunner: this.actionRunner,
			actionContext: this.actionContext,
			onDidSelect: () => {
				this.hide();
				this.onDidSelect?.();
			},
			onDidRequestClose: () => {
				this.hide();
				this.button.focus();
			},
		}));
		this._register(this.contextView.onDidHide(() => {
			this.open = false;
			this.button.domNode.setAttribute("aria-expanded", "false");
		}));
		this.button.domNode.setAttribute("role", "menuitem");
		this.button.domNode.setAttribute("aria-haspopup", "menu");
		this.button.domNode.setAttribute("aria-expanded", "false");
		const indicator = h(ownerDocument, "span");
		indicator.className = "ash-submenu-indicator";
		appendIcon(lxiconsLibrary.chevronRight, indicator);
		this.button.domNode.append(indicator);
	}

	protected override runAction(): void {
		if (this.open) {
			this.hide();
			return;
		}
		if (!this.contextView || !this.menu) return;
		this.contextView.show({
			anchor: this.button.domNode,
			content: this.menu.element,
			anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
			anchorPosition: AnchorPosition.Below,
			gap: 2,
			presentation: "menu",
			layer: this.submenuLayer,
			focusRestore: ContextViewFocusRestore.Previous,
			isTargetWithin: (target) => this.menu?.contains(target) ?? false,
		});
		this.open = true;
		this.button.domNode.setAttribute("aria-expanded", "true");
		this.menu.focusFirst();
	}

	private hide(): void {
		if (!this.open) return;
		this.open = false;
		this.contextView?.hide();
	}

	contains(target: Node): boolean {
		return this.contextView?.element.contains(target) === true ||
			this.menu?.contains(target) === true;
	}

	ownsTrigger(target: Element | null): boolean {
		return target === this.button.domNode;
	}

	openFromKeyboard(): void {
		if (!this.open) this.runAction();
	}
}

/** Creates the menu representation for an action. */
function createMenuActionViewItem(
	action: IAction,
	options: MenuActionViewItemOptions = {},
): ActionViewItem {
	if (action instanceof Separator) {
		return new SeparatorActionViewItem(action);
	}
	if (action instanceof SubmenuAction) {
		return new SubmenuMenuActionViewItem(action, options);
	}
	return new MenuActionViewItem(action, options);
}

export interface MenuOptions {
	readonly actions: readonly IAction[];
	readonly contextViewContainer?: HTMLElement;
	readonly onDidSelect?: () => void;
	readonly onDidRequestClose?: () => void;
	readonly getKeybinding?: (
		action: IAction,
	) => ResolvedKeybinding | undefined;
	readonly layer?: number;
	readonly actionRunner?: IActionRunner;
	readonly actionContext?: unknown;
	readonly className?: string;
	readonly actionViewItemProvider?: (
		action: IAction,
		options: MenuActionViewItemOptions,
	) => ActionViewItem | undefined;
	readonly getCheckedActionsRepresentation?: (
		action: IAction,
	) => "radio" | "checkbox";
}

interface MenuEntry {
	readonly action: IAction;
	readonly container: HTMLElement;
	readonly item: ActionViewItem;
}

/** Keyboard-focusable action menu with shared nested-submenu behavior. */
export class Menu extends Disposable {
	readonly element: HTMLDivElement;
	private readonly submenus: SubmenuMenuActionViewItem[] = [];
	private readonly entries: MenuEntry[] = [];
	private focusedEntry: MenuEntry | undefined;

	constructor(container: HTMLElement, options: MenuOptions) {
		super();
		const ownerDocument = container.ownerDocument;
		const element = h(ownerDocument, "div");
		this.element = element;
		this._register(toDisposable(() => element.remove()));
		element.className = options.className
			? `ash-menu ${options.className}`
			: "ash-menu";
		element.setAttribute("role", "menu");
		container.append(element);

		for (const action of options.actions) {
			const itemOptions: MenuActionViewItemOptions = {
				onDidSelect: options.onDidSelect,
				submenuLayer: (options.layer ?? 20) + 1,
				contextViewContainer: options.contextViewContainer,
				keybinding: options.getKeybinding?.(action),
				getKeybinding: options.getKeybinding,
				actionRunner: options.actionRunner,
				actionContext: options.actionContext,
				checkedActionRepresentation: options.getCheckedActionsRepresentation?.(action),
			};
			const item = this._register(
				options.actionViewItemProvider?.(action, itemOptions) ??
					createMenuActionViewItem(action, itemOptions),
			);
			if (item instanceof SubmenuMenuActionViewItem) {
				this.submenus.push(item);
			}
			const container = h(ownerDocument, "div");
			container.className = "ash-action-view-item";
			container.dataset.actionId = action.id;
			container.setAttribute("role", "presentation");
			element.append(container);
			item.render(container);
			this.entries.push({ action, container, item });
		}
		this._register(addDisposableListener(element, "focusin", (event) => {
			const entry = this.findEntry(event.target);
			if (entry?.action.enabled) this.setFocusedEntry(entry);
		}));
		this._register(addDisposableListener(element, "focusout", (event) => {
			if (isNode(event.relatedTarget) && this.contains(event.relatedTarget)) return;
			this.setFocusedEntry(undefined);
		}));
		this._register(addDisposableListener(element, "mouseover", (event) => {
			const entry = this.findEntry(event.target);
			this.setFocusedEntry(entry?.action.enabled ? entry : undefined, true);
		}));
		this._register(addDisposableListener(element, "mouseout", (event) => {
			if (isNode(event.relatedTarget) && this.contains(event.relatedTarget)) return;
			this.setFocusedEntry(undefined);
		}));
		this._register(addDisposableListener(element, "keydown", (event) => {
			if (event.isComposing) return;
			let handled = true;
			switch (event.key) {
				case "ArrowDown":
					moveFocus(
						element,
						FocusNavigationDirection.Forward,
						FocusNavigationBoundary.Wrap,
					);
					break;
				case "ArrowUp":
					moveFocus(
						element,
						FocusNavigationDirection.Backward,
						FocusNavigationBoundary.Wrap,
					);
					break;
				case "Home":
					focusFirst(element);
					break;
				case "End":
					focusLast(element);
					break;
				case "ArrowRight":
					{
						const activeElement = element.ownerDocument.activeElement;
						const submenu = this.submenus.find((item) =>
							item.ownsTrigger(activeElement)
						);
						if (submenu) submenu.openFromKeyboard();
						else handled = false;
					}
					break;
				case "ArrowLeft":
					options.onDidRequestClose?.();
					handled = options.onDidRequestClose !== undefined;
					break;
				default:
					handled = false;
			}
			if (!handled) return;
			event.preventDefault();
			event.stopPropagation();
		}));
	}

	focusFirst(): void {
		focusFirst(this.element);
	}

	contains(target: Node): boolean {
		return this.element.contains(target) ||
			this.submenus.some((submenu) => submenu.contains(target));
	}

	private findEntry(target: EventTarget | null): MenuEntry | undefined {
		if (!isNode(target)) return undefined;
		const targetElement = target.nodeType === 1
			? target as Element
			: target.parentElement;
		const container = targetElement?.closest<HTMLElement>(
			".ash-action-view-item",
		);
		if (container?.parentElement !== this.element) return undefined;
		return this.entries.find((entry) => entry.container === container);
	}

	private setFocusedEntry(entry: MenuEntry | undefined, focus = false): void {
		if (entry !== this.focusedEntry) {
			this.focusedEntry?.container.classList.remove("focused");
			this.focusedEntry = entry;
			entry?.container.classList.add("focused");
		}
		if (
			focus &&
			entry &&
			!entry.container.contains(this.element.ownerDocument.activeElement)
		) {
			entry.item.focus();
		}
	}
}
