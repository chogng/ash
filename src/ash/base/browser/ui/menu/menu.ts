import type { IButtonStyles } from '../button/button.js';
import type { IKeybindingLabelStyles } from '../keybindinglabel/keybindinglabel.js';
import { type IAction, type IActionRunner, Separator, SubmenuAction } from '../../../common/actions.js';
import { RunOnceScheduler } from '../../../common/async.js';
import { addDisposableListener, isNode, h } from '../../dom.js';
import { FocusNavigationBoundary, FocusNavigationDirection, focusFirst, focusLast, moveFocus } from '../../focus.js';
import { isModifierKey } from '../../keyboardEvent.js';
import type { ResolvedKeybinding } from '../../../common/keybindings.js';
import { Disposable, toDisposable } from '../../../common/lifecycle.js';
import { Lxicon } from '../../../common/lxicons.js';
import { ActionViewItem, ButtonActionViewItem, SeparatorActionViewItem, type ActionViewItemOptions } from '../actionbar/actionViewItems.js';
import { AnchorAxisAlignment, AnchorPosition, ContextView, ContextViewFocusRestore, ContextViewHideReason } from '../contextview/contextview.js';
import { appendIcon } from '../lxicons/lxicon.js';
import { KeybindingLabel } from '../keybindinglabel/keybindinglabel.js';

export interface MenuActionViewItemOptions extends ActionViewItemOptions {
	readonly menuStyles?: IMenuStyles;
	readonly keybindingLabelStyles?: IKeybindingLabelStyles;
	readonly ariaDescription?: string;
	readonly onDidSelect?: () => void;
	readonly submenuLayer?: number;
	readonly contextViewContainer?: HTMLElement;
	readonly keybinding?: ResolvedKeybinding;
	readonly getKeybinding?: (action: IAction) => ResolvedKeybinding | undefined;
	readonly actionRunner?: IActionRunner;
	readonly actionContext?: unknown;
	readonly checkedActionRepresentation?: 'radio' | 'checkbox';
	readonly onWillOpenSubmenu?: (item: ActionViewItem) => void;
	readonly openSubmenusImmediatelyOnHover?: boolean;
}

function prependMenuLeadingSlot(button: HTMLButtonElement, checked: boolean | undefined): void {
	const slot = h(button.ownerDocument, 'span');
	slot.className = 'ash-menu-leading-slot';
	slot.setAttribute('aria-hidden', 'true');
	// Keep IconLabel's icon node so Button.icon updates still reach the menu slot.
	const icon = button.querySelector<HTMLElement>(':scope > .ash-button-content > .ash-icon-label-icon');
	if (icon) slot.append(icon);
	if (checked !== undefined) {
		slot.classList.add('ash-menu-leading-check');
		appendIcon(Lxicon.check, slot);
	}
	button.prepend(slot);
}

/** Menus use the action label for accessibility without opening a tooltip. */
abstract class MenuButtonActionViewItem extends ButtonActionViewItem {
	protected override setupTooltip(): void {}
}

/** Button view item for an action presented inside a menu. */
class MenuActionViewItem extends MenuButtonActionViewItem {
	private readonly ariaDescription: string | undefined;
	private readonly onDidSelect: (() => void) | undefined;
	private readonly keybinding: ResolvedKeybinding | undefined;
	private readonly actionRunner: IActionRunner | undefined;
	private readonly actionContext: unknown;
	private readonly checkedActionRepresentation: 'radio' | 'checkbox';

	constructor(
		action: IAction,
		private readonly options: MenuActionViewItemOptions = {},
	) {
		super(action, options);
		this.ariaDescription = options.ariaDescription;
		this.onDidSelect = options.onDidSelect;
		this.keybinding = options.keybinding;
		this.actionRunner = options.actionRunner;
		this.actionContext = options.actionContext;
		this.checkedActionRepresentation = options.checkedActionRepresentation ?? 'checkbox';
	}

	override render(container: HTMLElement): void {
		super.render(container);
		prependMenuLeadingSlot(this.button.domNode, this.action.checked);
		if (this.ariaDescription) {
			this.button.domNode.setAttribute('aria-description', this.ariaDescription);
		}
		if (this.action.checked === undefined) {
			this.button.domNode.setAttribute('role', 'menuitem');
		} else {
			this.button.domNode.setAttribute('role', this.checkedActionRepresentation === 'radio' ? 'menuitemradio' : 'menuitemcheckbox');
			this.button.domNode.setAttribute('aria-checked', String(this.action.checked));
			this.button.domNode.removeAttribute('aria-pressed');
		}
		if (this.action.badge) {
			const badge = h(container.ownerDocument, 'span');
			badge.className = 'ash-menu-badge';
			badge.textContent = this.action.badge;
			this.button.domNode.append(badge);
		}
		if (!this.keybinding) return;
		const label = this._register(
			new KeybindingLabel(this.button.domNode, {
				...this.options.keybindingLabelStyles,
				keybinding: this.keybinding,
			}),
		);
		label.element.classList.add('ash-menu-keybinding');
	}

	protected override runAction(): unknown {
		try {
			return this.actionRunner ? this.actionRunner.run(this.action, this.actionContext) : super.runAction();
		} finally {
			this.onDidSelect?.();
		}
	}
}

/** Menu view item that owns the nested Menu for a submenu action. */
class SubmenuMenuActionViewItem extends MenuButtonActionViewItem {
	private readonly submenuAction: SubmenuAction;
	private readonly onDidSelect: (() => void) | undefined;
	private readonly submenuLayer: number;
	private readonly contextViewContainer: HTMLElement | undefined;
	private readonly getKeybinding: ((action: IAction) => ResolvedKeybinding | undefined) | undefined;
	private readonly actionRunner: IActionRunner | undefined;
	private readonly actionContext: unknown;
	private readonly onWillOpenSubmenu: ((item: ActionViewItem) => void) | undefined;
	private readonly openImmediatelyOnHover: boolean;
	private readonly showScheduler = this._register(
		new RunOnceScheduler(() => {
			if (this.pointerInside) this.openSubmenu(false);
		}, 250),
	);
	private readonly hideScheduler = this._register(
		new RunOnceScheduler(() => {
			const activeElement = this.button.domNode.ownerDocument.activeElement;
			if (this.ownsTrigger(activeElement) || (isNode(activeElement) && this.contains(activeElement))) return;
			this.close();
		}, 750),
	);
	private contextView: ContextView | undefined;
	private menu: Menu | undefined;
	private pointerInside = false;
	private lastPointerPosition: { x: number; y: number } | undefined;

	constructor(
		action: SubmenuAction,
		private readonly options: MenuActionViewItemOptions = {},
	) {
		super(action, options);
		this.submenuAction = action;
		this.onDidSelect = options.onDidSelect;
		this.submenuLayer = options.submenuLayer ?? 20;
		this.contextViewContainer = options.contextViewContainer;
		this.getKeybinding = options.getKeybinding;
		this.actionRunner = options.actionRunner;
		this.actionContext = options.actionContext;
		this.onWillOpenSubmenu = options.onWillOpenSubmenu;
		this.openImmediatelyOnHover = options.openSubmenusImmediatelyOnHover ?? false;
	}

	override render(container: HTMLElement): void {
		super.render(container);
		prependMenuLeadingSlot(this.button.domNode, undefined);
		const ownerDocument = container.ownerDocument;
		if (this.contextViewContainer && this.contextViewContainer.ownerDocument !== ownerDocument) {
			throw new Error('Context view container belongs to another document');
		}
		this.contextView = this._register(new ContextView(this.contextViewContainer ?? container.closest<HTMLElement>('dialog, [data-color-scheme]') ?? ownerDocument.body));
		this.menu = this._register(
			new Menu(
				this.contextView.element,
				{
					buttonStyles: this.options.buttonStyles,
					keybindingLabelStyles: this.options.keybindingLabelStyles,
					actions: this.submenuAction.actions,
					contextViewContainer: this.contextViewContainer,
					layer: this.submenuLayer,
					getKeybinding: this.getKeybinding,
					actionRunner: this.actionRunner,
					actionContext: this.actionContext,
					onDidSelect: () => {
						this.close();
						this.onDidSelect?.();
					},
					onDidRequestClose: () => {
						this.close();
						this.button.focus();
					},
				},
				this.options.menuStyles,
			),
		);
		this._register(
			this.contextView.onDidHide(reason => {
				this.showScheduler.cancel();
				this.hideScheduler.cancel();
				this.menu?.closeSubmenus();
				this.button.domNode.setAttribute('aria-expanded', 'false');
				if (reason === ContextViewHideReason.Escape) this.button.focus();
			}),
		);
		this.button.domNode.setAttribute('role', 'menuitem');
		this.button.domNode.setAttribute('aria-haspopup', 'menu');
		this.button.domNode.setAttribute('aria-expanded', 'false');
		const indicator = h(ownerDocument, 'span');
		indicator.className = 'ash-submenu-indicator';
		appendIcon(Lxicon.menuSubmenu, indicator);
		this.button.domNode.append(indicator);
		this._register(
			addDisposableListener(container, 'mouseenter', event => {
				this.lastPointerPosition = { x: event.clientX, y: event.clientY };
			}),
		);
		this._register(
			addDisposableListener(container, 'mousemove', event => {
				const previous = this.lastPointerPosition;
				// Some input paths report zero deltas, so compare positions before ignoring movement.
				const moved = Boolean(event.movementX || event.movementY || (previous && (previous.x !== event.clientX || previous.y !== event.clientY)));
				this.lastPointerPosition = { x: event.clientX, y: event.clientY };
				if (moved) this.openFromPointer();
			}),
		);
		this._register(
			addDisposableListener(container, 'mouseleave', () => {
				this.pointerInside = false;
				this.lastPointerPosition = undefined;
				this.showScheduler.cancel();
			}),
		);
		this._register(addDisposableListener(container, 'focusout', () => this.hideScheduler.schedule()));
		this._register(addDisposableListener(this.contextView.element, 'focusout', () => this.hideScheduler.schedule()));
		this._register(addDisposableListener(container, 'focusin', () => this.hideScheduler.cancel()));
		this._register(addDisposableListener(this.contextView.element, 'focusin', () => this.hideScheduler.cancel()));
	}

	protected override runAction(): void {
		this.openSubmenu(true);
	}

	private openFromPointer(): void {
		if (this.pointerInside || !this.action.enabled) return;
		this.pointerInside = true;
		if (this.openImmediatelyOnHover) this.openSubmenu(false);
		else this.showScheduler.schedule();
	}

	private openSubmenu(focusFirst: boolean): void {
		if (!this.contextView || !this.menu) return;
		if (!this.contextView.visible) {
			this.onWillOpenSubmenu?.(this);
			const shown = this.contextView.show({
				anchor: this.button.domNode,
				content: this.menu.element,
				anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
				anchorPosition: AnchorPosition.Below,
				gap: 2,
				presentation: 'menu',
				layer: this.submenuLayer,
				focusRestore: ContextViewFocusRestore.None,
				isTargetWithin: target => this.menu?.contains(target) ?? false,
			});
			if (!shown) return;
			this.button.domNode.setAttribute('aria-expanded', 'true');
		}
		if (focusFirst) this.menu.focusFirst();
	}

	close(): void {
		this.showScheduler.cancel();
		this.hideScheduler.cancel();
		this.contextView?.hide();
	}

	contains(target: Node): boolean {
		return this.contextView?.element.contains(target) === true || this.menu?.contains(target) === true;
	}

	ownsTrigger(target: Element | null): boolean {
		return target === this.button.domNode;
	}

	openFromKeyboard(): void {
		this.openSubmenu(true);
	}

	openFromHover(): void {
		this.openSubmenu(false);
	}
}

/** Creates the menu representation for an action. */
function createMenuActionViewItem(action: IAction, options: MenuActionViewItemOptions = {}): ActionViewItem {
	if (action instanceof Separator) {
		return new SeparatorActionViewItem(action);
	}
	if (action instanceof SubmenuAction) {
		return new SubmenuMenuActionViewItem(action, options);
	}
	return new MenuActionViewItem(action, options);
}

/** Host-provided CSS colors, resolved through the containing theme root. */
export interface IMenuStyles {
	readonly foregroundColor: string | undefined;
	readonly backgroundColor: string | undefined;
	readonly selectionForegroundColor: string | undefined;
	readonly selectionBackgroundColor: string | undefined;
	readonly borderColor: string | undefined;
	readonly separatorColor: string | undefined;
	readonly shadowColor: string | undefined;
}

export interface MenuOptions {
	readonly buttonStyles?: IButtonStyles;
	readonly keybindingLabelStyles?: IKeybindingLabelStyles;
	readonly getAriaDescription?: (action: IAction) => string | undefined;
	readonly actions: readonly IAction[];
	/** Applies only to submenu actions in this menu, not nested menus they create. */
	readonly openSubmenusImmediatelyOnHover?: boolean;
	readonly contextViewContainer?: HTMLElement;
	readonly onDidSelect?: () => void;
	readonly onDidRequestClose?: () => void;
	readonly getKeybinding?: (action: IAction) => ResolvedKeybinding | undefined;
	readonly layer?: number;
	readonly actionRunner?: IActionRunner;
	readonly actionContext?: unknown;
	readonly className?: string;
	readonly actionViewItemProvider?: (action: IAction, options: MenuActionViewItemOptions) => ActionViewItem | undefined;
	readonly getCheckedActionsRepresentation?: (action: IAction) => 'radio' | 'checkbox';
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
	private lastPointerPosition: { x: number; y: number } | undefined;

	constructor(container: HTMLElement, options: MenuOptions, styles?: IMenuStyles) {
		super();
		const ownerDocument = container.ownerDocument;
		const element = h(ownerDocument, 'div');
		this.element = element;
		this._register(toDisposable(() => element.remove()));
		element.className = options.className ? `ash-menu ${options.className}` : 'ash-menu';
		element.setAttribute('role', 'menu');
		element.tabIndex = -1;
		if (styles) {
			const colors = {
				'--ash-menu-style-foreground-color': styles.foregroundColor,
				'--ash-menu-style-background-color': styles.backgroundColor,
				'--ash-menu-style-selection-foreground-color': styles.selectionForegroundColor,
				'--ash-menu-style-selection-background-color': styles.selectionBackgroundColor,
				'--ash-menu-style-border-color': styles.borderColor,
				'--ash-menu-style-separator-color': styles.separatorColor,
				'--ash-menu-style-shadow-color': styles.shadowColor,
			};
			for (const [property, value] of Object.entries(colors)) {
				if (value !== undefined) element.style.setProperty(property, value);
			}
			if (container.classList.contains('ash-context-view')) {
				// ContextView owns the popup shell; restore its presentation when this menu releases it.
				const previous = new Map(
					Object.keys(colors).map(property => [
						property,
						{
							value: container.style.getPropertyValue(property),
							priority: container.style.getPropertyPriority(property),
						},
					]),
				);
				for (const [property, value] of Object.entries(colors)) {
					if (value !== undefined) container.style.setProperty(property, value);
				}
				this._register(
					toDisposable(() => {
						for (const [property, original] of previous) {
							if (original.value) container.style.setProperty(property, original.value, original.priority);
							else container.style.removeProperty(property);
						}
					}),
				);
			}
		}
		container.append(element);

		for (const action of options.actions) {
			const itemOptions: MenuActionViewItemOptions = {
				menuStyles: styles,
				buttonStyles: options.buttonStyles,
				keybindingLabelStyles: options.keybindingLabelStyles,
				ariaDescription: options.getAriaDescription?.(action),
				onDidSelect: options.onDidSelect,
				openSubmenusImmediatelyOnHover: options.openSubmenusImmediatelyOnHover,
				submenuLayer: (options.layer ?? 20) + 1,
				contextViewContainer: options.contextViewContainer,
				keybinding: options.getKeybinding?.(action),
				getKeybinding: options.getKeybinding,
				actionRunner: options.actionRunner,
				actionContext: options.actionContext,
				checkedActionRepresentation: options.getCheckedActionsRepresentation?.(action),
				onWillOpenSubmenu: submenu => {
					this.closeSubmenus(submenu);
					this.setFocusedEntry(
						this.entries.find(entry => entry.item === submenu),
						true,
					);
				},
			};
			const item = this._register(options.actionViewItemProvider?.(action, itemOptions) ?? createMenuActionViewItem(action, itemOptions));
			if (item instanceof SubmenuMenuActionViewItem) {
				this.submenus.push(item);
			}
			const container = h(ownerDocument, 'div');
			container.className = 'ash-action-view-item';
			container.dataset.actionId = action.id;
			container.setAttribute('role', 'presentation');
			element.append(container);
			item.render(container);
			this.entries.push({ action, container, item });
		}
		this._register(
			addDisposableListener(element, 'focusin', event => {
				const entry = this.findEntry(event.target);
				if (entry?.action.enabled) this.setFocusedEntry(entry);
			}),
		);
		this._register(
			addDisposableListener(element, 'focusout', event => {
				if (isNode(event.relatedTarget) && this.contains(event.relatedTarget)) return;
				this.setFocusedEntry(undefined);
			}),
		);
		// Keyboard input may come from a sibling filter or an open submenu before focus returns here.
		this._register(
			addDisposableListener(
				ownerDocument,
				'keydown',
				event => {
					if (event.isComposing || isModifierKey(event)) return;
					element.classList.remove('pointer-navigation');
				},
				true,
			),
		);
		this._register(
			addDisposableListener(element, 'pointerdown', () => {
				element.classList.add('pointer-navigation');
			}),
		);
		this._register(
			addDisposableListener(element, 'mouseover', event => {
				this.lastPointerPosition = { x: event.clientX, y: event.clientY };
			}),
		);
		this._register(
			addDisposableListener(element, 'mousemove', event => {
				const previous = this.lastPointerPosition;
				const moved = Boolean(event.movementX || event.movementY || (previous && (previous.x !== event.clientX || previous.y !== event.clientY)));
				this.lastPointerPosition = { x: event.clientX, y: event.clientY };
				// Showing a menu under a resting pointer must not select an action.
				if (!moved) return;
				element.classList.add('pointer-navigation');
				const entry = this.findEntry(event.target);
				this.setFocusedEntry(entry?.action.enabled ? entry : undefined, true);
			}),
		);
		this._register(
			addDisposableListener(element, 'mouseout', event => {
				if (isNode(event.relatedTarget) && this.contains(event.relatedTarget)) return;
				this.lastPointerPosition = undefined;
				this.setFocusedEntry(undefined);
			}),
		);
		this._register(
			addDisposableListener(
				container,
				'scroll',
				event => {
					if (isNode(event.target) && event.target.contains(this.element)) {
						this.closeSubmenus();
					}
				},
				true,
			),
		);
		this._register(
			addDisposableListener(element, 'keydown', event => {
				if (event.isComposing) return;
				let handled = true;
				switch (event.key) {
					case 'ArrowDown':
						this.closeSubmenus();
						moveFocus(element, FocusNavigationDirection.Forward, FocusNavigationBoundary.Wrap);
						break;
					case 'ArrowUp':
						this.closeSubmenus();
						moveFocus(element, FocusNavigationDirection.Backward, FocusNavigationBoundary.Wrap);
						break;
					case 'Home':
						this.closeSubmenus();
						focusFirst(element);
						break;
					case 'End':
						this.closeSubmenus();
						focusLast(element);
						break;
					case 'ArrowRight':
						{
							const activeElement = element.ownerDocument.activeElement;
							const submenu = this.submenus.find(item => item.ownsTrigger(activeElement));
							if (submenu) submenu.openFromKeyboard();
							else handled = false;
						}
						break;
					case 'ArrowLeft':
						options.onDidRequestClose?.();
						handled = options.onDidRequestClose !== undefined;
						break;
					default:
						handled = false;
				}
				if (!handled) return;
				event.preventDefault();
				event.stopPropagation();
			}),
		);
	}

	/** Menu focus and action focus are separate so opening need not highlight a row. */
	public focus(selectFirst?: boolean): void;
	public focus(index?: number): void;
	public focus(target: boolean | number = true): void {
		if (typeof target === 'number') {
			const entry = this.entries[target];
			if (entry?.action.enabled) {
				entry.item.focus();
				return;
			}
		} else if (target) {
			this.focusFirst();
			return;
		}
		this.setFocusedEntry(undefined);
		this.element.focus({ preventScroll: true });
	}

	focusFirst(): void {
		focusFirst(this.element);
	}

	closeSubmenus(except?: ActionViewItem): void {
		for (const submenu of this.submenus) {
			if (submenu !== except) submenu.close();
		}
	}

	contains(target: Node): boolean {
		return this.element.contains(target) || this.submenus.some(submenu => submenu.contains(target));
	}

	private findEntry(target: EventTarget | null): MenuEntry | undefined {
		if (!isNode(target)) return undefined;
		const targetElement = target.nodeType === 1 ? (target as Element) : target.parentElement;
		const container = targetElement?.closest<HTMLElement>('.ash-action-view-item');
		if (container?.parentElement !== this.element) return undefined;
		return this.entries.find(entry => entry.container === container);
	}

	private setFocusedEntry(entry: MenuEntry | undefined, focus = false): void {
		if (entry !== this.focusedEntry) {
			this.focusedEntry?.container.classList.remove('focused');
			this.focusedEntry = entry;
			entry?.container.classList.add('focused');
		}
		if (focus && entry && !entry.container.contains(this.element.ownerDocument.activeElement)) {
			entry.item.focus();
		}
	}
}
