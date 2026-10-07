import {
	Disposable,

	toDisposable,
} from "../../../common/lifecycle.js";
import { getWindow, h } from "../../dom.js";
import { disposableWindowInterval } from "../../scheduler.js";
import {
	setAriaAttribute,
	setRole,
} from "../aria/aria.js";

/** A compact four-pixel activity indicator with no image asset dependency. */
export class PixelSpinner extends Disposable {
	readonly element: HTMLSpanElement;
	private step = 0;

	constructor(container: HTMLElement) {
		super();
		const ownerDocument = container.ownerDocument;
		const element = h(ownerDocument, "span");
		this.element = element;
		this._register(toDisposable(() => element.remove()));
		element.className = "ash-pixel-spinner";
		setRole(element, "status");
		setAriaAttribute(element, "label", "Loading");
		element.append(...Array.from({ length: 4 }, () => h(ownerDocument, "i")));
		container.append(element);
		this._register(disposableWindowInterval(
			getWindow(element),
			() => this.render(),
			120,
		));
		this.render();
	}

	private render(): void {
		[...this.element.children].forEach((pixel, index) => pixel.classList.toggle("active", index === this.step));
		this.step = (this.step + 1) % 4;
	}
}
