import { stopEvent } from "./dom.js";
import { isFiniteNumber } from "../common/numbers.js";

export interface IMouseEvent {
	readonly browserEvent: MouseEvent;
	readonly target: EventTarget | null;
	readonly button: number;
	readonly leftButton: boolean;
	readonly middleButton: boolean;
	readonly rightButton: boolean;
	readonly buttons: number;
	readonly detail: number;
	readonly clientX: number;
	readonly clientY: number;
	readonly pageX: number;
	readonly pageY: number;
	readonly ctrlKey: boolean;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
	readonly timestamp: number;
	readonly defaultPrevented: boolean;
	preventDefault(): void;
	stopPropagation(): void;
}

export interface IMouseWheelEvent {
	readonly browserEvent: WheelEvent;
	readonly target: EventTarget | null;
	readonly deltaX: number;
	readonly deltaY: number;
	readonly deltaZ: number;
	readonly ctrlKey: boolean;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
	readonly defaultPrevented: boolean;
	preventDefault(): void;
	stopPropagation(): void;
}

/** Normalized mouse-event coordinates and buttons across browser windows. */
export class StandardMouseEvent implements IMouseEvent {
	readonly target: EventTarget | null;
	readonly button: number;
	readonly leftButton: boolean;
	readonly middleButton: boolean;
	readonly rightButton: boolean;
	readonly buttons: number;
	readonly detail: number;
	readonly clientX: number;
	readonly clientY: number;
	readonly pageX: number;
	readonly pageY: number;
	readonly ctrlKey: boolean;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
	readonly timestamp: number;

	constructor(readonly browserEvent: MouseEvent) {
		const targetWindow = eventWindow(browserEvent);
		this.target = browserEvent.target;
		this.button = browserEvent.button;
		this.leftButton = browserEvent.button === 0;
		this.middleButton = browserEvent.button === 1;
		this.rightButton = browserEvent.button === 2;
		this.buttons = browserEvent.buttons;
		this.detail = browserEvent.type === "dblclick"
			? 2
			: browserEvent.detail || 1;
		this.clientX = browserEvent.clientX;
		this.clientY = browserEvent.clientY;
		this.pageX = browserEvent.clientX + (targetWindow?.scrollX ?? 0);
		this.pageY = browserEvent.clientY + (targetWindow?.scrollY ?? 0);
		this.ctrlKey = browserEvent.ctrlKey;
		this.shiftKey = browserEvent.shiftKey;
		this.altKey = browserEvent.altKey;
		this.metaKey = browserEvent.metaKey;
		this.timestamp = browserEvent.timeStamp;
	}

	get defaultPrevented(): boolean {
		return this.browserEvent.defaultPrevented;
	}

	preventDefault(): void {
		this.browserEvent.preventDefault();
	}

	stopPropagation(): void {
		this.browserEvent.stopPropagation();
	}

	stop(options?: {
		readonly preventDefault?: boolean;
		readonly immediate?: boolean;
	}): void {
		stopEvent(this.browserEvent, options);
	}
}

function eventWindow(event: UIEvent): Window | undefined {
	if (event.view) return event.view;
	const target = event.target;
	if (
		target &&
		typeof target === "object" &&
		"ownerDocument" in target
	) {
		return (target as Node).ownerDocument?.defaultView ?? undefined;
	}
	return typeof window === "undefined" ? undefined : window;
}

export class StandardPointerEvent extends StandardMouseEvent {
	readonly pointerId: number;
	readonly pointerType: string;
	readonly pressure: number;
	readonly isPrimary: boolean;
	readonly width: number;
	readonly height: number;
	readonly tiltX: number;
	readonly tiltY: number;

	constructor(override readonly browserEvent: PointerEvent) {
		super(browserEvent);
		this.pointerId = browserEvent.pointerId ?? 0;
		this.pointerType = browserEvent.pointerType || "mouse";
		this.pressure = browserEvent.pressure ?? (
			browserEvent.buttons === 0 ? 0 : 0.5
		);
		this.isPrimary = browserEvent.isPrimary ?? true;
		this.width = browserEvent.width ?? 1;
		this.height = browserEvent.height ?? 1;
		this.tiltX = browserEvent.tiltX ?? 0;
		this.tiltY = browserEvent.tiltY ?? 0;
	}
}

export interface WheelNormalizationOptions {
	/** Pixel height represented by one line-mode wheel unit. */
	readonly lineHeight?: number;
	/** Pixel width represented by one page-mode horizontal wheel unit. */
	readonly pageWidth?: number;
	/** Pixel height represented by one page-mode vertical wheel unit. */
	readonly pageHeight?: number;
}

/**
 * A wheel event whose deltas are always expressed in CSS pixels.
 *
 * Positive X scrolls right and positive Y scrolls down, matching the modern
 * `WheelEvent` convention. Callers can therefore apply the deltas directly to
 * `scrollLeft` and `scrollTop`.
 */
export class StandardWheelEvent implements IMouseWheelEvent {
	readonly target: EventTarget | null;
	readonly deltaX: number;
	readonly deltaY: number;
	readonly deltaZ: number;
	readonly ctrlKey: boolean;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;

	constructor(
		readonly browserEvent: WheelEvent,
		options: WheelNormalizationOptions = {},
	) {
		this.target = browserEvent.target;
		const lineHeight = positiveFinite(options.lineHeight, 16);
		const pageWidth = positiveFinite(options.pageWidth, lineHeight * 10);
		const pageHeight = positiveFinite(options.pageHeight, lineHeight * 10);
		const factors = wheelDeltaFactors(
			browserEvent.deltaMode,
			lineHeight,
			pageWidth,
			pageHeight,
		);
		this.deltaX = finite(browserEvent.deltaX) * factors.x;
		this.deltaY = finite(browserEvent.deltaY) * factors.y;
		this.deltaZ = finite(browserEvent.deltaZ) * factors.z;
		this.ctrlKey = browserEvent.ctrlKey;
		this.shiftKey = browserEvent.shiftKey;
		this.altKey = browserEvent.altKey;
		this.metaKey = browserEvent.metaKey;
	}

	get defaultPrevented(): boolean {
		return this.browserEvent.defaultPrevented;
	}

	preventDefault(): void {
		this.browserEvent.preventDefault();
	}

	stopPropagation(): void {
		this.browserEvent.stopPropagation();
	}

	stop(options?: {
		readonly preventDefault?: boolean;
		readonly immediate?: boolean;
	}): void {
		stopEvent(this.browserEvent, options);
	}
}

function wheelDeltaFactors(
	deltaMode: number,
	lineHeight: number,
	pageWidth: number,
	pageHeight: number,
): { readonly x: number; readonly y: number; readonly z: number } {
	if (deltaMode === 1) {
		return { x: lineHeight, y: lineHeight, z: lineHeight };
	}
	if (deltaMode === 2) {
		return { x: pageWidth, y: pageHeight, z: pageHeight };
	}
	return { x: 1, y: 1, z: 1 };
}

function finite(value: number): number {
	return Number.isFinite(value) ? value : 0;
}

function positiveFinite(value: number | undefined, fallback: number): number {
	return isFiniteNumber(value) && value > 0
		? value
		: fallback;
}
