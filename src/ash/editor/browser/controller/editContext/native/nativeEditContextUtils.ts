import { addDisposableListener, getShadowRoot } from '../../../../../base/browser/dom.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { isLowSurrogate } from '../../../../../base/common/strings.js';
import { type ILogService } from '../../../../../platform/log/common/log.js';
import type { ITextBuffer } from '../../../../common/model.js';

interface EditorEditContextEventMap extends EditContextEventHandlersEventMap {
	readonly compositionupdate: Event;
	readonly selectionchange: Event;
}

export interface ITypeData {
	text: string;
	replacePrevCharCnt: number;
	replaceNextCharCnt: number;
	positionDelta: number;
}

/** Maximum native text window used when the complete document is too large. */
export const NATIVE_TEXT_WINDOW_LENGTH = 32 * 1_024;

/** Prevents an untrusted browser from requesting an unbounded geometry array. */
export const MAX_CHARACTER_BOUNDS_REQUEST_LENGTH = 4 * 1_024;

/** Tracks focus for a DOM node, including nodes hosted inside a shadow root. */
export class FocusTracker extends Disposable {
	private focused = false;
	private paused = false;

	constructor(
		logService: ILogService,
		private readonly domNode: HTMLElement,
		private readonly onFocusChange: (focused: boolean) => void,
	) {
		super();
		this._register(addDisposableListener(this.domNode, 'focus', () => {
			logService.trace('NativeEditContext.focus');
			if (!this.paused) this.refreshFocusState();
		}));
		this._register(addDisposableListener(this.domNode, 'blur', () => {
			logService.trace('NativeEditContext.blur');
			if (!this.paused) this.setFocused(false);
		}));
	}

	get isFocused(): boolean {
		return this.focused;
	}

	focus(): void {
		this.domNode.focus({ preventScroll: true });
		this.refreshFocusState();
	}

	pause(): void {
		this.paused = true;
	}

	resume(): void {
		this.paused = false;
		this.refreshFocusState();
	}

	refreshFocusState(): void {
		const shadowRoot = getShadowRoot(this.domNode);
		const activeElement = shadowRoot ? shadowRoot.activeElement : this.domNode.ownerDocument.activeElement;
		this.setFocused(activeElement === this.domNode);
	}

	private setFocused(focused: boolean): void {
		if (this.focused === focused) return;
		this.focused = focused;
		this.onFocusChange(focused);
	}
}

/** Adds a listener to the browser EditContext object and owns its removal. */
export function editContextAddDisposableListener<K extends keyof EditorEditContextEventMap>(
	target: EditContext,
	type: K,
	listener: (this: GlobalEventHandlers, ev: EditorEditContextEventMap[K]) => void,
	options?: boolean | AddEventListenerOptions,
): IDisposable {
	target.addEventListener(type, listener as EventListener, options);
	return toDisposable(() => target.removeEventListener(type, listener as EventListener));
}

export function isFiniteOffset(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

export function isValidOffset(value: number, length: number): boolean {
	return isFiniteOffset(value) && value <= length;
}

export function clampOffset(value: number, length: number): number {
	return Math.min(Math.max(0, Number.isSafeInteger(value) ? value : 0), length);
}

export function isNativeTextUpdateEvent(event: {
	readonly text?: unknown;
	readonly updateRangeStart?: unknown;
	readonly updateRangeEnd?: unknown;
} | null | undefined): boolean {
	return Boolean(
		event &&
		typeof event.text === 'string' &&
		isFiniteOffset(event.updateRangeStart as number) &&
		isFiniteOffset(event.updateRangeEnd as number),
	);
}

export function createNativeTextWindow(
	buffer: Pick<ITextBuffer, 'getLength' | 'getTextBetweenOffsets'>,
	selectionStart: number,
	selectionEnd: number,
): { readonly startOffset: number; readonly text: string; } {
	const length = buffer.getLength();
	const selectionLength = selectionEnd - selectionStart;
	const width = Math.max(NATIVE_TEXT_WINDOW_LENGTH, selectionLength);
	const contextBefore = Math.floor((width - selectionLength) / 2);
	let start = Math.max(0, Math.min(selectionStart - contextBefore, length - width));
	let end = Math.min(length, start + width);

	// Read one extra UTF-16 unit on each side so both edges can preserve surrogate
	// pairs. Raw offsets also preserve boundaries inside a CRLF sequence.
	const readStart = Math.max(0, start - 1);
	const text = buffer.getTextBetweenOffsets(readStart, Math.min(length, end + 1));
	if (start > 0 && isLowSurrogate(text.charCodeAt(start - readStart))) start--;
	if (end < length && isLowSurrogate(text.charCodeAt(end - readStart))) end++;
	return { startOffset: start, text: text.slice(start - readStart, end - readStart) };
}
