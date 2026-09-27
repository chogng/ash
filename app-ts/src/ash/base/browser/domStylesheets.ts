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

export interface IClonedDocumentStyles extends IDisposable {
	readonly whenStylesHaveLoaded: Promise<void>;
}

/** Mirrors stylesheet nodes while retaining unchanged links and their loaded state. */
export function cloneDocumentStyles(
	sourceDocument: Document,
	targetDocument: Document,
): IClonedDocumentStyles {
	const store = new DisposableStore();
	const clones = new Map<HTMLStyleElement | HTMLLinkElement, HTMLStyleElement | HTMLLinkElement>();
	const pendingLoads = new Set<Promise<void>>();
	const finishLoads = new Map<HTMLLinkElement, () => void>();
	const anchor = targetDocument.createComment('mirrored styles');
	targetDocument.head.append(anchor);
	const trackLinkLoad = (link: HTMLLinkElement): void => {
		finishLoads.get(link)?.();
		let finish!: () => void;
		const loaded = new Promise<void>(resolve => {
			finish = () => {
				link.removeEventListener('load', finish);
				link.removeEventListener('error', finish);
				finishLoads.delete(link);
				resolve();
			};
		});
		finishLoads.set(link, finish);
		pendingLoads.add(loaded);
		void loaded.then(() => pendingLoads.delete(loaded));
		link.addEventListener('load', finish);
		link.addEventListener('error', finish);
	};
	const removeClone = (source: HTMLStyleElement | HTMLLinkElement): void => {
		const clone = clones.get(source);
		if (!clone) return;
		if (clone.tagName === 'LINK') finishLoads.get(clone as HTMLLinkElement)?.();
		clone.remove();
		clones.delete(source);
	};
	store.add(toDisposable(() => {
		for (const source of clones.keys()) removeClone(source);
		anchor.remove();
	}));
	const synchronize = (): void => {
		const styles = [...sourceDocument.head.querySelectorAll<HTMLStyleElement | HTMLLinkElement>('style, link[rel="stylesheet"]')];
		const live = new Set(styles);
		for (const source of clones.keys()) if (!live.has(source)) removeClone(source);
		for (const source of styles) {
			let clone = clones.get(source);
			if (!clone) {
				clone = source.cloneNode(true) as HTMLStyleElement | HTMLLinkElement;
				clones.set(source, clone);
				if (source.tagName === 'LINK') {
					const link = clone as HTMLLinkElement;
					trackLinkLoad(link);
					link.href = (source as HTMLLinkElement).href;
				}
			} else {
				for (const attribute of [...clone.attributes]) {
					if (!source.hasAttribute(attribute.name)) clone.removeAttribute(attribute.name);
				}
				for (const attribute of [...source.attributes]) {
					const value = attribute.name === 'href' && source.tagName === 'LINK' ? (source as HTMLLinkElement).href : attribute.value;
					if (clone.getAttribute(attribute.name) !== value) {
						if (attribute.name === 'href' && source.tagName === 'LINK') trackLinkLoad(clone as HTMLLinkElement);
						clone.setAttribute(attribute.name, value);
					}
				}
				if (source.tagName === 'STYLE' && clone.textContent !== source.textContent) clone.textContent = source.textContent;
			}
		}
		let next: Node = anchor;
		for (let index = styles.length - 1; index >= 0; index--) {
			const clone = clones.get(styles[index]!)!;
			if (clone.nextSibling !== next) targetDocument.head.insertBefore(clone, next);
			next = clone;
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
	return {
		get whenStylesHaveLoaded() { return Promise.all([...pendingLoads]).then(() => undefined); },
		dispose: () => store.dispose(),
		[Symbol.dispose]: () => store.dispose(),
	};
}
