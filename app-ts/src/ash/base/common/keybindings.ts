import {
	operatingSystem,
	OperatingSystem,
} from "./platform.js";
import { KeyCode, KeyCodeUtils, type ScanCode } from "./keyCodes.js";

/**
 * Modifiers for a keybinding chord.
 *
 * `primaryKey` resolves to Command on macOS and Control elsewhere. Callers
 * choose either that portable modifier or explicit Control/Meta modifiers.
 */
export type KeybindingModifiers =
	| {
		readonly primaryKey?: boolean;
		readonly ctrlKey?: never;
		readonly metaKey?: never;
		readonly shiftKey?: boolean;
		readonly altKey?: boolean;
	}
	| {
		readonly primaryKey?: never;
		readonly ctrlKey?: boolean;
		readonly metaKey?: boolean;
		readonly shiftKey?: boolean;
		readonly altKey?: boolean;
	};

export enum KeybindingChordKind {
	Logical = "logical",
	Physical = "physical",
}

/** A layout-aware key chord matched against `KeyboardEvent.key`. */
export interface LogicalKeybindingChord {
	readonly kind: KeybindingChordKind.Logical;
	readonly key: string;
	readonly modifiers: Readonly<KeybindingModifiers>;
}

/** A layout-independent key chord matched against `KeyboardEvent.code`. */
export interface PhysicalKeybindingChord {
	readonly kind: KeybindingChordKind.Physical;
	readonly code: string;
	readonly modifiers: Readonly<KeybindingModifiers>;
}

export type KeybindingChord =
	| LogicalKeybindingChord
	| PhysicalKeybindingChord;

/** Maximum number of ordered chords accepted by the shared shortcut grammar. */
export const MAX_KEYBINDING_CHORDS = 4;

/** Creates a layout-aware chord without exposing representation details. */
export function logicalKey(
	key: string,
	modifiers: KeybindingModifiers = {},
): LogicalKeybindingChord {
	const normalizedKey = normalizeLogicalKey(key);
	if (!normalizedKey) throw new TypeError("Logical key must not be empty");
	return {
		kind: KeybindingChordKind.Logical,
		key: normalizedKey,
		modifiers: { ...modifiers },
	};
}

/** Creates a physical chord from a browser `KeyboardEvent.code` value. */
export function physicalKey(
	code: string,
	modifiers: KeybindingModifiers = {},
): PhysicalKeybindingChord {
	const normalizedCode = code.trim();
	if (!normalizedCode) throw new TypeError("Physical key code must not be empty");
	return {
		kind: KeybindingChordKind.Physical,
		code: normalizedCode,
		modifiers: { ...modifiers },
	};
}

/** One command shortcut consisting of one or more ordered chords. */
export class Keybinding {
	readonly chords: readonly KeybindingChord[];

	constructor(chords: readonly KeybindingChord[]) {
		if (chords.length === 0) {
			throw new TypeError("A keybinding requires at least one chord");
		}
		if (chords.length > MAX_KEYBINDING_CHORDS) {
			throw new TypeError(
				`A keybinding supports at most ${MAX_KEYBINDING_CHORDS} chords`,
			);
		}
		this.chords = [...chords];
	}

	static single(chord: KeybindingChord): Keybinding {
		return new Keybinding([chord]);
	}

	static chord(
		first: KeybindingChord,
		second: KeybindingChord,
		...remaining: readonly KeybindingChord[]
	): Keybinding {
		return new Keybinding([first, second, ...remaining]);
	}
}

export function decodeKeybinding(keybinding: number | readonly number[], targetOperatingSystem: OperatingSystem): Keybinding | null {
	const encodedChords = typeof keybinding === "number"
		? [keybinding & 0x0000FFFF, (keybinding & 0xFFFF0000) >>> 16]
		: keybinding;
	const chords = encodedChords
		.filter(encoded => encoded !== 0)
		.map(encoded => {
			const ctrlCmd = (encoded & (1 << 11)) !== 0;
			const shiftKey = (encoded & (1 << 10)) !== 0;
			const altKey = (encoded & (1 << 9)) !== 0;
			const winCtrl = (encoded & (1 << 8)) !== 0;
			const keyCode = encoded & 0xFF;
			return logicalKey(KeyCodeUtils.toString(keyCode), {
				ctrlKey: targetOperatingSystem === OperatingSystem.Macintosh ? winCtrl : ctrlCmd,
				shiftKey,
				altKey,
				metaKey: targetOperatingSystem === OperatingSystem.Macintosh ? ctrlCmd : winCtrl,
			});
		});
	return chords.length === 0 ? null : new Keybinding(chords);
}

/** A chord after portable modifiers have been resolved for one host OS. */
export interface ResolvedKeybindingChord {
	readonly kind: KeybindingChordKind;
	readonly key: string;
	/** Layout-aware presentation label without changing dispatch identity. */
	readonly label?: string;
	readonly keyCode?: KeyCode;
	readonly scanCode?: ScanCode;
	readonly isDeadKey?: boolean;
	readonly ctrlKey: boolean;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
}

/** A keybinding ready for matching and presentation on one host OS. */
export class ResolvedKeybinding {
	constructor(
		readonly chords: readonly ResolvedKeybindingChord[],
		readonly operatingSystem: OperatingSystem,
	) {}
}

/** Keyboard data consumed by a resolver without depending on browser types. */
export interface KeybindingEvent {
	readonly key: string;
	readonly code: string;
	readonly keyCode?: KeyCode;
	readonly scanCode?: ScanCode;
	readonly location?: number;
	readonly ctrlKey: boolean;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
	readonly altGraphKey?: boolean;
	readonly isComposing?: boolean;
}

export type PhysicalKeyLabelProvider = (
	code: string,
	modifiers: Readonly<{
		ctrlKey: boolean;
		shiftKey: boolean;
		altKey: boolean;
		metaKey: boolean;
	}>,
) => string | undefined;

export function resolveKeybinding(
	keybinding: Keybinding,
	targetOperatingSystem: OperatingSystem = operatingSystem,
	physicalKeyLabels?: ReadonlyMap<string, string> | PhysicalKeyLabelProvider,
): ResolvedKeybinding {
	return new ResolvedKeybinding(
		keybinding.chords.map((chord) =>
			resolveChord(chord, targetOperatingSystem, physicalKeyLabels)
		),
		targetOperatingSystem,
	);
}

export function matchesResolvedChord(
	chord: ResolvedKeybindingChord,
	event: KeybindingEvent,
): boolean {
	const keyMatches = chord.kind === KeybindingChordKind.Physical
		? chord.key === event.code
		: chord.key === normalizeLogicalKey(event.key);
	return keyMatches &&
		chord.ctrlKey === event.ctrlKey &&
		chord.shiftKey === event.shiftKey &&
		chord.altKey === event.altKey &&
		chord.metaKey === event.metaKey;
}

function resolveChord(
	chord: KeybindingChord,
	targetOperatingSystem: OperatingSystem,
	physicalKeyLabels: ReadonlyMap<string, string> | PhysicalKeyLabelProvider | undefined,
): ResolvedKeybindingChord {
	const modifiers = chord.modifiers;
	const primaryKey = Boolean(modifiers.primaryKey);
	const primaryIsMeta =
		targetOperatingSystem === OperatingSystem.Macintosh;
	const resolvedModifiers = {
		ctrlKey: Boolean(modifiers.ctrlKey) ||
			(primaryKey && !primaryIsMeta),
		shiftKey: Boolean(modifiers.shiftKey),
		altKey: Boolean(modifiers.altKey),
		metaKey: Boolean(modifiers.metaKey) ||
			(primaryKey && primaryIsMeta),
	};
	const label = chord.kind === KeybindingChordKind.Physical
		? typeof physicalKeyLabels === "function"
			? physicalKeyLabels(chord.code, resolvedModifiers)
			: physicalKeyLabels?.get(chord.code)
		: undefined;
	return {
		kind: chord.kind,
		key: chord.kind === KeybindingChordKind.Physical
			? chord.code
			: chord.key,
		label,
		...resolvedModifiers,
	};
}

export function normalizeLogicalKey(key: string): string {
	const trimmed = key.trim();
	if (key === " " || trimmed.toLocaleLowerCase("en-US") === "space") {
		return " ";
	}
	return trimmed.toLocaleLowerCase("en-US");
}
