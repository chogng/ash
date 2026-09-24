import { Emitter } from "../../../common/event.js";
import { Disposable, DisposableStore, toDisposable } from "../../../common/lifecycle.js";
import { AnchorAlignment, AnchorAxisAlignment, AnchorPosition, type IRectangle, layout2d } from "../../../common/layout.js";
import { addDisposableListener, getActiveElement, getWindow, isHTMLElement, isNode, h } from "../../dom.js";
import { restoreFocus } from "../../focus.js";
import { getViewport } from "../../geometry.js";
import { observeResize } from "../../observer.js";

export {
	AnchorAlignment,
	AnchorAxisAlignment,
	AnchorPosition,
} from "../../../common/layout.js";

export type ContextViewAnchor = Element | IRectangle;

export enum ContextViewFocusRestore {
	None,
	Previous,
}

export enum ContextViewHideReason {
	Programmatic,
	Replaced,
	OutsidePointer,
	Escape,
	WindowBlur,
	AnchorRemoved,
}

/** Named shell treatments owned by ContextView consumers. */
export type ContextViewPresentation = "default" | "hover" | "menu";

export interface ContextViewOptions {
	readonly anchor: ContextViewAnchor;
	readonly content: HTMLElement;
	readonly anchorAlignment?: AnchorAlignment;
	readonly anchorPosition?: AnchorPosition;
	readonly anchorAxisAlignment?: AnchorAxisAlignment;
	readonly gap?: number;
	readonly presentation?: ContextViewPresentation;
	readonly focusRestore?: ContextViewFocusRestore;
	readonly layer?: number;
	readonly isTargetWithin?: (target: Node) => boolean;
	readonly onHide?: (reason: ContextViewHideReason) => void;
}

const visibleContextViews = new WeakMap<Document, ContextView[]>();

/**
 * Hosts one transient anchored view at a time.
 *
 * Implementations replace the currently visible view when `show` is called
 * again and must invoke that view's `onHide` callback exactly once.
 */
export interface IContextViewProvider {
	show(options: ContextViewOptions): boolean;
	hide(reason?: ContextViewHideReason): void;
	layout(): void;
}

/** An anchored, transient host for menus, hovers, and other overlays. */
export class ContextView
	extends Disposable
	implements IContextViewProvider
{
	readonly element: HTMLDivElement;
	private readonly _onDidHide = this._register(new Emitter<ContextViewHideReason>());
	readonly onDidHide = this._onDidHide.event;
	private readonly visibleListeners = this._register(new DisposableStore());
	private restoreFocusTo: HTMLElement | undefined;
	private options: ContextViewOptions | undefined;

	constructor(container: HTMLElement) {
		super();
		const ownerDocument = container.ownerDocument;
		const element = h(ownerDocument, "div");
		this.element = element;
		this._register(toDisposable(() => element.remove()));
		element.className = "ash-context-view";
		element.hidden = true;
		container.append(element);
		this._register(toDisposable(() => this.hide()));
	}

	get visible(): boolean {
		return this.options !== undefined;
	}

	show(options: ContextViewOptions): boolean {
		if (this.visible) {
			this.hide(ContextViewHideReason.Replaced);
		}
		this.visibleListeners.clear();
		const ownerDocument = getAnchorDocument(
			options.anchor,
			this.element.ownerDocument,
		);
		const targetWindow = getWindow(ownerDocument);
		if (this.element.ownerDocument !== ownerDocument) {
			ownerDocument.adoptNode(this.element);
			ownerDocument.body.append(this.element);
		}
		const activeElement = getActiveElement(ownerDocument);
		this.restoreFocusTo = isHTMLElement(activeElement)
			? activeElement
			: undefined;

		this.options = options;
		this.element.replaceChildren(options.content);
		this.element.className =
			`ash-context-view ash-context-view-${options.presentation ?? "default"}`;
		this.element.style.setProperty(
			"--ash-context-view-layer",
			String(options.layer ?? 0),
		);
		this.element.style.visibility = "hidden";
		this.element.hidden = false;
		this.layout();
		if (!this.visible) return false;
		this.element.style.visibility = "";
		registerVisibleContextView(this);

		this.visibleListeners.add(addDisposableListener(
			ownerDocument,
			"pointerdown",
			(event: PointerEvent) => {
				const target = event.target;
				if (
					isNode(target) &&
					!this.element.contains(target) &&
					!anchorContains(options.anchor, target) &&
					!options.isTargetWithin?.(target)
				) {
					this.hide(ContextViewHideReason.OutsidePointer);
				}
			},
			true,
		));
		this.visibleListeners.add(addDisposableListener(
			ownerDocument,
			"keydown",
			(event: KeyboardEvent) => {
				if (
					event.isComposing ||
					event.key !== "Escape" ||
					!isTopmostContextView(this)
				) {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				this.hide(ContextViewHideReason.Escape);
			},
			true,
		));
		this.visibleListeners.add(addDisposableListener(
			targetWindow,
			"blur",
			() => this.hide(ContextViewHideReason.WindowBlur),
		));
		this.visibleListeners.add(addDisposableListener(
			targetWindow,
			"resize",
			() => this.layout(),
		));
		const visualViewport = targetWindow.visualViewport;
		if (visualViewport) {
			this.visibleListeners.add(addDisposableListener(
				visualViewport,
				"resize",
				() => this.layout(),
			));
			this.visibleListeners.add(addDisposableListener(
				visualViewport,
				"scroll",
				() => this.layout(),
			));
		}
		this.visibleListeners.add(addDisposableListener(
			ownerDocument,
			"scroll",
			() => this.layout(),
			true,
		));
		this.visibleListeners.add(observeResize(
			isElementAnchor(options.anchor) ? [this.element, options.anchor] : this.element,
			() => this.layout(),
		));
		return true;
	}

	layout(): void {
		const options = this.options;
		if (!options) return;
		if (isElementAnchor(options.anchor) && !options.anchor.isConnected) {
			this.hide(ContextViewHideReason.AnchorRemoved);
			return;
		}

		const targetWindow = getWindow(this.element);
		const anchor = getAnchorRectangle(options.anchor);
		const bounds = this.element.getBoundingClientRect();
		const result = layout2d(
			getViewport(targetWindow),
			{ width: bounds.width, height: bounds.height },
			anchor,
			options,
		);
		this.element.classList.toggle(
			"ash-context-view-above",
			result.anchorPosition === AnchorPosition.Above,
		);
		this.element.classList.toggle(
			"ash-context-view-below",
			result.anchorPosition === AnchorPosition.Below,
		);
		this.element.classList.toggle(
			"ash-context-view-align-right",
			result.anchorAlignment === AnchorAlignment.Right,
		);
		this.element.classList.toggle(
			"ash-context-view-align-left",
			result.anchorAlignment === AnchorAlignment.Left,
		);
		this.element.classList.toggle(
			"ash-context-view-axis-horizontal",
			options.anchorAxisAlignment === AnchorAxisAlignment.Horizontal,
		);
		this.element.style.left = `${result.left}px`;
		this.element.style.top = `${result.top}px`;
	}

	hide(
		reason: ContextViewHideReason = ContextViewHideReason.Programmatic,
	): void {
		const options = this.options;
		if (!options) return;
		this.options = undefined;
		unregisterVisibleContextView(this);
		this.visibleListeners.clear();
		this.element.hidden = true;
		this.element.replaceChildren();
		this.element.style.removeProperty("--ash-context-view-layer");
		const restoreFocusTo = this.restoreFocusTo;
		this.restoreFocusTo = undefined;
		try {
			if (
				options.focusRestore === ContextViewFocusRestore.Previous &&
				restoreFocusTo
			) {
				restoreFocus(restoreFocusTo);
			}
		} finally {
			try {
				options.onHide?.(reason);
			} finally {
				this._onDidHide.fire(reason);
			}
		}
	}
}

function registerVisibleContextView(contextView: ContextView): void {
	const ownerDocument = contextView.element.ownerDocument;
	const stack = visibleContextViews.get(ownerDocument);
	if (stack) stack.push(contextView);
	else visibleContextViews.set(ownerDocument, [contextView]);
}

function unregisterVisibleContextView(contextView: ContextView): void {
	const ownerDocument = contextView.element.ownerDocument;
	const stack = visibleContextViews.get(ownerDocument);
	if (!stack) return;
	const index = stack.lastIndexOf(contextView);
	if (index >= 0) stack.splice(index, 1);
	if (stack.length === 0) visibleContextViews.delete(ownerDocument);
}

function isTopmostContextView(contextView: ContextView): boolean {
	const stack = visibleContextViews.get(contextView.element.ownerDocument);
	return stack?.[stack.length - 1] === contextView;
}

function getAnchorDocument(
	anchor: ContextViewAnchor,
	fallback: Document,
): Document {
	if (isElementAnchor(anchor)) return anchor.ownerDocument;
	const targetWindow = "targetWindow" in anchor
		? (anchor as IRectangle & { readonly targetWindow?: Window }).targetWindow
		: undefined;
	return targetWindow?.document ?? fallback;
}

function getAnchorRectangle(anchor: ContextViewAnchor): IRectangle {
	if (!isElementAnchor(anchor)) return anchor;
	const bounds = anchor.getBoundingClientRect();
	return {
		left: bounds.left,
		top: bounds.top,
		width: bounds.width,
		height: bounds.height,
	};
}

function anchorContains(anchor: ContextViewAnchor, target: Node): boolean {
	return isElementAnchor(anchor) && anchor.contains(target);
}

function isElementAnchor(
	anchor: ContextViewAnchor,
): anchor is Element {
	return isNode(anchor) &&
		anchor.nodeType === 1 &&
		typeof (anchor as Element).getBoundingClientRect === "function";
}
