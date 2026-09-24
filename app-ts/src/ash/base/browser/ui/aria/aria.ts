import {
	Disposable,
	MutableDisposable,
	type IDisposable,

	toDisposable,
} from "../../../common/lifecycle.js";
import { scheduleAtNextAnimationFrame } from "../../scheduler.js";
import { h } from "../../dom.js";

export type AriaRole =
	| "alert"
	| "button"
	| "combobox"
	| "dialog"
	| "listbox"
	| "menu"
	| "menuitem"
	| "option"
	| "status"
	| "textbox"
	| (string & {});

export type AriaAutoComplete = "none" | "inline" | "list" | "both";
export type AriaLivePriority = "polite" | "assertive";
export type AriaAttribute =
	| "activedescendant"
	| "atomic"
	| "autocomplete"
	| "checked"
	| "controls"
	| "describedby"
	| "disabled"
	| "expanded"
	| "haspopup"
	| "hidden"
	| "invalid"
	| "label"
	| "labelledby"
	| "live"
	| "pressed"
	| "selected";
export type AriaAttributeValue =
	| string
	| number
	| boolean
	| null
	| undefined;

/** Sets or removes one ARIA attribute while preserving boolean false. */
export function setAriaAttribute(
	element: Element,
	attribute: AriaAttribute,
	value: AriaAttributeValue,
): void {
	const name = `aria-${attribute}`;
	if (value === undefined || value === null) {
		element.removeAttribute(name);
	} else {
		element.setAttribute(name, String(value));
	}
}

/** Reads one ARIA attribute without exposing DOM null semantics. */
export function getAriaAttribute(
	element: Element,
	attribute: AriaAttribute,
): string | undefined {
	return element.getAttribute(`aria-${attribute}`) ?? undefined;
}

/** Sets or removes an element's semantic role. */
export function setRole(
	element: Element,
	role: AriaRole | undefined,
): void {
	if (role === undefined) {
		element.removeAttribute("role");
	} else {
		element.setAttribute("role", role);
	}
}

/**
 * Owns screen-reader status and alert regions for one document.
 *
 * Callers should create one region per UI root and dispose it with that root.
 */
export class AriaLiveRegion extends Disposable {
	private readonly root: HTMLDivElement;
	private readonly polite: readonly [HTMLDivElement, HTMLDivElement];
	private readonly assertive: readonly [HTMLDivElement, HTMLDivElement];
	private readonly pending = this._register(new MutableDisposable<IDisposable>());
	private politeIndex = 0;
	private assertiveIndex = 0;

	constructor(ownerDocument: Document, container: HTMLElement = ownerDocument.body) {
		super();
		this.root = h(ownerDocument, "div");
		this.root.className = "ash-aria-live";
		this.polite = [
			this.createRegion(ownerDocument, "polite"),
			this.createRegion(ownerDocument, "polite"),
		];
		this.assertive = [
			this.createRegion(ownerDocument, "assertive"),
			this.createRegion(ownerDocument, "assertive"),
		];
		this.root.append(...this.polite, ...this.assertive);
		container.append(this.root);
		this._register(toDisposable(() => this.root.remove()));
	}

	status(message: string): void {
		this.announce(message, "polite");
	}

	alert(message: string): void {
		this.announce(message, "assertive");
	}

	announce(
		message: string,
		priority: AriaLivePriority = "polite",
	): void {
		const regions = priority === "assertive"
			? this.assertive
			: this.polite;
		const index = priority === "assertive"
			? this.assertiveIndex
			: this.politeIndex;
		const target = regions[index];
		const alternate = regions[index === 0 ? 1 : 0];
		if (priority === "assertive") {
			this.assertiveIndex = index === 0 ? 1 : 0;
		} else {
			this.politeIndex = index === 0 ? 1 : 0;
		}
		this.pending.clear();
		target.textContent = "";
		alternate.textContent = "";
		const targetWindow = target.ownerDocument.defaultView;
		if (!targetWindow) return;
		this.pending.value = scheduleAtNextAnimationFrame(
			targetWindow,
			() => {
				this.pending.clear();
				target.textContent = message.slice(0, maximumMessageLength);
			},
		);
	}

	clear(): void {
		this.pending.clear();
		for (const region of [...this.polite, ...this.assertive]) {
			region.textContent = "";
		}
	}

	private createRegion(
		ownerDocument: Document,
		priority: AriaLivePriority,
	): HTMLDivElement {
		const region = h(ownerDocument, "div");
		region.className = priority === "assertive"
			? "ash-aria-alert"
			: "ash-aria-status";
		if (priority === "assertive") {
			setRole(region, "alert");
		} else {
			setAriaAttribute(region, "live", "polite");
		}
		setAriaAttribute(region, "atomic", true);
		return region;
	}
}

const maximumMessageLength = 20_000;

let ariaLiveRegion: AriaLiveRegion | undefined;

export function setARIAContainer(parent: HTMLElement): void {
	ariaLiveRegion?.dispose();
	ariaLiveRegion = new AriaLiveRegion(parent.ownerDocument, parent);
}

export function alert(message: string): void {
	getARIAContainer().alert(message);
}

export function status(message: string): void {
	getARIAContainer().status(message);
}

function getARIAContainer(): AriaLiveRegion {
	if (!ariaLiveRegion) throw new Error("ARIA container has not been initialized");
	return ariaLiveRegion;
}
