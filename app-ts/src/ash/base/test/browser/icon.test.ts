import { strict as assert } from "node:assert";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { appendIcon } from "../../browser/ui/icon/icon.js";
import { register } from "../../common/icon.js";

test("appendIcon parses one prototype per document and clones isolated SVG elements", () => {
	const firstDocument = new JSDOM("<!doctype html><body></body>").window.document;
	const secondDocument = new JSDOM("<!doctype html><body></body>").window.document;
	let definitionCalls = 0;
	const icon = register("test-browser-icon-prototype-cache", () => {
		definitionCalls += 1;
		return `<svg viewBox="0 0 16 16"><path stroke="black" d="M2 8h12"/></svg>`;
	});

	const first = appendIcon(icon, firstDocument.body);
	const second = appendIcon(icon, firstDocument.body);
	assert.equal(definitionCalls, 1);
	assert.notEqual(first, second);
	assert.equal(first.getAttribute("aria-hidden"), "true");
	assert.equal(first.getAttribute("focusable"), "false");
	assert(first.classList.contains("ash-icon"));

	first.querySelector("path")?.setAttribute("stroke", "red");
	const third = appendIcon(icon, firstDocument.body);
	assert.equal(third.querySelector("path")?.getAttribute("stroke"), "black");
	assert.equal(definitionCalls, 1);

	appendIcon(icon, secondDocument.body);
	assert.equal(definitionCalls, 2);
});
