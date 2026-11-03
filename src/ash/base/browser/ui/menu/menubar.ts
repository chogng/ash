import './menubar.css';
import { addDisposableListener, getActiveElement, h, isHTMLElement } from '../../dom.js';
import { observeResize } from '../../observer.js';
import { Separator, SubmenuAction, type IAction, type IActionRunner } from '../../../common/actions.js';
import { Emitter } from '../../../common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../common/lifecycle.js';
import { Lxicon } from '../../../common/lxicons.js';
import type { ResolvedKeybinding } from '../../../common/keybindings.js';
import { Button, type IButtonStyles } from '../button/button.js';
import { AnchorAlignment, AnchorPosition, ContextView, ContextViewFocusRestore } from '../contextview/contextview.js';
import { Menu, MENU_MNEMONIC_REGEX, cleanMnemonic, HorizontalDirection, VerticalDirection, type IMenuDirection, type IMenuStyles } from './menu.js';
import { localize } from '../../../../nls.js';

export interface IMenuBarOptions {
	readonly enableMnemonics?: boolean;
	readonly disableAltFocus?: boolean;
	readonly visibility?: string;
	readonly getKeybinding?: (action: IAction) => ResolvedKeybinding | undefined;
	readonly alwaysOnMnemonics?: boolean;
	readonly compactMode?: IMenuDirection;
	readonly actionRunner?: IActionRunner;
	readonly getCompactMenuActions?: () => IAction[];
	/** Host-specific accessible name and button colors retain the containing surface's identity. */
	readonly ariaLabel?: string;
	readonly buttonStyles?: IButtonStyles;
}

export interface MenuBarMenu {
	actions: IAction[];
	label: string;
}

/** Menu categories and their popup lifecycle, independent of Workbench contributions. */
export class MenuBar extends Disposable {
	static readonly OVERFLOW_INDEX = -1;
	private readonly element: HTMLElement;
	private readonly menus: MenuBarMenu[] = [];
	private readonly buttons: Array<{ index: number; button: Button; }> = [];
	private readonly buttonResources = this._register(new DisposableStore());
	private readonly popup = this._register(new MutableDisposable<DisposableStore>());
	private readonly visibilityChanged = this._register(new Emitter<boolean>());
	private readonly focusChanged = this._register(new Emitter<boolean>());
	readonly onVisibilityChange = this.visibilityChanged.event;
	readonly onFocusStateChange = this.focusChanged.event;
	private overflowButton: Button | undefined;
	private overflowIndices: number[] = [];
	private activeIndex: number | undefined;
	private activeMenu: Menu | undefined;
	private focusBefore: HTMLElement | undefined;
	private focused = false;
	private visible = true;
	private temporarilyVisible = false;
	private altOnly = false;

	constructor(private readonly container: HTMLElement, private options: IMenuBarOptions, private readonly menuStyle: IMenuStyles) {
		super();
		this.element = h(container.ownerDocument, 'div', { className: 'ash-menubar' });
		this.element.setAttribute('role', 'menubar');
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
		this._register(observeResize(container, () => this.update()));
		const document = container.ownerDocument;
		// Observe combinations before a host's document-level shortcut can stop
		// propagation. Menu actions still respect consumption at the document.
		const keyObserver = document.defaultView ?? document;
		this._register(addDisposableListener(keyObserver, 'keydown', (event: KeyboardEvent) => {
			if (event.key !== 'Alt' || event.ctrlKey || event.shiftKey || event.metaKey || event.isComposing || event.defaultPrevented) this.altOnly = false;
			else if (!event.repeat) this.altOnly = true;
		}, true));
		this._register(addDisposableListener(keyObserver, 'compositionstart', () => { this.altOnly = false; }, true));
		this._register(addDisposableListener(document, 'focusin', () => this.updateFocus(), true));
		this._register(addDisposableListener(document, 'focusout', () => {
			queueMicrotask(() => { if (!this.isDisposed) this.updateFocus(); });
		}, true));
		this._register(addDisposableListener(document, 'pointerdown', () => { this.altOnly = false; }, true));
		this._register(addDisposableListener(document, 'keydown', event => this.onKeyDown(event), true));
		this._register(addDisposableListener(document, 'keyup', event => {
			if (event.key === 'Alt') {
				if (this.altOnly && !event.ctrlKey && !event.shiftKey && !event.metaKey && !event.isComposing && !event.defaultPrevented && !this.options.disableAltFocus) this.toggleFocus();
				this.altOnly = false;
			}
			this.element.classList.toggle('show-mnemonics', this.options.alwaysOnMnemonics === true || event.altKey);
		}, true));
		if (document.defaultView) this._register(addDisposableListener(document.defaultView, 'blur', () => { this.altOnly = false; this.blur(); }));
		this.render();
	}

	push(menus: MenuBarMenu | MenuBarMenu[]): void {
		this.menus.push(...Array.isArray(menus) ? menus : [menus]);
		this.render();
	}

	updateMenu(menu: MenuBarMenu): void {
		const index = this.menus.findIndex(candidate => candidate.label === menu.label);
		if (index < 0) return;
		this.menus[index] = menu;
		if (this.activeMenu) {
			const actions = this.activeIndex === MenuBar.OVERFLOW_INDEX ? this.getOverflowActions() : this.menus[this.activeIndex!]?.actions ?? [];
			this.activeMenu.setActions(actions);
		}
	}

	createOverflowMenu(): void {
		if (this.overflowButton) return;
		const button = this.overflowButton = this.buttonResources.add(new Button(this.element, {
			...this.options.buttonStyles,
			label: '', icon: Lxicon.menu, iconOnly: true,
			ariaLabel: this.options.ariaLabel ?? localize('menuBar.applicationMenu', 'Application Menu'),
			onClick: event => this.toggleMenu(MenuBar.OVERFLOW_INDEX, event.detail === 0),
		}));
		button.setTitle(this.options.ariaLabel ?? localize('menuBar.applicationMenu', 'Application Menu'));
		this.configureButton(button, MenuBar.OVERFLOW_INDEX);
	}

	update(options?: IMenuBarOptions): void {
		if (options) {
			this.options = { ...this.options, ...options };
			this.render();
			return;
		}
		this.element.classList.toggle('compact', this.options.compactMode !== undefined);
		this.element.classList.toggle('show-mnemonics', this.options.alwaysOnMnemonics === true);
		this.applyVisibility();
		if (!this.overflowButton) return;
		this.overflowIndices = [];
		for (const entry of this.buttons) entry.button.hidden = false;
		this.overflowButton.hidden = !this.options.compactMode;
		if (this.options.compactMode) {
			for (const entry of this.buttons) entry.button.hidden = true;
			this.overflowIndices = this.menus.map((_, index) => index);
			return;
		}
		const available = this.container.clientWidth;
		if (available <= 0) return;
		const widths = this.buttons.map(entry => entry.button.domNode.getBoundingClientRect().width);
		if (widths.reduce((sum, width) => sum + width, 0) <= available) return;
		this.overflowButton.hidden = false;
		let used = this.overflowButton.domNode.getBoundingClientRect().width;
		for (const [index, entry] of this.buttons.entries()) {
			used += widths[index]!;
			if (used > available) {
				entry.button.hidden = true;
				this.overflowIndices.push(entry.index);
			}
		}
	}

	get isVisible(): boolean { return this.visible; }
	getWidth(): number { return this.options.compactMode ? 0 : this.element.getBoundingClientRect().width; }
	getHeight(): number { return this.container.clientHeight; }

	toggleFocus(): void {
		if (this.activeIndex !== undefined) return;
		if (this.focused) {
			this.blur();
			if (this.focusBefore?.isConnected) this.focusBefore.focus();
			return;
		}
		if (this.options.visibility === 'hidden') return;
		const active = getActiveElement(this.container.ownerDocument);
		this.focusBefore = isHTMLElement(active) ? active : undefined;
		this.temporarilyVisible = true;
		this.applyVisibility();
		this.visibleButtons()[0]?.button.focus();
	}

	blur(): void {
		this.closeMenu(false);
		const active = getActiveElement(this.container.ownerDocument);
		if (isHTMLElement(active) && this.element.contains(active)) active.blur();
		this.temporarilyVisible = false;
		this.applyVisibility();
		this.updateFocus();
	}

	private render(): void {
		const active = getActiveElement(this.container.ownerDocument);
		const hadFocus = this.element.contains(active) || this.activeIndex !== undefined;
		const previousIndex = this.activeIndex ?? this.buttons.find(entry => entry.button.domNode.contains(active))?.index;
		this.closeMenu(false);
		this.buttonResources.clear();
		this.buttons.length = 0;
		this.overflowButton = undefined;
		this.element.replaceChildren();
		for (const [index, menu] of this.options.compactMode ? [] : this.menus.entries()) {
			const readableLabel = cleanMnemonic(menu.label);
			const button = this.buttonResources.add(new Button(this.element, {
				...this.options.buttonStyles,
				label: readableLabel,
				ariaLabel: readableLabel,
				onClick: event => this.toggleMenu(index, event.detail === 0),
			}));
			this.configureButton(button, index);
			const mnemonic = this.mnemonic(menu.label);
			if (this.options.enableMnemonics && mnemonic) {
				button.domNode.setAttribute('aria-keyshortcuts', `Alt+${mnemonic}`);
				const caption = button.domNode.querySelector('.ash-button-label');
				const offset = readableLabel.toLocaleLowerCase().indexOf(mnemonic);
				if (caption) {
					const key = h(this.container.ownerDocument, 'u');
					if (offset >= 0) {
						key.textContent = readableLabel[offset]!;
						caption.replaceChildren(readableLabel.slice(0, offset), key, readableLabel.slice(offset + 1));
					} else {
						const match = MENU_MNEMONIC_REGEX.exec(menu.label);
						key.textContent = match?.[1] ?? match?.[3] ?? mnemonic;
						caption.replaceChildren(readableLabel, '(', key, ')');
					}
				}
			}
			this.buttons.push({ index, button });
		}
		this.createOverflowMenu();
		this.update();
		if (hadFocus && this.visible) {
			const buttons = this.visibleButtons();
			(buttons.find(entry => entry.index === previousIndex) ?? buttons[0])?.button.focus();
		}
	}

	private configureButton(button: Button, index: number): void {
		button.domNode.classList.add('ash-menubar-menu-button');
		button.domNode.setAttribute('role', 'menuitem');
		button.domNode.setAttribute('aria-haspopup', 'menu');
		button.domNode.setAttribute('aria-expanded', 'false');
		button.domNode.tabIndex = index === 0 || index === MenuBar.OVERFLOW_INDEX && this.options.compactMode ? 0 : -1;
		this.buttonResources.add(addDisposableListener(button.domNode, 'mouseenter', () => {
			if (this.activeIndex !== undefined && this.activeIndex !== index) this.openMenu(index, false);
		}));
	}

	private toggleMenu(index: number, selectFirst: boolean): void {
		if (this.activeIndex === index) this.closeMenu(true);
		else this.openMenu(index, selectFirst);
	}

	private openMenu(index: number, selectFirst: boolean): void {
		const button = index === MenuBar.OVERFLOW_INDEX ? this.overflowButton : this.buttons.find(entry => entry.index === index)?.button;
		if (!button) return;
		const actions = index === MenuBar.OVERFLOW_INDEX ? this.getOverflowActions() : this.menus[index]?.actions ?? [];
		if (actions.length === 0) return;
		this.closeMenu(false);
		button.focus();
		const lifetime = this.popup.value = new DisposableStore();
		const root = this.element.getRootNode();
		const host = root.nodeType === 11 && 'host' in root ? root as ShadowRoot
			: this.element.closest<HTMLElement>('dialog, [data-color-scheme]') ?? this.container.ownerDocument.body;
		const view = lifetime.add(new ContextView(host));
		const menu = lifetime.add(new Menu(view.element, actions, {
			actionRunner: this.options.actionRunner,
			getKeyBinding: this.options.getKeybinding,
			enableMnemonics: this.options.enableMnemonics,
			expandDirection: this.options.compactMode,
			ariaLabel: index === MenuBar.OVERFLOW_INDEX ? this.options.ariaLabel : cleanMnemonic(this.menus[index]!.label),
			openSubmenusImmediatelyOnHover: index === MenuBar.OVERFLOW_INDEX,
		}, this.menuStyle));
		this.activeIndex = index;
		this.activeMenu = menu;
		button.domNode.classList.add('active');
		button.domNode.setAttribute('aria-expanded', 'true');
		lifetime.add(menu.onDidCancel(() => this.closeMenu(true)));
		lifetime.add(menu.onDidBlur(() => this.closeMenu(false)));
		lifetime.add(menu.onWillRun(() => this.closeMenu(true)));
		lifetime.add(view.onDidHide(() => this.closeMenu(false)));
		const shown = view.show({
			anchor: button.domNode, content: menu.getContainer(), presentation: 'menu',
			anchorAlignment: this.options.compactMode?.horizontal === HorizontalDirection.Left ? AnchorAlignment.Right : AnchorAlignment.Left,
			anchorPosition: this.options.compactMode?.vertical === VerticalDirection.Above ? AnchorPosition.Above : AnchorPosition.Below,
			gap: 2, focusRestore: ContextViewFocusRestore.Previous,
			isTargetWithin: target => menu.contains(target),
		});
		if (shown) menu.focus(selectFirst);
		else this.closeMenu(false);
		this.updateFocus();
	}

	private closeMenu(restoreFocus: boolean): void {
		const index = this.activeIndex;
		this.activeIndex = undefined;
		this.activeMenu = undefined;
		for (const { button } of this.visibleButtons()) {
			button.domNode.classList.remove('active');
			button.domNode.setAttribute('aria-expanded', 'false');
		}
		this.popup.clear();
		if (restoreFocus && index !== undefined) {
			const target = this.visibleButtons().find(entry => entry.index === index);
			target?.button.focus();
		}
		this.updateFocus();
	}

	private getOverflowActions(): IAction[] {
		const categories = this.overflowIndices.map(index => new SubmenuAction(`menubar.${index}`, this.menus[index]!.label, this.menus[index]!.actions));
		return Separator.join(categories, this.options.getCompactMenuActions?.() ?? []);
	}

	private visibleButtons(): Array<{ index: number; button: Button; }> {
		return [...this.buttons, ...this.overflowButton ? [{ index: MenuBar.OVERFLOW_INDEX, button: this.overflowButton }] : []]
			.filter(entry => !entry.button.hidden);
	}

	private onKeyDown(event: KeyboardEvent): void {
		if (event.isComposing || event.defaultPrevented) { this.altOnly = false; return; }
		this.element.classList.toggle('show-mnemonics', this.options.alwaysOnMnemonics === true || event.altKey);
		if (this.options.enableMnemonics && event.altKey && !event.ctrlKey && !event.metaKey && event.key.length === 1) {
			const index = this.menus.findIndex(menu => this.mnemonic(menu.label) === event.key.toLocaleLowerCase());
			if (index >= 0) {
				if (this.options.compactMode || this.overflowIndices.includes(index)) {
					this.openMenu(MenuBar.OVERFLOW_INDEX, true);
					this.activeMenu?.trigger(this.overflowIndices.indexOf(index));
				} else this.openMenu(index, true);
				event.preventDefault(); event.stopPropagation();
				return;
			}
		}
		const target = event.composedPath()[0];
		if (!isHTMLElement(target)) return;
		const buttons = this.visibleButtons();
		const current = buttons.findIndex(entry => entry.button.domNode.contains(target));
		const inRootMenu = this.activeMenu?.getContainer().contains(target) === true;
		if (current < 0 && !inRootMenu) return;
		if (event.key === 'ArrowDown' && current >= 0) this.openMenu(buttons[current]!.index, true);
		else if (event.key === 'Escape' && current >= 0) this.blur();
		else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !this.options.compactMode) {
			if (inRootMenu && event.key === 'ArrowRight' && this.activeMenu?.getAction(target) instanceof SubmenuAction) return;
			const index = current >= 0 ? current : buttons.findIndex(entry => entry.index === this.activeIndex);
			const next = buttons[(index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length];
			if (next) {
				if (this.activeIndex !== undefined) this.openMenu(next.index, true);
				else next.button.focus();
			}
		} else return;
		event.preventDefault(); event.stopPropagation();
	}

	private mnemonic(label: string): string | undefined {
		if (!this.options.enableMnemonics) return undefined;
		const match = MENU_MNEMONIC_REGEX.exec(label);
		return (match?.[1] ?? match?.[3])?.toLocaleLowerCase();
	}

	private applyVisibility(): void {
		const visible = this.options.visibility !== 'hidden' && (this.options.visibility !== 'toggle' || this.temporarilyVisible);
		this.element.hidden = !visible;
		if (visible !== this.visible) { this.visible = visible; this.visibilityChanged.fire(visible); }
	}

	private updateFocus(): void {
		const active = getActiveElement(this.container.ownerDocument);
		const focused = this.element.contains(active) || this.activeIndex !== undefined;
		if (!focused && this.temporarilyVisible) {
			this.temporarilyVisible = false;
			this.applyVisibility();
		}
		if (focused !== this.focused) { this.focused = focused; this.focusChanged.fire(focused); }
	}
}
