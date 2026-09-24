import { stopEvent } from "./dom.js";
import {
	keyCodeFromKeyboardEvent,
	KeyCode,
	ScanCode,
	ScanCodeUtils,
} from "../common/keyCodes.js";

export interface KeyChord {
	/** Physical key identity, such as `KeyP` or `ArrowDown`. */
	readonly code: string;
	readonly ctrlKey?: boolean;
	readonly shiftKey?: boolean;
	readonly altKey?: boolean;
	readonly metaKey?: boolean;
}

export interface IKeyboardEvent {
	readonly browserEvent: KeyboardEvent;
	readonly key: string;
	readonly code: string;
	readonly keyCode: KeyCode;
	readonly scanCode: ScanCode;
	readonly location: number;
	readonly ctrlKey: boolean;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
	readonly altGraphKey: boolean;
	readonly isComposing: boolean;
	readonly repeat: boolean;
	matches(chord: KeyChord): boolean;
	stop(options?: { readonly preventDefault?: boolean; readonly immediate?: boolean }): void;
}

/**
 * Stable physical-key view for shortcut and keybinding matching.
 *
 * Local widget navigation should normally read `KeyboardEvent.key` directly.
 * Construct this representation when an event crosses a component boundary or
 * must be compared with a reusable physical key chord.
 */
export class StandardKeyboardEvent implements IKeyboardEvent {
	readonly key: string;
	readonly code: string;
	readonly keyCode: KeyCode;
	readonly scanCode: ScanCode;
	readonly location: number;
	readonly ctrlKey: boolean;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
	readonly altGraphKey: boolean;
	readonly isComposing: boolean;
	readonly repeat: boolean;

	constructor(readonly browserEvent: KeyboardEvent) {
		this.key = browserEvent.key;
		this.code = browserEvent.code;
		this.keyCode = keyCodeFromKeyboardEvent(
			browserEvent.key,
			browserEvent.keyCode,
			browserEvent.code,
			browserEvent.location,
		);
		this.scanCode = ScanCodeUtils.toEnum(browserEvent.code);
		this.location = browserEvent.location;
		this.ctrlKey = browserEvent.ctrlKey;
		this.shiftKey = browserEvent.shiftKey;
		this.altKey = browserEvent.altKey;
		this.metaKey = browserEvent.metaKey;
		this.altGraphKey = browserEvent.getModifierState?.("AltGraph") ?? false;
		this.isComposing = browserEvent.isComposing;
		this.repeat = browserEvent.repeat;
	}

	matches(chord: KeyChord): boolean {
		return !this.isComposing &&
			!this.altGraphKey &&
			this.code === chord.code &&
			this.ctrlKey === Boolean(chord.ctrlKey) &&
			this.shiftKey === Boolean(chord.shiftKey) &&
			this.altKey === Boolean(chord.altKey) &&
			this.metaKey === Boolean(chord.metaKey);
	}

	stop(options?: {
		readonly preventDefault?: boolean;
		readonly immediate?: boolean;
	}): void {
		stopEvent(this.browserEvent, options);
	}
}

export function hasModifierKeys(event: KeyboardEvent): boolean {
	return event.ctrlKey || event.shiftKey || event.altKey || event.metaKey;
}

export function isModifierKey(event: KeyboardEvent): boolean {
	return event.key === "Control" ||
		event.key === "Shift" ||
		event.key === "Alt" ||
		event.key === "Meta";
}
