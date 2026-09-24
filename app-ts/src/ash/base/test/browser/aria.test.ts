import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM, type DOMWindow } from "jsdom";
import { scheduleAtNextAnimationFrame } from "../../browser/scheduler.js";
import { alert, AriaLiveRegion, setARIAContainer, setAriaAttribute, setRole, status } from "../../browser/ui/aria/aria.js";

test("ARIA helpers set, preserve false, and remove semantic attributes", () => {
	const dom = new JSDOM("<!doctype html><body><button></button></body>");
	const button = dom.window.document.querySelector("button");
	assert.ok(button);

	setRole(button, "menuitem");
	setAriaAttribute(button, "expanded", false);
	setAriaAttribute(button, "controls", "menu");
	assert.equal(button.getAttribute("role"), "menuitem");
	assert.equal(button.getAttribute("aria-expanded"), "false");
	assert.equal(button.getAttribute("aria-controls"), "menu");

	setRole(button, undefined);
	setAriaAttribute(button, "controls", undefined);
	assert.equal(button.hasAttribute("role"), false);
	assert.equal(button.hasAttribute("aria-controls"), false);
	dom.window.close();
});

test("AriaLiveRegion announces repeated status and alert messages", async () => {
	const dom = new JSDOM("<!doctype html><body></body>", {
		pretendToBeVisual: true,
	});
	const region = new AriaLiveRegion(dom.window.document);

	region.status("Ready");
	await nextAnimationFrame(dom.window);
	assert.deepEqual(
		[...dom.window.document.querySelectorAll(".ash-aria-status")]
			.map((element) => element.textContent),
		["Ready", ""],
	);

	region.status("Ready");
	await nextAnimationFrame(dom.window);
	assert.deepEqual(
		[...dom.window.document.querySelectorAll(".ash-aria-status")]
			.map((element) => element.textContent),
		["", "Ready"],
	);

	region.alert("Failed");
	await nextAnimationFrame(dom.window);
	const alert = dom.window.document.querySelector(".ash-aria-alert");
	assert.equal(alert?.getAttribute("role"), "alert");
	assert.equal(alert?.getAttribute("aria-atomic"), "true");
	assert.equal(alert?.textContent, "Failed");

	region.clear();
	assert.equal(
		dom.window.document.querySelector(".ash-aria-live")?.textContent,
		"",
	);
	region.dispose();
	assert.equal(
		dom.window.document.querySelector(".ash-aria-live"),
		null,
	);
	dom.window.close();
});

test("module ARIA owner announces through the configured workbench container", async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>", {
		pretendToBeVisual: true,
	});
	const container = dom.window.document.querySelector("main");
	assert.ok(container);
	setARIAContainer(container);

	status("Ready");
	await nextAnimationFrame(dom.window);
	alert("Tab moves focus");
	await nextAnimationFrame(dom.window);

	assert.equal(container.querySelector(".ash-aria-status")?.textContent, "Ready");
	assert.equal(container.querySelector(".ash-aria-alert")?.textContent, "Tab moves focus");
	dom.window.close();
});

function nextAnimationFrame(targetWindow: DOMWindow): Promise<void> {
	return new Promise((resolve) => {
		scheduleAtNextAnimationFrame(targetWindow as unknown as Window, resolve);
	});
}
