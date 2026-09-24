import {
	Disposable,
	DisposableStore,
	type IDisposable,
	toDisposable,
} from "../common/lifecycle.js";
import { observeMutations } from "./observer.js";
import {
	type BrowserWindow,
	getWindows,
	onDidRegisterWindow,
	onWillUnregisterWindow,
} from "./window.js";
import { h } from "./dom.js";

/** A disposable stylesheet attached to one document. */
export class ManagedStyleSheet extends Disposable {
	readonly element: HTMLStyleElement;

	constructor(
		ownerDocument: Document,
		cssText = "",
	) {
		super();
		const element = h(ownerDocument, "style");
		this.element = element;
		element.type = "text/css";
		element.media = "screen";
		element.textContent = cssText;
		ownerDocument.head.append(element);
		this._register(toDisposable(() => element.remove()));
	}

	setText(cssText: string): void {
		if (this.element.textContent !== cssText) {
			this.element.textContent = cssText;
		}
	}
}

/**
 * Keeps the same dynamic stylesheet attached to every registered browser
 * window.
 */
export class GlobalStyleSheet extends Disposable {
	private readonly styles = new Map<BrowserWindow, ManagedStyleSheet>();
	private cssText: string;

	constructor(cssText = "") {
		super();
		this.cssText = cssText;
		for (const registration of getWindows()) {
			this.attach(registration.window);
		}
		this._register(onDidRegisterWindow(({ window }) => this.attach(window)));
		this._register(onWillUnregisterWindow(({ window }) => this.detach(window)));
		this._register(toDisposable(() => this.styles.clear()));
	}

	setText(cssText: string): void {
		if (cssText === this.cssText) return;
		this.cssText = cssText;
		for (const style of this.styles.values()) style.setText(cssText);
	}

	private attach(targetWindow: BrowserWindow): void {
		if (this.styles.has(targetWindow)) return;
		const style = this._register(
			new ManagedStyleSheet(targetWindow.document, this.cssText),
		);
		this.styles.set(targetWindow, style);
	}

	private detach(targetWindow: BrowserWindow): void {
		const style = this.styles.get(targetWindow);
		if (!style) return;
		this.styles.delete(targetWindow);
		style.dispose();
	}
}

export function createStyleSheet(
	ownerDocument: Document,
	cssText = "",
): {
	readonly element: HTMLStyleElement;
	readonly registration: IDisposable;
} {
	const element = h(ownerDocument, "style");
	element.type = "text/css";
	element.media = "screen";
	element.textContent = cssText;
	ownerDocument.head.append(element);
	return {
		element,
		registration: toDisposable(() => element.remove()),
	};
}

/**
 * Mirrors style and stylesheet-link elements into another document. The
 * returned registration owns both the clones and mutation tracking.
 */
export function cloneDocumentStyles(
	sourceDocument: Document,
	targetDocument: Document,
): IDisposable {
	const store = new DisposableStore();
	const clones = store.add(new DisposableStore());
	const synchronize = (): void => {
		clones.clear();
		const styles = sourceDocument.head.querySelectorAll<
			HTMLStyleElement | HTMLLinkElement
		>('style, link[rel="stylesheet"]');
		for (const source of styles) {
			const clone = source.cloneNode(true) as
				HTMLStyleElement | HTMLLinkElement;
			if (source.tagName === "LINK") {
				(clone as HTMLLinkElement).href =
					(source as HTMLLinkElement).href;
			}
			targetDocument.head.append(clone);
			clones.add(toDisposable(() => clone.remove()));
		}
	};
	synchronize();
	store.add(observeMutations(
		sourceDocument.head,
		synchronize,
		{
			attributes: true,
			childList: true,
			characterData: true,
			subtree: true,
		},
	));
	return store;
}
