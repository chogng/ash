import { addDisposableListener, getActiveElement, h, isHTMLElement } from "../../dom.js";
import { Disposable, toDisposable } from "../../../common/lifecycle.js";
import {
	focusFirst,
	restoreFocus,
	trapTabFocus,
} from "../../focus.js";
import { setAriaAttribute } from "../aria/aria.js";
import { Button, type ButtonPresentation } from "../button/button.js";

let nextDialogId = 1;

export interface DialogOptions {
	readonly title: string;
	readonly content: Element | string;
	readonly buttons?: readonly DialogButton[];
	readonly cancelValue?: string;
}

export interface DialogButton {
	readonly label: string;
	readonly value: string;
	readonly presentation?: ButtonPresentation;
}

/** A modal dialog backed by the browser's native dialog element. */
export class Dialog extends Disposable {
	readonly element: HTMLDialogElement;
	private resolve: ((result: string) => void) | undefined;
	private shown = false;
	private focusToReturn: HTMLElement | undefined;

	constructor(container: HTMLElement, options: DialogOptions) {
		super();
		const ownerDocument = container.ownerDocument;
		const element = h(ownerDocument, "dialog");
		this.element = element;
		element.className = "ash-dialog";
		element.tabIndex = -1;
		const heading = h(ownerDocument, "h2");
		heading.className = "ash-dialog-title";
		heading.id = `ash-dialog-title-${nextDialogId++}`;
		heading.textContent = options.title;
		setAriaAttribute(element, "labelledby", heading.id);
		const body = h(ownerDocument, "div");
		body.className = "ash-dialog-body";
		if (typeof options.content === "string") {
			body.textContent = options.content;
		} else {
			body.append(options.content);
		}
		if (options.buttons?.length) {
			const actions = h(ownerDocument, "footer");
			actions.className = "ash-dialog-actions";
			for (const option of options.buttons) {
				this._register(new Button(actions, {
					label: option.label,
					presentation: option.presentation,
					onClick: () => this.close(option.value),
				}));
			}
			body.append(actions);
		}
		element.append(heading, body);
		container.append(element);
		this._register(addDisposableListener(element, "cancel", (event) => {
			event.preventDefault();
			this.close(options.cancelValue ?? "");
		}));
		this._register(addDisposableListener(element, "close", () => {
			this.finish(element.returnValue);
		}));
		this._register(trapTabFocus(element));
		this._register(toDisposable(() => {
			if (element.open) {
				element.close(options.cancelValue ?? "");
			}
			this.finish(options.cancelValue ?? "");
			element.remove();
		}));
	}

	show(): Promise<string> {
		if (this.shown) {
			throw new Error("Dialog instances can only be shown once");
		}
		this.shown = true;
		const activeElement = getActiveElement(this.element.ownerDocument);
		if (isHTMLElement(activeElement)) {
			this.focusToReturn = activeElement;
		}
		const result = new Promise<string>((resolve) => {
			this.resolve = resolve;
		});
		try {
			this.element.showModal();
			if (!focusFirst(this.element)) {
				this.element.focus();
			}
		} catch (error) {
			this.resolve = undefined;
			throw error;
		}
		return result;
	}

	close(result = ""): void {
		if (!this.element.open) return;
		this.element.close(result);
		this.finish(result);
	}

	private finish(result: string): void {
		const resolve = this.resolve;
		if (!resolve) return;
		this.resolve = undefined;
		restoreFocus(this.focusToReturn);
		resolve(result);
	}
}
