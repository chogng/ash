import { strict as assert } from "node:assert";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { appendIcon, setIconResolver } from "../../browser/ui/lxicons/lxicon.js";
import { getLxiconDefinition, registerLxicon } from "../../common/lxiconsUtil.js";
import { Lxicon } from '../../common/lxicons.js';

test('appendIcon creates isolated native glyph nodes in each document', () => {
	const firstDocument = new JSDOM('<!doctype html><body></body>').window.document;
	const secondDocument = new JSDOM('<!doctype html><body></body>').window.document;
	try {
		const icon = registerLxicon('test-browser-native-font', 0xe001);
		const first = appendIcon(icon, firstDocument.body);
		const second = appendIcon(icon, firstDocument.body);
		assert.notEqual(first, second);
		assert.equal(first.getAttribute('aria-hidden'), 'true');
		assert.equal(first.tabIndex, -1);
		assert.equal(first.childElementCount, 0);
		assert.equal(first.textContent, '');
		first.dataset.ashIconCharacter = 'X';
		assert.equal(second.dataset.ashIconCharacter, '\ue001');
		assert.equal(appendIcon(icon, secondDocument.body).dataset.ashIconCharacter, '\ue001');
	} finally { firstDocument.defaultView?.close(); secondDocument.defaultView?.close(); }
});

test('native font icons retain their identity through font theme overrides', () => {
	const firstDocument = new JSDOM('<!doctype html><body></body>').window.document;
	const secondDocument = new JSDOM('<!doctype html><body></body>').window.document;
	try {
		const icon = Lxicon.dialogError;
		const defaultDefinition = getLxiconDefinition(icon.id)!;
		const first = appendIcon(icon, firstDocument.body);
		const second = appendIcon(icon, secondDocument.body);
		assert.equal(first.getAttribute('data-ash-icon-id'), 'dialog-error');
		assert.equal(first.getAttribute('data-ash-icon-character'), (defaultDefinition as { fontCharacter: string; }).fontCharacter);
		assert.equal(first.childElementCount, 0);
		assert.equal(first.textContent, '');
		assert.equal(first.getAttribute('aria-hidden'), 'true');
		const source = appendIcon(Lxicon.error, firstDocument.body);
		const sourceArtwork = source.innerHTML;
		first.classList.add('custom-size');
		first.setAttribute('title', 'Keep this tooltip');
		const themedDefinition = { fontCharacter: 'B' };
		setIconResolver(firstDocument, requested => requested.id === icon.id ? themedDefinition : undefined);
		assert.equal(firstDocument.querySelector('.ash-icon'), first);
		assert(first.classList.contains('custom-size'));
		assert.equal(first.getAttribute('title'), 'Keep this tooltip');
		assert.equal(first.dataset.ashIconCharacter, 'B');
		assert.equal(first.childElementCount, 0);
		assert.equal(source.innerHTML, sourceArtwork);
		assert.equal(second.innerHTML, sourceArtwork);
		assert.equal(appendIcon(icon, firstDocument.body).dataset.ashIconCharacter, 'B');
		setIconResolver(firstDocument, requested => requested.id === icon.id ? defaultDefinition : undefined);
		assert.equal(first.innerHTML, sourceArtwork);
		assert.equal(first.childElementCount, 0);
		assert(first.classList.contains('ash-icon-default-font'));
		const themedFont = { fontCharacter: 'A', font: { id: 'test-font', definition: { weight: '600', style: 'italic' } } };
		setIconResolver(firstDocument, () => themedFont);
		assert.equal(first.dataset.ashIconCharacter, 'A');
		assert.equal(first.style.getPropertyValue('--ash-icon-font-family'), '"test-font"');
		assert.equal(first.style.getPropertyValue('--ash-icon-font-weight'), '600');
		assert.equal(first.style.getPropertyValue('--ash-icon-font-style'), 'italic');
		assert(!first.classList.contains('ash-icon-default-font'));
		setIconResolver(firstDocument, () => undefined);
		assert.equal(first.style.getPropertyValue('--ash-icon-font-family'), '');
		assert(first.classList.contains('ash-icon-default-font'));
	} finally {
		firstDocument.defaultView?.close();
		secondDocument.defaultView?.close();
	}
});


test('prepared glyph layers retain their animation identities and clear on theme replacement', () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	try {
		const icon = Lxicon.ashMark;
		const node = appendIcon(icon, browser.window.document.body);
		assert.equal(node.querySelectorAll('.ash-icon-font-layer').length, 9);
		assert.equal(node.querySelector('svg'), null);
		assert.equal(node.textContent, '');
		const petal = node.querySelector<HTMLElement>('[data-ash-icon-layer="petal-north"]')!;
		assert.ok(petal.dataset.ashIconCharacter);
		assert.match(petal.style.transformOrigin, /%/);
		setIconResolver(browser.window.document, () => ({ fontCharacter: 'B' }));
		assert.equal(node.childElementCount, 0);
		assert.equal(node.classList.contains('ash-icon-layered'), false);
		setIconResolver(browser.window.document, () => undefined);
		assert.equal(node.querySelectorAll('.ash-icon-font-layer').length, 9);
	} finally { browser.window.close(); }
});
