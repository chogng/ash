/**
 * Layout-independent key identities used by keyboard events and keybinding mappers.
 * `KeyCode` describes the logical key while `ScanCode` describes its physical position.
 */
export enum KeyCode {
	DependsOnKeyboardLayout = -1,
	Unknown = 0,
	Backspace,
	Tab,
	Enter,
	Shift,
	Ctrl,
	Alt,
	PauseBreak,
	CapsLock,
	Escape,
	Space,
	PageUp,
	PageDown,
	End,
	Home,
	LeftArrow,
	UpArrow,
	RightArrow,
	DownArrow,
	Insert,
	Delete,
	Digit0,
	Digit1,
	Digit2,
	Digit3,
	Digit4,
	Digit5,
	Digit6,
	Digit7,
	Digit8,
	Digit9,
	KeyA,
	KeyB,
	KeyC,
	KeyD,
	KeyE,
	KeyF,
	KeyG,
	KeyH,
	KeyI,
	KeyJ,
	KeyK,
	KeyL,
	KeyM,
	KeyN,
	KeyO,
	KeyP,
	KeyQ,
	KeyR,
	KeyS,
	KeyT,
	KeyU,
	KeyV,
	KeyW,
	KeyX,
	KeyY,
	KeyZ,
	Meta,
	ContextMenu,
	F1,
	F2,
	F3,
	F4,
	F5,
	F6,
	F7,
	F8,
	F9,
	F10,
	F11,
	F12,
	F13,
	F14,
	F15,
	F16,
	F17,
	F18,
	F19,
	F20,
	F21,
	F22,
	F23,
	F24,
	NumLock,
	ScrollLock,
	Semicolon,
	Equal,
	Comma,
	Minus,
	Period,
	Slash,
	Backquote,
	BracketLeft,
	Backslash,
	BracketRight,
	Quote,
	Oem8,
	IntlBackslash,
	Numpad0,
	Numpad1,
	Numpad2,
	Numpad3,
	Numpad4,
	Numpad5,
	Numpad6,
	Numpad7,
	Numpad8,
	Numpad9,
	NumpadMultiply,
	NumpadAdd,
	NumpadSeparator,
	NumpadSubtract,
	NumpadDecimal,
	NumpadDivide,
	KeyInComposition,
	AbntC1,
	AbntC2,
	AudioVolumeMute,
	AudioVolumeUp,
	AudioVolumeDown,
	BrowserSearch,
	BrowserHome,
	BrowserBack,
	BrowserForward,
	MediaTrackNext,
	MediaTrackPrevious,
	MediaStop,
	MediaPlayPause,
	LaunchMediaPlayer,
	LaunchMail,
	LaunchApp2,
	Clear,
	MaxValue,
}

/** Values from the W3C `KeyboardEvent.code` vocabulary. */
export enum ScanCode {
	DependsOnKeyboardLayout = -1,
	None = 0,
	Hyper,
	Super,
	Fn,
	FnLock,
	Suspend,
	Resume,
	Turbo,
	Sleep,
	WakeUp,
	KeyA,
	KeyB,
	KeyC,
	KeyD,
	KeyE,
	KeyF,
	KeyG,
	KeyH,
	KeyI,
	KeyJ,
	KeyK,
	KeyL,
	KeyM,
	KeyN,
	KeyO,
	KeyP,
	KeyQ,
	KeyR,
	KeyS,
	KeyT,
	KeyU,
	KeyV,
	KeyW,
	KeyX,
	KeyY,
	KeyZ,
	Digit1,
	Digit2,
	Digit3,
	Digit4,
	Digit5,
	Digit6,
	Digit7,
	Digit8,
	Digit9,
	Digit0,
	Enter,
	Escape,
	Backspace,
	Tab,
	Space,
	Minus,
	Equal,
	BracketLeft,
	BracketRight,
	Backslash,
	IntlHash,
	Semicolon,
	Quote,
	Backquote,
	Comma,
	Period,
	Slash,
	CapsLock,
	F1,
	F2,
	F3,
	F4,
	F5,
	F6,
	F7,
	F8,
	F9,
	F10,
	F11,
	F12,
	PrintScreen,
	ScrollLock,
	Pause,
	Insert,
	Home,
	PageUp,
	Delete,
	End,
	PageDown,
	ArrowRight,
	ArrowLeft,
	ArrowDown,
	ArrowUp,
	NumLock,
	NumpadDivide,
	NumpadMultiply,
	NumpadSubtract,
	NumpadAdd,
	NumpadEnter,
	Numpad1,
	Numpad2,
	Numpad3,
	Numpad4,
	Numpad5,
	Numpad6,
	Numpad7,
	Numpad8,
	Numpad9,
	Numpad0,
	NumpadDecimal,
	IntlBackslash,
	ContextMenu,
	Power,
	NumpadEqual,
	F13,
	F14,
	F15,
	F16,
	F17,
	F18,
	F19,
	F20,
	F21,
	F22,
	F23,
	F24,
	Open,
	Help,
	Select,
	Again,
	Undo,
	Cut,
	Copy,
	Paste,
	Find,
	AudioVolumeMute,
	AudioVolumeUp,
	AudioVolumeDown,
	NumpadComma,
	IntlRo,
	KanaMode,
	IntlYen,
	Convert,
	NonConvert,
	Lang1,
	Lang2,
	Lang3,
	Lang4,
	Lang5,
	Abort,
	Props,
	NumpadParenLeft,
	NumpadParenRight,
	NumpadBackspace,
	NumpadMemoryStore,
	NumpadMemoryRecall,
	NumpadMemoryClear,
	NumpadMemoryAdd,
	NumpadMemorySubtract,
	NumpadClear,
	NumpadClearEntry,
	ControlLeft,
	ShiftLeft,
	AltLeft,
	MetaLeft,
	ControlRight,
	ShiftRight,
	AltRight,
	MetaRight,
	BrightnessUp,
	BrightnessDown,
	MediaPlay,
	MediaRecord,
	MediaFastForward,
	MediaRewind,
	MediaTrackNext,
	MediaTrackPrevious,
	MediaStop,
	Eject,
	MediaPlayPause,
	MediaSelect,
	LaunchMail,
	LaunchApp2,
	LaunchApp1,
	SelectTask,
	LaunchScreenSaver,
	BrowserSearch,
	BrowserHome,
	BrowserBack,
	BrowserForward,
	BrowserStop,
	BrowserRefresh,
	BrowserFavorites,
	ZoomToggle,
	MailReply,
	MailForward,
	MailSend,
	MaxValue,
}

const keyCodeAliases = new Map<string, KeyCode>();

function defineKeyCode(keyCode: KeyCode, ...aliases: readonly string[]): void {
	for (const alias of aliases) {
		keyCodeAliases.set(alias.toLocaleLowerCase('en-US'), keyCode);
	}
}

for (let digit = 0; digit <= 9; digit += 1) {
	defineKeyCode(KeyCode.Digit0 + digit, String(digit), `Digit${digit}`);
}
for (let index = 0; index < 26; index += 1) {
	const letter = String.fromCharCode(65 + index);
	defineKeyCode(KeyCode.KeyA + index, letter, `Key${letter}`);
}
for (let index = 1; index <= 24; index += 1) {
	defineKeyCode(KeyCode.F1 + index - 1, `F${index}`);
}

const namedKeyCodes: readonly [KeyCode, readonly string[]][] = [
	[KeyCode.Backspace, ['Backspace']],
	[KeyCode.Tab, ['Tab']],
	[KeyCode.Enter, ['Enter', 'Return']],
	[KeyCode.Shift, ['Shift']],
	[KeyCode.Ctrl, ['Ctrl', 'Control']],
	[KeyCode.Alt, ['Alt', 'Option']],
	[KeyCode.PauseBreak, ['Pause', 'PauseBreak']],
	[KeyCode.CapsLock, ['CapsLock']],
	[KeyCode.Escape, ['Escape', 'Esc']],
	[KeyCode.Space, ['Space', ' ']],
	[KeyCode.PageUp, ['PageUp']],
	[KeyCode.PageDown, ['PageDown']],
	[KeyCode.End, ['End']],
	[KeyCode.Home, ['Home']],
	[KeyCode.LeftArrow, ['ArrowLeft', 'Left']],
	[KeyCode.UpArrow, ['ArrowUp', 'Up']],
	[KeyCode.RightArrow, ['ArrowRight', 'Right']],
	[KeyCode.DownArrow, ['ArrowDown', 'Down']],
	[KeyCode.Insert, ['Insert']],
	[KeyCode.Delete, ['Delete', 'Del']],
	[KeyCode.Meta, ['Meta', 'Command', 'Windows', 'Super']],
	[KeyCode.ContextMenu, ['ContextMenu']],
	[KeyCode.NumLock, ['NumLock']],
	[KeyCode.ScrollLock, ['ScrollLock']],
	[KeyCode.Semicolon, [';', 'Semicolon']],
	[KeyCode.Equal, ['=', 'Equal']],
	[KeyCode.Comma, [',', 'Comma']],
	[KeyCode.Minus, ['-', 'Minus']],
	[KeyCode.Period, ['.', 'Period']],
	[KeyCode.Slash, ['/', 'Slash']],
	[KeyCode.Backquote, ['`', 'Backquote']],
	[KeyCode.BracketLeft, ['[', 'BracketLeft']],
	[KeyCode.Backslash, ['\\', 'Backslash']],
	[KeyCode.BracketRight, [']', 'BracketRight']],
	[KeyCode.Quote, ["'", 'Quote']],
	[KeyCode.Oem8, ['OEM_8', 'Oem8']],
	[KeyCode.IntlBackslash, ['IntlBackslash']],
	[KeyCode.Numpad0, ['NumPad0', 'Numpad0']],
	[KeyCode.Numpad1, ['NumPad1', 'Numpad1']],
	[KeyCode.Numpad2, ['NumPad2', 'Numpad2']],
	[KeyCode.Numpad3, ['NumPad3', 'Numpad3']],
	[KeyCode.Numpad4, ['NumPad4', 'Numpad4']],
	[KeyCode.Numpad5, ['NumPad5', 'Numpad5']],
	[KeyCode.Numpad6, ['NumPad6', 'Numpad6']],
	[KeyCode.Numpad7, ['NumPad7', 'Numpad7']],
	[KeyCode.Numpad8, ['NumPad8', 'Numpad8']],
	[KeyCode.Numpad9, ['NumPad9', 'Numpad9']],
	[KeyCode.NumpadMultiply, ['NumPad_Multiply', 'NumpadMultiply']],
	[KeyCode.NumpadAdd, ['NumPad_Add', 'NumpadAdd']],
	[KeyCode.NumpadSeparator, ['NumPad_Separator', 'NumpadSeparator']],
	[KeyCode.NumpadSubtract, ['NumPad_Subtract', 'NumpadSubtract']],
	[KeyCode.NumpadDecimal, ['NumPad_Decimal', 'NumpadDecimal']],
	[KeyCode.NumpadDivide, ['NumPad_Divide', 'NumpadDivide']],
	[KeyCode.AbntC1, ['ABNT_C1', 'AbntC1']],
	[KeyCode.AbntC2, ['ABNT_C2', 'AbntC2']],
	[KeyCode.AudioVolumeMute, ['AudioVolumeMute']],
	[KeyCode.AudioVolumeUp, ['AudioVolumeUp']],
	[KeyCode.AudioVolumeDown, ['AudioVolumeDown']],
	[KeyCode.BrowserSearch, ['BrowserSearch']],
	[KeyCode.BrowserHome, ['BrowserHome']],
	[KeyCode.BrowserBack, ['BrowserBack']],
	[KeyCode.BrowserForward, ['BrowserForward']],
	[KeyCode.MediaTrackNext, ['MediaTrackNext']],
	[KeyCode.MediaTrackPrevious, ['MediaTrackPrevious']],
	[KeyCode.MediaStop, ['MediaStop']],
	[KeyCode.MediaPlayPause, ['MediaPlayPause']],
	[KeyCode.LaunchMediaPlayer, ['LaunchMediaPlayer', 'MediaSelect']],
	[KeyCode.LaunchMail, ['LaunchMail']],
	[KeyCode.LaunchApp2, ['LaunchApp2']],
	[KeyCode.Clear, ['Clear']],
];
for (const [keyCode, aliases] of namedKeyCodes) {
	defineKeyCode(keyCode, ...aliases);
}

const scanCodeStrings: string[] = [];
const scanCodeAliases = new Map<string, ScanCode>();
for (let scanCode = ScanCode.None; scanCode < ScanCode.MaxValue; scanCode += 1) {
	const name = ScanCode[scanCode];
	if (!name) {
		continue;
	}
	scanCodeStrings[scanCode] = name;
	scanCodeAliases.set(name.toLocaleLowerCase('en-US'), scanCode);
}

/** Legacy DOM keyCode to logical key identity, retained for Electron/browser edge cases. */
export const EVENT_KEY_CODE_MAP: KeyCode[] = new Array<KeyCode>(230).fill(KeyCode.Unknown);
/** Native Windows virtual-key name to logical key identity. */
export const NATIVE_WINDOWS_KEY_CODE_TO_KEY_CODE: Readonly<Record<string, KeyCode>> = Object.create(null) as Record<string, KeyCode>;
/** W3C code name to its legacy DOM keyCode when one exists. */
export const SCAN_CODE_STR_TO_EVENT_KEY_CODE: Readonly<Record<string, number>> = Object.create(null) as Record<string, number>;
/** Layout-independent physical-to-logical mappings; other entries remain layout-dependent. */
export const IMMUTABLE_CODE_TO_KEY_CODE: KeyCode[] = new Array<KeyCode>(ScanCode.MaxValue + 1).fill(KeyCode.DependsOnKeyboardLayout);
/** Layout-independent logical-to-physical mappings; other entries remain layout-dependent. */
export const IMMUTABLE_KEY_CODE_TO_CODE: ScanCode[] = new Array<ScanCode>(KeyCode.MaxValue + 1).fill(ScanCode.DependsOnKeyboardLayout);

function registerKeyIdentity(
	scanCode: ScanCode,
	keyCode: KeyCode,
	eventKeyCode: number,
	vkey: string,
	immutable: boolean,
): void {
	const scanCodeName = scanCodeStrings[scanCode];
	if (eventKeyCode > 0) {
		EVENT_KEY_CODE_MAP[eventKeyCode] = keyCode;
	}
	if (scanCodeName && eventKeyCode > 0) {
		(SCAN_CODE_STR_TO_EVENT_KEY_CODE as Record<string, number>)[scanCodeName] = eventKeyCode;
	}
	if (vkey) {
		(NATIVE_WINDOWS_KEY_CODE_TO_KEY_CODE as Record<string, KeyCode>)[vkey] = keyCode;
	}
	if (!immutable) {
		return;
	}
	IMMUTABLE_CODE_TO_KEY_CODE[scanCode] = keyCode;
	if (keyCode !== KeyCode.Unknown && keyCode !== KeyCode.Enter && !isModifierKey(keyCode)) {
		IMMUTABLE_KEY_CODE_TO_CODE[keyCode] = scanCode;
	}
}

for (let index = 0; index < 26; index += 1) {
	registerKeyIdentity(ScanCode.KeyA + index, KeyCode.KeyA + index, 65 + index, `VK_${String.fromCharCode(65 + index)}`, false);
}
for (let digit = 0; digit <= 9; digit += 1) {
	const scanCode = digit === 0 ? ScanCode.Digit0 : ScanCode.Digit1 + digit - 1;
	registerKeyIdentity(scanCode, KeyCode.Digit0 + digit, 48 + digit, `VK_${digit}`, false);
}

const immutableKeyIdentities: readonly [ScanCode, KeyCode, number, string][] = [
	[ScanCode.Enter, KeyCode.Enter, 13, 'VK_RETURN'],
	[ScanCode.Escape, KeyCode.Escape, 27, 'VK_ESCAPE'],
	[ScanCode.Backspace, KeyCode.Backspace, 8, 'VK_BACK'],
	[ScanCode.Tab, KeyCode.Tab, 9, 'VK_TAB'],
	[ScanCode.Space, KeyCode.Space, 32, 'VK_SPACE'],
	[ScanCode.CapsLock, KeyCode.CapsLock, 20, 'VK_CAPITAL'],
	[ScanCode.ScrollLock, KeyCode.ScrollLock, 145, 'VK_SCROLL'],
	[ScanCode.Pause, KeyCode.PauseBreak, 19, 'VK_PAUSE'],
	[ScanCode.Insert, KeyCode.Insert, 45, 'VK_INSERT'],
	[ScanCode.Home, KeyCode.Home, 36, 'VK_HOME'],
	[ScanCode.PageUp, KeyCode.PageUp, 33, 'VK_PRIOR'],
	[ScanCode.Delete, KeyCode.Delete, 46, 'VK_DELETE'],
	[ScanCode.End, KeyCode.End, 35, 'VK_END'],
	[ScanCode.PageDown, KeyCode.PageDown, 34, 'VK_NEXT'],
	[ScanCode.ArrowRight, KeyCode.RightArrow, 39, 'VK_RIGHT'],
	[ScanCode.ArrowLeft, KeyCode.LeftArrow, 37, 'VK_LEFT'],
	[ScanCode.ArrowDown, KeyCode.DownArrow, 40, 'VK_DOWN'],
	[ScanCode.ArrowUp, KeyCode.UpArrow, 38, 'VK_UP'],
	[ScanCode.NumLock, KeyCode.NumLock, 144, 'VK_NUMLOCK'],
	[ScanCode.NumpadDivide, KeyCode.NumpadDivide, 111, 'VK_DIVIDE'],
	[ScanCode.NumpadMultiply, KeyCode.NumpadMultiply, 106, 'VK_MULTIPLY'],
	[ScanCode.NumpadSubtract, KeyCode.NumpadSubtract, 109, 'VK_SUBTRACT'],
	[ScanCode.NumpadAdd, KeyCode.NumpadAdd, 107, 'VK_ADD'],
	[ScanCode.NumpadEnter, KeyCode.Enter, 13, 'VK_RETURN'],
	[ScanCode.Numpad0, KeyCode.Numpad0, 96, 'VK_NUMPAD0'],
	[ScanCode.Numpad1, KeyCode.Numpad1, 97, 'VK_NUMPAD1'],
	[ScanCode.Numpad2, KeyCode.Numpad2, 98, 'VK_NUMPAD2'],
	[ScanCode.Numpad3, KeyCode.Numpad3, 99, 'VK_NUMPAD3'],
	[ScanCode.Numpad4, KeyCode.Numpad4, 100, 'VK_NUMPAD4'],
	[ScanCode.Numpad5, KeyCode.Numpad5, 101, 'VK_NUMPAD5'],
	[ScanCode.Numpad6, KeyCode.Numpad6, 102, 'VK_NUMPAD6'],
	[ScanCode.Numpad7, KeyCode.Numpad7, 103, 'VK_NUMPAD7'],
	[ScanCode.Numpad8, KeyCode.Numpad8, 104, 'VK_NUMPAD8'],
	[ScanCode.Numpad9, KeyCode.Numpad9, 105, 'VK_NUMPAD9'],
	[ScanCode.NumpadDecimal, KeyCode.NumpadDecimal, 110, 'VK_DECIMAL'],
	[ScanCode.NumpadComma, KeyCode.NumpadSeparator, 108, 'VK_SEPARATOR'],
	[ScanCode.ContextMenu, KeyCode.ContextMenu, 93, 'VK_APPS'],
	[ScanCode.ControlLeft, KeyCode.Ctrl, 17, 'VK_CONTROL'],
	[ScanCode.ControlRight, KeyCode.Ctrl, 17, 'VK_CONTROL'],
	[ScanCode.ShiftLeft, KeyCode.Shift, 16, 'VK_SHIFT'],
	[ScanCode.ShiftRight, KeyCode.Shift, 16, 'VK_SHIFT'],
	[ScanCode.AltLeft, KeyCode.Alt, 18, 'VK_MENU'],
	[ScanCode.AltRight, KeyCode.Alt, 18, 'VK_MENU'],
	[ScanCode.MetaLeft, KeyCode.Meta, 91, 'VK_LWIN'],
	[ScanCode.MetaRight, KeyCode.Meta, 92, 'VK_RWIN'],
	[ScanCode.AudioVolumeMute, KeyCode.AudioVolumeMute, 173, 'VK_VOLUME_MUTE'],
	[ScanCode.AudioVolumeDown, KeyCode.AudioVolumeDown, 174, 'VK_VOLUME_DOWN'],
	[ScanCode.AudioVolumeUp, KeyCode.AudioVolumeUp, 175, 'VK_VOLUME_UP'],
	[ScanCode.MediaTrackNext, KeyCode.MediaTrackNext, 176, 'VK_MEDIA_NEXT_TRACK'],
	[ScanCode.MediaTrackPrevious, KeyCode.MediaTrackPrevious, 177, 'VK_MEDIA_PREV_TRACK'],
	[ScanCode.MediaStop, KeyCode.MediaStop, 178, 'VK_MEDIA_STOP'],
	[ScanCode.MediaPlayPause, KeyCode.MediaPlayPause, 179, 'VK_MEDIA_PLAY_PAUSE'],
	[ScanCode.MediaSelect, KeyCode.LaunchMediaPlayer, 181, 'VK_LAUNCH_MEDIA_SELECT'],
	[ScanCode.LaunchMail, KeyCode.LaunchMail, 180, 'VK_LAUNCH_MAIL'],
	[ScanCode.LaunchApp2, KeyCode.LaunchApp2, 183, 'VK_LAUNCH_APP2'],
	[ScanCode.BrowserSearch, KeyCode.BrowserSearch, 170, 'VK_BROWSER_SEARCH'],
	[ScanCode.BrowserHome, KeyCode.BrowserHome, 172, 'VK_BROWSER_HOME'],
	[ScanCode.BrowserBack, KeyCode.BrowserBack, 166, 'VK_BROWSER_BACK'],
	[ScanCode.BrowserForward, KeyCode.BrowserForward, 167, 'VK_BROWSER_FORWARD'],
];
for (const identity of immutableKeyIdentities) {
	registerKeyIdentity(...identity, true);
}
for (let index = 1; index <= 24; index += 1) {
	registerKeyIdentity(ScanCode.F1 + index - 1, KeyCode.F1 + index - 1, 111 + index, `VK_F${index}`, true);
}

const layoutDependentKeyIdentities: readonly [ScanCode, KeyCode, number, string][] = [
	[ScanCode.Semicolon, KeyCode.Semicolon, 186, 'VK_OEM_1'],
	[ScanCode.Equal, KeyCode.Equal, 187, 'VK_OEM_PLUS'],
	[ScanCode.Comma, KeyCode.Comma, 188, 'VK_OEM_COMMA'],
	[ScanCode.Minus, KeyCode.Minus, 189, 'VK_OEM_MINUS'],
	[ScanCode.Period, KeyCode.Period, 190, 'VK_OEM_PERIOD'],
	[ScanCode.Slash, KeyCode.Slash, 191, 'VK_OEM_2'],
	[ScanCode.Backquote, KeyCode.Backquote, 192, 'VK_OEM_3'],
	[ScanCode.BracketLeft, KeyCode.BracketLeft, 219, 'VK_OEM_4'],
	[ScanCode.Backslash, KeyCode.Backslash, 220, 'VK_OEM_5'],
	[ScanCode.BracketRight, KeyCode.BracketRight, 221, 'VK_OEM_6'],
	[ScanCode.Quote, KeyCode.Quote, 222, 'VK_OEM_7'],
	[ScanCode.IntlBackslash, KeyCode.IntlBackslash, 226, 'VK_OEM_102'],
	[ScanCode.IntlRo, KeyCode.AbntC1, 193, 'VK_ABNT_C1'],
];
for (const identity of layoutDependentKeyIdentities) {
	registerKeyIdentity(...identity, false);
}
IMMUTABLE_KEY_CODE_TO_CODE[KeyCode.Enter] = ScanCode.Enter;
EVENT_KEY_CODE_MAP[194] = KeyCode.AbntC2;
EVENT_KEY_CODE_MAP[223] = KeyCode.Oem8;
(NATIVE_WINDOWS_KEY_CODE_TO_KEY_CODE as Record<string, KeyCode>).VK_ABNT_C2 = KeyCode.AbntC2;
(NATIVE_WINDOWS_KEY_CODE_TO_KEY_CODE as Record<string, KeyCode>).VK_OEM_8 = KeyCode.Oem8;
Object.freeze(NATIVE_WINDOWS_KEY_CODE_TO_KEY_CODE);
Object.freeze(SCAN_CODE_STR_TO_EVENT_KEY_CODE);

export const ScanCodeUtils = {
	lowerCaseToEnum(code: string): ScanCode {
		return scanCodeAliases.get(code.toLocaleLowerCase('en-US')) ?? ScanCode.None;
	},
	toEnum(code: string): ScanCode {
		return scanCodeAliases.get(code.toLocaleLowerCase('en-US')) ?? ScanCode.None;
	},
	toString(scanCode: ScanCode): string {
		return scanCodeStrings[scanCode] ?? 'None';
	},
};

export const KeyCodeUtils = {
	fromString(key: string): KeyCode {
		return keyCodeAliases.get(key.toLocaleLowerCase('en-US')) ?? KeyCode.Unknown;
	},
	toString(keyCode: KeyCode): string {
		if (keyCode >= KeyCode.Digit0 && keyCode <= KeyCode.Digit9) {
			return String(keyCode - KeyCode.Digit0);
		}
		if (keyCode >= KeyCode.KeyA && keyCode <= KeyCode.KeyZ) {
			return String.fromCharCode(65 + keyCode - KeyCode.KeyA);
		}
		return namedKeyCodes.find(([candidate]) => candidate === keyCode)?.[1][0] ?? KeyCode[keyCode] ?? 'Unknown';
	},
	toUserSettings(keyCode: KeyCode): string {
		return this.toString(keyCode).toLocaleLowerCase('en-US');
	},
	toUserSettingsUS(keyCode: KeyCode): string {
		return userSettingsAlias(keyCode, true);
	},
	toUserSettingsGeneral(keyCode: KeyCode): string {
		return userSettingsAlias(keyCode, false);
	},
	fromUserSettings(key: string): KeyCode {
		return this.fromString(key);
	},
	toElectronAccelerator(keyCode: KeyCode): string | undefined {
		if (keyCode >= KeyCode.Numpad0 && keyCode <= KeyCode.NumpadDivide) {
			return undefined;
		}
		switch (keyCode) {
			case KeyCode.UpArrow: return 'Up';
			case KeyCode.DownArrow: return 'Down';
			case KeyCode.LeftArrow: return 'Left';
			case KeyCode.RightArrow: return 'Right';
			default: return this.toString(keyCode);
		}
	},
};

export function keyCodeFromKeyboardEvent(
	key: string,
	legacyKeyCode = 0,
	code = '',
	location = 0,
): KeyCode {
	if (legacyKeyCode === 229) {
		return KeyCode.KeyInComposition;
	}
	if (location === 3) {
		const numpadKeyCode = IMMUTABLE_CODE_TO_KEY_CODE[ScanCodeUtils.toEnum(code)];
		if (numpadKeyCode !== undefined && numpadKeyCode !== KeyCode.DependsOnKeyboardLayout) {
			return numpadKeyCode;
		}
	}
	const keyCode = KeyCodeUtils.fromString(key);
	return keyCode !== KeyCode.Unknown ? keyCode : EVENT_KEY_CODE_MAP[legacyKeyCode] ?? KeyCode.Unknown;
}

export const enum KeyMod {
	CtrlCmd = (1 << 11) >>> 0,
	Shift = (1 << 10) >>> 0,
	Alt = (1 << 9) >>> 0,
	WinCtrl = (1 << 8) >>> 0,
}

export function KeyChord(firstPart: number, secondPart: number): number {
	const chordPart = ((secondPart & 0x0000FFFF) << 16) >>> 0;
	return (firstPart | chordPart) >>> 0;
}

export function isModifierKey(keyCode: KeyCode): boolean {
	return keyCode === KeyCode.Ctrl || keyCode === KeyCode.Shift || keyCode === KeyCode.Alt || keyCode === KeyCode.Meta;
}

function userSettingsAlias(keyCode: KeyCode, usStandard: boolean): string {
	switch (keyCode) {
		case KeyCode.LeftArrow: return 'left';
		case KeyCode.UpArrow: return 'up';
		case KeyCode.RightArrow: return 'right';
		case KeyCode.DownArrow: return 'down';
		case KeyCode.Delete: return 'delete';
		case KeyCode.Semicolon: return usStandard ? ';' : 'oem_1';
		case KeyCode.Equal: return usStandard ? '=' : 'oem_plus';
		case KeyCode.Comma: return usStandard ? ',' : 'oem_comma';
		case KeyCode.Minus: return usStandard ? '-' : 'oem_minus';
		case KeyCode.Period: return usStandard ? '.' : 'oem_period';
		case KeyCode.Slash: return usStandard ? '/' : 'oem_2';
		case KeyCode.Backquote: return usStandard ? '`' : 'oem_3';
		case KeyCode.BracketLeft: return usStandard ? '[' : 'oem_4';
		case KeyCode.Backslash: return usStandard ? '\\' : 'oem_5';
		case KeyCode.BracketRight: return usStandard ? ']' : 'oem_6';
		case KeyCode.Quote: return usStandard ? "'" : 'oem_7';
		default: return KeyCodeUtils.toUserSettings(keyCode);
	}
}
