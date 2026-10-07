import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { fragment, h, svg } from "../../browser/dom.js";

test("DOM construction creates typed nested HTML in the supplied document", () => {
	const firstDocument = new JSDOM("<!doctype html><body></body>").window.document;
	const secondDocument = new JSDOM("<!doctype html><body></body>").window.document;
	let referenced: HTMLButtonElement | undefined;

	const root = h(secondDocument, "section", {
		className: ["root", false, "selected"],
		attributes: { role: "dialog", "aria-modal": "true" },
		properties: { tabIndex: -1, hidden: false },
		dataset: { state: "ready" },
		style: { width: "10px", backgroundColor: "red", opacity: "1" },
	}, [
		h(secondDocument, "h2", "Title"),
		false,
		null,
		h(
			secondDocument,
			"button",
			{ properties: { type: "button" }, ref: value => referenced = value },
			"Close",
		),
	]);

	assert.equal(root.ownerDocument, secondDocument);
	assert.notEqual(root.ownerDocument, firstDocument);
	assert.equal(root.outerHTML, '<section class="root selected" role="dialog" aria-modal="true" tabindex="-1" data-state="ready" style="width: 10px; background-color: red; opacity: 1;"><h2>Title</h2><button type="button">Close</button></section>');
	assert.equal(referenced, root.querySelector("button"));
});

test("DOM construction creates SVG and fragments in the supplied document", () => {
	const ownerDocument = new JSDOM("<!doctype html><body></body>").window.document;
	const icon = svg(
		ownerDocument,
		"svg",
		{
			attributes: { viewBox: "0 0 16 16" },
			dataset: { state: "ready" },
		},
		svg(ownerDocument, "path", { attributes: { d: "M0 0h16v16z" } }),
	);
	const result = fragment(ownerDocument, "before", icon, 3);

	assert.equal(
		icon.outerHTML,
		'<svg viewBox="0 0 16 16" data-state="ready"><path d="M0 0h16v16z"></path></svg>',
	);
	assert.equal(result.ownerDocument, ownerDocument);
	assert.equal(result.textContent, "before3");
	assert.equal(result.childNodes.length, 3);
});
