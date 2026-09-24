import { h } from "../../dom.js";
import { DomEmitter, type DOMEventMap } from "../../event.js";
import { FastDomNode } from "../../fastDomNode.js";
import type { Icon } from "../../../common/icon.js";
import type { Event } from "../../../common/event.js";
import { Disposable, MutableDisposable, toDisposable } from "../../../common/lifecycle.js";
import { setAriaAttribute } from "../aria/aria.js";
import type { AnchorPosition } from "../contextview/contextview.js";
import { getHoverDelegate, type IManagedHover } from "../hover/hoverDelegate.js";
import { IconLabel } from "../iconlabel/iconlabel.js";

/** Controls whether a button centers its complete content group or its text label. */
export type ButtonContentAlignment = "groupCentered" | "labelCentered";

/** Domain-neutral visual treatment selected by button consumers. */
export type ButtonPresentation = "quiet" | "primary" | "secondary" | "danger";

/** Standard button sizing shared across product surfaces. */
export type ButtonSize = "standard" | "small";

export interface ButtonOptions {
	label: string;
	icon?: Icon;
	ariaLabel?: string;
	contentAlignment?: ButtonContentAlignment;
	presentation?: ButtonPresentation;
	size?: ButtonSize;
	type?: "button" | "submit" | "reset";
	title?: string;
	hoverGroupId?: string;
	hoverAnchorPosition?: AnchorPosition;
	enabled?: boolean;
	checked?: boolean;
	onClick?: (event: DOMEventMap["click"]) => void;
}

/** A semantic button with an explicit enabled state. */
export class Button extends Disposable {
	readonly domNode: HTMLButtonElement;
	private readonly root: FastDomNode<HTMLButtonElement>;
	private readonly content: IconLabel;
	private readonly hover = this._register(new MutableDisposable<IManagedHover>());
	private readonly hoverGroupId: string | undefined;
	private readonly hoverAnchorPosition: AnchorPosition | undefined;
	private currentIcon: Icon | undefined;
	readonly onDidClick: Event<DOMEventMap["click"]>;

	constructor(container: HTMLElement, options: ButtonOptions) {
		super();
		const ownerDocument = container.ownerDocument;
		this.hoverGroupId = options.hoverGroupId;
		this.hoverAnchorPosition = options.hoverAnchorPosition;
		this.currentIcon = options.icon;
		const domNode = h(ownerDocument, "button", {
			properties: {
				type: options.type ?? "button",
				disabled: options.enabled === false,
			},
		});
		this._register(toDisposable(() => domNode.remove()));
		const root = new FastDomNode(domNode);
		root.setClassName([
			"ash-button",
			`ash-button-${options.presentation ?? "quiet"}`,
			`ash-button-${options.size ?? "standard"}`,
			options.contentAlignment === "labelCentered" && "label-centered",
		].filter(value => value !== false).join(" "));
		this.root = root;
		this.domNode = root.domNode;
		if (options.ariaLabel) {
			setAriaAttribute(this.domNode, "label", options.ariaLabel);
		}
		this.content = this._register(new IconLabel(this.domNode, {
			label: options.label,
			icon: options.icon,
		}));
		this.content.element.classList.add("ash-button-content");
		this.content.labelElement.classList.add("ash-button-label");
		container.append(this.domNode);
		this.setTitle(options.title);
		if (options.checked !== undefined) {
			this.checked = options.checked;
		}
		this.onDidClick = this._register(new DomEmitter(this.domNode, "click")).event;
		if (options.onClick) {
			this._register(this.onDidClick(options.onClick));
		}
	}

	set enabled(value: boolean) { this.domNode.disabled = !value; }
	get enabled(): boolean { return !this.domNode.disabled; }

	focus(): void { this.domNode.focus(); }

	blur(): void { this.domNode.blur(); }

	hasFocus(): boolean { return this.domNode.ownerDocument.activeElement === this.domNode; }

	set label(value: string) { this.content.setLabel(value, undefined, { icon: this.currentIcon }); }
	get label(): string { return this.content.labelElement.textContent ?? ""; }

	set icon(value: Icon | undefined) {
		this.currentIcon = value;
		this.content.setIcon(value);
	}
	get icon(): Icon | undefined { return this.currentIcon; }

	toggleClassName(className: string, shouldHaveIt?: boolean): void {
		this.root.toggleClassName(className, shouldHaveIt);
	}

	set hidden(value: boolean) {
		if (this.domNode.hidden !== value) this.domNode.hidden = value;
		this.root.toggleClassName("hidden", value);
	}

	get hidden(): boolean { return this.domNode.classList.contains("hidden"); }

	set checked(value: boolean | undefined) {
		this.root.toggleClassName("checked", value === true);
		setAriaAttribute(this.domNode, "pressed", value);
	}

	get checked(): boolean { return this.domNode.classList.contains("checked"); }

	setTitle(title: string | undefined): void {
		this.hover.clear();
		this.domNode.removeAttribute("title");
		if (!title) return;
		this.hover.value = getHoverDelegate().setupHover({
			target: this.domNode,
			content: title,
			groupId: this.hoverGroupId,
			anchorPosition: this.hoverAnchorPosition,
		});
	}
}
