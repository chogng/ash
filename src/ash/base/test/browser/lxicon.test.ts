import { strict as assert } from "node:assert";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { appendIcon, setIconResolver } from "../../browser/ui/lxicons/lxicon.js";
import { getLxiconDefinition, registerLxicon } from "../../common/lxiconsUtil.js";
import { Lxicon } from '../../common/lxicons.js';

test("appendIcon parses one prototype per document and clones isolated dedicated artwork", () => {
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
	assert.equal(first.tabIndex, -1);
	assert(first.classList.contains("ash-icon"));

	first.querySelector("path")?.setAttribute("stroke", "red");
	const third = appendIcon(icon, firstDocument.body);
	assert.equal(third.querySelector("path")?.getAttribute("stroke"), "black");
	assert.equal(definitionCalls, 1);

	appendIcon(icon, secondDocument.body);
	assert.equal(definitionCalls, 2);
});

test('derived SVG icons retain their identity and update independently across documents', () => {
	const firstDocument = new JSDOM('<!doctype html><body></body>').window.document;
	const secondDocument = new JSDOM('<!doctype html><body></body>').window.document;
	try {
		const icon = Lxicon.dialogError;
		const defaultDefinition = getLxiconDefinition(icon.id)!;
		const first = appendIcon(icon, firstDocument.body);
		const second = appendIcon(icon, secondDocument.body);
		assert.equal(first.getAttribute('data-ash-icon-id'), 'dialog-error');
		const source = appendIcon(Lxicon.error, firstDocument.body);
		const sourceArtwork = source.innerHTML;
		first.classList.add('custom-size');
		first.setAttribute('title', 'Keep this tooltip');
		const themedDefinition = () => '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/></svg>';
		setIconResolver(firstDocument, requested => requested.id === icon.id ? themedDefinition : undefined);
		assert.equal(firstDocument.querySelector('.ash-icon'), first);
		assert(first.classList.contains('custom-size'));
		assert.equal(first.getAttribute('title'), 'Keep this tooltip');
		assert.equal(first.querySelector('svg')?.getAttribute('viewBox'), '0 0 24 24');
		assert(first.querySelector('circle'));
		assert.equal(source.innerHTML, sourceArtwork);
		assert.equal(second.innerHTML, sourceArtwork);
		assert(appendIcon(icon, firstDocument.body).querySelector('circle'));
		setIconResolver(firstDocument, requested => requested.id === icon.id ? defaultDefinition : undefined);
		assert.equal(first.innerHTML, sourceArtwork);
		assert.equal(first.querySelector('svg')?.getAttribute('viewBox'), source.querySelector('svg')?.getAttribute('viewBox'));
	} finally {
		firstDocument.defaultView?.close();
		secondDocument.defaultView?.close();
	}
});
