import { addDisposableListener, h } from "../../dom.js";
import { Disposable, toDisposable } from "../../../common/lifecycle.js";
import {
	focusFirst,
	trapTabFocus,
} from "../../focus.js";
import { setAriaAttribute } from "../aria/aria.js";

let nextDialogId = 1;

export interface DialogOptions {
	readonly title: string;
	readonly content: Element | string;
}

/** A modal dialog backed by the browser's native dialog element. */
export class Dialog extends Disposable {
	readonly element: HTMLDialogElement;
	private resolve: ((result: string) => void) | undefined;
	private shown = false;

	constructor(container: HTMLElement, options: DialogOptions) {
		super();
		const ownerDocument = container.ownerDocument;
		const element = h(ownerDocument, "dialog");
		this.element = element;
		this._register(toDisposable(() => element.remove()));
		element.className = "ash-dialog";
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
		element.append(heading, body);
		container.append(element);
		this._register(addDisposableListener(element, "close", () => {
			this.finish(element.returnValue);
		}));
		this._register(trapTabFocus(element));
		this._register(toDisposable(() => {
			if (element.open) element.close();
			this.finish("");
		}));
	}

	show(): Promise<string> {
		if (this.shown) {
			throw new Error("Dialog instances can only be shown once");
		}
		this.shown = true;
		const result = new Promise<string>((resolve) => {
			this.resolve = resolve;
		});
		try {
			this.element.showModal();
			focusFirst(this.element);
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
		resolve(result);
	}
}
