import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { createReactiveDom } from "../../browser/reactiveDom.js";
import { observableValue } from "../../common/observable.js";

test("reactive DOM updates class, state, style, and nested children", () => {
	const ownerDocument = new JSDOM("<!doctype html><body></body>").window.document;
	const n = createReactiveDom(ownerDocument);
	const active = observableValue("active", false);
	const label = observableValue("label", "Before");
	const width = observableValue("width", "10px");
	const backgroundColor = observableValue("backgroundColor", "red");
	const view = n.div({
		className: ["root", active.map(value => value && "active")],
		attributes: { "aria-expanded": active.map(value => String(value)) },
		properties: { hidden: active.map(value => !value) },
		dataset: { state: active.map(value => value ? "active" : "idle") },
		style: { width, backgroundColor },
	}, [
		n.elem("span", { className: "label" }, label),
	]);
	const live = view.toLiveElement();

	assert.equal(live.element.ownerDocument, ownerDocument);
	assert.equal(live.element.outerHTML, '<div class="root" aria-expanded="false" hidden="" data-state="idle" style="width: 10px; background-color: red;"><span class="label">Before</span></div>');

	active.set(true);
	label.set("After");
	width.set("20px");
	backgroundColor.set("blue");

	assert.equal(live.element.outerHTML, '<div class="root active" aria-expanded="true" data-state="active" style="width: 20px; background-color: blue;"><span class="label">After</span></div>');
	live.dispose();
	label.set("Ignored");
	assert.equal(live.element.textContent, "After");
});

test("reactive DOM switches observable child trees without global document access", () => {
	const firstDocument = new JSDOM("<!doctype html><body></body>").window.document;
	const secondDocument = new JSDOM("<!doctype html><body></body>").window.document;
	const n = createReactiveDom(secondDocument);
	const first = n.elem("strong", {}, "First");
	const second = n.elem("em", {}, "Second");
	const child = observableValue("child", first);
	const live = n.div({}, child).toLiveElement();

	assert.notEqual(live.element.ownerDocument, firstDocument);
	assert.equal(live.element.innerHTML, "<strong>First</strong>");
	child.set(second);
	assert.equal(live.element.innerHTML, "<em>Second</em>");
	live.dispose();
});

test("reactive DOM projects and removes SVG dataset values", () => {
	const ownerDocument = new JSDOM("<!doctype html><body></body>").window.document;
	const n = createReactiveDom(ownerDocument);
	const state = observableValue<string | undefined>("state", "ready");
	const live = n.svg({
		dataset: { state },
	}, n.svgElem("path", { attributes: { d: "M0 0h16v16z" } })).toLiveElement();

	assert.equal(
		live.element.outerHTML,
		'<svg data-state="ready"><path d="M0 0h16v16z"></path></svg>',
	);
	state.set(undefined);
	assert.equal(live.element.outerHTML, '<svg><path d="M0 0h16v16z"></path></svg>');
	live.dispose();
});
