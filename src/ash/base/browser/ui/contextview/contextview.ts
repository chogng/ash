import './contextview.css';
import { findLast } from '../../../common/arraysFind.js';
import { Emitter } from '../../../common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../common/lifecycle.js';
import { AnchorAlignment, AnchorAxisAlignment, AnchorPosition, type IRectangle, layout2d } from '../../../common/layout.js';
import { addDisposableListener, getActiveElement, getWindow, isHTMLElement, isNode, h } from '../../dom.js';
import { isAncestorOfActiveElement, isFocusable, restoreFocus } from '../../focus.js';
import { getViewport } from '../../geometry.js';
import { observeResize } from '../../observer.js';
import { getVisibleWCOTitlebarAreaRect } from '../../browser.js';
import { avoidWindowControlsOverlay } from './windowControlsOverlay.js';

export {
	AnchorAlignment,
	AnchorAxisAlignment,
	AnchorPosition,
} from '../../../common/layout.js';

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

/** Named shell treatments; plain lets the content own its floating surface. */
export type ContextViewPresentation = 'default' | 'hover' | 'menu' | 'dialog' | 'plain';

export interface ContextViewOptions {
	readonly anchor: ContextViewAnchor;
	readonly content: HTMLElement;
	readonly anchorAlignment?: AnchorAlignment;
	readonly anchorPosition?: AnchorPosition;
	readonly anchorAxisAlignment?: AnchorAxisAlignment;
	/** For a side-by-side view, align this content element with the anchor’s top edge. */
	readonly alignTopTo?: Element;
	/** For a side-by-side view, align this content element with the anchor’s bottom edge. */
	readonly alignBottomTo?: Element;
	readonly gap?: number;
	readonly presentation?: ContextViewPresentation;
	readonly focusRestore?: ContextViewFocusRestore;
	readonly layer?: number;
	/** Shield background controls from pointer interaction while the popup is open. */
	readonly blockOutsidePointer?: boolean;
	readonly isTargetWithin?: (target: Node) => boolean;
	/** Handle Escape inside the popup before the default dismissal. */
	readonly onEscape?: (event: KeyboardEvent) => boolean;
	readonly onHide?: (reason: ContextViewHideReason) => void;
}

const popupRevisions = new WeakMap<Document, number>();
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
	implements IContextViewProvider {
	readonly element: HTMLDivElement;
	private readonly _onDidHide = this._register(new Emitter<ContextViewHideReason>());
	readonly onDidHide = this._onDidHide.event;
	private readonly visibleListeners = this._register(new DisposableStore());
	private restoreFocusTo: HTMLElement | undefined;
	private options: ContextViewOptions | undefined;

	constructor(container: HTMLElement | ShadowRoot) {
		super();
		const ownerDocument = container.ownerDocument;
		const element = h(ownerDocument, 'div');
		this.element = element;
		this._register(toDisposable(() => element.remove()));
		element.className = 'ash-context-view';
		element.hidden = true;
		container.append(element);
		this._register(toDisposable(() => this.hide()));
	}

	get visible(): boolean {
		return this.options !== undefined;
	}

	static getPopupRevision(document: Document): number {
		return popupRevisions.get(document) ?? 0;
	}

	static getHoverScope(target: HTMLElement): ContextView | undefined {
		return findLast(visibleContextViews.get(target.ownerDocument) ?? [], view =>
			view.options?.blockOutsidePointer && !isTargetInAnotherModal(target, view.element));
	}

	contains(target: Node): boolean {
		return this.element.contains(target) || this.options?.isTargetWithin?.(target) === true;
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
		if (options.blockOutsidePointer) {
			const shield = h(ownerDocument, 'div', { className: 'ash-context-view-pointer-shield' });
			shield.setAttribute('aria-hidden', 'true');
			this.element.prepend(shield);
			// Let pointerdown leave the menu input before restoring trigger focus on click.
			// The shield still consumes the full click.
			this.visibleListeners.add(addDisposableListener(shield, 'click', event => {
				event.stopPropagation();
				this.hide(ContextViewHideReason.OutsidePointer);
			}));
			this.visibleListeners.add(addDisposableListener(shield, 'contextmenu', event => event.preventDefault()));
		}
		this.element.className =
			`ash-context-view ash-context-view-${options.presentation ?? 'default'}`;
		this.element.style.setProperty(
			'--ash-context-view-layer',
			String(options.layer ?? 0),
		);
		this.element.style.visibility = 'hidden';
		this.element.hidden = false;
		// The top layer keeps menu coordinates in the viewport under transformed hosts.
		const followsMenu = options.presentation === 'hover' && isElementAnchor(options.anchor) && options.anchor.closest('.ash-context-view[popover]') !== null;
		if ((options.presentation === 'menu' || followsMenu) && this.element.isConnected && typeof this.element.showPopover === 'function') {
			this.element.popover = 'manual';
			this.element.showPopover();
		} else {
			this.element.removeAttribute('popover');
		}
		this.layout();
		if (!this.visible) return false;
		this.element.style.visibility = '';
		registerVisibleContextView(this);
		if (options.presentation !== 'hover') {
			popupRevisions.set(ownerDocument, ContextView.getPopupRevision(ownerDocument) + 1);
		}

		this.visibleListeners.add(addDisposableListener(
			ownerDocument,
			'pointerdown',
			(event: PointerEvent) => {
				const target = event.composedPath()[0] ?? event.target;
				if (isTargetInAnotherModal(target, this.element)) return;
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
			'keydown',
			(event: KeyboardEvent) => {
				if (
					event.isComposing ||
					event.key !== 'Escape' ||
					!isTopmostContextView(this) ||
					isTargetInAnotherModal(event.target, this.element)
				) {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				if (!options.onEscape?.(event)) {
					this.hide(ContextViewHideReason.Escape);
				}
			},
			true,
		));
		this.visibleListeners.add(addDisposableListener(
			targetWindow,
			'blur',
			() => this.hide(ContextViewHideReason.WindowBlur),
		));
		this.visibleListeners.add(addDisposableListener(
			targetWindow,
			'resize',
			() => this.layout(),
		));
		const overlay = (targetWindow.navigator as Navigator & { windowControlsOverlay?: EventTarget; }).windowControlsOverlay;
		if (overlay) {
			this.visibleListeners.add(addDisposableListener(overlay, 'geometrychange', () => this.layout()));
		}
		const visualViewport = targetWindow.visualViewport;
		if (visualViewport) {
			this.visibleListeners.add(addDisposableListener(
				visualViewport,
				'resize',
				() => this.layout(),
			));
			this.visibleListeners.add(addDisposableListener(
				visualViewport,
				'scroll',
				() => this.layout(),
			));
		}
		this.visibleListeners.add(addDisposableListener(
			ownerDocument,
			'scroll',
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
		const viewport = getViewport(targetWindow);
		// Account for the surface inset before viewport fitting so rows can line up.
		let top = anchor.top;
		if (options.anchorAxisAlignment === AnchorAxisAlignment.Horizontal) {
			if (options.alignBottomTo) {
				const rowBottom = options.alignBottomTo.getBoundingClientRect().bottom - bounds.top + options.content.scrollTop;
				top += anchor.height - rowBottom;
			} else if (options.alignTopTo) {
				top -= options.alignTopTo.getBoundingClientRect().top - bounds.top + options.content.scrollTop;
			}
		}
		const result = layout2d(
			viewport,
			{ width: bounds.width, height: bounds.height },
			{ ...anchor, top },
			options,
		);
		const titlebar = getVisibleWCOTitlebarAreaRect(targetWindow);
		const position = avoidWindowControlsOverlay(titlebar && {
			x: titlebar.x - viewport.left,
			y: titlebar.y - viewport.top,
			width: titlebar.width,
			height: titlebar.height,
		}, viewport, bounds, result);
		this.element.classList.toggle(
			'ash-context-view-above',
			result.anchorPosition === AnchorPosition.Above,
		);
		this.element.classList.toggle(
			'ash-context-view-below',
			result.anchorPosition === AnchorPosition.Below,
		);
		this.element.classList.toggle(
			'ash-context-view-align-right',
			result.anchorAlignment === AnchorAlignment.Right,
		);
		this.element.classList.toggle(
			'ash-context-view-align-left',
			result.anchorAlignment === AnchorAlignment.Left,
		);
		this.element.classList.toggle(
			'ash-context-view-align-center',
			result.anchorAlignment === AnchorAlignment.Center,
		);
		if (result.anchorAlignment === AnchorAlignment.Center && options.anchorAxisAlignment !== AnchorAxisAlignment.Horizontal) {
			this.element.style.setProperty('--ash-context-view-anchor-offset', `${anchor.left + anchor.width / 2 - position.left}px`);
		} else {
			this.element.style.removeProperty('--ash-context-view-anchor-offset');
		}
		this.element.classList.toggle(
			'ash-context-view-axis-horizontal',
			options.anchorAxisAlignment === AnchorAxisAlignment.Horizontal,
		);
		this.element.style.left = `${position.left}px`;
		this.element.style.top = `${position.top}px`;
	}

	hide(
		reason: ContextViewHideReason = ContextViewHideReason.Programmatic,
	): void {
		const options = this.options;
		if (!options) return;
		// Removing content loses its active element; a newer view or modal owns its own focus.
		const activeElement = getActiveElement(this.element.ownerDocument);
		// Related hosts such as submenus delegate focus return even when mounted outside this DOM.
		const shouldRestoreFocus = options.focusRestore === ContextViewFocusRestore.Previous &&
			!isTargetInAnotherModal(activeElement, this.element) &&
			((isTopmostContextView(this) && isAncestorOfActiveElement(this.element)) ||
				(activeElement !== null && options.isTargetWithin?.(activeElement) === true));
		this.options = undefined;
		unregisterVisibleContextView(this);
		this.visibleListeners.clear();
		if (typeof this.element.hidePopover === 'function' && this.element.matches(':popover-open')) this.element.hidePopover();
		this.element.hidden = true;
		this.element.replaceChildren();
		this.element.style.removeProperty('--ash-context-view-layer');
		const restoreFocusTo = this.restoreFocusTo;
		this.restoreFocusTo = undefined;
		try {
			if (
				shouldRestoreFocus &&
				restoreFocusTo &&
				isFocusable(restoreFocusTo)
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

/** A modal above the anchored view owns its clicks and Escape until it closes. */
function isTargetInAnotherModal(target: EventTarget | null, view: HTMLElement): boolean {
	if (!isNode(target)) return false;
	const element = target.nodeType === 1 ? target as Element : target.parentElement;
	const modal = element?.closest('dialog:modal');
	return !!modal && !modal.contains(view);
}

function getAnchorDocument(
	anchor: ContextViewAnchor,
	fallback: Document,
): Document {
	if (isElementAnchor(anchor)) return anchor.ownerDocument;
	const targetWindow = 'targetWindow' in anchor
		? (anchor as IRectangle & { readonly targetWindow?: Window; }).targetWindow
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
		typeof (anchor as Element).getBoundingClientRect === 'function';
}
