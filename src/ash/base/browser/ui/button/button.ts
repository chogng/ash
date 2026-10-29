import './button.css';
import { addDisposableListener, h, stopEvent } from '../../dom.js';
import type { IContextMenuProvider } from '../../contextmenu.js';
import { Separator, type IAction, type IActionRunner } from '../../../common/actions.js';
import { CancellationTokenSource } from '../../../common/cancellation.js';
import { DomEmitter, type DOMEventMap } from '../../event.js';
import { FastDomNode } from '../../fastDomNode.js';
import { observeElementSize } from '../../observer.js';
import type { Icon } from '../../../common/icon.js';
import type { Event } from '../../../common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../common/lifecycle.js';
import { setAriaAttribute } from '../aria/aria.js';
import type { AnchorPosition } from '../contextview/contextview.js';
import { getHoverDelegate, type IManagedHover } from '../hover/hoverDelegate.js';
import { IconLabel } from '../iconlabel/iconlabel.js';
import type { IActionProvider } from '../dropdown/dropdown.js';
import { Lxicon } from '../../../common/lxicons.js';
import { localize } from '../../../../nls.js';

/** Controls whether a button centers its complete content group or its text label. */
export type ButtonContentAlignment = 'groupCentered' | 'labelCentered';

/** Domain-neutral visual treatment selected by button consumers. */
export type ButtonPresentation = 'quiet' | 'primary' | 'secondary' | 'danger';

/** Standard button sizing shared across product surfaces. */
export type ButtonSize = 'standard' | 'small';

/** CSS colors supplied by the host; the base widget does not depend on the theme registry. */
export interface IButtonStyles {
	readonly buttonForeground?: string;
	readonly buttonBackground?: string;
	readonly buttonHoverBackground?: string;
	readonly buttonSecondaryForeground?: string;
	readonly buttonSecondaryBackground?: string;
	readonly buttonSecondaryHoverBackground?: string;
	readonly buttonSecondaryBorder?: string;
	readonly buttonBorder?: string;
}

export interface IButtonOptions extends Partial<IButtonStyles> {
	label: string;
	icon?: Icon;
	ariaLabel?: string;
	iconOnly?: boolean;
	contentAlignment?: ButtonContentAlignment;
	presentation?: ButtonPresentation;
	size?: ButtonSize;
	type?: 'button' | 'submit' | 'reset';
	title?: string;
	hoverGroupId?: string;
	hoverAnchorPosition?: AnchorPosition;
	enabled?: boolean;
	checked?: boolean;
	onClick?: (event: DOMEventMap['click']) => void;
}

export interface IButtonWithDropdownOptions extends IButtonOptions {
	readonly contextMenuProvider: IContextMenuProvider;
	readonly actions: readonly IAction[] | IActionProvider;
	readonly actionRunner?: IActionRunner;
	readonly addPrimaryActionToDropdown?: boolean;
}

/** A semantic button with an explicit enabled state. */
export class Button extends Disposable {
	readonly domNode: HTMLButtonElement;
	private readonly root: FastDomNode<HTMLButtonElement>;
	private readonly content = this._register(new MutableDisposable<IconLabel>());
	private readonly hover = this._register(new MutableDisposable<IManagedHover>());
	private readonly hoverGroupId: string | undefined;
	private readonly hoverAnchorPosition: AnchorPosition | undefined;
	private readonly usesLabelAsAriaLabel: boolean;
	private currentIcon: Icon | undefined;
	readonly onDidClick: Event<DOMEventMap['click']>;

	constructor(container: HTMLElement, options: IButtonOptions) {
		super();
		const ownerDocument = container.ownerDocument;
		this.hoverGroupId = options.hoverGroupId;
		this.hoverAnchorPosition = options.hoverAnchorPosition;
		this.usesLabelAsAriaLabel = options.iconOnly === true && options.ariaLabel === undefined;
		this.currentIcon = options.icon;
		const domNode = h(ownerDocument, 'button', {
			properties: { type: options.type ?? 'button', disabled: options.enabled === false },
		});
		this._register(toDisposable(() => domNode.remove()));
		const root = new FastDomNode(domNode);
		root.setClassName(
			[
				'ash-button',
				`ash-button-${options.presentation ?? 'quiet'}`,
				`ash-button-${options.size ?? 'standard'}`,
				options.iconOnly === true && 'icon-only',
				options.contentAlignment === 'labelCentered' && 'label-centered',
			]
				.filter(value => value !== false)
				.join(' '),
		);
		this.root = root;
		this.domNode = root.domNode;
		const properties = {
			'--ash-button-style-foreground': options.buttonForeground,
			'--ash-button-style-background': options.buttonBackground,
			'--ash-button-style-hover-background': options.buttonHoverBackground,
			'--ash-button-style-secondary-foreground': options.buttonSecondaryForeground,
			'--ash-button-style-secondary-background': options.buttonSecondaryBackground,
			'--ash-button-style-secondary-hover-background': options.buttonSecondaryHoverBackground,
			'--ash-button-style-secondary-border': options.buttonSecondaryBorder,
		};
		for (const [property, value] of Object.entries(properties)) {
			if (value !== undefined) domNode.style.setProperty(property, value);
		}
		if (options.buttonBorder !== undefined) domNode.style.borderColor = options.buttonBorder;
		if (options.ariaLabel || options.iconOnly) {
			setAriaAttribute(this.domNode, 'label', options.ariaLabel ?? options.label);
		}
		// Swatches and host-supplied content need a semantic button, but no empty label subtree.
		if (options.label || options.icon) this.getContent(options.label);
		container.append(this.domNode);
		this.setTitle(options.title);
		if (options.checked !== undefined) {
			this.checked = options.checked;
		}
		this.onDidClick = this._register(new DomEmitter(this.domNode, 'click')).event;
		if (options.onClick) {
			this._register(this.onDidClick(options.onClick));
		}
	}

	private getContent(label = ''): IconLabel {
		if (!this.content.value) {
			const content = (this.content.value = new IconLabel(this.domNode, { label, icon: this.currentIcon }));
			content.element.classList.add('ash-button-content');
			content.labelElement.classList.add('ash-button-label');
			// Hosts can append their own swatches or indicators before the first label is assigned.
			this.domNode.prepend(content.element);
		}
		return this.content.value;
	}

	set enabled(value: boolean) {
		this.domNode.disabled = !value;
	}
	get enabled(): boolean {
		return !this.domNode.disabled;
	}

	focus(): void {
		this.domNode.focus();
	}

	blur(): void {
		this.domNode.blur();
	}

	hasFocus(): boolean {
		return this.domNode.ownerDocument.activeElement === this.domNode;
	}

	set label(value: string) {
		if (!value && !this.currentIcon) this.content.clear();
		else this.getContent().setLabel(value, undefined, { icon: this.currentIcon });
		if (this.usesLabelAsAriaLabel) setAriaAttribute(this.domNode, 'label', value);
	}
	get label(): string {
		return this.content.value?.labelElement.textContent ?? '';
	}

	set icon(value: Icon | undefined) {
		this.currentIcon = value;
		if (!value && !this.label) this.content.clear();
		else this.getContent().setIcon(value);
	}
	get icon(): Icon | undefined {
		return this.currentIcon;
	}

	toggleClassName(className: string, shouldHaveIt?: boolean): void {
		this.root.toggleClassName(className, shouldHaveIt);
	}

	set hidden(value: boolean) {
		if (this.domNode.hidden !== value) this.domNode.hidden = value;
		this.root.toggleClassName('hidden', value);
	}

	get hidden(): boolean {
		return this.domNode.classList.contains('hidden');
	}

	set checked(value: boolean | undefined) {
		this.root.toggleClassName('checked', value === true);
		setAriaAttribute(this.domNode, 'pressed', value);
	}

	get checked(): boolean {
		return this.domNode.classList.contains('checked');
	}

	setTitle(title: string | undefined): void {
		this.hover.clear();
		this.domNode.removeAttribute('title');
		if (!title) return;
		this.hover.value = getHoverDelegate().setupHover({
			target: this.domNode,
			content: title,
			groupId: this.hoverGroupId,
			anchorPosition: this.hoverAnchorPosition,
		});
	}
}

/** A primary button and a related action menu with one shared presentation and lifetime. */
export class ButtonWithDropdown extends Disposable {
	readonly element: HTMLElement;
	readonly primaryButton: Button;
	readonly dropdownButton: Button;
	readonly onDidClick: Event<DOMEventMap['click']>;
	private readonly menu = this._register(new MutableDisposable<CancellationTokenSource>());

	constructor(
		container: HTMLElement,
		private readonly options: IButtonWithDropdownOptions,
	) {
		super();
		this.element = h(container.ownerDocument, 'div', { className: 'ash-button-dropdown' });
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
		this.primaryButton = this._register(new Button(this.element, options));
		this.onDidClick = this.primaryButton.onDidClick;
		const menuLabel = localize('button.moreActions', 'More Actions...');
		this.dropdownButton = this._register(
			new Button(this.element, {
				...options,
				label: menuLabel,
				ariaLabel: menuLabel,
				title: menuLabel,
				icon: Lxicon.chevronDown,
				iconOnly: true,
				contentAlignment: 'groupCentered',
				checked: undefined,
				type: 'button',
				onClick: () => {
					if (this.menu.value) {
						this.hideDropdown();
					} else {
						this.showDropdown();
					}
				},
			}),
		);
		this.dropdownButton.domNode.setAttribute('aria-haspopup', 'menu');
		this.dropdownButton.domNode.setAttribute('aria-expanded', 'false');
		// Follow the rendered border box, including larger fonts and host-specific button sizing.
		this._register(
			observeElementSize(this.primaryButton.domNode, size => {
				if (size.height > 0) {
					this.dropdownButton.domNode.style.width = `${size.height}px`;
				}
			}),
		);
		this._register(
			addDisposableListener(this.element, 'keydown', event => {
				if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && this.dropdownButton.enabled) {
					stopEvent(event);
					this.showDropdown();
				} else if (
					event.key === 'ArrowRight' &&
					event.target === this.primaryButton.domNode &&
					this.dropdownButton.enabled
				) {
					stopEvent(event);
					this.dropdownButton.focus();
				} else if (
					event.key === 'ArrowLeft' &&
					event.target === this.dropdownButton.domNode &&
					this.primaryButton.enabled
				) {
					stopEvent(event);
					this.primaryButton.focus();
				}
			}),
		);
	}

	focus(): void {
		this.primaryButton.focus();
	}

	get enabled(): boolean {
		return this.primaryButton.enabled;
	}
	get label(): string {
		return this.primaryButton.label;
	}
	set label(value: string) {
		this.primaryButton.label = value;
	}
	set enabled(value: boolean) {
		this.primaryButton.enabled = value;
		this.dropdownButton.enabled = value;
		if (!value) {
			this.hideDropdown();
		}
	}

	private showDropdown(): void {
		if (this.isDisposed || !this.dropdownButton.enabled || this.menu.value) {
			return;
		}
		const actions = 'getActions' in this.options.actions ? this.options.actions.getActions() : this.options.actions;
		if (actions.length === 0) {
			return;
		}
		const primary: IAction = {
			id: 'button.primary',
			label: this.primaryButton.label,
			tooltip: '',
			enabled: this.primaryButton.enabled,
			run: () => this.primaryButton.domNode.click(),
		};
		const menuActions =
			this.options.addPrimaryActionToDropdown === false ? actions : [primary, new Separator(), ...actions];
		const menu = new CancellationTokenSource();
		this.menu.value = menu;
		this.dropdownButton.focus();
		this.dropdownButton.domNode.setAttribute('aria-expanded', 'true');
		this.element.classList.add('active');
		try {
			this.options.contextMenuProvider.showContextMenu({
				getAnchor: () => this.dropdownButton.domNode,
				getActions: () => menuActions,
				actionRunner: this.options.actionRunner,
				autoSelectFirstItem: true,
				cancellationToken: menu.token,
				onHide: () => this.didHideMenu(menu),
			});
		} catch (error) {
			this.hideDropdown();
			throw error;
		}
	}

	private hideDropdown(): void {
		const menu = this.menu.value;
		if (!menu) {
			return;
		}
		try {
			menu.cancel();
		} finally {
			this.didHideMenu(menu);
		}
	}

	private didHideMenu(menu: CancellationTokenSource): void {
		// A late hide from a replaced presentation cannot close the current menu.
		if (this.menu.value !== menu) {
			return;
		}
		this.menu.clear();
		this.dropdownButton.domNode.setAttribute('aria-expanded', 'false');
		this.element.classList.remove('active');
	}

	protected override disposeCore(): void {
		try {
			this.hideDropdown();
		} finally {
			super.disposeCore();
		}
	}
}
