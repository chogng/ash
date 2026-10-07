import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { addDisposableListener, computeScreenAwareSize, Dimension, getActiveDocument, getActiveElement, getDocument, getDomNodePagePosition, getShadowRoot, getWindow, h, isEditableElement, isElement, isHTMLElement, isNode, stopEvent, svg } from "../../browser/dom.js";
import { registerWindow } from "../../browser/window.js";

test("disposable DOM listeners detach deterministically", () => {
	const target = new EventTarget();
	let calls = 0;
	const registration = addDisposableListener(
		target,
		"change",
		() => calls++,
	);

	target.dispatchEvent(new Event("change"));
	registration.dispose();
	registration.dispose();
	target.dispatchEvent(new Event("change"));

	assert.equal(calls, 1);
});

test("disposable DOM listeners retain their registered capture mode", () => {
	const ownerWindow = new JSDOM("<!doctype html><body><button></button></body>").window;
	const button = ownerWindow.document.querySelector("button")!;
	const options = { capture: true };
	let calls = 0;
	const registration = addDisposableListener(button, "click", () => calls++, options);

	options.capture = false;
	registration.dispose();
	button.dispatchEvent(new ownerWindow.MouseEvent("click", { bubbles: true }));

	assert.equal(calls, 0);
});

test("DOM guards validate nodes from their owning window", () => {
	const firstDocument = new JSDOM("<!doctype html><body></body>").window.document;
	const secondDocument = new JSDOM("<!doctype html><body></body>").window.document;
	const element = h(secondDocument, "div");
	const svgElement = svg(secondDocument, "svg");

	assert.deepEqual({
		firstDocument: isNode(firstDocument),
		secondDocument: isNode(secondDocument),
		element: isElement(element),
		htmlElement: isHTMLElement(element),
		svgElement: isElement(svgElement),
		svgHtmlElement: isHTMLElement(svgElement),
		structuralLookalike: isNode({
			nodeType: 1,
			namespaceURI: "http://www.w3.org/1999/xhtml",
		}),
	}, {
		firstDocument: true,
		secondDocument: true,
		element: true,
		htmlElement: true,
		svgElement: true,
		svgHtmlElement: false,
		structuralLookalike: false,
	});
});

test("DOM exposes shared geometry and editable-element guards", () => {
	const ownerWindow = new JSDOM("<!doctype html><body><input><div contenteditable='true'></div><span></span></body>").window;
	const input = ownerWindow.document.querySelector("input")!;
	const editable = ownerWindow.document.querySelector("div")!;
	const span = ownerWindow.document.querySelector("span")!;
	Object.defineProperty(span, "getBoundingClientRect", { value: () => ({ left: 2, top: 3, width: 4, height: 5 }) });
	assert.equal(Dimension.None, Dimension.Zero);
	assert.equal(isEditableElement(input), true);
	assert.equal(isEditableElement(editable), true);
	assert.equal(isEditableElement(span), false);
	assert.deepEqual(getDomNodePagePosition(span), { left: 2, top: 3, width: 4, height: 5 });
	ownerWindow.close();
});

test("DOM context queries resolve the owning window and document", () => {
	const ownerWindow = new JSDOM("<!doctype html><body><button></button></body>").window;
	const button = ownerWindow.document.querySelector("button")!;

	assert.deepEqual({
		windowFromNode: getWindow(button),
		windowFromDocument: getWindow(ownerWindow.document),
		documentFromNode: getDocument(button),
	}, {
		windowFromNode: ownerWindow,
		windowFromDocument: ownerWindow,
		documentFromNode: ownerWindow.document,
	});
	ownerWindow.close();
});

test("screen-aware CSS sizes occupy stable whole physical pixels", () => {
	const ownerWindow = new JSDOM("<!doctype html><body></body>").window;
	Object.defineProperty(ownerWindow, "devicePixelRatio", { configurable: true, value: 1.25 });

	assert.deepEqual({
		thin: computeScreenAwareSize(ownerWindow as unknown as Window, 1),
		wide: computeScreenAwareSize(ownerWindow as unknown as Window, 2),
	}, {
		thin: 0.8,
		wide: 1.6,
	});
	ownerWindow.close();
});

test("active DOM context follows a registered focused window", () => {
	const ownerWindow = new JSDOM("<!doctype html><body><button></button></body>").window;
	const registration = registerWindow(ownerWindow as unknown as Window);
	const button = ownerWindow.document.querySelector("button")!;
	button.focus();

	try {
		assert.deepEqual({
			document: getActiveDocument(),
			element: getActiveElement(),
		}, {
			document: ownerWindow.document,
			element: button,
		});
	} finally {
		registration.dispose();
		ownerWindow.close();
	}
});

test('getShadowRoot resolves an element inside an open shadow tree', () => {
	const ownerWindow = new JSDOM('<!doctype html><body><main><button></button></main></body>').window;
	const document = ownerWindow.document;
	const main = document.querySelector('main')!;
	const shadowRoot = main.attachShadow({ mode: 'open' });
	const shadowChild = h(document, 'span');
	shadowRoot.append(shadowChild);

	assert.equal(getShadowRoot(shadowChild), shadowRoot);
	ownerWindow.close();
});

test("stopEvent prevents native behavior and propagation", () => {
	const event = new Event("submit", {
		bubbles: true,
		cancelable: true,
	});
	let propagated = false;
	const target = new EventTarget();
	target.addEventListener("submit", (next) =>
		stopEvent(next, { immediate: true }),
	);
	target.addEventListener("submit", () => {
		propagated = true;
	});

	const accepted = target.dispatchEvent(event);

	assert.equal(accepted, false);
	assert.equal(event.defaultPrevented, true);
	assert.equal(propagated, false);
});
