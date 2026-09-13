import assert from "node:assert/strict";
import { test } from "mocha";
import {
	StandardKeyboardEvent,
} from "../../browser/keyboardEvent.js";
import { KeyCode, ScanCode } from "../../common/keyCodes.js";

function keyboardEvent(
	overrides: Partial<KeyboardEvent> = {},
): KeyboardEvent {
	return {
		key: "p",
		code: "KeyP",
		ctrlKey: true,
		shiftKey: false,
		altKey: false,
		metaKey: false,
		repeat: false,
		isComposing: false,
		getModifierState: () => false,
		preventDefault: () => {},
		stopPropagation: () => {},
		stopImmediatePropagation: () => {},
		...overrides,
	} as KeyboardEvent;
}

test("standard keyboard events match physical chords and modifiers", () => {
	const event = new StandardKeyboardEvent(keyboardEvent());

	assert.equal(event.matches({ code: "KeyP", ctrlKey: true }), true);
	assert.equal(event.keyCode, KeyCode.KeyP);
	assert.equal(event.scanCode, ScanCode.KeyP);
	assert.equal(event.matches({ code: "KeyP" }), false);
	assert.equal(event.matches({ code: "KeyO", ctrlKey: true }), false);
});

test("composing keyboard events do not trigger physical chords", () => {
	const event = new StandardKeyboardEvent(keyboardEvent({
		isComposing: true,
	}));

	assert.equal(event.matches({ code: "KeyP", ctrlKey: true }), false);
});

test("AltGraph does not masquerade as a Ctrl+Alt shortcut", () => {
	const event = new StandardKeyboardEvent(keyboardEvent({
		altKey: true,
		getModifierState: (key) => key === "AltGraph",
	}));

	assert.equal(
		event.matches({ code: "KeyP", ctrlKey: true, altKey: true }),
		false,
	);
});

test("numpad events retain their keypad identity when NumLock changes the key value", () => {
	const event = new StandardKeyboardEvent(keyboardEvent({
		key: "End",
		code: "Numpad1",
		keyCode: 35,
		location: 3,
	}));

	assert.equal(event.keyCode, KeyCode.Numpad1);
	assert.equal(event.scanCode, ScanCode.Numpad1);
});
