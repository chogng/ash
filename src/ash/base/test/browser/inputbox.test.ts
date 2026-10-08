import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { HistoryInputBox, InputBox } from "../../browser/ui/inputbox/inputbox.js";

test('Flexible InputBox preserves multiline editing, selection and validation without changing default numeric inputs', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using input = new InputBox(dom.window.document.body, { flexibleHeight: true, flexibleMaxHeight: 134, presentation: 'compact' });
	using numeric = new InputBox(dom.window.document.body, { type: 'number' });
	const changed: string[] = [];
	input.onDidChange(value => changed.push(value));
	input.value = '中文😀\nsecond';
	input.focus();
	input.select({ start: 2, end: 4 });
	input.showValidation('Invalid pattern');
	assert.deepEqual({ tag: input.inputElement.tagName, value: input.value, selection: [input.inputElement.selectionStart, input.inputElement.selectionEnd], changed, invalid: input.inputElement.getAttribute('aria-invalid') }, {
		tag: 'TEXTAREA', value: '中文😀\nsecond', selection: [2, 4], changed: ['中文😀\nsecond'], invalid: 'true',
	});
	numeric.inputElement.valueAsNumber = 3;
	numeric.step = '2';
	assert.deepEqual([numeric.inputElement.tagName, numeric.inputElement.type, numeric.inputElement.valueAsNumber, numeric.step], ['INPUT', 'number', 3, '2']);
	input.dispose(); numeric.dispose();
	dom.window.close();
});

test('Flexible history input retains multiline entries and restores the multiline draft', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using input = new HistoryInputBox(dom.window.document.body, { flexibleHeight: true, history: new Set(['saved\nquery']) });
	input.value = 'current\ndraft';
	input.showPreviousValue();
	assert.equal(input.value, 'saved\nquery');
	input.showNextValue();
	assert.equal(input.value, 'current\ndraft');
	input.addToHistory();
	assert.deepEqual(input.getHistory(), ['saved\nquery', 'current\ndraft']);
	input.dispose();
	dom.window.close();
});

test("InputBox exposes value, keyboard, focus, and selection behavior", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const inputBox = new InputBox(dom.window.document.body, {
		placeholder: "Search",
		ariaLabel: "Search commands",
	});
	dom.window.document.body.append(inputBox.element);
	const values: string[] = [];
	const keys: string[] = [];
	let focusCount = 0;
	let blurCount = 0;
	inputBox.onDidChange((value) => values.push(value));
	inputBox.onKeyDown((event) => keys.push(event.key));
	inputBox.onDidFocus(() => focusCount += 1);
	inputBox.onDidBlur(() => blurCount += 1);

	inputBox.value = "command";
	inputBox.value = "command";
	assert.deepEqual(values, ["command"]);
	assert.equal(inputBox.placeholder, "Search");
	assert.equal(
		inputBox.inputElement.getAttribute("aria-label"),
		"Search commands",
	);

	inputBox.focus();
	assert.equal(inputBox.hasFocus(), true);
	inputBox.select({ start: 1, end: 4 });
	assert.equal(inputBox.inputElement.selectionStart, 1);
	assert.equal(inputBox.inputElement.selectionEnd, 4);
	inputBox.inputElement.dispatchEvent(new dom.window.KeyboardEvent(
		"keydown",
		{ bubbles: true, key: "ArrowDown" },
	));
	inputBox.blur();
	assert.deepEqual(keys, ["ArrowDown"]);
	assert.equal(focusCount, 1);
	assert.equal(blurCount, 1);

	inputBox.dispose();
	dom.window.close();
});

test("InputBox owns enabled, read-only, and validation accessibility state", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const inputBox = new InputBox(dom.window.document.body, {
		enabled: false,
		readOnly: true,
	});

	assert.equal(inputBox.enabled, false);
	assert.equal(inputBox.element.classList.contains("is-disabled"), true);
	assert.equal(inputBox.inputElement.readOnly, true);
	inputBox.enabled = true;
	inputBox.readOnly = false;
	assert.equal(inputBox.enabled, true);
	assert.equal(inputBox.inputElement.readOnly, false);

	inputBox.showValidation("A value is required");
	assert.equal(inputBox.inputElement.getAttribute("aria-invalid"), "true");
	assert.ok(inputBox.inputElement.getAttribute("aria-describedby"));
	inputBox.showValidation("");
	assert.equal(inputBox.inputElement.hasAttribute("aria-invalid"), false);
	assert.equal(
		inputBox.inputElement.hasAttribute("aria-describedby"),
		false,
	);

	inputBox.dispose();
	dom.window.close();
});

test("InputBox supports numeric field presentation", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const inputBox = new InputBox(dom.window.document.body, {
		type: "number",
		presentation: "field",
	});

	assert.equal(inputBox.inputElement.type, "number");
	inputBox.step = "1";
	assert.equal(inputBox.step, "1");
	assert.equal(inputBox.element.classList.contains("ash-input-box-field"), true);
	dom.window.close();
});

test('HistoryInputBox navigates saved values and restores the uncommitted input', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const inputBox = new HistoryInputBox(dom.window.document.body, {
		history: new Set(['first', 'second']),
		showHistoryHint: () => true,
	});
	inputBox.value = 'draft';
	inputBox.focus();
	assert.equal(inputBox.inputElement.getAttribute('aria-keyshortcuts'), 'ArrowUp ArrowDown');
	inputBox.showPreviousValue();
	assert.equal(inputBox.value, 'second');
	inputBox.showPreviousValue();
	assert.equal(inputBox.value, 'first');
	inputBox.showNextValue();
	inputBox.showNextValue();
	assert.equal(inputBox.value, 'draft');

	inputBox.showPreviousValue();
	inputBox.value = 'edited';
	inputBox.showNextValue();
	assert.equal(inputBox.value, 'edited');
	inputBox.addToHistory();
	assert.deepEqual(inputBox.getHistory(), ['first', 'second', 'edited']);
	inputBox.dispose();
	dom.window.close();
});
