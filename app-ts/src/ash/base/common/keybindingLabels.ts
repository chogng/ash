import {
	KeybindingChordKind,
	type ResolvedKeybinding,
	type ResolvedKeybindingChord,
} from "./keybindings.js";
import { OperatingSystem } from "./platform.js";

export enum KeybindingLabelStyle {
	UI = "ui",
	Aria = "aria",
	UserSettings = "userSettings",
}

export interface KeybindingLabelPart {
	readonly label: string;
	readonly ariaLabel: string;
}

/** Returns one visual and accessible label for each chord. */
export function getKeybindingLabelParts(
	keybinding: ResolvedKeybinding,
): readonly KeybindingLabelPart[] {
	return keybinding.chords.map((chord) => ({
		label: formatChord(
			chord,
			keybinding.operatingSystem,
			KeybindingLabelStyle.UI,
		),
		ariaLabel: formatChord(
			chord,
			keybinding.operatingSystem,
			KeybindingLabelStyle.Aria,
		),
	}));
}

/** Formats a resolved keybinding for UI, accessibility, or settings. */
export function getKeybindingLabel(
	keybinding: ResolvedKeybinding,
	style: KeybindingLabelStyle = KeybindingLabelStyle.UI,
): string {
	const separator = style === KeybindingLabelStyle.Aria ? ", " : " ";
	return keybinding.chords
		.map((chord) =>
			formatChord(chord, keybinding.operatingSystem, style)
		)
		.join(separator);
}

function formatChord(
	chord: ResolvedKeybindingChord,
	operatingSystem: OperatingSystem,
	style: KeybindingLabelStyle,
): string {
	const singleModifier = singleModifierLabel(chord, operatingSystem, style);
	if (singleModifier) {
		return singleModifier;
	}
	if (style === KeybindingLabelStyle.UserSettings) {
		return formatUserSettingsChord(chord, operatingSystem);
	}

	const labels = style === KeybindingLabelStyle.Aria
		? ariaModifierLabels(operatingSystem)
		: uiModifierLabels(operatingSystem);
	const parts: string[] = [];
	if (chord.ctrlKey) parts.push(labels.ctrl);
	if (chord.shiftKey) parts.push(labels.shift);
	if (chord.altKey) parts.push(labels.alt);
	if (chord.metaKey) parts.push(labels.meta);
	parts.push(displayKey(chord));
	return parts.join(labels.separator);
}

function singleModifierLabel(
	chord: ResolvedKeybindingChord,
	operatingSystem: OperatingSystem,
	style: KeybindingLabelStyle,
): string | undefined {
	if (chord.ctrlKey || chord.shiftKey || chord.altKey || chord.metaKey) {
		return undefined;
	}
	const key = chord.key.toLocaleLowerCase("en-US");
	if (key !== "ctrl" && key !== "shift" && key !== "alt" && key !== "meta") {
		return undefined;
	}
	if (style === KeybindingLabelStyle.UserSettings) {
		return key === "meta"
			? operatingSystem === OperatingSystem.Macintosh ? "cmd" : operatingSystem === OperatingSystem.Windows ? "win" : "meta"
			: key;
	}
	const labels = style === KeybindingLabelStyle.Aria
		? ariaModifierLabels(operatingSystem)
		: uiModifierLabels(operatingSystem);
	return key === "ctrl" ? labels.ctrl :
		key === "shift" ? labels.shift :
		key === "alt" ? labels.alt : labels.meta;
}

function formatUserSettingsChord(
	chord: ResolvedKeybindingChord,
	operatingSystem: OperatingSystem,
): string {
	const parts: string[] = [];
	if (chord.ctrlKey) parts.push("ctrl");
	if (chord.shiftKey) parts.push("shift");
	if (chord.altKey) parts.push("alt");
	if (chord.metaKey) {
		parts.push(operatingSystem === OperatingSystem.Macintosh
			? "cmd"
			: operatingSystem === OperatingSystem.Windows
				? "win"
				: "meta");
	}
	parts.push(chord.kind === KeybindingChordKind.Physical
		? `[${chord.key}]`
		: chord.key);
	return parts.join("+");
}

interface ModifierLabels {
	readonly ctrl: string;
	readonly shift: string;
	readonly alt: string;
	readonly meta: string;
	readonly separator: string;
}

function uiModifierLabels(
	operatingSystem: OperatingSystem,
): ModifierLabels {
	if (operatingSystem === OperatingSystem.Macintosh) {
		return {
			ctrl: "⌃",
			shift: "⇧",
			alt: "⌥",
			meta: "⌘",
			separator: "",
		};
	}
	return {
		ctrl: "Ctrl",
		shift: "Shift",
		alt: "Alt",
		meta: operatingSystem === OperatingSystem.Windows ? "Windows" : "Super",
		separator: "+",
	};
}

function ariaModifierLabels(
	operatingSystem: OperatingSystem,
): ModifierLabels {
	return {
		ctrl: "Control",
		shift: "Shift",
		alt: operatingSystem === OperatingSystem.Macintosh ? "Option" : "Alt",
		meta: operatingSystem === OperatingSystem.Macintosh
			? "Command"
			: operatingSystem === OperatingSystem.Windows
				? "Windows"
				: "Super",
		separator: "+",
	};
}

function displayKey(chord: ResolvedKeybindingChord): string {
	if (chord.label) {
		return chord.label.length === 1
			? chord.label.toLocaleUpperCase("en-US")
			: chord.label;
	}
	if (chord.kind === KeybindingChordKind.Physical) {
		if (/^Key[A-Z]$/.test(chord.key)) return chord.key.slice(3);
		if (/^Digit[0-9]$/.test(chord.key)) return chord.key.slice(5);
	}
	const knownKeys: Readonly<Record<string, string>> = {
		arrowdown: "Down",
		arrowleft: "Left",
		arrowright: "Right",
		arrowup: "Up",
		escape: "Escape",
		enter: "Enter",
		backspace: "Backspace",
		delete: "Delete",
		pageup: "Page Up",
		pagedown: "Page Down",
		" ": "Space",
	};
	return knownKeys[chord.key.toLocaleLowerCase("en-US")] ??
		(chord.key.length === 1 ? chord.key.toLocaleUpperCase("en-US") : chord.key);
}
