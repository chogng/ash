import assert from "node:assert/strict";
import { test } from "mocha";
import {
	getKeybindingLabel,
	KeybindingLabelStyle,
} from "../../common/keybindingLabels.js";
import {
	parseKeybinding,
	serializeKeybinding,
} from "../../common/keybindingParser.js";
import {
	decodeKeybinding,
	Keybinding,
	KeybindingChordKind,
	logicalKey,
	matchesResolvedChord,
	physicalKey,
	resolveKeybinding,
} from "../../common/keybindings.js";
import { OperatingSystem } from "../../common/platform.js";
import { loadKeybindingConformanceFixtures } from "./keybindingConformanceFixtures.js";
import {
	EVENT_KEY_CODE_MAP,
	IMMUTABLE_CODE_TO_KEY_CODE,
	IMMUTABLE_KEY_CODE_TO_CODE,
	KeyCode,
	KeyCodeUtils,
	KeyMod,
	NATIVE_WINDOWS_KEY_CODE_TO_KEY_CODE,
	ScanCode,
	ScanCodeUtils,
} from "../../common/keyCodes.js";

interface ParserFixture {
	readonly input: string;
	readonly valid: boolean;
	readonly canonical?: string;
	readonly chords?: number;
}

interface ConformanceFixtures {
	readonly parser: readonly ParserFixture[];
}

test("canonical key codes distinguish logical keys from physical scan codes", () => {
	assert.equal(KeyCodeUtils.fromString("ArrowLeft"), KeyCode.LeftArrow);
	assert.equal(KeyCodeUtils.fromString("KeyZ"), KeyCode.KeyZ);
	assert.equal(KeyCodeUtils.toUserSettings(KeyCode.Slash), "/");
	assert.equal(ScanCodeUtils.toEnum("IntlYen"), ScanCode.IntlYen);
	assert.equal(ScanCodeUtils.lowerCaseToEnum("intlyen"), ScanCode.IntlYen);
	assert.equal(ScanCodeUtils.toString(ScanCode.NumpadEnter), "NumpadEnter");
	assert.equal(EVENT_KEY_CODE_MAP[38], KeyCode.UpArrow);
	assert.equal(NATIVE_WINDOWS_KEY_CODE_TO_KEY_CODE.VK_F12, KeyCode.F12);
	assert.equal(IMMUTABLE_CODE_TO_KEY_CODE[ScanCode.ArrowUp], KeyCode.UpArrow);
	assert.equal(IMMUTABLE_KEY_CODE_TO_CODE[KeyCode.UpArrow], ScanCode.ArrowUp);
	assert.equal(IMMUTABLE_CODE_TO_KEY_CODE[ScanCode.KeyA], KeyCode.DependsOnKeyboardLayout);
});

test("keybinding parser distinguishes logical and physical chords", () => {
	const parsed = parseKeybinding("ctrl+k shift+[KeyP]");

	assert.ok(parsed);
	assert.equal(parsed.chords.length, 2);
	assert.equal(parsed.chords[0].kind, KeybindingChordKind.Logical);
	assert.equal(parsed.chords[1].kind, KeybindingChordKind.Physical);
	assert.equal(
		parsed.chords[1].kind === KeybindingChordKind.Physical
			? parsed.chords[1].code
			: undefined,
		"KeyP",
	);
	assert.equal(parseKeybinding("ctrl+shift"), undefined);
	assert.equal(parseKeybinding("primary+ctrl+k"), undefined);
	assert.equal(parseKeybinding("ctrl+k+v"), undefined);
	assert.equal(parseKeybinding("ctrl+banana"), undefined);
	assert.equal(parseKeybinding("ctrl+[Banana]"), undefined);
});

test("portable primary modifiers resolve and format for each OS", () => {
	const keybinding = Keybinding.single(logicalKey("n", {
		primaryKey: true,
	}));
	const windows = resolveKeybinding(
		keybinding,
		OperatingSystem.Windows,
	);
	const mac = resolveKeybinding(
		keybinding,
		OperatingSystem.Macintosh,
	);

	assert.equal(getKeybindingLabel(windows), "Ctrl+N");
	assert.equal(getKeybindingLabel(mac), "⌘N");
	assert.equal(
		getKeybindingLabel(mac, KeybindingLabelStyle.Aria),
		"Command+N",
	);
	assert.equal(
		getKeybindingLabel(mac, KeybindingLabelStyle.UserSettings),
		"cmd+n",
	);
});

test("VS Code numeric keybindings decode into the canonical keybinding model", () => {
	const windows = decodeKeybinding(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyM, OperatingSystem.Windows);
	const mac = decodeKeybinding(KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.KeyM, OperatingSystem.Macintosh);

	assert.ok(windows);
	assert.deepEqual(resolveKeybinding(windows, OperatingSystem.Windows).chords[0], {
		kind: KeybindingChordKind.Logical,
		key: "m",
		label: undefined,
		ctrlKey: true,
		shiftKey: true,
		altKey: false,
		metaKey: false,
	});
	assert.ok(mac);
	assert.equal(resolveKeybinding(mac, OperatingSystem.Macintosh).chords[0].ctrlKey, true);
	assert.equal(resolveKeybinding(mac, OperatingSystem.Macintosh).chords[0].metaKey, true);
});

test("resolved chords match their declared logical or physical identity", () => {
	const resolved = resolveKeybinding(
		Keybinding.chord(
			logicalKey("z", { ctrlKey: true }),
			physicalKey("KeyY", { ctrlKey: true }),
		),
		OperatingSystem.Windows,
	);

	assert.equal(matchesResolvedChord(resolved.chords[0], {
		key: "Z",
		code: "KeyY",
		ctrlKey: true,
		shiftKey: false,
		altKey: false,
		metaKey: false,
	}), true);
	assert.equal(matchesResolvedChord(resolved.chords[1], {
		key: "z",
		code: "KeyY",
		ctrlKey: true,
		shiftKey: false,
		altKey: false,
		metaKey: false,
	}), true);
});

test("space has a stable user representation", () => {
	const parsed = parseKeybinding("ctrl+space");
	assert.ok(parsed);
	assert.equal(
		getKeybindingLabel(
			resolveKeybinding(parsed, OperatingSystem.Windows),
		),
		"Ctrl+Space",
	);
});

test("shared keybinding parser fixtures match the TypeScript implementation", () => {
	const fixtures = loadKeybindingConformanceFixtures<ConformanceFixtures>();

	for (const fixture of fixtures.parser) {
		const parsed = parseKeybinding(fixture.input);
		assert.equal(Boolean(parsed), fixture.valid, fixture.input);
		if (parsed) {
			assert.equal(parsed.chords.length, fixture.chords, fixture.input);
			assert.equal(serializeKeybinding(parsed), fixture.canonical, fixture.input);
		}
	}
});
