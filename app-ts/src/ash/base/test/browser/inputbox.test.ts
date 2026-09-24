import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { InputBox } from "../../browser/ui/inputbox/inputbox.js";

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
