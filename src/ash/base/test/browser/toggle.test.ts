import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Checkbox, Switch, Toggle } from "../../browser/ui/toggle/toggle.js";
import { h } from "../../browser/dom.js";

test("Toggle and Checkbox expose shared native boolean state", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const changes: boolean[] = [];
	using checkbox = new Checkbox(dom.window.document.body, {
		label: "Underline links",
		onChange: checked => changes.push(checked),
	});
	dom.window.document.body.append(checkbox.element);

	assert.equal(checkbox.element.classList.contains("ash-checkbox"), true);
	assert.equal(checkbox.input.type, "checkbox");
	assert.equal(checkbox.checked, false);

	checkbox.input.click();

	assert.equal(checkbox.checked, true);
	assert.equal(checkbox.element.classList.contains("checked"), true);
	assert.deepEqual(changes, [true]);

	checkbox.checked = false;
	assert.equal(checkbox.element.classList.contains("checked"), false);
	dom.window.close();
});

test("Switch projects the shared state as a switch control", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	using toggle = new Toggle(dom.window.document.body, {
		ariaLabel: "Generic toggle",
	});
	using switchControl = new Switch(dom.window.document.body, {
		ariaLabel: "Reduce motion",
		checked: true,
	});
	dom.window.document.body.append(toggle.element, switchControl.element);

	assert.equal(toggle.input.getAttribute("role"), null);
	assert.equal(switchControl.input.getAttribute("role"), "switch");
	assert.equal(switchControl.input.getAttribute("aria-checked"), "true");
	assert.equal(switchControl.element.querySelector(".ash-switch-track"), switchControl.track);
	switchControl.busy = true;
	assert.equal(switchControl.enabled, true);
	assert.equal(switchControl.input.disabled, true);
	assert.equal(switchControl.input.getAttribute("aria-busy"), "true");
	assert.equal(switchControl.element.classList.contains("busy"), true);
	assert.equal(switchControl.element.classList.contains("disabled"), false);
	switchControl.busy = false;
	assert.equal(switchControl.input.disabled, false);
	assert.equal(switchControl.input.hasAttribute("aria-busy"), false);

	switchControl.input.click();

	assert.equal(switchControl.checked, false);
	assert.equal(switchControl.input.getAttribute("aria-checked"), "false");
	assert.equal(switchControl.element.classList.contains("checked"), false);
	dom.window.close();
});

test("Toggle can place its content before the control", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const content = h(dom.window.document, "span");
	content.textContent = "Minimap";
	using switchControl = new Switch(dom.window.document.body, {
		ariaLabel: "Minimap",
		content,
		contentPlacement: "before-control",
	});
	dom.window.document.body.append(switchControl.element);

	assert.equal(switchControl.element.classList.contains("ash-toggle-content-before-control"), true);
	assert.equal(switchControl.element.querySelector(".ash-toggle-content")?.firstElementChild, content);
	assert.equal(switchControl.element.children[1]?.classList.contains("ash-toggle-content"), true);
	assert.equal(switchControl.element.children[2], switchControl.track);
	dom.window.close();
});
