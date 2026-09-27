import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { cloneDocumentStyles } from '../../browser/domStylesheets.js';

test('document style mirror retains loaded links while synchronizing changed styles', async () => {
	const source = new JSDOM('<!doctype html><head><link id="sheet" rel="stylesheet" href="/editor.css"><style id="theme">.editor { color: red; }</style></head><body></body>', { url: 'https://ash.test/workbench' });
	const target = new JSDOM('<!doctype html><head></head><body></body>', { url: 'https://ash.test/popup' });
	using mirror = cloneDocumentStyles(source.window.document, target.window.document);
	try {
		const link = target.window.document.head.querySelector<HTMLLinkElement>('#sheet')!;
		const theme = target.window.document.head.querySelector<HTMLStyleElement>('#theme')!;
		assert.equal(link.href, 'https://ash.test/editor.css');
		let ready = false;
		const loaded = mirror.whenStylesHaveLoaded.then(() => { ready = true; });
		await Promise.resolve();
		assert.equal(ready, false);
		link.dispatchEvent(new target.window.Event('load'));
		await loaded;
		assert.equal(ready, true);

		source.window.document.querySelector('#theme')!.textContent = '.editor { color: green; }';
		await Promise.resolve();
		assert.equal(target.window.document.head.querySelector('#sheet'), link);
		assert.equal(target.window.document.head.querySelector('#theme'), theme);
		assert.equal(theme.textContent, '.editor { color: green; }');

		(source.window.document.querySelector('#sheet') as HTMLLinkElement).href = '/updated.css';
		await Promise.resolve();
		assert.equal(target.window.document.head.querySelector('#sheet'), link);
		assert.equal(link.href, 'https://ash.test/updated.css');
		ready = false;
		const reloaded = mirror.whenStylesHaveLoaded.then(() => { ready = true; });
		await Promise.resolve();
		assert.equal(ready, false);
		link.dispatchEvent(new target.window.Event('load'));
		await reloaded;
		assert.equal(ready, true);
	} finally {
		source.window.close();
		target.window.close();
	}
});
