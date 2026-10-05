import { Emitter } from "../../../common/event.js";
import { Disposable, MutableDisposable, DisposableStore, type IDisposable, toDisposable } from "../../../common/lifecycle.js";
import { addDisposableListener, getWindow, isHTMLElement, isNode, h } from "../../dom.js";
import { disposableWindowTimeout } from "../../scheduler.js";
import { restoreFocus } from '../../focus.js';
import { getAriaAttribute, setAriaAttribute } from "../aria/aria.js";
import { AnchorAlignment, AnchorAxisAlignment, AnchorPosition, ContextView, ContextViewHideReason, type IContextViewProvider } from "../contextview/contextview.js";
import { HoverPosition } from './hoverWidget.js';

export type HoverContentValue = string | HTMLElement | undefined;
export type HoverContent = HoverContentValue | (() => HoverContentValue);
export type HoverDelay = number | (() => number);
export type HoverPersistence = "transient" | "sticky";

export interface IHoverPositionOptions {
	hoverPosition?: HoverPosition;
}

/** Element hover inputs resolved together after the delay, immediately before display. */
export interface IDelayedHoverOptions {
	content: string | HTMLElement;
	position?: IHoverPositionOptions;
}

export interface IHoverLifecycleOptions {
	/** Related targets skip the delay when moving between their hovers. */
	readonly groupId?: string;
	/** Uses the configured shorter pointer delay. */
	readonly reducedDelay?: boolean;
	/** Enter or Space moves keyboard focus into the tooltip. */
	readonly setupKeyboardEvents?: boolean;
}

export interface HoverOptions {
	readonly target: HTMLElement;
	readonly content: HoverContent;
	readonly getHoverOptions?: () => IDelayedHoverOptions;
	readonly delayMs?: HoverDelay;
	readonly persistence?: HoverPersistence;
	readonly enabled?: () => boolean;
	readonly pointerHoverEnabled?: () => boolean;
	readonly anchorAlignment?: AnchorAlignment;
	readonly anchorAxisAlignment?: AnchorAxisAlignment;
	readonly anchorPosition?: AnchorPosition;
	readonly gap?: number;
	readonly contextViewProvider?: IContextViewProvider;
	readonly setupKeyboardEvents?: boolean;
}

let hoverId = 0;

/** A managed, accessible tooltip hosted in a ContextView. */
export class Hover extends Disposable {
	readonly element: HTMLElement;
	private readonly contextView: IContextViewProvider;
	private readonly showTimer = this._register(new MutableDisposable<IDisposable>());
	private readonly hideTimer = this._register(new MutableDisposable<IDisposable>());
	private readonly tooltipListeners = this._register(new DisposableStore());
	private readonly _onDidShow = this._register(new Emitter<void>());
	private readonly _onDidHide = this._register(new Emitter<void>());
	readonly onDidShow = this._onDidShow.event;
	readonly onDidHide = this._onDidHide.event;
	private readonly delayMs: HoverDelay;
	private readonly persistence: HoverPersistence;
	private readonly enabled: (() => boolean) | undefined;
	private readonly pointerHoverEnabled: (() => boolean) | undefined;
	private readonly anchorAlignment: AnchorAlignment;
	private readonly anchorAxisAlignment: AnchorAxisAlignment;
	private readonly anchorPosition: AnchorPosition;
	private readonly gap: number;
	private content: HoverContent;
	private readonly getHoverOptions: (() => IDelayedHoverOptions) | undefined;
	private tooltip: HTMLDivElement | undefined;
	private previousTitle: string | undefined;
	private previousDescription: string | undefined;
	private descriptionApplied = false;
	private _visible = false;
	private pointerDown = false;
	private hoverFocused = false;

	constructor(options: HoverOptions) {
		super();
		const target = options.target;
		this.element = target;
		this.content = options.content;
		this.getHoverOptions = options.getHoverOptions;
		this.delayMs = options.delayMs ?? 300;
		this.persistence = options.persistence ?? "transient";
		this.enabled = options.enabled;
		this.pointerHoverEnabled = options.pointerHoverEnabled;
		this.anchorAlignment = options.anchorAlignment ??
			AnchorAlignment.Center;
		this.anchorAxisAlignment = options.anchorAxisAlignment ??
			AnchorAxisAlignment.Vertical;
		this.anchorPosition = options.anchorPosition ??
			AnchorPosition.Above;
		this.gap = Math.max(0, options.gap ?? 6);
		this.contextView = options.contextViewProvider ??
			this._register(new ContextView(target.ownerDocument.body));

		const title = target.getAttribute("title");
		if (title !== null) {
			this.previousTitle = title;
			target.removeAttribute("title");
		}
		this._register(toDisposable(() => {
			this.restoreDescription();
			if (this.previousTitle !== undefined) {
				target.setAttribute("title", this.previousTitle);
			}
		}));
		this._register(toDisposable(() => this.hide()));

		this._register(addDisposableListener(target, "pointerenter", () => {
			this.hideTimer.clear();
			this.scheduleShow("pointer");
		}));
		this._register(addDisposableListener(target, "pointerdown", () => {
			this.pointerDown = true;
			this.hide();
		}, true));
		this._register(addDisposableListener(target, "pointerup", () => {
			this.pointerDown = false;
		}, true));
		this._register(addDisposableListener(target, "pointercancel", () => {
			this.pointerDown = false;
		}, true));
		this._register(addDisposableListener(target, "pointerleave", (event) => {
			this.pointerDown = false;
			if (this.isInsideHover(event.relatedTarget)) return;
			this.scheduleHide();
		}));
		this._register(addDisposableListener(target, "focusin", (event: FocusEvent) => {
			// Focus returning from a dismissed hover or removed overlay must not reopen it.
			const fromHover = isHTMLElement(event.relatedTarget) &&
				event.relatedTarget.closest(".ash-hover") !== null;
			if (this.pointerDown || !event.relatedTarget || fromHover) {
				return;
			}
			this.scheduleShow("focus");
		}));
		this._register(addDisposableListener(target, "focusout", (event) => {
			if (this.isInsideHover(event.relatedTarget)) return;
			this.scheduleHide();
		}));
		if (options.setupKeyboardEvents) {
			this._register(addDisposableListener(target, "keydown", (event: KeyboardEvent) => {
				if (event.key !== " " && event.key !== "Enter") return;
				this.show();
				if (this.tooltip) {
					this.tooltip.tabIndex = -1;
					this.tooltip.focus();
				}
			}));
		}
	}

	get visible(): boolean {
		return this._visible;
	}

	show(): void {
		this.showTimer.clear();
		this.hideTimer.clear();
		if (this.visible || this.enabled?.() === false) return;
		const ownerDocument = this.element.ownerDocument;
		const tooltip = h(ownerDocument, "div");
		hoverId += 1;
		tooltip.id = `ash-hover-${hoverId}`;
		tooltip.className = "ash-hover";
		tooltip.setAttribute("role", "tooltip");
		const hoverOptions = this.getHoverOptions?.();
		if (!this.renderContent(tooltip, hoverOptions ? hoverOptions.content : this.content)) return;
		let anchorAxisAlignment = this.anchorAxisAlignment;
		let anchorPosition = this.anchorPosition;
		switch (hoverOptions?.position?.hoverPosition) {
			case HoverPosition.LEFT:
				anchorAxisAlignment = AnchorAxisAlignment.Horizontal;
				anchorPosition = AnchorPosition.Above;
				break;
			case HoverPosition.RIGHT:
				anchorAxisAlignment = AnchorAxisAlignment.Horizontal;
				anchorPosition = AnchorPosition.Below;
				break;
			case HoverPosition.BELOW:
				anchorAxisAlignment = AnchorAxisAlignment.Vertical;
				anchorPosition = AnchorPosition.Below;
				break;
			case HoverPosition.ABOVE:
				anchorAxisAlignment = AnchorAxisAlignment.Vertical;
				anchorPosition = AnchorPosition.Above;
				break;
		}
		this.tooltipListeners.clear();
		this.tooltipListeners.add(addDisposableListener(
			tooltip,
			"pointerenter",
			() => this.hideTimer.clear(),
		));
		this.tooltipListeners.add(addDisposableListener(
			tooltip,
			"pointerleave",
			(event) => {
				if (
					isNode(event.relatedTarget) &&
					this.element.contains(event.relatedTarget)
				) {
					return;
				}
				this.scheduleHide();
			},
		));
		this.tooltipListeners.add(addDisposableListener(
			tooltip,
			"focusin",
			() => {
				this.hoverFocused = true;
				this.hideTimer.clear();
			},
		));
		this.tooltipListeners.add(addDisposableListener(
			tooltip,
			"focusout",
			(event) => {
				// ContextView hides its DOM before reporting Escape, blurring actions with no next target.
				if (event.relatedTarget) this.hoverFocused = this.isInsideHover(event.relatedTarget);
				if (
					isNode(event.relatedTarget) &&
					this.element.contains(event.relatedTarget)
				) {
					return;
				}
				this.scheduleHide();
			},
		));
		this.tooltipListeners.add(addDisposableListener(ownerDocument, "pointermove", event => {
			if (this.persistence === "sticky" || this.hoverFocused) return;
			if (isNode(event.target) && (this.element.contains(event.target) || tooltip.contains(event.target))) {
				this.hideTimer.clear();
				return;
			}
			const target = this.element.getBoundingClientRect();
			const card = tooltip.getBoundingClientRect();
			const inside = (rect: DOMRect): boolean => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
			// Only the narrow gap between the anchor and card belongs to the hover's pointer region.
			const horizontalGap = event.clientX >= Math.min(target.right, card.right) && event.clientX <= Math.max(target.left, card.left) && event.clientY >= Math.max(target.top, card.top) && event.clientY <= Math.min(target.bottom, card.bottom);
			const verticalGap = event.clientY >= Math.min(target.bottom, card.bottom) && event.clientY <= Math.max(target.top, card.top) && event.clientX >= Math.max(target.left, card.left) && event.clientX <= Math.min(target.right, card.right);
			if (inside(target) || inside(card) || horizontalGap || verticalGap) this.hideTimer.clear();
			else this.scheduleHide();
		}));
		const dismissOutsideTooltip = (event: Event) => {
			if (isNode(event.target) && tooltip.contains(event.target)) return;
			this.hide();
		};
		this.tooltipListeners.add(addDisposableListener(ownerDocument, "pointerdown", dismissOutsideTooltip, true));
		this.tooltipListeners.add(addDisposableListener(ownerDocument, "click", dismissOutsideTooltip, true));
		this.tooltip = tooltip;
		this.applyDescription(tooltip.id);
		// Layout can synchronously rebuild and dispose the target while measuring
		// its anchor. Treat the view as active first so disposal can close it.
		this._visible = true;
		const shown = this.contextView.show({
			anchor: this.element,
			content: tooltip,
			anchorAlignment: this.anchorAlignment,
			anchorAxisAlignment,
			anchorPosition,
			gap: this.gap,
			presentation: "hover",
			onHide: (reason) => this.didHide(reason),
		});
		if (!shown) {
			if (this._visible) this.didHide();
			return;
		}
		this._onDidShow.fire();
	}

	hide(): void {
		this.showTimer.clear();
		this.hideTimer.clear();
		if (!this._visible) return;
		this.contextView.hide();
	}

	update(content: HoverContent): void {
		this.content = content;
		if (!this._visible || !this.tooltip) return;
		if (!this.renderContent(this.tooltip)) {
			this.hide();
			return;
		}
		this.contextView.layout();
	}

	private scheduleShow(trigger: "pointer" | "focus"): void {
		if (this.visible || this.showTimer.value) return;
		const delayMs = Math.max(
			0,
			typeof this.delayMs === "function"
				? this.delayMs()
				: this.delayMs,
		);
		this.showTimer.value = disposableWindowTimeout(
			getWindow(this.element),
			() => {
				this.showTimer.clear();
				if (trigger === "pointer" && this.pointerHoverEnabled?.() === false) return;
				this.show();
			},
			delayMs,
		);
	}

	private scheduleHide(): void {
		this.showTimer.clear();
		if (
			this.persistence === "sticky" ||
			this.hoverFocused ||
			!this.visible ||
			this.hideTimer.value
		) return;
		this.hideTimer.value = disposableWindowTimeout(
			getWindow(this.element),
			() => {
				this.hideTimer.clear();
				this.hide();
			},
			80,
		);
	}

	private renderContent(container: HTMLElement, source: HoverContent = this.content): boolean {
		const content = typeof source === "function" ? source() : source;
		container.replaceChildren();
		if (content === undefined || content === "") return false;
		if (typeof content === "string") {
			container.textContent = content;
		} else {
			container.append(content);
		}
		return true;
	}

	private isInsideHover(candidate: EventTarget | null): boolean {
		return isNode(candidate) && Boolean(this.tooltip?.contains(candidate));
	}

	private applyDescription(id: string): void {
		this.previousDescription = getAriaAttribute(
			this.element,
			"describedby",
		);
		this.descriptionApplied = true;
		const ids = new Set(
			this.previousDescription?.split(/\s+/).filter(Boolean) ?? [],
		);
		ids.add(id);
		setAriaAttribute(this.element, "describedby", [...ids].join(" "));
	}

	private restoreDescription(): void {
		if (!this.descriptionApplied) return;
		if (this.previousDescription === undefined) {
			setAriaAttribute(this.element, "describedby", undefined);
		} else {
			setAriaAttribute(
				this.element,
				"describedby",
				this.previousDescription,
			);
		}
		this.previousDescription = undefined;
		this.descriptionApplied = false;
	}

	private didHide(reason?: ContextViewHideReason): void {
		const wasVisible = this._visible;
		const returnFocus = reason === ContextViewHideReason.Escape && this.hoverFocused;
		this._visible = false;
		this.hoverFocused = false;
		this.tooltip = undefined;
		if (!this.tooltipListeners.isDisposed) this.tooltipListeners.clear();
		this.restoreDescription();
		if (returnFocus) restoreFocus(this.element);
		if (wasVisible) this._onDidHide.fire();
	}
}
