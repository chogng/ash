import { Emitter } from "../../../common/event.js";
import { Disposable, MutableDisposable, DisposableStore, type IDisposable, toDisposable } from "../../../common/lifecycle.js";
import { addDisposableListener, getWindow, isNode, h } from "../../dom.js";
import { disposableWindowTimeout } from "../../scheduler.js";
import { getAriaAttribute, setAriaAttribute } from "../aria/aria.js";
import { AnchorAlignment, AnchorAxisAlignment, AnchorPosition, ContextView, type ContextViewHideReason, type IContextViewProvider } from "../contextview/contextview.js";

export type HoverContentValue = string | HTMLElement | undefined;
export type HoverContent = HoverContentValue | (() => HoverContentValue);
export type HoverDelay = number | (() => number);
export type HoverPersistence = "transient" | "sticky";

export interface HoverOptions {
	readonly target: HTMLElement;
	readonly content: HoverContent;
	readonly delayMs?: HoverDelay;
	readonly persistence?: HoverPersistence;
	readonly enabled?: () => boolean;
	readonly pointerHoverEnabled?: () => boolean;
	readonly anchorAlignment?: AnchorAlignment;
	readonly anchorAxisAlignment?: AnchorAxisAlignment;
	readonly anchorPosition?: AnchorPosition;
	readonly gap?: number;
	readonly contextViewProvider?: IContextViewProvider;
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
	private tooltip: HTMLDivElement | undefined;
	private previousTitle: string | undefined;
	private previousDescription: string | undefined;
	private descriptionApplied = false;
	private _visible = false;
	private pointerDown = false;

	constructor(options: HoverOptions) {
		super();
		const target = options.target;
		this.element = target;
		this.content = options.content;
		this.delayMs = options.delayMs ?? 300;
		this.persistence = options.persistence ?? "transient";
		this.enabled = options.enabled;
		this.pointerHoverEnabled = options.pointerHoverEnabled;
		this.anchorAlignment = options.anchorAlignment ??
			AnchorAlignment.Left;
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
			this.scheduleShow();
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
		this._register(addDisposableListener(target, "focusin", () => {
			if (!this.pointerDown) this.show();
		}));
		this._register(addDisposableListener(target, "focusout", (event) => {
			if (this.isInsideHover(event.relatedTarget)) return;
			this.scheduleHide();
		}));
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
		if (!this.renderContent(tooltip)) return;
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
			() => this.hideTimer.clear(),
		));
		this.tooltipListeners.add(addDisposableListener(
			tooltip,
			"focusout",
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
			anchorAxisAlignment: this.anchorAxisAlignment,
			anchorPosition: this.anchorPosition,
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

	private scheduleShow(): void {
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
				if (this.pointerHoverEnabled?.() === false) return;
				this.show();
			},
			delayMs,
		);
	}

	private scheduleHide(): void {
		this.showTimer.clear();
		if (
			this.persistence === "sticky" ||
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

	private renderContent(container: HTMLElement): boolean {
		const content = typeof this.content === "function"
			? this.content()
			: this.content;
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

	private didHide(_reason?: ContextViewHideReason): void {
		const wasVisible = this._visible;
		this._visible = false;
		this.tooltip = undefined;
		if (!this.tooltipListeners.isDisposed) this.tooltipListeners.clear();
		this.restoreDescription();
		if (wasVisible) this._onDidHide.fire();
	}
}
