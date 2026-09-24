import { Emitter, type Event } from "../common/event.js";
import {
	Disposable,
	MutableDisposable,
	type IDisposable,
} from "../common/lifecycle.js";
import {
	addDisposableListener,
	getActiveDocument,
	getActiveElement,
	getWindow,
	isAncestor,
	isHTMLElement,
	isNode,
} from "./dom.js";
import { disposableWindowTimeout } from "./scheduler.js";
import {
	type BrowserWindow,
	isWindow,
} from "./window.js";

export interface IFocusTracker extends IDisposable {
	readonly onDidFocus: Event<void>;
	readonly onDidBlur: Event<void>;
	readonly hasFocus: boolean;
	refreshState(): void;
}

const tabbableSelector = [
	"a[href]",
	"area[href]",
	"button",
	"input",
	"select",
	"textarea",
	"iframe",
	"object",
	"embed",
	"audio[controls]",
	"video[controls]",
	"summary",
	"[contenteditable]",
	"[tabindex]",
].join(",");

export enum FocusNavigationDirection {
	Forward,
	Backward,
}

export enum FocusNavigationBoundary {
	Stop,
	Wrap,
}

export function isActiveElement(element: Element): boolean {
	return getActiveElement(element.ownerDocument) === element;
}

export function isAncestorOfActiveElement(ancestor: Element): boolean {
	return isComposedAncestor(
		getActiveElement(ancestor.ownerDocument),
		ancestor,
	);
}

export function trackFocus(
	target: HTMLElement | BrowserWindow,
): IFocusTracker {
	return new FocusTracker(target);
}

/** Focuses an element without changing the scroll positions of its ancestors. */
export function focusPreservingScroll(element: HTMLElement): void {
	const positions = saveAncestorScrollPositions(element);
	element.focus({ preventScroll: true });
	restoreAncestorScrollPositions(positions);
}

/** Restores focus only while the captured element remains connected. */
export function restoreFocus(
	element: HTMLElement | null | undefined,
): boolean {
	if (!element?.isConnected) return false;
	focusPreservingScroll(element);
	return isAncestorOfActiveElement(element);
}

/**
 * Returns whether an element can receive programmatic focus in its current
 * rendered and enabled state.
 */
export function isFocusable(element: HTMLElement): boolean {
	if (!element.isConnected || isUnavailableForFocus(element)) return false;
	if (element.hasAttribute("tabindex")) return true;
	if (element.isContentEditable) return true;
	switch (element.tagName) {
		case "A":
		case "AREA":
			return element.hasAttribute("href");
		case "BUTTON":
		case "INPUT":
		case "SELECT":
		case "TEXTAREA":
		case "IFRAME":
		case "OBJECT":
		case "EMBED":
		case "SUMMARY":
			return true;
		case "AUDIO":
		case "VIDEO":
			return element.hasAttribute("controls");
		default:
			return false;
	}
}

/** Returns whether an element participates in sequential Tab navigation. */
export function isTabbable(element: HTMLElement): boolean {
	return isFocusable(element) &&
		element.tabIndex >= 0 &&
		isTabbableRadio(element);
}

/**
 * Returns tabbable descendants in browser navigation order: positive
 * `tabindex` values first, then normal DOM order.
 */
export function getTabbableElements(
	container: ParentNode,
): readonly HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>(tabbableSelector))
		.filter(isTabbable)
		.map((element, order) => ({ element, order }))
		.sort((left, right) => {
			const leftIndex = left.element.tabIndex;
			const rightIndex = right.element.tabIndex;
			if (leftIndex > 0 && rightIndex <= 0) return -1;
			if (leftIndex <= 0 && rightIndex > 0) return 1;
			if (leftIndex > 0 && rightIndex > 0 && leftIndex !== rightIndex) {
				return leftIndex - rightIndex;
			}
			return left.order - right.order;
		})
		.map(({ element }) => element);
}

export function focusFirst(container: ParentNode): HTMLElement | undefined {
	const first = getTabbableElements(container)[0];
	if (first) focusPreservingScroll(first);
	return first;
}

export function focusLast(container: ParentNode): HTMLElement | undefined {
	const elements = getTabbableElements(container);
	const last = elements[elements.length - 1];
	if (last) focusPreservingScroll(last);
	return last;
}

/**
 * Moves focus through the tabbable descendants of a container.
 *
 * `boundary` makes wrapping explicit at call sites instead of encoding it as
 * an ambiguous boolean argument.
 */
export function moveFocus(
	container: ParentNode,
	direction: FocusNavigationDirection,
	boundary: FocusNavigationBoundary = FocusNavigationBoundary.Stop,
): HTMLElement | undefined {
	const elements = getTabbableElements(container);
	if (elements.length === 0) return undefined;
	const ownerDocument = getOwnerDocument(container);
	const activeElement = getActiveElement(ownerDocument);
	const currentIndex = elements.findIndex((element) =>
		element === activeElement
	);
	let nextIndex = direction === FocusNavigationDirection.Forward
		? currentIndex + 1
		: currentIndex < 0 ? elements.length - 1 : currentIndex - 1;

	if (nextIndex < 0 || nextIndex >= elements.length) {
		if (boundary === FocusNavigationBoundary.Stop) return undefined;
		nextIndex = nextIndex < 0 ? elements.length - 1 : 0;
	}

	const next = elements[nextIndex];
	if (next) focusPreservingScroll(next);
	return next;
}

/** Keeps sequential Tab navigation inside a container until disposed. */
export function trapTabFocus(container: HTMLElement): IDisposable {
	return addDisposableListener(container, "keydown", (event: KeyboardEvent) => {
		if (
			event.isComposing ||
			event.key !== "Tab" ||
			event.altKey ||
			event.ctrlKey ||
			event.metaKey
		) {
			return;
		}
		const direction = event.shiftKey
			? FocusNavigationDirection.Backward
			: FocusNavigationDirection.Forward;
		const next = moveFocus(
			container,
			direction,
			FocusNavigationBoundary.Wrap,
		);
		if (next || isAncestorOfActiveElement(container)) {
			event.preventDefault();
		}
	}, true);
}

export interface ScrollPosition {
	readonly element: Element;
	readonly left: number;
	readonly top: number;
}

export function saveAncestorScrollPositions(
	node: Element,
): readonly ScrollPosition[] {
	const positions: ScrollPosition[] = [];
	for (let current = composedParent(node); current; current = composedParent(
		current,
	)) {
		positions.push({
			element: current,
			left: current.scrollLeft,
			top: current.scrollTop,
		});
	}
	return positions;
}

export function restoreAncestorScrollPositions(
	positions: readonly ScrollPosition[],
): void {
	for (const position of positions) {
		position.element.scrollTo(position.left, position.top);
	}
}

class FocusTracker extends Disposable implements IFocusTracker {
	private readonly _onDidFocus = this._register(new Emitter<void>());
	private readonly _onDidBlur = this._register(new Emitter<void>());
	private readonly pendingRefresh = this._register(new MutableDisposable<IDisposable>());
	readonly onDidFocus = this._onDidFocus.event;
	readonly onDidBlur = this._onDidBlur.event;
	private readonly target: HTMLElement | BrowserWindow;
	private _hasFocus: boolean;

	constructor(target: HTMLElement | BrowserWindow) {
		super();
		this.target = target;
		if (isWindow(target)) {
			this._hasFocus = target.document.hasFocus();
			this._register(addDisposableListener(target, "focus", () =>
				this.setFocused(true),
			));
			this._register(addDisposableListener(target, "blur", () =>
				this.setFocused(false),
			));
			return;
		}

		this._hasFocus = isAncestorOfActiveElement(target);
		this._register(addDisposableListener(target, "focusin", () => {
			this.pendingRefresh.clear();
			this.setFocused(true);
		}));
		this._register(addDisposableListener(target, "focusout", () =>
			this.scheduleRefresh()
		));
		this._register(addDisposableListener(getWindow(target), "blur", () =>
			this.setFocused(false),
		));
	}

	get hasFocus(): boolean {
		return this._hasFocus;
	}

	refreshState(): void {
		this.pendingRefresh.clear();
		this.setFocused(isWindow(this.target)
			? this.target.document.hasFocus()
			: isAncestorOfActiveElement(this.target));
	}

	private scheduleRefresh(): void {
		if (this.pendingRefresh.value) return;
		const targetWindow = getWindow(this.target);
		this.pendingRefresh.value = disposableWindowTimeout(targetWindow, () => {
			this.pendingRefresh.clear();
			this.refreshState();
		}, 0);
	}

	private setFocused(focused: boolean): void {
		if (focused === this._hasFocus) return;
		this._hasFocus = focused;
		if (focused) this._onDidFocus.fire();
		else this._onDidBlur.fire();
	}
}

function isUnavailableForFocus(element: HTMLElement): boolean {
	if (
		element.hidden ||
		element.closest("[inert], [aria-hidden='true']") !== null ||
		element.matches(":disabled")
	) {
		return true;
	}
	const style = getWindow(element).getComputedStyle(element);
	return style.display === "none" ||
		style.visibility === "hidden" ||
		style.visibility === "collapse" ||
		element.getClientRects().length === 0;
}

function getOwnerDocument(node: ParentNode): Document {
	if (isNode(node)) {
		return node.nodeType === 9
			? node as Document
			: node.ownerDocument ?? getActiveDocument();
	}
	return getActiveDocument();
}

function composedParent(element: Element): Element | null {
	if (element.parentElement) return element.parentElement;
	const root = element.getRootNode();
	return isShadowRoot(root) ? root.host : null;
}

function isComposedAncestor(
	candidate: Element | null,
	ancestor: Element,
): boolean {
	for (let current = candidate; current; current = composedParent(current)) {
		if (current === ancestor || isAncestor(current, ancestor)) return true;
	}
	return false;
}

function isShadowRoot(node: Node): node is ShadowRoot {
	return node.nodeType === 11 &&
		"host" in node &&
		isHTMLElement((node as ShadowRoot).host);
}

function isTabbableRadio(element: HTMLElement): boolean {
	if (
		element.tagName !== "INPUT" ||
		(element as HTMLInputElement).type !== "radio"
	) {
		return true;
	}
	const radio = element as HTMLInputElement;
	if (!radio.name) return true;
	const root: ParentNode = radio.form ??
		(radio.getRootNode() as Document | ShadowRoot);
	const group = Array.from(
		root.querySelectorAll<HTMLInputElement>("input[type='radio']"),
	).filter((candidate) =>
		candidate.name === radio.name &&
		candidate.form === radio.form &&
		isFocusable(candidate)
	);
	return (group.find((candidate) => candidate.checked) ?? group[0]) === radio;
}
