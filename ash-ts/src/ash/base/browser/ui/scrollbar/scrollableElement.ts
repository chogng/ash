import './scrollbar.css';
import { localize } from '../../../../nls.js';
import { RunOnceScheduler } from '../../../common/async.js';
import { Scrollable, ScrollbarVisibility as ScrollbarVisibilityOption, type INewScrollPosition } from '../../../common/scrollable.js';
import type { IMouseWheelEvent } from '../../mouseEvent.js';
import type { ScrollableElementCreationOptions, ScrollableElementChangeOptions } from './scrollableElementOptions.js';
import { addDisposableListener, h } from "../../dom.js";
import { FastDomNode } from "../../fastDomNode.js";
import { StandardWheelEvent } from "../../mouseEvent.js";
import { observeResize } from "../../observer.js";
import { disposableWindowTimeout, scheduleAtNextAnimationFrame } from "../../scheduler.js";
import { Emitter, type Event } from "../../../common/event.js";
import { Disposable, DisposableStore, MutableDisposable, type IDisposable, toDisposable } from "../../../common/lifecycle.js";
import type { ScrollbarAxis } from "./abstractScrollbar.js";
import { HorizontalScrollbar } from "./horizontalScrollbar.js";
import {
	clampScrollbarPosition,
	createScrollbarAxisMetrics,
	type ScrollbarAxisMetrics,
} from "./scrollbarState.js";
import {
	resolveScrollableElementOptions,
	type ResolvedScrollableElementOptions,
	type ScrollableElementOptions,
	type ScrollbarVisibility,
} from "./scrollableElementOptions.js";
import { VerticalScrollbar } from "./verticalScrollbar.js";

export type {
	ScrollableElementOptions,
	ScrollbarVisibility,
	ScrollbarWheelOptions,
	ScrollDirection,
} from "./scrollableElementOptions.js";
export type { ScrollbarAxis } from "./abstractScrollbar.js";

export interface ScrollPosition {
	readonly left: number;
	readonly top: number;
}

export interface ScrollableElementState extends ScrollPosition {
	readonly width: number;
	readonly height: number;
	readonly scrollWidth: number;
	readonly scrollHeight: number;
	readonly maximumLeft: number;
	readonly maximumTop: number;
}

export interface ScrollableScrollEvent {
	readonly previous: ScrollPosition;
	readonly current: ScrollableElementState;
}

const initialState: ScrollableElementState = {
	left: 0,
	top: 0,
	width: 0,
	height: 0,
	scrollWidth: 0,
	scrollHeight: 0,
	maximumLeft: 0,
	maximumTop: 0,
};
let nextScrollableId = 1;

/**
 * Themeable two-axis scroll container with managed wheel and pointer input.
 *
 * Content remains in a native scrolling viewport for keyboard, touch, focus
 * reveal, and accessibility behavior. The native bars are hidden and mirrored
 * by stable DOM tracks whose visibility and interaction are controlled here.
 */
export class ScrollableElement extends Disposable {
	readonly element: HTMLDivElement;
	readonly scrollableElement: HTMLDivElement;
	readonly contentElement: HTMLDivElement;
	readonly onDidScroll: Event<ScrollableScrollEvent>;
	private readonly horizontal: HorizontalScrollbar;
	private readonly vertical: VerticalScrollbar;
	private readonly corner: HTMLDivElement;
	private readonly cornerNode: FastDomNode<HTMLDivElement>;
	private readonly options: ResolvedScrollableElementOptions;
	private readonly onScrollOption: ((position: ScrollPosition) => void) | undefined;
	private readonly onDidScrollEmitter: Emitter<ScrollableScrollEvent>;
	private _state = initialState;
	private pendingReveal: Element | undefined;
	private readonly scrollActivityTimeout = this._register(new MutableDisposable<IDisposable>());

	constructor(container: HTMLElement, options: ScrollableElementOptions = {}) {
		super();
		this.options = resolveScrollableElementOptions(options);
		this.onScrollOption = options.onScroll;
		const ownerDocument = container.ownerDocument;
		const element = h(ownerDocument, "div");
		const viewport = h(ownerDocument, "div");
		const content = h(ownerDocument, "div");
		viewport.id = `ash-scrollable-${nextScrollableId++}`;
		const horizontal = this._register(new HorizontalScrollbar(element, {
			viewport,
			trackClickBehavior: this.options.trackClickBehavior,
			getMetrics: () => this.axisMetrics("horizontal"),
			setPosition: (position) =>
				this.setAxisPosition("horizontal", position),
		}));
		const vertical = this._register(new VerticalScrollbar(element, {
			viewport,
			trackClickBehavior: this.options.trackClickBehavior,
			getMetrics: () => this.axisMetrics("vertical"),
			setPosition: (position) =>
				this.setAxisPosition("vertical", position),
		}));
		const corner = h(ownerDocument, "div");
		this.element = element;
		this.scrollableElement = viewport;
		this.contentElement = content;
		this.horizontal = horizontal;
		this.vertical = vertical;
		this.corner = corner;
		this.cornerNode = new FastDomNode(corner);
		this.onDidScrollEmitter = this._register(new Emitter<ScrollableScrollEvent>());
		this.onDidScroll = this.onDidScrollEmitter.event;

		element.className = "ash-scrollable-element ash-scrollbar";
		element.dataset.scrollDirection = this.options.direction;
		element.tabIndex = options.tabIndex ?? 0;
		element.style.setProperty(
			"--ash-scrollbar-size",
			`${this.options.scrollbarSize}px`,
		);
		if (options.ariaLabel) {
			element.setAttribute("role", "region");
			element.setAttribute("aria-label", options.ariaLabel);
		}
		viewport.className = "ash-scrollbar-viewport";
		content.className = "ash-scrollbar-content";
		horizontal.track.dataset.visibility = this.options.horizontal;
		vertical.track.dataset.visibility = this.options.vertical;
		this.cornerNode.setClassName("ash-scrollbar-corner");
		viewport.append(content);
		element.append(
			viewport,
			horizontal.track,
			vertical.track,
			corner,
		);
		container.append(element);

		this._register(toDisposable(() => {
			this.pendingReveal = undefined;
			element.remove();
		}));
		this._register(addDisposableListener(viewport, "scroll", () =>
			this.handleNativeScroll(),
		));
		this._register(addDisposableListener(viewport, "wheel", (event: WheelEvent) =>
			this.handleWheel(event),
		{ passive: false }));
		this._register(addDisposableListener(element, "keydown", (event: KeyboardEvent) =>
			this.handleContainerKeydown(event),
		));

		this._register(observeResize([element, content], () => this.layout()));
		this.layout();
	}

	get state(): ScrollableElementState {
		return this._state;
	}

	setContent(content: Element): void {
		this.replaceChildren(content);
	}

	append(...children: readonly (Node | string)[]): void {
		this.contentElement.append(...children);
		this.layout();
	}

	replaceChildren(...children: readonly (Node | string)[]): void {
		this.contentElement.replaceChildren(...children);
		this.layout();
	}

	layout(): void {
		const width = Math.max(0, this.scrollableElement.clientWidth);
		const height = Math.max(0, this.scrollableElement.clientHeight);
		const scrollWidth = this.options.direction === "vertical"
			? width
			: Math.max(width, this.scrollableElement.scrollWidth);
		const scrollHeight = this.options.direction === "horizontal"
			? height
			: Math.max(height, this.scrollableElement.scrollHeight);
		const maximumLeft = Math.max(0, scrollWidth - width);
		const maximumTop = Math.max(0, scrollHeight - height);
		const left = clampScrollbarPosition(
			this.scrollableElement.scrollLeft,
			maximumLeft,
		);
		const top = clampScrollbarPosition(
			this.scrollableElement.scrollTop,
			maximumTop,
		);
		if (
			left !== this.scrollableElement.scrollLeft ||
			top !== this.scrollableElement.scrollTop
		) {
			this.scrollableElement.scrollLeft = left;
			this.scrollableElement.scrollTop = top;
		}
		this.commitState({
			left,
			top,
			width,
			height,
			scrollWidth,
			scrollHeight,
			maximumLeft,
			maximumTop,
		});
		this.applyPendingReveal();
	}

	scrollTo(left: number, top: number): void {
		this.setScrollPosition(left, top);
	}

	scrollBy(deltaLeft: number, deltaTop: number): void {
		this.setScrollPosition(
			this._state.left + deltaLeft,
			this._state.top + deltaTop,
		);
	}

	/** Reveals a descendant at the nearest visible edge on the enabled axes. */
	reveal(element: Element): void {
		if (!this.contentElement.contains(element)) {
			throw new RangeError("ScrollableElement can only reveal its descendants");
		}
		this.pendingReveal = element;
		this.layout();
	}

	private applyPendingReveal(): void {
		const element = this.pendingReveal;
		if (!element) return;
		if (!this.contentElement.contains(element)) {
			this.pendingReveal = undefined;
			return;
		}
		if (
			(this.options.direction !== "vertical" && this._state.width <= 0) ||
			(this.options.direction !== "horizontal" && this._state.height <= 0)
		) return;
		this.pendingReveal = undefined;
		const viewportBounds = this.scrollableElement.getBoundingClientRect();
		const elementBounds = element.getBoundingClientRect();
		let left = this._state.left;
		let top = this._state.top;
		if (this.options.direction !== "vertical") {
			const viewportLeft = viewportBounds.left;
			const viewportRight = viewportBounds.left + this._state.width -
				(this.vertical.rendered ? this.options.scrollbarSize : 0);
			if (elementBounds.left < viewportLeft) {
				left += elementBounds.left - viewportLeft;
			} else if (elementBounds.right > viewportRight) {
				left += elementBounds.right - viewportRight;
			}
		}
		if (this.options.direction !== "horizontal") {
			const viewportTop = viewportBounds.top;
			const viewportBottom = viewportBounds.top + this._state.height -
				(this.horizontal.rendered ? this.options.scrollbarSize : 0);
			if (elementBounds.top < viewportTop) {
				top += elementBounds.top - viewportTop;
			} else if (elementBounds.bottom > viewportBottom) {
				top += elementBounds.bottom - viewportBottom;
			}
		}
		this.setScrollPosition(left, top);
	}

	private handleNativeScroll(): void {
		const previous = this._state;
		this.layout();
		if (
			previous.left === this._state.left &&
			previous.top === this._state.top
		) return;
		this.showScrollbars();
	}

	private handleWheel(browserEvent: WheelEvent): void {
		const wheel = new StandardWheelEvent(browserEvent, {
			pageWidth: this._state.width,
			pageHeight: this._state.height,
		});
		let deltaX = wheel.deltaX;
		let deltaY = wheel.deltaY;
		if (
			wheel.shiftKey &&
			this.options.wheel.shift === "horizontal" &&
			deltaX === 0
		) {
			deltaX = deltaY;
			deltaY = 0;
		}
		if (this.options.direction === "horizontal") {
			if (deltaX === 0) deltaX = deltaY;
			deltaY = 0;
		} else if (this.options.direction === "vertical") {
			deltaX = 0;
		}
		if (
			this.options.wheel.axis === "predominant" &&
			deltaX !== 0 &&
			deltaY !== 0
		) {
			if (Math.abs(deltaX) > Math.abs(deltaY)) deltaY = 0;
			else deltaX = 0;
		}
		const sensitivity = this.options.wheel.sensitivity * (
			wheel.altKey ? this.options.wheel.fastSensitivity : 1
		);
		const changed = this.setScrollPosition(
			this._state.left + deltaX * sensitivity,
			this._state.top + deltaY * sensitivity,
		);
		if (
			changed ||
			this.options.wheel.consume === "always"
		) {
			wheel.stop();
		}
	}

	private handleContainerKeydown(event: KeyboardEvent): void {
		if (event.target !== this.element) return;
		const step = event.altKey ? 10 : 40;
		let left = this._state.left;
		let top = this._state.top;
		switch (event.key) {
			case "ArrowLeft":
				if (this.options.direction === "vertical") return;
				left -= step;
				break;
			case "ArrowRight":
				if (this.options.direction === "vertical") return;
				left += step;
				break;
			case "ArrowUp":
				if (this.options.direction === "horizontal") return;
				top -= step;
				break;
			case "ArrowDown":
				if (this.options.direction === "horizontal") return;
				top += step;
				break;
			case "PageUp":
				if (this.options.direction === "horizontal") {
					left -= this._state.width;
				} else {
					top -= this._state.height;
				}
				break;
			case "PageDown":
				if (this.options.direction === "horizontal") {
					left += this._state.width;
				} else {
					top += this._state.height;
				}
				break;
			case "Home":
				if (this.options.direction === "horizontal") left = 0;
				else top = 0;
				break;
			case "End":
				if (this.options.direction === "horizontal") {
					left = this._state.maximumLeft;
				} else {
					top = this._state.maximumTop;
				}
				break;
			default: return;
		}
		event.preventDefault();
		this.setScrollPosition(left, top);
	}

	private setAxisPosition(axis: ScrollbarAxis, position: number): boolean {
		return axis === "horizontal"
			? this.setScrollPosition(position, this._state.top)
			: this.setScrollPosition(this._state.left, position);
	}

	private setScrollPosition(left: number, top: number): boolean {
		left = clampScrollbarPosition(left, this._state.maximumLeft);
		top = clampScrollbarPosition(top, this._state.maximumTop);
		if (left === this._state.left && top === this._state.top) return false;
		this.scrollableElement.scrollLeft = left;
		this.scrollableElement.scrollTop = top;
		this.commitState({ ...this._state, left, top });
		this.showScrollbars();
		return true;
	}

	private commitState(next: ScrollableElementState): void {
		const previous = this._state;
		this._state = next;
		this.render();
		if (previous.left === next.left && previous.top === next.top) return;
		const previousPosition = {
			left: previous.left,
			top: previous.top,
		};
		this.onDidScrollEmitter.fire({
			previous: previousPosition,
			current: next,
		});
		this.onScrollOption?.({ left: next.left, top: next.top });
	}

	private render(): void {
		const horizontalNeeded = this._state.maximumLeft > 0;
		const verticalNeeded = this._state.maximumTop > 0;
		const horizontalRendered = isRendered(
			this.options.horizontal,
			horizontalNeeded,
		);
		const verticalRendered = isRendered(
			this.options.vertical,
			verticalNeeded,
		);
		this.horizontal.trackNode.setRight(verticalRendered ? this.options.scrollbarSize : 0);
		this.vertical.trackNode.setBottom(horizontalRendered ? this.options.scrollbarSize : 0);
		const cornerHidden = !(horizontalRendered && verticalRendered);
		if (this.corner.hidden !== cornerHidden) this.corner.hidden = cornerHidden;
		const horizontalTrackSize = Math.max(
			0,
			this._state.width -
				(verticalRendered ? this.options.scrollbarSize : 0),
		);
		const verticalTrackSize = Math.max(
			0,
			this._state.height -
				(horizontalRendered ? this.options.scrollbarSize : 0),
		);
		this.horizontal.render(
			createScrollbarAxisMetrics(
				this._state.width,
				this._state.scrollWidth,
				this._state.left,
				horizontalTrackSize,
				this.options.minimumThumbSize,
			),
			horizontalRendered,
		);
		this.vertical.render(
			createScrollbarAxisMetrics(
				this._state.height,
				this._state.scrollHeight,
				this._state.top,
				verticalTrackSize,
				this.options.minimumThumbSize,
			),
			verticalRendered,
		);
	}

	private axisMetrics(axis: ScrollbarAxis): ScrollbarAxisMetrics {
		const oppositeRendered = axis === "horizontal"
			? this.vertical.rendered
			: this.horizontal.rendered;
		const trackSize = (
			axis === "horizontal" ? this._state.width : this._state.height
		) - (oppositeRendered ? this.options.scrollbarSize : 0);
		return axis === "horizontal"
			? createScrollbarAxisMetrics(
				this._state.width,
				this._state.scrollWidth,
				this._state.left,
				trackSize,
				this.options.minimumThumbSize,
			)
			: createScrollbarAxisMetrics(
				this._state.height,
				this._state.scrollHeight,
				this._state.top,
				trackSize,
				this.options.minimumThumbSize,
			);
	}

	private showScrollbars(): void {
		const targetWindow = ownerWindow(this.element);
		this.element.classList.add("ash-scrollbar-scrolling");
		this.scrollActivityTimeout.value = disposableWindowTimeout(targetWindow, () => {
			this.scrollActivityTimeout.clear();
			this.element.classList.remove("ash-scrollbar-scrolling");
		}, 700);
	}
}

function isRendered(
	visibility: ScrollbarVisibility,
	needed: boolean,
): boolean {
	return visibility === "visible" ||
		(visibility === "auto" && needed);
}

function ownerWindow(element: HTMLElement): Window {
	const targetWindow = element.ownerDocument.defaultView;
	if (!targetWindow) throw new Error("ScrollableElement requires a browser window");
	return targetWindow;
}

export interface IOverviewRulerLayoutInfo {
	parent: HTMLElement;
	insertBefore: HTMLElement;
}

/** Scrollbar controls for content whose scroll state is owned by its caller. */
export class SmoothScrollableElement extends Disposable {
	private readonly domNode: HTMLDivElement;
	private readonly horizontal: HorizontalScrollbar;
	private readonly vertical: VerticalScrollbar;
	private horizontalMetrics = createScrollbarAxisMetrics(0, 0, 0, 0, 0);
	private verticalMetrics = createScrollbarAxisMetrics(0, 0, 0, 0, 0);
	private hovered = false;
	private focused = false;
	private scrolling = false;
	private readonly activity: RunOnceScheduler;
	private readonly arrows: { button: HTMLButtonElement; axis: ScrollbarAxis; direction: number }[] = [];
	private readonly arrowPress = this._register(new DisposableStore());
	private readonly inertia = this._register(new MutableDisposable<IDisposable>());
	private applyingInertia = false;
	private readonly wheelEvents = new WeakSet<WheelEvent>();
	private wheelInput: {
		magnitude: number;
		horizontal: boolean;
		quantum: number;
		discreteCount: number;
		continuousTime: number;
	} | undefined;
	private options: ScrollableElementCreationOptions;

	constructor(element: HTMLElement, options: ScrollableElementCreationOptions, private readonly scrollable: Scrollable) {
		super();
		this.options = { ...options };
		const root = h(element.ownerDocument, 'div');
		this.domNode = root;
		root.className = `ash-smooth-scrollable ${options.className ?? ''}`.trim();
		this._register(toDisposable(() => root.remove()));
		root.append(element);
		if (!element.id) element.id = `ash-scrollable-${nextScrollableId++}`;
		const owner = this;
		this.horizontal = this._register(new HorizontalScrollbar(root, {
			viewport: element,
			get trackClickBehavior() { return owner.options.scrollByPage ? 'page' : 'jump'; },
			getMetrics: () => this.horizontalMetrics,
			setPosition: scrollLeft => scrollable.setScrollPositionNow({ scrollLeft }),
		}));
		this.vertical = this._register(new VerticalScrollbar(root, {
			viewport: element,
			get trackClickBehavior() { return owner.options.scrollByPage ? 'page' : 'jump'; },
			getMetrics: () => this.verticalMetrics,
			setPosition: scrollTop => scrollable.setScrollPositionNow({ scrollTop }),
		}));
		const arrowDefinitions = [
			{ axis: 'horizontal', direction: -1, glyph: '◂', label: localize('scrollLeft', 'Scroll left') },
			{ axis: 'horizontal', direction: 1, glyph: '▸', label: localize('scrollRight', 'Scroll right') },
			{ axis: 'vertical', direction: -1, glyph: '▴', label: localize('scrollUp', 'Scroll up') },
			{ axis: 'vertical', direction: 1, glyph: '▾', label: localize('scrollDown', 'Scroll down') },
		] as const;
		for (const { axis, direction, glyph, label } of arrowDefinitions) {
			const button = h(element.ownerDocument, 'button');
			button.type = 'button';
			button.className = `ash-scrollbar-arrow ash-scrollbar-arrow-${axis}`;
			button.textContent = glyph;
			button.setAttribute('aria-label', label);
			button.setAttribute('aria-controls', element.id);
			button.hidden = true;
			root.append(button);
			this.arrows.push({ button, axis, direction });
			const activate = (): void => {
				this.inertia.clear();
				const position = scrollable.getCurrentScrollPosition();
				scrollable.setScrollPositionNow(axis === 'horizontal'
					? { scrollLeft: position.scrollLeft + direction * 40 }
					: { scrollTop: position.scrollTop + direction * 40 });
			};
			this._register(addDisposableListener(button, 'click', (event: MouseEvent) => {
				event.stopPropagation();
				if (event.detail === 0 && !button.disabled) {
					activate();
				}
			}));
			this._register(addDisposableListener(button, 'pointerdown', (event: PointerEvent) => {
				if (event.button !== 0 || button.disabled) {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				this.arrowPress.clear();
				button.setPointerCapture(event.pointerId);
				this.arrowPress.add(toDisposable(() => {
					if (button.hasPointerCapture(event.pointerId)) {
						button.releasePointerCapture(event.pointerId);
					}
				}));
				this.arrowPress.add(addDisposableListener(button, 'lostpointercapture', () => this.arrowPress.clear()));
				const targetWindow = element.ownerDocument.defaultView!;
				const repeat = this.arrowPress.add(new MutableDisposable<IDisposable>());
				const tick = (): void => {
					if (button.hidden || button.disabled) {
						this.arrowPress.clear();
						return;
					}
					activate();
					repeat.value = disposableWindowTimeout(targetWindow, tick, 50);
				};
				for (const type of ['pointerup', 'pointercancel', 'blur']) {
					this.arrowPress.add(addDisposableListener(targetWindow, type, () => this.arrowPress.clear()));
				}
				activate();
				repeat.value = disposableWindowTimeout(targetWindow, tick, 300);
			}));
		}
		this.activity = this._register(new RunOnceScheduler(() => {
			this.scrolling = false;
			this.updateVisibility();
		}, 700));
		const eventTarget = options.listenOnDomNode ?? root;
		for (const type of ['pointerdown', 'keydown']) {
			this._register(addDisposableListener(eventTarget, type, () => this.inertia.clear(), true));
		}
		this._register(addDisposableListener(element.ownerDocument.defaultView!, 'blur', () => this.inertia.clear()));
		this.hovered = eventTarget.matches(':hover');
		this.focused = eventTarget.contains(element.ownerDocument.activeElement);
		this._register(addDisposableListener(eventTarget, 'mouseenter', () => {
			this.hovered = true;
			this.updateVisibility();
		}));
		this._register(addDisposableListener(eventTarget, 'mouseleave', () => {
			this.hovered = false;
			this.updateVisibility();
		}));
		this._register(addDisposableListener(eventTarget, 'focusin', () => {
			this.focused = true;
			this.updateVisibility();
		}));
		this._register(addDisposableListener(eventTarget, 'focusout', (event: FocusEvent) => {
			this.focused = eventTarget.contains(event.relatedTarget as Node | null);
			this.updateVisibility();
		}));
		this._register(addDisposableListener(eventTarget, 'wheel', (event: WheelEvent) => {
			const dimensions = scrollable.getScrollDimensions();
			this.delegateScrollFromMouseWheelEvent(new StandardWheelEvent(event, { pageWidth: dimensions.width, pageHeight: dimensions.height }));
		}, { passive: false }));
		this._register(scrollable.onScroll(event => {
			if (!this.applyingInertia || event.widthChanged || event.heightChanged || event.scrollWidthChanged || event.scrollHeightChanged) {
				this.inertia.clear();
			}
			if (event.scrollLeftChanged || event.scrollTopChanged) {
				this.scrolling = true;
				this.activity.schedule();
				this.updateVisibility();
			}
			if (!this.options.lazyRender) this.renderNow();
		}));
	}

	public getDomNode(): HTMLElement { return this.domNode; }

	public getOverviewRulerLayoutInfo(): IOverviewRulerLayoutInfo {
		return { parent: this.domNode, insertBefore: this.vertical.track };
	}

	public delegateVerticalScrollbarPointerDown(event: PointerEvent): void {
		this.vertical.delegatePointerDown(event);
	}

	public updateOptions(options: ScrollableElementChangeOptions): void {
		this.inertia.clear();
		this.arrowPress.clear();
		this.options = { ...this.options, ...options };
		if (!this.options.lazyRender) this.renderNow();
	}

	public setScrollPosition(position: INewScrollPosition & { reuseAnimation?: boolean }): void {
		this.inertia.clear();
		this.scrollable.setScrollPositionSmooth(position, position.reuseAnimation);
	}

	public delegateScrollFromMouseWheelEvent(event: IMouseWheelEvent): void {
		if (event.browserEvent.defaultPrevented || this.options.handleMouseWheel === false) return;
		if (this.wheelEvents.has(event.browserEvent)) {
			return;
		}
		this.wheelEvents.add(event.browserEvent);
		this.inertia.clear();
		const continuous = this.isContinuousWheel(event);
		let { deltaX, deltaY } = event;
		if (event.shiftKey && deltaX === 0) {
			deltaX = deltaY;
			deltaY = 0;
		}
		if (this.options.scrollPredominantAxis !== false) {
			if (Math.abs(deltaY) >= Math.abs(deltaX)) deltaX = 0;
			else deltaY = 0;
		}
		const speed = (this.options.mouseWheelScrollSensitivity ?? 1) * (event.altKey ? this.options.fastScrollSensitivity ?? 5 : 1);
		const previous = this.scrollable.getFutureScrollPosition();
		const dimensions = this.scrollable.getScrollDimensions();
		const scrollLeft = clampScrollbarPosition(previous.scrollLeft + deltaX * speed, dimensions.scrollWidth - dimensions.width);
		const scrollTop = clampScrollbarPosition(previous.scrollTop + deltaY * speed, dimensions.scrollHeight - dimensions.height);
		const changed = scrollLeft !== previous.scrollLeft || scrollTop !== previous.scrollTop;
		if (changed) {
			if (this.options.inertialScroll && continuous) {
				this.scrollable.setScrollPositionNow({ scrollLeft, scrollTop });
				this.continueInertia(deltaX * speed, deltaY * speed);
			} else if (this.options.mouseWheelSmoothScroll === false) {
				this.scrollable.setScrollPositionNow({ scrollLeft, scrollTop });
			} else {
				this.setScrollPosition({ scrollLeft, scrollTop, reuseAnimation: true });
			}
		}
		if (changed || this.options.alwaysConsumeMouseWheel) event.preventDefault();
	}

	private isContinuousWheel(event: IMouseWheelEvent): boolean {
		if (event.browserEvent.deltaMode !== 0) {
			this.wheelInput = undefined;
			return false;
		}
		// Classify before sensitivity and axis mapping. Keep CSS pixels for
		// scrolling; only the device evidence uses conventional 40px steps.
		const magnitude = Math.max(Math.abs(event.deltaX), Math.abs(event.deltaY)) / 40;
		if (magnitude === 0) {
			return false;
		}
		const horizontal = event.deltaX !== 0;
		const previous = this.wheelInput;
		const repeated = previous !== undefined && previous.horizontal === horizontal
			&& magnitude >= 1 && Math.abs(previous.magnitude - magnitude) < 0.00001;
		let quantum = previous?.quantum ?? 0;
		if (repeated) {
			quantum = quantum > 0 ? Math.min(quantum, magnitude) : magnitude;
		}
		const wholeStep = Math.abs(magnitude - Math.round(magnitude)) < 0.00001;
		const learnedStep = quantum > 0 && Math.abs(magnitude / quantum - Math.round(magnitude / quantum)) < 0.00001;
		const discreteCount = wholeStep || learnedStep ? (previous?.discreteCount ?? 0) + 1 : 0;
		const now = event.browserEvent.timeStamp;
		const continuousTime = previous?.continuousTime ?? -Infinity;
		const continuous = (event.deltaX !== 0 && event.deltaY !== 0) || discreteCount === 0
			|| (now - continuousTime <= 100 && discreteCount < 2 && !repeated);
		this.wheelInput = {
			magnitude,
			horizontal,
			quantum: continuous ? 0 : quantum,
			discreteCount,
			continuousTime: continuous ? now : continuousTime,
		};
		return continuous;
	}

	private continueInertia(deltaX: number, deltaY: number): void {
		const targetWindow = this.domNode.ownerDocument.defaultView!;
		let previousTime = targetWindow.performance.now();
		const startTime = previousTime;
		const tick = (): void => {
			const now = targetWindow.performance.now();
			const elapsed = now - previousTime;
			previousTime = now;
			if (elapsed > 100 || now - startTime > 1200) {
				this.inertia.clear();
				return;
			}
			const decay = Math.exp(-elapsed / 160);
			const distance = 160 / 16 * (1 - decay);
			const before = this.scrollable.getCurrentScrollPosition();
			this.applyingInertia = true;
			try {
				this.scrollable.setScrollPositionNow({
					scrollLeft: before.scrollLeft + deltaX * distance,
					scrollTop: before.scrollTop + deltaY * distance,
				});
			} finally {
				this.applyingInertia = false;
			}
			const after = this.scrollable.getCurrentScrollPosition();
			deltaX = after.scrollLeft === before.scrollLeft ? 0 : deltaX * decay;
			deltaY = after.scrollTop === before.scrollTop ? 0 : deltaY * decay;
			if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < 0.5) {
				this.inertia.clear();
				return;
			}
			this.inertia.value = scheduleAtNextAnimationFrame(targetWindow, tick);
		};
		this.inertia.value = scheduleAtNextAnimationFrame(targetWindow, tick);
	}

	public renderNow(): void {
		const { width, height, scrollWidth, scrollHeight } = this.scrollable.getScrollDimensions();
		const { scrollLeft, scrollTop } = this.scrollable.getCurrentScrollPosition();
		const horizontalSize = this.options.horizontalScrollbarSize ?? 10;
		const verticalSize = this.options.verticalScrollbarSize ?? 10;
		const horizontalRendered = horizontalSize > 0 && this.isRendered(this.options.horizontal, scrollWidth > width);
		const verticalRendered = verticalSize > 0 && this.isRendered(this.options.vertical, scrollHeight > height);
		this.horizontal.trackNode.setHeight(horizontalSize);
		this.vertical.trackNode.setWidth(verticalSize);
		const horizontalLength = Math.max(0, width - (verticalRendered ? verticalSize : 0));
		const verticalLength = Math.max(0, height - (horizontalRendered ? horizontalSize : 0));
		const horizontalArrow = this.options.horizontalHasArrows ? Math.min(this.options.arrowSize ?? 11, horizontalLength / 2) : 0;
		const verticalArrow = this.options.verticalHasArrows ? Math.min(this.options.arrowSize ?? 11, verticalLength / 2) : 0;
		this.horizontal.trackNode.setLeft(horizontalArrow);
		this.horizontal.trackNode.setRight((verticalRendered ? verticalSize : 0) + horizontalArrow);
		this.vertical.trackNode.setTop(verticalArrow);
		this.vertical.trackNode.setBottom((horizontalRendered ? horizontalSize : 0) + verticalArrow);
		this.horizontal.track.style.setProperty('--ash-scrollbar-slider-size', `${Math.min(horizontalSize, this.options.horizontalSliderSize ?? horizontalSize)}px`);
		this.vertical.track.style.setProperty('--ash-scrollbar-slider-size', `${Math.min(verticalSize, this.options.verticalSliderSize ?? verticalSize)}px`);
		const transform = `translate3d(${scrollLeft}px, ${scrollTop}px, 0)`;
		this.horizontal.trackNode.setTransform(transform);
		this.vertical.trackNode.setTransform(transform);
		this.horizontalMetrics = createScrollbarAxisMetrics(width, scrollWidth, scrollLeft, horizontalLength - 2 * horizontalArrow, 20);
		this.verticalMetrics = createScrollbarAxisMetrics(height, scrollHeight, scrollTop, verticalLength - 2 * verticalArrow, 20);
		this.horizontal.render(this.horizontalMetrics, horizontalRendered);
		this.vertical.render(this.verticalMetrics, verticalRendered);
		for (const { button, axis, direction } of this.arrows) {
			const horizontal = axis === 'horizontal';
			const size = horizontal ? horizontalArrow : verticalArrow;
			const metrics = horizontal ? this.horizontalMetrics : this.verticalMetrics;
			button.hidden = size === 0 || !(horizontal ? horizontalRendered : verticalRendered);
			button.disabled = direction < 0 ? metrics.position <= 0 : metrics.position >= metrics.maximumPosition;
			button.style.width = `${horizontal ? size : verticalSize}px`;
			button.style.height = `${horizontal ? horizontalSize : size}px`;
			const length = horizontal ? horizontalLength : verticalLength;
			const offset = direction < 0 ? 0 : length - size;
			button.style.left = `${horizontal ? offset : width - verticalSize}px`;
			button.style.top = `${horizontal ? height - horizontalSize : offset}px`;
			button.style.transform = transform;
		}
		this.updateVisibility();
	}

	private isRendered(visibility: ScrollbarVisibilityOption | undefined, needed: boolean): boolean {
		return visibility === ScrollbarVisibilityOption.Visible || (visibility !== ScrollbarVisibilityOption.Hidden && needed);
	}

	private updateVisibility(): void {
		const reveal = this.hovered || this.focused || this.scrolling;
		this.horizontal.track.dataset.visibility = this.options.horizontal === ScrollbarVisibilityOption.Visible || reveal ? 'visible' : 'auto';
		this.vertical.track.dataset.visibility = this.options.vertical === ScrollbarVisibilityOption.Visible || reveal ? 'visible' : 'auto';
		for (const { button, axis } of this.arrows) {
			button.dataset.visibility = axis === 'horizontal' ? this.horizontal.track.dataset.visibility : this.vertical.track.dataset.visibility;
		}
	}
}
