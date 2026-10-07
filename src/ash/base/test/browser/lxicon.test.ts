import { strict as assert } from "node:assert";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { appendIcon, setIconResolver } from "../../browser/ui/lxicons/lxicon.js";
import { getLxiconDefinition, registerLxicon } from "../../common/lxiconsUtil.js";
import { Lxicon } from '../../common/lxicons.js';

test('derived Lxicon IDs render SVGs and receive independent theme updates', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const document = dom.window.document;
		const derived = appendIcon(Lxicon.dialogError, document.body);
		const source = appendIcon(Lxicon.error, document.body);
		assert.equal(derived.getAttribute('data-ash-icon-id'), 'dialog-error');
		assert.equal(derived.getAttribute('aria-hidden'), 'true');
		assert.equal(derived.innerHTML, source.innerHTML);
		const original = source.innerHTML;
		const themed = () => '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/></svg>';
		setIconResolver(document, icon => icon.id === Lxicon.dialogError.id ? themed : getLxiconDefinition(icon.id));
		assert.equal(document.querySelector('[data-ash-icon-id="dialog-error"]'), derived);
		assert.equal(derived.getAttribute('viewBox'), '0 0 24 24');
		assert.equal(derived.querySelectorAll('circle').length, 1);
		assert.equal(source.innerHTML, original);
	} finally {
		dom.window.close();
	}
});

test("appendIcon parses one prototype per document and clones isolated SVG elements", () => {
	const firstDocument = new JSDOM("<!doctype html><body></body>").window.document;
	const secondDocument = new JSDOM("<!doctype html><body></body>").window.document;
	let definitionCalls = 0;
	const icon = registerLxicon("test-browser-icon-prototype-cache", () => {
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

test('product SVG themes update mounted icons and preserve their DOM identity', () => {
	const firstDocument = new JSDOM('<!doctype html><body></body>').window.document;
	const secondDocument = new JSDOM('<!doctype html><body></body>').window.document;
	const defaultDefinition = () => '<svg viewBox="0 0 16 16"><path d="M1 1"/></svg>';
	const icon = registerLxicon('test-browser-icon-theming', defaultDefinition);
	const first = appendIcon(icon, firstDocument.body);
	const second = appendIcon(icon, secondDocument.body);
	first.classList.add('custom-size');
	first.setAttribute('title', 'Keep this tooltip');
	const themedDefinition = () => '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/></svg>';
	setIconResolver(firstDocument, requested => requested.id === icon.id ? themedDefinition : undefined);
	assert.equal(firstDocument.querySelector('svg.ash-icon'), first);
	assert(first.classList.contains('custom-size'));
	assert.equal(first.getAttribute('title'), 'Keep this tooltip');
	assert.equal(first.getAttribute('viewBox'), '0 0 24 24');
	assert(first.querySelector('circle'));
	assert(second.querySelector('path'));
	assert(appendIcon(icon, firstDocument.body).querySelector('circle'));
	setIconResolver(firstDocument, requested => requested.id === icon.id ? defaultDefinition : undefined);
	assert(first.querySelector('path'));
	assert.equal(first.getAttribute('viewBox'), '0 0 16 16');
});
