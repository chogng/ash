import './hover.css';
import { Emitter } from '../../../common/event.js';
import { cancelOnDispose, type CancellationToken } from '../../../common/cancellation.js';
import { Disposable, MutableDisposable, DisposableStore, type IDisposable, toDisposable } from '../../../common/lifecycle.js';
import { addDisposableListener, getWindow, isHTMLElement, isNode, h } from '../../dom.js';
import { disposableWindowTimeout } from '../../scheduler.js';
import { restoreFocus, trapTabFocus } from '../../focus.js';
import { getAriaAttribute, setAriaAttribute } from '../aria/aria.js';
import { AnchorAlignment, AnchorAxisAlignment, AnchorPosition, ContextView, ContextViewHideReason, type IContextViewProvider } from '../contextview/contextview.js';
import { HoverPosition } from './hoverWidget.js';

export type HoverContentValue = string | HTMLElement | undefined;
/** A factory's token is cancelled when its content is replaced, hidden or disposed. */
export type HoverContent = HoverContentValue | ((token: CancellationToken) => HoverContentValue);
export type HoverDelay = number | (() => number);
export type HoverPersistence = 'transient' | 'sticky';

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
	readonly trapFocus?: boolean;
	/** The coordinating owner can include child hover views in this hover's interaction boundary. */
	readonly isTargetWithin?: (target: Node) => boolean;
}

let hoverId = 0;

/** A managed, accessible tooltip hosted in a ContextView. */
export class Hover extends Disposable {
	readonly element: HTMLElement;
	private readonly contextView: IContextViewProvider;
	private readonly showTimer = this._register(new MutableDisposable<IDisposable>());
	private readonly hideTimer = this._register(new MutableDisposable<IDisposable>());
	private readonly tooltipListeners = this._register(new DisposableStore());
	private readonly contentLifetime = this._register(new DisposableStore());
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
	private pointerOver = false;
	private targetFocused = false;
	private readonly targetExitListeners = this._register(new MutableDisposable<DisposableStore>());
	private hoverFocused = false;
	private pointerInHover = false;
	private pointerLocked = false;
	private hideOnKeyDown = true;
	private keyboardFocusTrapped = false;
	private readonly trapFocus: boolean;
	private readonly isTargetWithin: ((target: Node) => boolean) | undefined;

	constructor(options: HoverOptions) {
		super();
		const target = options.target;
		this.element = target;
		this.content = options.content;
		this.getHoverOptions = options.getHoverOptions;
		this.trapFocus = options.trapFocus ?? false;
		this.isTargetWithin = options.isTargetWithin;
		this.delayMs = options.delayMs ?? 300;
		this.persistence = options.persistence ?? 'transient';
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

		const title = target.getAttribute('title');
		if (title !== null) {
			this.previousTitle = title;
			target.removeAttribute('title');
		}
		this._register(toDisposable(() => {
			this.restoreDescription();
			if (this.previousTitle !== undefined) {
				target.setAttribute('title', this.previousTitle);
			}
		}));

		this._register(addDisposableListener(target, 'pointerenter', () => {
			this.pointerOver = true;
			this.bindTargetExitListeners();
			this.hideTimer.clear();
			this.scheduleShow('pointer');
		}));
		this._register(addDisposableListener(target, 'pointerdown', () => {
			this.pointerDown = true;
			this.bindTargetExitListeners();
			this.hide();
		}, true));
		this._register(addDisposableListener(target, 'focusin', (event: FocusEvent) => {
			this.targetFocused = true;
			this.bindTargetExitListeners();
			// Focus returning from a dismissed hover or removed overlay must not reopen it.
			const fromHover = isHTMLElement(event.relatedTarget) &&
				event.relatedTarget.closest('.ash-hover') !== null;
			if (this.pointerDown || !event.relatedTarget || fromHover) {
				return;
			}
			this.scheduleShow('focus');
		}));
		if (options.setupKeyboardEvents) {
			this._register(addDisposableListener(target, 'keydown', (event: KeyboardEvent) => {
				if (event.key !== ' ' && event.key !== 'Enter') return;
				event.preventDefault();
				event.stopPropagation();
				this.show(true);
			}));
		}
	}

	/** Idle targets need only activation listeners; exit tracking belongs to an interaction. */
	private bindTargetExitListeners(): void {
		if (this.targetExitListeners.value) return;
		const listeners = new DisposableStore();
		this.targetExitListeners.value = listeners;
		for (const type of ['pointerup', 'pointercancel'] as const) {
			listeners.add(addDisposableListener(this.element, type, () => {
				this.pointerDown = false;
				this.releaseTargetExitListeners();
			}, true));
		}
		listeners.add(addDisposableListener(this.element, 'pointerleave', event => {
			this.pointerOver = false;
			this.pointerDown = false;
			this.releaseTargetExitListeners();
			if (!this.isInsideHover(event.relatedTarget)) this.scheduleHide();
		}));
		listeners.add(addDisposableListener(this.element, 'focusout', event => {
			this.targetFocused = false;
			this.releaseTargetExitListeners();
			if (!this.isInsideHover(event.relatedTarget)) this.scheduleHide();
		}));
		listeners.add(addDisposableListener(this.element.ownerDocument, 'keydown', event => {
			if (event.isComposing || event.defaultPrevented) { return; }
			if (event.key === 'Alt') {
				this.pointerLocked = true;
				this.hideTimer.clear();
				return;
			}
			if (event.key === 'Escape' || (this.hideOnKeyDown && !event.ctrlKey && !event.metaKey && !['Shift', 'Control', 'Meta'].includes(event.key))) {
				this.hide();
			}
		}));
		listeners.add(addDisposableListener(this.element.ownerDocument, 'keyup', event => {
			if (event.key !== 'Alt') { return; }
			this.pointerLocked = false;
			if (!this.pointerOver && !this.pointerInHover && !this.hoverFocused && this.persistence !== 'sticky') { this.hide(); }
			this.releaseTargetExitListeners();
		}));
		listeners.add(addDisposableListener(getWindow(this.element), 'blur', () => {
			this.pointerOver = false;
			this.pointerDown = false;
			this.targetFocused = false;
			this.hide();
			this.releaseTargetExitListeners();
		}));
	}

	private releaseTargetExitListeners(): void {
		if (!this.pointerOver && !this.pointerDown && !this.targetFocused && !this.visible && !this.pointerLocked) {
			this.targetExitListeners.clear();
		}
	}

	get visible(): boolean {
		return this._visible;
	}

	/** Current rendered root for coordinating child views; callers must not mutate its content. */
	get domNode(): HTMLElement | undefined {
		return this.tooltip;
	}

	protected override disposeCore(): void {
		// Notify callers while subscriptions still exist, then release owned resources.
		this.hide();
		super.disposeCore();
	}

	show(focus = false): void {
		this.showTimer.clear();
		this.hideTimer.clear();
		if (this.visible) {
			if (focus) { this.focusTooltip(); }
			return;
		}
		if (this.enabled?.() === false) {
			return;
		}
		const ownerDocument = this.element.ownerDocument;
		const tooltip = h(ownerDocument, 'div');
		hoverId += 1;
		tooltip.id = `ash-hover-${hoverId}`;
		tooltip.className = 'ash-hover';
		tooltip.setAttribute('role', 'tooltip');
		const hoverOptions = this.getHoverOptions?.();
		if (!this.renderContent(tooltip, hoverOptions ? hoverOptions.content : this.content)) {
			this.contentLifetime.clear();
			return;
		}
		const { anchorAxisAlignment, anchorPosition } = this.resolvePosition(hoverOptions?.position?.hoverPosition);
		// Explicit show() calls also need exit tracking, even without a preceding enter event.
		this.bindTargetExitListeners();
		this.bindTooltipListeners(tooltip);
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
			presentation: 'hover',
			isTargetWithin: this.isTargetWithin,
			onHide: (reason) => this.didHide(reason),
		});
		if (!shown) {
			if (this._visible) {
				this.didHide();
			}
			return;
		}
		this._onDidShow.fire();
		if (focus) { this.focusTooltip(); }
	}

	private focusTooltip(): void {
		if (!this.tooltip) { return; }
		if (!this.trapFocus && !this.keyboardFocusTrapped) {
			this.tooltipListeners.add(trapTabFocus(this.tooltip));
			this.keyboardFocusTrapped = true;
		}
		this.tooltip.tabIndex = -1;
		this.tooltip.focus();
	}

	hide(): void {
		this.showTimer.clear();
		this.hideTimer.clear();
		if (!this._visible) {
			this.contentLifetime.clear();
			return;
		}
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

	private resolvePosition(position: HoverPosition | undefined): { anchorAxisAlignment: AnchorAxisAlignment; anchorPosition: AnchorPosition; } {
		let anchorAxisAlignment = this.anchorAxisAlignment;
		let anchorPosition = this.anchorPosition;
		switch (position) {
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
		return { anchorAxisAlignment, anchorPosition };
	}

	private bindTooltipListeners(tooltip: HTMLDivElement): void {
		const ownerDocument = this.element.ownerDocument;
		this.tooltipListeners.clear();
		if (this.trapFocus) this.tooltipListeners.add(trapTabFocus(tooltip));
		this.tooltipListeners.add(addDisposableListener(tooltip, 'pointerenter', () => {
			this.pointerInHover = true;
			this.hideTimer.clear();
		}));
		this.tooltipListeners.add(addDisposableListener(tooltip, 'pointerleave', event => {
			this.pointerInHover = false;
			if (isNode(event.relatedTarget) && this.element.contains(event.relatedTarget)) {
				return;
			}
			this.scheduleHide();
		}));
		this.tooltipListeners.add(addDisposableListener(tooltip, 'focusin', () => {
			this.hoverFocused = true;
			this.hideTimer.clear();
		}));
		this.tooltipListeners.add(addDisposableListener(tooltip, 'focusout', event => {
			// ContextView hides its DOM before reporting Escape, blurring actions with no next target.
			if (event.relatedTarget) {
				this.hoverFocused = this.isInsideHover(event.relatedTarget);
			}
			if (isNode(event.relatedTarget) && this.element.contains(event.relatedTarget)) {
				return;
			}
			this.scheduleHide();
		}));

		this.tooltipListeners.add(addDisposableListener(ownerDocument, 'pointermove', event => this.handlePointerMove(event, tooltip)));
		const dismissOutsideTooltip = (event: Event) => {
			if (this.isInsideHover(event.target)) {
				return;
			}
			this.hide();
		};
		this.tooltipListeners.add(addDisposableListener(ownerDocument, 'pointerdown', dismissOutsideTooltip, true));
		this.tooltipListeners.add(addDisposableListener(ownerDocument, 'click', dismissOutsideTooltip, true));
	}

	private handlePointerMove(event: PointerEvent, tooltip: HTMLDivElement): void {
		const targetBounds = this.element.getBoundingClientRect();
		const tooltipBounds = tooltip.getBoundingClientRect();
		this.pointerInHover = this.isInsideHover(event.target) ||
			isPointInHoverRegion(event.clientX, event.clientY, targetBounds, tooltipBounds);
		if (this.persistence === 'sticky' || this.hoverFocused || this.pointerLocked) { return; }
		if (this.pointerInHover || (isNode(event.target) && this.element.contains(event.target))) {
			this.hideTimer.clear();
		} else {
			this.scheduleHide();
		}
	}

	private scheduleShow(trigger: 'pointer' | 'focus'): void {
		if (this.visible || this.showTimer.value) return;
		const delayMs = Math.max(
			0,
			typeof this.delayMs === 'function'
				? this.delayMs()
				: this.delayMs,
		);
		this.showTimer.value = disposableWindowTimeout(
			getWindow(this.element),
			() => {
				this.showTimer.clear();
				if (trigger === 'pointer' && this.pointerHoverEnabled?.() === false) return;
				this.show();
			},
			delayMs,
		);
	}

	private scheduleHide(): void {
		this.showTimer.clear();
		if (
			this.persistence === 'sticky' ||
			this.pointerLocked ||
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
		this.contentLifetime.clear();
		const content = typeof source === 'function' ? source(cancelOnDispose(this.contentLifetime)) : source;
		this.hideOnKeyDown = typeof content === 'string';
		container.replaceChildren();
		if (content === undefined || content === '') return false;
		if (typeof content === 'string') {
			container.textContent = content;
		} else {
			container.append(content);
		}
		return true;
	}

	private isInsideHover(candidate: EventTarget | null): boolean {
		return isNode(candidate) && (Boolean(this.tooltip?.contains(candidate)) || this.isTargetWithin?.(candidate) === true);
	}

	private applyDescription(id: string): void {
		this.previousDescription = getAriaAttribute(
			this.element,
			'describedby',
		);
		this.descriptionApplied = true;
		const ids = new Set(
			this.previousDescription?.split(/\s+/).filter(Boolean) ?? [],
		);
		ids.add(id);
		setAriaAttribute(this.element, 'describedby', [...ids].join(' '));
	}

	private restoreDescription(): void {
		if (!this.descriptionApplied) return;
		if (this.previousDescription === undefined) {
			setAriaAttribute(this.element, 'describedby', undefined);
		} else {
			setAriaAttribute(
				this.element,
				'describedby',
				this.previousDescription,
			);
		}
		this.previousDescription = undefined;
		this.descriptionApplied = false;
	}

	private didHide(reason?: ContextViewHideReason): void {
		this.showTimer.clear();
		this.hideTimer.clear();
		const wasVisible = this._visible;
		const returnFocus = reason === ContextViewHideReason.Escape && this.hoverFocused;
		this._visible = false;
		this.hoverFocused = false;
		this.pointerInHover = false;
		this.pointerLocked = false;
		this.keyboardFocusTrapped = false;
		this.tooltip = undefined;
		this.releaseTargetExitListeners();
		if (!this.contentLifetime.isDisposed) this.contentLifetime.clear();
		if (!this.tooltipListeners.isDisposed) this.tooltipListeners.clear();
		this.restoreDescription();
		if (returnFocus) restoreFocus(this.element);
		if (wasVisible) this._onDidHide.fire();
	}
}

function isPointInHoverRegion(x: number, y: number, target: DOMRect, tooltip: DOMRect): boolean {
	const containsPoint = (bounds: DOMRect): boolean => {
		return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
	};
	if (containsPoint(target) || containsPoint(tooltip)) {
		return true;
	}

	// Only the gap within both rectangles' shared span keeps the hover open.
	const inHorizontalGap = x >= Math.min(target.right, tooltip.right)
		&& x <= Math.max(target.left, tooltip.left)
		&& y >= Math.max(target.top, tooltip.top)
		&& y <= Math.min(target.bottom, tooltip.bottom);
	const inVerticalGap = y >= Math.min(target.bottom, tooltip.bottom)
		&& y <= Math.max(target.top, tooltip.top)
		&& x >= Math.max(target.left, tooltip.left)
		&& x <= Math.min(target.right, tooltip.right);
	return inHorizontalGap || inVerticalGap;
}
