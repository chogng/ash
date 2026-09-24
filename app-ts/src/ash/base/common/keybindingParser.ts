import {
	Keybinding,
	type KeybindingChord,
	KeybindingChordKind,
	logicalKey,
	MAX_KEYBINDING_CHORDS,
	physicalKey,
} from "./keybindings.js";
import { KeyCode, KeyCodeUtils, ScanCode, ScanCodeUtils } from "./keyCodes.js";

const modifierNames = new Map<string, ModifierName>([
	["ctrl", "ctrlKey"],
	["control", "ctrlKey"],
	["shift", "shiftKey"],
	["alt", "altKey"],
	["option", "altKey"],
	["meta", "metaKey"],
	["cmd", "metaKey"],
	["command", "metaKey"],
	["win", "metaKey"],
	["windows", "metaKey"],
	["super", "metaKey"],
	["primary", "primaryKey"],
	["cmdorctrl", "primaryKey"],
]);

type ModifierName =
	| "primaryKey"
	| "ctrlKey"
	| "shiftKey"
	| "altKey"
	| "metaKey";

/**
 * Parses a user keybinding such as `ctrl+k ctrl+c` or `shift+[KeyP]`.
 *
 * Logical keys use `KeyboardEvent.key`; bracketed keys use the physical
 * `KeyboardEvent.code`. Invalid or ambiguous input returns `undefined`.
 */
export function parseKeybinding(value: string): Keybinding | undefined {
	const chordTexts = value.trim().split(/\s+/).filter(Boolean);
	if (chordTexts.length === 0) return undefined;
	if (chordTexts.length > MAX_KEYBINDING_CHORDS) return undefined;

	const chords: KeybindingChord[] = [];
	for (const chordText of chordTexts) {
		const chord = parseChord(chordText);
		if (!chord) return undefined;
		chords.push(chord);
	}
	return new Keybinding(chords);
}

/** Serializes a keybinding into the canonical shared user-settings syntax. */
export function serializeKeybinding(keybinding: Keybinding): string {
	return keybinding.chords.map((chord) => {
		const parts: string[] = [];
		if (chord.modifiers.primaryKey) parts.push("primary");
		if (chord.modifiers.ctrlKey) parts.push("ctrl");
		if (chord.modifiers.metaKey) parts.push("meta");
		if (chord.modifiers.altKey) parts.push("alt");
		if (chord.modifiers.shiftKey) parts.push("shift");
		if (chord.kind === KeybindingChordKind.Physical) {
			parts.push(`[${chord.code}]`);
		} else {
			parts.push(chord.key === " " ? "space" : chord.key);
		}
		return parts.join("+");
	}).join(" ");
}

function parseChord(value: string): KeybindingChord | undefined {
	const tokens = value.split("+").map((token) => token.trim());
	if (tokens.some((token) => token.length === 0)) return undefined;
	if (tokens.length === 1) {
		const singleModifier = singleModifierKey(tokens[0]);
		if (singleModifier) return logicalKey(singleModifier);
	}

	const modifiers: Record<ModifierName, boolean> = {
		primaryKey: false,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		metaKey: false,
	};
	let key: string | undefined;

	for (const token of tokens) {
		const modifier = modifierNames.get(token.toLocaleLowerCase("en-US"));
		if (modifier) {
			if (modifiers[modifier]) return undefined;
			modifiers[modifier] = true;
			continue;
		}
		if (key !== undefined) return undefined;
		key = token;
	}

	if (!key) return undefined;
	if (modifiers.primaryKey && (modifiers.ctrlKey || modifiers.metaKey)) {
		return undefined;
	}

	const chordModifiers = modifiers.primaryKey
		? {
			primaryKey: true,
			shiftKey: modifiers.shiftKey,
			altKey: modifiers.altKey,
		} as const
		: {
			ctrlKey: modifiers.ctrlKey,
			shiftKey: modifiers.shiftKey,
			altKey: modifiers.altKey,
			metaKey: modifiers.metaKey,
		} as const;
	const physicalMatch = /^\[([^\]]+)\]$/.exec(key);
	if (physicalMatch) {
		return ScanCodeUtils.toEnum(physicalMatch[1]) === ScanCode.None
			? undefined
			: physicalKey(ScanCodeUtils.toString(ScanCodeUtils.toEnum(physicalMatch[1])), chordModifiers);
	}
	if (KeyCodeUtils.fromString(key) === KeyCode.Unknown && [...key].length !== 1) {
		return undefined;
	}
	return logicalKey(key, chordModifiers);
}

function singleModifierKey(value: string): string | undefined {
	switch (value.toLocaleLowerCase("en-US")) {
		case "ctrl":
		case "control":
			return "ctrl";
		case "shift":
			return "shift";
		case "alt":
		case "option":
			return "alt";
		case "meta":
		case "cmd":
		case "command":
		case "win":
		case "windows":
			return "meta";
		default:
			return undefined;
	}
}
