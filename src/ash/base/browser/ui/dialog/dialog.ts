import './dialog.css';
import { addDisposableListener, getActiveElement, getWindow, h, isHTMLElement } from "../../dom.js";
import { StandardKeyboardEvent } from "../../keyboardEvent.js";
import { Disposable, toDisposable } from "../../../common/lifecycle.js";
import { focusFirst, isTabbable, restoreFocus, trapTabFocus } from "../../focus.js";
import { observeResize } from "../../observer.js";
import { setAriaAttribute } from "../aria/aria.js";
import { Button, type IButtonStyles } from "../button/button.js";
import { InputBox, type IInputBoxStyles } from "../inputbox/inputbox.js";
import { Checkbox, type ICheckboxStyles } from "../toggle/toggle.js";
import { appendIcon } from "../lxicons/lxicon.js";
import { Lxicon } from "../../../common/lxicons.js";
import type { ThemeIcon } from "../../../common/themables.js";
import { localize } from "../../../../nls.js";

let nextDialogId = 1;

export interface IDialogInputOptions {
	readonly placeholder?: string;
	readonly type?: 'text' | 'password';
	readonly value?: string;
}

export enum DialogContentsAlignment {
	Horizontal = 0,
	Vertical,
}

/** Host-provided CSS colors, resolved through the containing theme root. */
export interface IDialogStyles {
	readonly dialogForeground: string | undefined;
	readonly dialogBackground: string | undefined;
	readonly dialogBorder: string | undefined;
	readonly dialogShadow: string | undefined;
	readonly errorIconForeground: string | undefined;
	readonly warningIconForeground: string | undefined;
	readonly infoIconForeground: string | undefined;
	readonly textLinkForeground: string | undefined;
}

/** The base widget owns modal interaction and standard controls; hosts render custom content. */
export interface IDialogOptions {
	readonly cancelId?: number;
	readonly detail?: string;
	readonly detailElement?: HTMLElement;
	readonly alignment?: DialogContentsAlignment;
	readonly checkboxLabel?: string;
	readonly checkboxChecked?: boolean;
	readonly type?: 'none' | 'info' | 'error' | 'question' | 'warning' | 'pending';
	readonly extraClasses?: string[];
	readonly inputs?: IDialogInputOptions[];
	readonly keyEventProcessor?: (event: StandardKeyboardEvent) => void;
	readonly renderBody?: (container: HTMLElement) => void;
	readonly renderFooter?: (container: HTMLElement) => void;
	readonly icon?: ThemeIcon;
	readonly buttonOptions?: Array<undefined | { styleButton?: (button: Button) => void; }>;
	readonly disableCloseAction?: boolean;
	readonly disableCloseButton?: boolean;
	readonly disableDefaultAction?: boolean;
	readonly onVisibilityChange?: (window: Window, visible: boolean) => void;
	readonly buttonStyles: IButtonStyles;
	readonly checkboxStyles: ICheckboxStyles;
	readonly inputBoxStyles: IInputBoxStyles;
	readonly dialogStyles: IDialogStyles;
}

export interface IDialogResult {
	readonly button: number;
	readonly checkboxChecked?: boolean;
	readonly values?: string[];
}

/** A service-independent dialog with native top-layer modality and index-based results. */
export class Dialog extends Disposable {
	private readonly element: HTMLDialogElement;
	private readonly headingDomNode: HTMLHeadingElement;
	private readonly bodyDomNode: HTMLElement;
	private readonly inputs: InputBox[] = [];
	private readonly buttons: Button[] = [];
	private readonly checkbox: Checkbox | undefined;
	private resolve: ((result: IDialogResult) => void) | undefined;
	private shown = false;
	private visible = false;
	private focusToReturn: HTMLElement | undefined;

	constructor(container: HTMLElement, message: string, buttons: string[] | undefined, private readonly options: IDialogOptions) {
		super();
		const ownerDocument = container.ownerDocument;
		const element = h(ownerDocument, "dialog");
		this.element = element;
		element.className = "ash-dialog";
		element.classList.add(...(options.extraClasses ?? []));
		element.classList.toggle("ash-dialog-vertical", options.alignment === DialogContentsAlignment.Vertical);
		if (options.type) element.dataset.dialogSeverity = options.type;
		const colors = {
			'--ash-dialog-style-dialog-foreground': options.dialogStyles.dialogForeground,
			'--ash-dialog-style-dialog-background': options.dialogStyles.dialogBackground,
			'--ash-dialog-style-dialog-border': options.dialogStyles.dialogBorder,
			'--ash-dialog-style-dialog-shadow': options.dialogStyles.dialogShadow,
		};
		for (const [property, value] of Object.entries(colors)) {
			if (value !== undefined) element.style.setProperty(property, value);
		}
		element.tabIndex = -1;
		element.setAttribute("aria-modal", "true");
		const header = h(ownerDocument, "header", { className: "ash-dialog-header" });
		if (options.icon || options.type && options.type !== 'none') {
			const icon = h(ownerDocument, "span", { className: "ash-dialog-icon", attributes: { 'aria-hidden': 'true' } });
			appendIcon(options.icon ?? (options.type === 'error' ? Lxicon.dialogError : options.type === 'warning' ? Lxicon.dialogWarning : Lxicon.dialogInfo), icon);
			const color = options.type === 'error' ? options.dialogStyles.errorIconForeground : options.type === 'warning' ? options.dialogStyles.warningIconForeground : options.dialogStyles.infoIconForeground;
			if (color) icon.style.color = color;
			header.append(icon);
		}
		this.headingDomNode = h(ownerDocument, "h2", { className: "ash-dialog-title" });
		this.headingDomNode.id = "ash-dialog-title-" + nextDialogId++;
		this.updateMessage(message);
		setAriaAttribute(element, "labelledby", this.headingDomNode.id);
		header.append(this.headingDomNode);
		if (!options.disableCloseAction && !options.disableCloseButton) {
			const close = this._register(new Button(header, {
				...options.buttonStyles,
				label: localize('dialogClose', 'Close Dialog'),
				icon: Lxicon.dialogClose,
				iconOnly: true,
				onClick: () => this.finish(options.cancelId ?? 0),
			}));
			close.domNode.classList.add("ash-dialog-close");
		}
		const body = h(ownerDocument, "div", { className: "ash-dialog-body" });
		this.bodyDomNode = body;
		options.renderBody?.(body);
		if (options.detailElement || options.detail) {
			const detail = h(ownerDocument, "div", { className: "ash-dialog-detail" });
			detail.id = this.headingDomNode.id + "-detail";
			if (options.detailElement) detail.append(options.detailElement);
			else detail.textContent = options.detail!;
			body.append(detail);
			setAriaAttribute(element, "describedby", detail.id);
			// Scrollability changes with viewport size, not with the message's character count.
			const updateFocusability = (): void => {
				if (detail.scrollHeight > detail.clientHeight) detail.tabIndex = 0;
				else detail.removeAttribute("tabindex");
			};
			this._register(observeResize(detail, updateFocusability));
		}
		if (options.inputs?.length) {
			const inputContainer = h(ownerDocument, "div", { className: "ash-dialog-inputs" });
			body.append(inputContainer);
			for (const [index, inputOptions] of options.inputs.entries()) {
				const input = this._register(new InputBox(inputContainer, {
					inputBoxStyles: options.inputBoxStyles,
					type: inputOptions.type,
					placeholder: inputOptions.placeholder,
					presentation: "field",
					ariaLabel: inputOptions.placeholder ?? localize('dialog.inputNumber', '{0}, field {1}', message, index + 1),
				}));
				input.value = inputOptions.value ?? "";
				this.inputs.push(input);
			}
		}
		if (options.checkboxLabel) {
			this.checkbox = this._register(new Checkbox(body, {
				...options.checkboxStyles,
				label: options.checkboxLabel,
				checked: options.checkboxChecked,
			}));
		}
		if (options.renderFooter) {
			const footer = h(ownerDocument, "footer", { className: "ash-dialog-footer" });
			body.append(footer);
			options.renderFooter(footer);
		}
		const labels = buttons?.length ? buttons : options.disableDefaultAction ? [] : [localize('dialog.ok', 'OK')];
		if (labels.length) {
			const actions = h(ownerDocument, "footer", { className: "ash-dialog-actions" });
			for (const [index, label] of labels.entries()) {
				const button = this._register(new Button(actions, {
					...options.buttonStyles,
					label,
					presentation: index === 0 ? "primary" : "secondary",
					onClick: () => this.finish(index),
				}));
				this.buttons.push(button);
				options.buttonOptions?.[index]?.styleButton?.(button);
			}
			body.append(actions);
		}
		for (const link of body.querySelectorAll<HTMLAnchorElement>("a")) {
			link.tabIndex = 0;
			if (options.dialogStyles.textLinkForeground) {
				link.style.color = options.dialogStyles.textLinkForeground;
				link.style.textDecoration = "underline";
			}
		}
		element.append(header, body);
		container.append(element);
		this._register(addDisposableListener(element, "keydown", event => {
			options.keyEventProcessor?.(new StandardKeyboardEvent(event));
			if (event.defaultPrevented || event.isComposing) return;
			if (event.key === "Escape") {
				// Native search fields consume Escape before the dialog's cancel event.
				event.preventDefault();
				event.stopPropagation();
				if (!options.disableCloseAction) this.finish(options.cancelId ?? 0);
				return;
			}
			if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
				const focused = getActiveElement(ownerDocument);
				if (!this.buttons.some(button => button.domNode.contains(focused))) return;
				// CSS and RTL can change the visual order without changing result indices.
				const available = this.buttons.filter(button => isTabbable(button.domNode))
					.map(button => ({ button, left: button.domNode.getBoundingClientRect().left }))
					.sort((left, right) => left.left - right.left);
				const index = available.findIndex(({ button }) => button.domNode.contains(focused));
				if (index >= 0) {
					const next = (index + (event.key === "ArrowRight" ? 1 : -1) + available.length) % available.length;
					event.preventDefault();
					available[next].button.focus();
				}
				return;
			}
			if (event.key !== "Enter" || options.disableDefaultAction) return;
			const target = event.target;
			if (isHTMLElement(target) && (target.closest("button, textarea, select, [contenteditable], [role=combobox]"))) return;
			const primary = this.buttons[0];
			if (primary?.enabled) {
				event.preventDefault();
				this.finish(0);
			}
		}));
		this._register(addDisposableListener(element, "cancel", event => {
			event.preventDefault();
			if (!options.disableCloseAction) this.finish(options.cancelId ?? 0);
		}));
		this._register(addDisposableListener(element, "close", () => this.finish(options.cancelId ?? 0)));
		this._register(trapTabFocus(element));
		this._register(toDisposable(() => {
			this.finish(options.cancelId ?? 0);
			element.remove();
		}));
	}

	public updateMessage(message: string): void {
		this.headingDomNode.textContent = message;
		this.headingDomNode.title = message;
	}

	public show(): Promise<IDialogResult> {
		this.assertNotDisposed();
		if (this.shown) throw new Error("Dialog instances can only be shown once");
		this.shown = true;
		const activeElement = getActiveElement(this.element.ownerDocument);
		if (isHTMLElement(activeElement)) this.focusToReturn = activeElement;
		const result = new Promise<IDialogResult>(resolve => { this.resolve = resolve; });
		try {
			this.element.showModal();
			this.visible = true;
			this.options.onVisibilityChange?.(getWindow(this.element), true);
			if (this.inputs.length) this.inputs[0].focus();
			else if (!focusFirst(this.bodyDomNode)) this.element.focus();
		} catch (error) {
			this.finish(this.options.cancelId ?? 0);
			throw error;
		}
		return result;
	}

	private finish(button: number): void {
		const resolve = this.resolve;
		if (!resolve) return;
		this.resolve = undefined;
		const result: IDialogResult = {
			button,
			...(this.checkbox ? { checkboxChecked: this.checkbox.checked } : {}),
			...(this.inputs.length ? { values: this.inputs.map(input => input.value) } : {}),
		};
		if (this.element.open) this.element.close();
		try {
			if (this.visible) {
				this.visible = false;
				this.options.onVisibilityChange?.(getWindow(this.element), false);
			}
		} finally {
			restoreFocus(this.focusToReturn);
			resolve(result);
		}
	}
}
