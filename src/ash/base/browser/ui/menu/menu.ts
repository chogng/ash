import './menu.css';
import menuCSS from './menu.css?inline';
import buttonCSS from '../button/button.css?inline';
import actionbarCSS from '../actionbar/actionbar.css?inline';
import iconlabelCSS from '../iconlabel/iconlabel.css?inline';
import iconCSS from '../lxicons/lxicon.css?inline';
import contextviewCSS from '../contextview/contextview.css?inline';
import type { IButtonStyles } from '../button/button.js';
import type { IKeybindingLabelStyles } from '../keybindinglabel/keybindinglabel.js';
import { getActionForAltMode, type IAction, type IActionRunner, Separator, SubmenuAction } from '../../../common/actions.js';
import { RunOnceScheduler } from '../../../common/async.js';
import { addDisposableListener, isNode, h, ModifierKeyEmitter, getActiveElement } from '../../dom.js';
import { isModifierKey } from '../../keyboardEvent.js';
import type { ResolvedKeybinding } from '../../../common/keybindings.js';
import { MutableDisposable, toDisposable } from '../../../common/lifecycle.js';
import { Scrollable } from '../../../common/scrollable.js';
import { observeResize } from '../../observer.js';
import { scheduleAtNextAnimationFrame } from '../../scheduler.js';
import { Lxicon } from '../../../common/lxicons.js';
import { ActionBar } from '../actionbar/actionbar.js';
import { ActionViewItem, ButtonActionViewItem, SeparatorActionViewItem, type ActionViewItemOptions } from '../actionbar/actionViewItems.js';
import { AnchorAlignment, AnchorAxisAlignment, AnchorPosition, ContextView, ContextViewFocusRestore, ContextViewHideReason } from '../contextview/contextview.js';
import { appendIcon } from '../lxicons/lxicon.js';
import { KeybindingLabel } from '../keybindinglabel/keybindinglabel.js';

export interface MenuActionViewItemOptions extends ActionViewItemOptions {
	readonly menuStyles?: IMenuStyles;
	readonly submenuOptions?: IMenuOptions;
	readonly enableMnemonics?: boolean;
	readonly useEventAsContext?: boolean;
	readonly keybindingLabelStyles?: IKeybindingLabelStyles;
	readonly ariaDescription?: string;
	readonly onDidSelect?: () => void;
	readonly submenuLayer?: number;
	readonly contextViewContainer?: HTMLElement;
	readonly keybinding?: ResolvedKeybinding;
	readonly getKeyBinding?: (
		action: IAction,
	) => ResolvedKeybinding | undefined;
	readonly checkedActionRepresentation?: 'radio' | 'checkbox';
	readonly onWillOpenSubmenu?: (item: ActionViewItem) => void;
	readonly openSubmenusImmediatelyOnHover?: boolean;
}

interface MenuItemHostOptions extends MenuActionViewItemOptions {
	readonly onInvalidFocus?: () => void;
}

function prependMenuLeadingSlot(
	button: HTMLButtonElement,
	checked: boolean | undefined,
): void {
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

/** Menus project one action, selected from current modifiers, into a stable control. */
abstract class MenuButtonActionViewItem extends ButtonActionViewItem {
	private renderedLabel: string | undefined;
	private renderedClass: string | undefined;
	private renderedIcon: IAction['icon'];

	constructor(action: IAction, protected readonly menuOptions: MenuItemHostOptions = {}) {
		super(action, menuOptions);
	}

	protected override setupTooltip(): void { }
	abstract override runAction(event?: MouseEvent | KeyboardEvent): unknown;

	override render(container: HTMLElement): void {
		super.render(container);
		const refresh = (): void => { if (this.update()) this.menuOptions.onInvalidFocus?.(); };
		if (this.action.onDidChange) this._register(this.action.onDidChange(refresh));
		if (this.action.alt?.onDidChange) this._register(this.action.alt.onDidChange(refresh));
		const targetWindow = container.ownerDocument.defaultView;
		if (targetWindow && this.action.alt) {
			this._register(ModifierKeyEmitter.getInstance(targetWindow).event(refresh));
		}
	}

	protected get displayedAction(): IAction {
		if (!this.action.alt) return this.action;
		const targetWindow = this.button.domNode.ownerDocument.defaultView;
		return getActionForAltMode(this.action, targetWindow ? ModifierKeyEmitter.getInstance(targetWindow).keyStatus : {});
	}

	get mnemonic(): string | undefined {
		return this.menuOptions.enableMnemonics ? parseMenuLabel(this.displayedAction.label).mnemonic : undefined;
	}

	update(): boolean {
		const action = this.displayedAction;
		const lostFocus = !action.enabled && getActiveElement(this.button.domNode.ownerDocument) === this.button.domNode;
		this.button.enabled = action.enabled;
		const parsed = parseMenuLabel(action.label, this.menuOptions.enableMnemonics === true);
		if (this.renderedLabel !== action.label) {
			this.button.label = parsed.label;
			this.button.domNode.setAttribute('aria-label', parsed.label);
			const label = this.button.domNode.querySelector<HTMLElement>('.ash-button-label');
			if (label && this.menuOptions.enableMnemonics && parsed.index !== undefined) {
				const key = h(label.ownerDocument, 'u');
				key.textContent = parsed.label[parsed.index]!;
				label.replaceChildren(parsed.label.slice(0, parsed.index), key, parsed.label.slice(parsed.index + 1));
			}
			this.renderedLabel = action.label;
		}
		if (this.mnemonic) this.button.domNode.setAttribute('aria-keyshortcuts', this.mnemonic);
		else this.button.domNode.removeAttribute('aria-keyshortcuts');
		if (this.renderedIcon !== action.icon) {
			this.button.icon = action.icon;
			this.renderedIcon = action.icon;
		}
		if (this.renderedClass !== action.class) {
			for (const name of this.renderedClass?.split(/\s+/).filter(Boolean) ?? []) this.button.domNode.classList.remove(name);
			for (const name of action.class?.split(/\s+/).filter(Boolean) ?? []) this.button.domNode.classList.add(name);
			this.renderedClass = action.class;
		}
		return lostFocus;
	}
}

/** Runnable menu action with live checked, shortcut and alternative presentation. */
export class MenuActionViewItem extends MenuButtonActionViewItem {
	private readonly shortcut = this._register(new MutableDisposable<KeybindingLabel>());
	private badge: HTMLElement | undefined;
	private shortcutValue: ResolvedKeybinding | undefined;

	override render(container: HTMLElement): void {
		super.render(container);
		prependMenuLeadingSlot(this.button.domNode, this.action.checked);
		if (this.menuOptions.ariaDescription) this.button.domNode.setAttribute('aria-description', this.menuOptions.ariaDescription);
		this.update();
	}

	override update(): boolean {
		const lostFocus = super.update();
		const action = this.displayedAction;
		this.button.checked = action.checked;
		this.button.domNode.removeAttribute('aria-pressed');
		const checked = action.checked !== undefined;
		this.button.domNode.setAttribute('role', checked
			? this.menuOptions.checkedActionRepresentation === 'radio' ? 'menuitemradio' : 'menuitemcheckbox'
			: 'menuitem');
		if (checked) this.button.domNode.setAttribute('aria-checked', String(action.checked));
		else this.button.domNode.removeAttribute('aria-checked');
		const slot = this.button.domNode.querySelector<HTMLElement>('.ash-menu-leading-slot');
		if (slot) {
			slot.classList.toggle('ash-menu-leading-check', checked);
			if (checked && !slot.querySelector(':scope > .ash-icon')) appendIcon(Lxicon.check, slot);
		}
		if (action.badge && !this.badge) {
			this.badge = h(this.button.domNode.ownerDocument, 'span', { className: 'ash-menu-badge' });
			this.button.domNode.append(this.badge);
		}
		if (this.badge) {
			this.badge.textContent = action.badge ?? '';
			this.badge.hidden = !action.badge;
		}
		const keybinding = this.menuOptions.getKeyBinding ? this.menuOptions.getKeyBinding(action)
			: action === this.action ? this.menuOptions.keybinding : undefined;
		if (this.shortcutValue !== keybinding) {
			this.shortcut.clear();
			if (keybinding) {
				const label = this.shortcut.value = new KeybindingLabel(this.button.domNode, {
					...this.menuOptions.keybindingLabelStyles, keybinding,
				});
				label.element.classList.add('ash-menu-keybinding');
			}
			this.shortcutValue = keybinding;
		}
		return lostFocus;
	}

	override runAction(event?: MouseEvent | KeyboardEvent): unknown {
		const targetWindow = this.button.domNode.ownerDocument.defaultView;
		const action = getActionForAltMode(this.action, event ?? (this.action.alt && targetWindow ? ModifierKeyEmitter.getInstance(targetWindow).keyStatus : {}));
		if (!action.enabled) return;
		try {
			return this.runActionWithContext(action, this.menuOptions.useEventAsContext ? event : this.actionContext);
		} finally {
			this.menuOptions.onDidSelect?.();
		}
	}
}

/** Menu view item that owns the nested Menu for a submenu action. */
export class SubmenuMenuActionViewItem extends MenuButtonActionViewItem {
	private readonly submenuAction: SubmenuAction;
	private readonly onDidSelect: (() => void) | undefined;
	private readonly submenuLayer: number;
	private readonly contextViewContainer: HTMLElement | undefined;
	private readonly getKeyBinding:
		| ((action: IAction) => ResolvedKeybinding | undefined)
		| undefined;
	private readonly onWillOpenSubmenu: ((item: ActionViewItem) => void) | undefined;
	private readonly openImmediatelyOnHover: boolean;
	private readonly showScheduler = this._register(new RunOnceScheduler(() => {
		if (this.pointerInside) this.open(false);
	}, 250));
	private readonly hideScheduler = this._register(new RunOnceScheduler(() => {
		const activeElement = getActiveElement(this.button.domNode.ownerDocument);
		if (this.ownsTrigger(activeElement) || (isNode(activeElement) && this.contains(activeElement))) return;
		this.close();
	}, 750));
	private contextView: ContextView | undefined;
	private menu: Menu | undefined;
	private pointerInside = false;
	private lastPointerPosition: { x: number; y: number; } | undefined;

	constructor(
		action: SubmenuAction,
		private readonly options: MenuActionViewItemOptions = {},
	) {
		super(action, options);
		this.submenuAction = action;
		this.onDidSelect = options.onDidSelect;
		this.submenuLayer = options.submenuLayer ?? 20;
		this.contextViewContainer = options.contextViewContainer;
		this.getKeyBinding = options.getKeyBinding;
		this.onWillOpenSubmenu = options.onWillOpenSubmenu;
		this.openImmediatelyOnHover = options.openSubmenusImmediatelyOnHover ?? false;
	}

	override render(container: HTMLElement): void {
		super.render(container);
		prependMenuLeadingSlot(this.button.domNode, undefined);
		const ownerDocument = container.ownerDocument;
		if (
			this.contextViewContainer &&
			this.contextViewContainer.ownerDocument !== ownerDocument
		) {
			throw new Error('Context view container belongs to another document');
		}
		const root = container.getRootNode();
		this.contextView = this._register(new ContextView(
			this.contextViewContainer ?? (root.nodeType === 11 && 'host' in root ? root as ShadowRoot
				: container.closest<HTMLElement>('dialog, [data-color-scheme]') ?? ownerDocument.body),
		));
		this._register(this.contextView.onDidHide((reason) => {
			this.showScheduler.cancel();
			this.hideScheduler.cancel();
			this.menu?.closeSubmenus();
			this.button.domNode.setAttribute('aria-expanded', 'false');
			if (reason === ContextViewHideReason.Escape) this.button.focus();
		}));
		this.button.domNode.setAttribute('role', 'menuitem');
		this.button.domNode.setAttribute('aria-haspopup', 'menu');
		this.button.domNode.setAttribute('aria-expanded', 'false');
		const indicator = h(ownerDocument, 'span');
		indicator.className = 'ash-submenu-indicator';
		appendIcon(Lxicon.menuSubmenu, indicator);
		this.button.domNode.append(indicator);
		this._register(addDisposableListener(container, 'mouseenter', (event) => {
			this.lastPointerPosition = { x: event.clientX, y: event.clientY };
		}));
		this._register(addDisposableListener(container, 'mousemove', (event) => {
			const previous = this.lastPointerPosition;
			// Some input paths report zero deltas, so compare positions before ignoring movement.
			const moved = Boolean(
				event.movementX || event.movementY ||
				(previous && (previous.x !== event.clientX || previous.y !== event.clientY))
			);
			this.lastPointerPosition = { x: event.clientX, y: event.clientY };
			if (moved) this.openFromPointer();
		}));
		this._register(addDisposableListener(container, 'mouseleave', () => {
			this.pointerInside = false;
			this.lastPointerPosition = undefined;
			this.showScheduler.cancel();
		}));
		this._register(addDisposableListener(container, 'focusout', () => this.hideScheduler.schedule()));
		this._register(addDisposableListener(this.contextView.element, 'focusout', () => this.hideScheduler.schedule()));
		this._register(addDisposableListener(container, 'focusin', () => this.hideScheduler.cancel()));
		this._register(addDisposableListener(this.contextView.element, 'focusin', () => this.hideScheduler.cancel()));
		this.update();
	}

	override runAction(event?: MouseEvent | KeyboardEvent): void {
		this.open((event?.detail ?? 0) === 0);
	}

	private openFromPointer(): void {
		if (this.pointerInside || !this.action.enabled) return;
		this.pointerInside = true;
		if (this.openImmediatelyOnHover) this.open(false);
		else this.showScheduler.schedule();
	}

	open(selectFirst = true): void {
		if (!this.contextView) return;
		// Build only the requested level instead of eagerly traversing the action graph.
		if (!this.menu) {
			this.menu = this._register(new Menu(this.contextView.element, this.submenuAction.actions, {
				...this.options.submenuOptions,
				buttonStyles: this.options.buttonStyles,
				keybindingLabelStyles: this.options.keybindingLabelStyles,
				contextViewContainer: this.contextViewContainer,
				layer: this.submenuLayer,
				getKeyBinding: this.getKeyBinding,
				actionRunner: this.actionRunner,
				context: this.actionContext,
				ariaLabel: cleanMnemonic(this.action.label),
				className: undefined,
				openSubmenusImmediatelyOnHover: undefined,
				submenuIds: new Set([...(this.options.submenuOptions?.submenuIds ?? []), this.action.id]),
				onDidSelect: () => {
					this.close();
					this.button.focus();
					this.onDidSelect?.();
				},
			}, this.options.menuStyles ?? unthemedMenuStyles));
			this._register(this.menu.onDidCancel(() => {
				this.close();
				this.button.focus();
			}));
		}
		this.showScheduler.cancel();
		if (!this.contextView.visible) {
			this.onWillOpenSubmenu?.(this);
			const shown = this.contextView.show({
				anchor: this.button.domNode,
				content: this.menu.getContainer(),
				anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
				// Nested menus align to the parent row; vertical direction positions the MenuBar popup.
				anchorAlignment: AnchorAlignment.Left,
				anchorPosition: (this.options.submenuOptions?.expandDirection?.horizontal ??
					(this.options.submenuOptions?.anchorAlignment === AnchorAlignment.Right ? HorizontalDirection.Left : HorizontalDirection.Right)) === HorizontalDirection.Left
					? AnchorPosition.Above : AnchorPosition.Below,
				gap: 2,
				presentation: 'menu',
				layer: this.submenuLayer,
				focusRestore: ContextViewFocusRestore.None,
				isTargetWithin: (target) => this.menu?.contains(target) ?? false,
			});
			if (!shown) return;
			this.button.domNode.setAttribute('aria-expanded', 'true');
		}
		if (selectFirst) this.menu.focusFirst();
	}

	override setActionContext(context: unknown): void {
		super.setActionContext(context);
		if (this.menu) this.menu.context = context;
	}

	override get actionRunner(): IActionRunner | undefined { return super.actionRunner; }
	override set actionRunner(runner: IActionRunner | undefined) {
		super.actionRunner = runner;
		if (runner && this.menu) this.menu.actionRunner = runner;
	}

	close(): void {
		this.showScheduler.cancel();
		this.hideScheduler.cancel();
		this.contextView?.hide();
	}

	get isExpanded(): boolean {
		return this.contextView?.visible === true;
	}

	override update(): boolean {
		const lostFocus = super.update();
		this.menu?.update();
		return lostFocus;
	}

	contains(target: Node): boolean {
		return this.contextView?.element.contains(target) === true ||
			this.menu?.contains(target) === true;
	}

	ownsTrigger(target: Element | null): boolean {
		return target === this.button.domNode;
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

/** Host-provided CSS colors, resolved through the containing theme root. */
export interface IMenuStyles {
	readonly foregroundColor: string | undefined;
	readonly backgroundColor: string | undefined;
	readonly selectionForegroundColor: string | undefined;
	readonly selectionBackgroundColor: string | undefined;
	readonly borderColor: string | undefined;
	readonly selectionBorderColor: string | undefined;
	readonly scrollbarShadow: string | undefined;
	readonly scrollbarSliderBackground: string | undefined;
	readonly scrollbarSliderHoverBackground: string | undefined;
	readonly scrollbarSliderActiveBackground: string | undefined;
	readonly separatorColor: string | undefined;
	readonly shadowColor: string | undefined;
}

export const unthemedMenuStyles: IMenuStyles = {
	foregroundColor: undefined, backgroundColor: undefined,
	selectionForegroundColor: undefined, selectionBackgroundColor: undefined,
	borderColor: undefined, separatorColor: undefined, shadowColor: undefined,
	selectionBorderColor: undefined, scrollbarShadow: undefined,
	scrollbarSliderBackground: undefined, scrollbarSliderHoverBackground: undefined, scrollbarSliderActiveBackground: undefined,
};

export enum HorizontalDirection { Right, Left }
export enum VerticalDirection { Above, Below }
export interface IMenuDirection {
	horizontal: HorizontalDirection;
	vertical: VerticalDirection;
}

export interface IMenuOptions {
	readonly ariaLabel?: string;
	readonly anchorAlignment?: AnchorAlignment;
	readonly expandDirection?: IMenuDirection;
	readonly submenuIds?: Set<string>;
	readonly buttonStyles?: IButtonStyles;
	readonly keybindingLabelStyles?: IKeybindingLabelStyles;
	readonly getAriaDescription?: (action: IAction) => string | undefined;
	readonly enableMnemonics?: boolean;
	readonly useEventAsContext?: boolean;
	/** Applies only to submenu actions in this menu, not nested menus they create. */
	readonly openSubmenusImmediatelyOnHover?: boolean;
	readonly contextViewContainer?: HTMLElement;
	readonly onDidSelect?: () => void;
	readonly getKeyBinding?: (
		action: IAction,
	) => ResolvedKeybinding | undefined;
	readonly layer?: number;
	readonly actionRunner?: IActionRunner;
	readonly context?: unknown;
	readonly className?: string;
	readonly actionViewItemProvider?: (
		action: IAction,
		options: MenuActionViewItemOptions,
	) => ActionViewItem | undefined;
	readonly getCheckedActionsRepresentation?: (
		action: IAction,
	) => 'radio' | 'checkbox';
}

interface MenuEntry {
	readonly action: IAction;
	readonly container: HTMLElement;
	readonly item: ActionViewItem;
}

/** Keyboard-focusable action menu with shared nested-submenu behavior. */
export class Menu extends ActionBar {
	private focusedEntry: MenuEntry | undefined;
	private lastPointerPosition: { x: number; y: number; } | undefined;
	private readonly scroll = this._register(new Scrollable({
		forceIntegerValues: false, smoothScrollDuration: 0,
		scheduleAtNextAnimationFrame: callback => scheduleAtNextAnimationFrame(this.domNode.ownerDocument.defaultView!, callback),
	}));
	readonly onScroll = this.scroll.onScroll;

	get scrollOffset(): number { return this.domNode.scrollTop; }

	constructor(container: HTMLElement, actions: readonly IAction[], private readonly options: IMenuOptions, private readonly styles: IMenuStyles) {
		super(container, { ariaRole: 'menu', orientation: 'vertical', actionRunner: options.actionRunner });
		const ownerDocument = container.ownerDocument;
		const element = this.domNode;
		element.classList.add('ash-menu');
		if (options.className) element.classList.add(...options.className.split(/\s+/).filter(Boolean));
		element.tabIndex = -1;
		if (options.ariaLabel) this.setAriaLabel(options.ariaLabel);
		this.context = options.context;
		const colors = {
			'--ash-menu-style-foreground-color': styles.foregroundColor,
			'--ash-menu-style-background-color': styles.backgroundColor,
			'--ash-menu-style-selection-foreground-color': styles.selectionForegroundColor,
			'--ash-menu-style-selection-background-color': styles.selectionBackgroundColor,
			'--ash-menu-style-selection-border-color': styles.selectionBorderColor,
			'--ash-menu-style-scrollbar-shadow': styles.scrollbarShadow,
			'--ash-menu-style-scrollbar-background': styles.scrollbarSliderBackground,
			'--ash-menu-style-scrollbar-hover-background': styles.scrollbarSliderHoverBackground,
			'--ash-menu-style-scrollbar-active-background': styles.scrollbarSliderActiveBackground,
			'--ash-menu-style-border-color': styles.borderColor,
			'--ash-menu-style-separator-color': styles.separatorColor,
			'--ash-menu-style-shadow-color': styles.shadowColor,
		};
		for (const [property, value] of Object.entries(colors)) {
			if (value !== undefined) element.style.setProperty(property, value);
		}
		if (container.classList.contains('ash-context-view')) {
			// ContextView owns the popup shell; restore its presentation when this menu releases it.
			const previous = new Map(Object.keys(colors).map(property => [property, {
				value: container.style.getPropertyValue(property), priority: container.style.getPropertyPriority(property),
			}]));
			for (const [property, value] of Object.entries(colors)) {
				if (value !== undefined) container.style.setProperty(property, value);
			}
			this._register(toDisposable(() => {
				for (const [property, original] of previous) {
					if (original.value) container.style.setProperty(property, original.value, original.priority);
					else container.style.removeProperty(property);
				}
			}));
		}
		const root = container.getRootNode();
		if (root.nodeType === 11 && 'host' in root) this._register(adoptMenuStyles(root as ShadowRoot));
		this._register(this.onScroll(event => {
			if (event.scrollLeftChanged || event.scrollTopChanged) this.closeSubmenus();
		}));
		this._register(addDisposableListener(element, 'scroll', () => this.syncScroll()));
		this._register(observeResize(element, () => this.syncScroll()));
		this.push(actions.filter(action => !options.submenuIds?.has(action.id)));
		this._register(addDisposableListener(element, 'focusin', (event) => {
			const entry = this.findEntry(event.target);
			if (entry?.action.enabled) this.setFocusedEntry(entry);
		}));
		this._register(addDisposableListener(element, 'focusout', (event) => {
			if (isNode(event.relatedTarget) && this.contains(event.relatedTarget)) return;
			this.setFocusedEntry(undefined);
		}));
		// Keyboard input may come from a sibling filter or an open submenu before focus returns here.
		this._register(addDisposableListener(ownerDocument, 'keydown', event => {
			if (event.isComposing || isModifierKey(event)) return;
			element.classList.remove('pointer-navigation');
		}, true));
		this._register(addDisposableListener(element, 'pointerdown', () => {
			element.classList.add('pointer-navigation');
		}));
		this._register(addDisposableListener(element, 'mouseover', (event) => {
			this.lastPointerPosition = { x: event.clientX, y: event.clientY };
		}));
		this._register(addDisposableListener(element, 'mousemove', (event) => {
			const previous = this.lastPointerPosition;
			const moved = Boolean(event.movementX || event.movementY ||
				(previous && (previous.x !== event.clientX || previous.y !== event.clientY)));
			this.lastPointerPosition = { x: event.clientX, y: event.clientY };
			// Showing a menu under a resting pointer must not select an action.
			if (!moved) return;
			element.classList.add('pointer-navigation');
			const entry = this.findEntry(event.target);
			this.setFocusedEntry(entry?.action.enabled ? entry : undefined, true);
			// Only this parent's still-visible submenu keeps a cascade continuous.
			if (entry?.action.enabled && entry.item instanceof SubmenuMenuActionViewItem
				&& this.submenus.some(sibling => sibling !== entry.item && sibling.isExpanded)) {
				entry.item.open(false);
			}
		}));
		this._register(addDisposableListener(element, 'mouseout', (event) => {
			if (isNode(event.relatedTarget) && this.contains(event.relatedTarget)) return;
			this.lastPointerPosition = undefined;
			this.setFocusedEntry(undefined);
		}));
		this._register(addDisposableListener(container, 'scroll', (event) => {
			if (event.target !== this.domNode && isNode(event.target) && event.target.contains(this.domNode)) {
				this.closeSubmenus();
			}
		}, true));

	}

	protected override handleNavigation(event: KeyboardEvent): void {
		const element = this.domNode;
		const ownerDocument = element.ownerDocument;
		if (event.isComposing || event.defaultPrevented) return;
		let handled = true;
		switch (event.key) {
			case 'Tab':
			case 'Escape':
				if (event.key === 'Escape') this.cancel();
				break;
			case 'Enter':
			case ' ':
				this.activate(this.findEntry(event.target), event);
				break;
			case 'ArrowDown':
			case 'ArrowUp':
			case 'Home':
			case 'End':
				this.closeSubmenus();
				super.handleNavigation(event);
				return;
			case 'ArrowRight':
				{
					const activeElement = getActiveElement(element.ownerDocument);
					const submenu = this.submenus.find((item) =>
						item.ownsTrigger(activeElement)
					);
					if (submenu) submenu.open(true);
					else handled = false;
				}
				break;
			case 'ArrowLeft':
				this.cancel();
				break;
			default: {
				const matches = this.entries.filter(entry => entry.action.enabled && entry.item instanceof MenuButtonActionViewItem
					&& entry.item.mnemonic === event.key.toLocaleLowerCase());
				if (event.ctrlKey || event.metaKey || matches.length === 0) { handled = false; break; }
				if (matches.length === 1) {
					const button = matches[0]!.container.querySelector<HTMLButtonElement>('button');
					button?.dispatchEvent(new ownerDocument.defaultView!.MouseEvent('click', { bubbles: true, altKey: event.altKey, shiftKey: event.shiftKey }));
				} else {
					const current = matches.findIndex(entry => entry === this.focusedEntry);
					this.setFocusedEntry(matches[(current + 1) % matches.length], true);
				}
				break;
			}
		}
		if (!handled) return;
		event.preventDefault();
		event.stopPropagation();
	}

	/** Menu focus and action focus are separate so opening need not highlight a row. */
	public override focus(selectFirst?: boolean): void;
	public override focus(index?: number): void;
	public override focus(target: boolean | number = true): void {
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
		this.domNode.focus({ preventScroll: true });
	}

	focusFirst(): void {
		const first = this.entries.find(entry => entry.action.enabled);
		if (first) first.item.focus();
		else this.domNode.focus();
	}

	trigger(index: number): void {
		this.activate(this.entries[index]);
	}

	override pull(index: number): void {
		if (this.entries[index] === this.focusedEntry) this.setFocusedEntry(undefined);
		super.pull(index);
	}

	override isFocused(index?: number): boolean {
		const active = getActiveElement(this.domNode.ownerDocument);
		if (index === undefined) return active !== null && this.contains(active);
		const entry = this.entries[index];
		return active !== null && (entry?.container.contains(active) === true ||
			entry?.item instanceof SubmenuMenuActionViewItem && entry.item.contains(active));
	}

	private syncScroll(): void {
		const element = this.domNode;
		element.classList.toggle('scrolled', element.scrollTop > 0);
		this.scroll.setScrollDimensions({
			width: element.clientWidth, height: element.clientHeight,
			scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight,
		}, true);
		this.scroll.setScrollPositionNow({ scrollLeft: element.scrollLeft, scrollTop: element.scrollTop });
	}

	private get submenus(): SubmenuMenuActionViewItem[] {
		return this.viewItems.filter((item): item is SubmenuMenuActionViewItem => item instanceof SubmenuMenuActionViewItem);
	}

	protected override containsFocus(target: Node): boolean { return this.contains(target); }

	protected override createActionViewItem(action: IAction): ActionViewItem {
		const itemOptions: MenuItemHostOptions = {
			onInvalidFocus: () => this.focusFirst(),
			menuStyles: this.styles,
			submenuOptions: this.options,
			enableMnemonics: this.options.enableMnemonics,
			useEventAsContext: this.options.useEventAsContext,
			buttonStyles: this.options.buttonStyles,
			keybindingLabelStyles: this.options.keybindingLabelStyles,
			ariaDescription: this.options.getAriaDescription?.(action),
			onDidSelect: this.options.onDidSelect,
			openSubmenusImmediatelyOnHover: this.options.openSubmenusImmediatelyOnHover,
			submenuLayer: (this.options.layer ?? 20) + 1,
			contextViewContainer: this.options.contextViewContainer,
			keybinding: this.options.getKeyBinding?.(action),
			getKeyBinding: this.options.getKeyBinding,
			actionRunner: this.actionRunner,
			actionContext: this.context,
			checkedActionRepresentation: this.options.getCheckedActionsRepresentation?.(action),
			onWillOpenSubmenu: (submenu) => {
				this.syncScroll();
				this.closeSubmenus(submenu);
				this.setFocusedEntry(this.entries.find((entry) => entry.item === submenu), true);
			},
		};
		const item = this.options.actionViewItemProvider?.(action, itemOptions) ?? createMenuActionViewItem(action, itemOptions);
		return item;
	}

	private activate(entry: MenuEntry | undefined, event?: KeyboardEvent): void {
		if (!entry?.action.enabled) return;
		if (entry.item instanceof MenuButtonActionViewItem) entry.item.runAction(event);
		else entry.container.querySelector<HTMLButtonElement>('button')?.click();
	}

	/** Refresh retained action projections, including custom views and open submenus. */
	update(): void {
		let lostFocus = false;
		for (const entry of this.entries) {
			if (entry.item instanceof MenuButtonActionViewItem) {
				lostFocus = entry.item.update() || lostFocus;
			}
		}
		if (lostFocus) this.focusFirst();
	}

	closeSubmenus(except?: ActionViewItem): void {
		for (const submenu of this.submenus) {
			if (submenu !== except) submenu.close();
		}
	}

	contains(target: Node): boolean {
		return this.domNode.contains(target) ||
			this.submenus.some((submenu) => submenu.contains(target));
	}

	private findEntry(target: EventTarget | null): MenuEntry | undefined {
		if (!isNode(target)) return undefined;
		const targetElement = target.nodeType === 1
			? target as Element
			: target.parentElement;
		const container = targetElement?.closest<HTMLElement>(
			'.ash-action-view-item',
		);
		if (container?.parentElement !== this.domNode) return undefined;
		return this.entries.find((entry) => entry.container === container);
	}

	private setFocusedEntry(entry: MenuEntry | undefined, focus = false): void {
		if (entry !== this.focusedEntry) {
			this.focusedEntry?.container.classList.remove('focused');
			this.focusedEntry = entry;
			entry?.container.classList.add('focused');
		}
		if (
			focus &&
			entry &&
			!entry.container.contains(getActiveElement(this.domNode.ownerDocument))
		) {
			entry.item.focus();
		}
	}
}

export const MENU_MNEMONIC_REGEX = /\(&([^\s&])\)|(^|[^&])&([^\s&])/;

/** Removes the first mnemonic, including its parenthesized suffix when present. */
export function cleanMnemonic(label: string): string {
	const match = MENU_MNEMONIC_REGEX.exec(label);
	if (!match) return label;
	const start = match.index;
	if (match[1]) return (label.slice(0, start) + label.slice(start + match[0].length)).trim();
	const marker = start + (match[2]?.length ?? 0);
	return (label.slice(0, marker) + label.slice(marker + 1)).trim();
}

function parseMenuLabel(value: string, enabled = true): { label: string; mnemonic?: string; index?: number; } {
	const match = MENU_MNEMONIC_REGEX.exec(value);
	if (!enabled || !match) return { label: cleanMnemonic(value).replace(/&&/g, '&') };
	const marker = match.index + (match[1] ? 1 : match[2]?.length ?? 0);
	const before = value.slice(0, marker).replace(/&&/g, '&');
	return {
		label: before + value.slice(marker + 1).replace(/&&/g, '&'),
		index: before.length,
		mnemonic: (match[1] ?? match[3])?.toLocaleLowerCase(),
	};
}

const shadowMenuStyles = new WeakMap<ShadowRoot, { count: number; element: HTMLStyleElement; }>();

function adoptMenuStyles(root: ShadowRoot): ReturnType<typeof toDisposable> {
	let shared = shadowMenuStyles.get(root);
	if (!shared) {
		const element = h(root.ownerDocument, 'style');
		// Use the component's own styles; theme values already live on each menu root.
		element.textContent = [buttonCSS, actionbarCSS, iconlabelCSS, iconCSS, contextviewCSS, menuCSS].join('\n');
		root.append(element);
		shared = { count: 0, element };
		shadowMenuStyles.set(root, shared);
	}
	shared.count++;
	return toDisposable(() => {
		if (--shared.count === 0) {
			shared.element.remove();
			shadowMenuStyles.delete(root);
		}
	});
}
