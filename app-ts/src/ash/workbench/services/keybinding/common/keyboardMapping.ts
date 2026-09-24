import { CharCode } from '../../../../base/common/charCode.js';
import {
	IMMUTABLE_CODE_TO_KEY_CODE,
	KeyCode,
	KeyCodeUtils,
	NATIVE_WINDOWS_KEY_CODE_TO_KEY_CODE,
	ScanCodeUtils,
} from '../../../../base/common/keyCodes.js';
import type { KeybindingEvent, ResolvedKeybindingChord } from '../../../../base/common/keybindings.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import type { IKeyboardMapping, IKeyboardMappingEntry } from '../../../../platform/keyboardLayout/common/keyboardLayout.js';

const emptyMappingEntry: IKeyboardMappingEntry = Object.freeze({
	value: '',
	withShift: '',
	withAltGr: '',
	withShiftAltGr: '',
});

const shiftedDigits = ')!@#$%^&*(';
const punctuation: Readonly<Record<string, readonly [string, string]>> = {
	Minus: ['-', '_'],
	Equal: ['=', '+'],
	BracketLeft: ['[', '{'],
	BracketRight: [']', '}'],
	Backslash: ['\\', '|'],
	Semicolon: [';', ':'],
	Quote: ["'", '"'],
	Backquote: ['`', '~'],
	Comma: [',', '<'],
	Period: ['.', '>'],
	Slash: ['/', '?'],
	IntlBackslash: ['\\', '|'],
};

export function createUSKeyboardMapping(): IKeyboardMapping {
	const mapping: Record<string, IKeyboardMappingEntry> = {};
	for (let index = 0; index < 26; index += 1) {
		const letter = String.fromCharCode(65 + index);
		mapping[`Key${letter}`] = mappingEntry(letter.toLocaleLowerCase('en-US'), letter);
	}
	for (let digit = 0; digit <= 9; digit += 1) {
		mapping[`Digit${digit}`] = mappingEntry(String(digit), shiftedDigits[digit]);
	}
	for (const [code, values] of Object.entries(punctuation)) {
		mapping[code] = mappingEntry(values[0], values[1]);
	}
	return Object.freeze(mapping);
}

export function createKeyboardMappingFromLabels(labels: ReadonlyMap<string, string>): IKeyboardMapping {
	const mapping: Record<string, IKeyboardMappingEntry> = {};
	for (const [code, value] of labels) {
		mapping[code] = mappingEntry(value, inferShiftValue(value));
	}
	return Object.freeze(mapping);
}

export function copyKeyboardMapping(mapping: IKeyboardMapping): Record<string, IKeyboardMappingEntry> {
	const copy: Record<string, IKeyboardMappingEntry> = {};
	for (const [code, entry] of Object.entries(mapping)) {
		copy[code] = { ...entry };
	}
	return copy;
}

export function observeKeyboardMapping(
	mapping: IKeyboardMapping,
	event: KeybindingEvent,
): IKeyboardMapping {
	if (!event.code || event.key.length === 0 || event.key === 'Process') {
		return mapping;
	}
	const next = copyKeyboardMapping(mapping);
	const current = next[event.code] ?? emptyMappingEntry;
	const isDeadKey = event.key === 'Dead';
	const value = isDeadKey ? currentValue(current, event) : event.key;
	if (event.altGraphKey && event.shiftKey) {
		next[event.code] = { ...current, withShiftAltGr: value, withShiftAltGrIsDeadKey: isDeadKey };
	} else if (event.altGraphKey) {
		next[event.code] = { ...current, withAltGr: value, withAltGrIsDeadKey: isDeadKey };
	} else if (event.shiftKey) {
		next[event.code] = { ...current, withShift: value, withShiftIsDeadKey: isDeadKey };
	} else {
		next[event.code] = { ...current, value, valueIsDeadKey: isDeadKey };
	}
	return Object.freeze(next);
}

export function getKeyboardMappingValue(
	entry: IKeyboardMappingEntry | undefined,
	modifiers: Pick<ResolvedKeybindingChord, 'ctrlKey' | 'shiftKey' | 'altKey'> & { readonly altGraphKey?: boolean },
	mapAltGrToCtrlAlt: boolean,
): string {
	if (!entry) {
		return '';
	}
	const isAltGr = Boolean(modifiers.altGraphKey) || (mapAltGrToCtrlAlt && modifiers.ctrlKey && modifiers.altKey);
	if (isAltGr && modifiers.shiftKey) {
		return entry.withShiftAltGr;
	}
	if (isAltGr) {
		return entry.withAltGr;
	}
	return modifiers.shiftKey ? entry.withShift : entry.value;
}

export function isKeyboardMappingDeadKey(
	entry: IKeyboardMappingEntry | undefined,
	modifiers: Pick<ResolvedKeybindingChord, 'ctrlKey' | 'shiftKey' | 'altKey'> & { readonly altGraphKey?: boolean },
	mapAltGrToCtrlAlt: boolean,
): boolean {
	if (!entry) {
		return false;
	}
	const isAltGr = Boolean(modifiers.altGraphKey) || (mapAltGrToCtrlAlt && modifiers.ctrlKey && modifiers.altKey);
	if (isAltGr && modifiers.shiftKey) {
		return Boolean(entry.withShiftAltGrIsDeadKey);
	}
	if (isAltGr) {
		return Boolean(entry.withAltGrIsDeadKey);
	}
	return modifiers.shiftKey ? Boolean(entry.withShiftIsDeadKey) : Boolean(entry.valueIsDeadKey);
}

export function getKeyboardMappingLabel(
	code: string,
	entry: IKeyboardMappingEntry | undefined,
	modifiers: Pick<ResolvedKeybindingChord, 'ctrlKey' | 'shiftKey' | 'altKey'>,
	mapAltGrToCtrlAlt: boolean,
): string | undefined {
	const value = getKeyboardMappingValue(entry, modifiers, mapAltGrToCtrlAlt) || entry?.value;
	if (value) {
		return isCombiningCharacter(value) ? spacingAccent(value) : value;
	}
	if (/^Key[A-Z]$/.test(code)) {
		return code.slice(3);
	}
	if (/^Digit[0-9]$/.test(code)) {
		return code.slice(5);
	}
	const immutableKeyCode = IMMUTABLE_CODE_TO_KEY_CODE[ScanCodeUtils.toEnum(code)];
	if (immutableKeyCode !== undefined && immutableKeyCode !== KeyCode.DependsOnKeyboardLayout) {
		return immutableKeyLabel(immutableKeyCode);
	}
	return undefined;
}

function immutableKeyLabel(keyCode: KeyCode): string {
	switch (keyCode) {
		case KeyCode.LeftArrow: return 'Left';
		case KeyCode.UpArrow: return 'Up';
		case KeyCode.RightArrow: return 'Right';
		case KeyCode.DownArrow: return 'Down';
		default: return KeyCodeUtils.toString(keyCode);
	}
}

export function findKeyboardMappingCodes(
	mapping: IKeyboardMapping,
	key: string,
	_modifiers: Pick<ResolvedKeybindingChord, 'ctrlKey' | 'shiftKey' | 'altKey'>,
	_mapAltGrToCtrlAlt: boolean,
): readonly string[] {
	const normalizedKey = key.toLocaleLowerCase('en-US');
	const targetKeyCode = KeyCodeUtils.fromString(key);
	const matches: string[] = [];
	for (const [code, entry] of Object.entries(mapping)) {
		const nativeKeyCode = entry.vkey ? NATIVE_WINDOWS_KEY_CODE_TO_KEY_CODE[entry.vkey] : undefined;
		if ((nativeKeyCode !== undefined && nativeKeyCode === targetKeyCode) ||
			(entry.value && entry.value.toLocaleLowerCase('en-US') === normalizedKey)) {
			matches.push(code);
		}
	}
	if (matches.length === 0 && /^[a-z]$/u.test(normalizedKey) && !mappingProducesLatinLetters(mapping)) {
		const code = `Key${normalizedKey.toLocaleUpperCase('en-US')}`;
		if (mapping[code]) {
			matches.push(code);
		}
	}
	return matches;
}

export interface IKeyboardMappingCandidate {
	readonly code: string;
	readonly ctrlKey: boolean;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
	readonly label: string;
	readonly isDeadKey: boolean;
}

/** Translates a US logical key chord into every physical chord that produces it. */
export function findKeyboardMappingCandidates(
	mapping: IKeyboardMapping,
	key: string,
	keyCode: KeyCode,
	modifiers: Pick<ResolvedKeybindingChord, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
	operatingSystem: OperatingSystem,
): readonly IKeyboardMappingCandidate[] {
	if (operatingSystem === OperatingSystem.Windows) {
		const nativeMatches = Object.entries(mapping).filter(([, entry]) =>
			entry.vkey !== undefined && NATIVE_WINDOWS_KEY_CODE_TO_KEY_CODE[entry.vkey] === keyCode
		);
		if (nativeMatches.length > 0) {
			return nativeMatches.map(([code, entry]) => ({
				code,
				...modifiers,
				label: keyboardMappingOutputLabel(entry.value) || key,
				isDeadKey: Boolean(entry.valueIsDeadKey),
			}));
		}
	}

	const target = usProducedValue(keyCode, key, modifiers.shiftKey);
	const matches: IKeyboardMappingCandidate[] = [];
	for (const [code, entry] of Object.entries(mapping)) {
		const states = [
			{ value: entry.value, shiftKey: false, altGr: false, dead: Boolean(entry.valueIsDeadKey) },
			{ value: entry.withShift, shiftKey: true, altGr: false, dead: Boolean(entry.withShiftIsDeadKey) },
			{ value: entry.withAltGr, shiftKey: false, altGr: true, dead: Boolean(entry.withAltGrIsDeadKey) },
			{ value: entry.withShiftAltGr, shiftKey: true, altGr: true, dead: Boolean(entry.withShiftAltGrIsDeadKey) },
		] as const;
		for (const state of states) {
			if (!state.value || state.value !== target) {
				continue;
			}
			// On Linux, Ctrl/Alt already used as shortcut modifiers cannot also stand in for AltGr.
			if (state.altGr && operatingSystem === OperatingSystem.Linux && (modifiers.ctrlKey || modifiers.altKey)) {
				continue;
			}
			matches.push({
				code,
				ctrlKey: modifiers.ctrlKey || state.altGr,
				shiftKey: state.shiftKey,
				altKey: modifiers.altKey || state.altGr,
				metaKey: modifiers.metaKey,
				label: keyboardMappingOutputLabel(entry.value) || code,
				isDeadKey: state.dead,
			});
		}
	}
	if (matches.length === 0 && /^[a-z]$/iu.test(key) && !mappingProducesLatinLetters(mapping)) {
		const code = `Key${key.toLocaleUpperCase('en-US')}`;
		const entry = mapping[code];
		if (entry) {
			matches.push({
				code,
				...modifiers,
				label: key,
				isDeadKey: false,
			});
		}
	}
	return matches;
}

function mappingProducesLatinLetters(mapping: IKeyboardMapping): boolean {
	return Object.values(mapping).some((entry) => /^[a-z]$/iu.test(entry.value));
}

function usProducedValue(keyCode: KeyCode, key: string, shiftKey: boolean): string {
	if (keyCode >= KeyCode.KeyA && keyCode <= KeyCode.KeyZ) {
		const value = String.fromCharCode('a'.charCodeAt(0) + keyCode - KeyCode.KeyA);
		return shiftKey ? value.toLocaleUpperCase('en-US') : value;
	}
	if (keyCode >= KeyCode.Digit0 && keyCode <= KeyCode.Digit9) {
		const digit = keyCode - KeyCode.Digit0;
		return shiftKey ? shiftedDigits[digit] : String(digit);
	}
	const punctuationByKeyCode: Partial<Record<KeyCode, readonly [string, string]>> = {
		[KeyCode.Semicolon]: [';', ':'],
		[KeyCode.Equal]: ['=', '+'],
		[KeyCode.Comma]: [',', '<'],
		[KeyCode.Minus]: ['-', '_'],
		[KeyCode.Period]: ['.', '>'],
		[KeyCode.Slash]: ['/', '?'],
		[KeyCode.Backquote]: ['`', '~'],
		[KeyCode.BracketLeft]: ['[', '{'],
		[KeyCode.Backslash]: ['\\', '|'],
		[KeyCode.BracketRight]: [']', '}'],
		[KeyCode.Quote]: ["'", '"'],
		[KeyCode.IntlBackslash]: ['\\', '|'],
	};
	const punctuationValue = punctuationByKeyCode[keyCode];
	if (punctuationValue) {
		return punctuationValue[shiftKey ? 1 : 0];
	}
	if (keyCode === KeyCode.Space) {
		return ' ';
	}
	return shiftKey && key.length === 1 ? key.toLocaleUpperCase('en-US') : key;
}

export function keyboardMappingOutputLabel(value: string): string {
	return isCombiningCharacter(value) ? spacingAccent(value) : value;
}

function mappingEntry(value: string, withShift: string): IKeyboardMappingEntry {
	return Object.freeze({ value, withShift, withAltGr: '', withShiftAltGr: '' });
}

function inferShiftValue(value: string): string {
	if (value.length === 1 && value.toLocaleLowerCase('en-US') !== value.toLocaleUpperCase('en-US')) {
		return value.toLocaleUpperCase('en-US');
	}
	return '';
}

function currentValue(entry: IKeyboardMappingEntry, event: KeybindingEvent): string {
	if (event.altGraphKey && event.shiftKey) {
		return entry.withShiftAltGr;
	}
	if (event.altGraphKey) {
		return entry.withAltGr;
	}
	return event.shiftKey ? entry.withShift : entry.value;
}

function isCombiningCharacter(value: string): boolean {
	const code = value.charCodeAt(0);
	return value.length === 1 && code >= CharCode.U_Combining_Grave_Accent && code <= CharCode.U_Combining_Latin_Small_Letter_X;
}

function spacingAccent(value: string): string {
	switch (value.charCodeAt(0)) {
		case CharCode.U_Combining_Grave_Accent: return '`';
		case CharCode.U_Combining_Acute_Accent: return '´';
		case CharCode.U_Combining_Circumflex_Accent: return '^';
		case CharCode.U_Combining_Tilde: return '~';
		case CharCode.U_Combining_Macron: return '¯';
		case CharCode.U_Combining_Breve: return '˘';
		case CharCode.U_Combining_Dot_Above: return '˙';
		case CharCode.U_Combining_Diaeresis: return '¨';
		case CharCode.U_Combining_Ring_Above: return '˚';
		case CharCode.U_Combining_Double_Acute_Accent: return '˝';
		case CharCode.U_Combining_Caron: return 'ˇ';
		case CharCode.U_Combining_Cedilla: return '¸';
		case CharCode.U_Combining_Ogonek: return '˛';
		default: return value;
	}
}
