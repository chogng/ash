import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import '../../../editor/test/browser/testEditorDom.js';
import { cloneDocumentStyles, GlobalStyleSheet } from '../../browser/domStylesheets.js';
import { getWindows, registerWindow } from '../../browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';

// Establish the suite's main window before tracking per-test auxiliary resources.
getWindows();
ensureNoDisposablesAreLeakedInTestSuite();

test('global styles follow live windows and release each window independently', () => {
	const first = new JSDOM('<!doctype html><head></head><body></body>');
	const second = new JSDOM('<!doctype html><head></head><body></body>');
	try {
		using firstRegistration = registerWindow(first.window as unknown as Window);
		using styles = new GlobalStyleSheet(':root { --test-layer: 10; }');
		using secondRegistration = registerWindow(second.window as unknown as Window);
		const firstStyle = first.window.document.querySelector('style')!;
		const secondStyle = second.window.document.querySelector('style')!;
		assert.deepEqual([firstStyle.textContent, secondStyle.textContent], [':root { --test-layer: 10; }', ':root { --test-layer: 10; }']);
		firstRegistration.dispose();
		styles.setText(':root { --test-layer: 20; }');
		assert.equal(first.window.document.querySelector('style'), null);
		assert.equal(firstStyle.textContent, ':root { --test-layer: 10; }');
		assert.equal(second.window.document.querySelector('style'), secondStyle);
		assert.equal(secondStyle.textContent, ':root { --test-layer: 20; }');
		styles.dispose();
		assert.equal(second.window.document.querySelector('style'), null);
	} finally {
		first.window.close();
		second.window.close();
	}
});

test('document style mirror retains loaded links while synchronizing changed styles', async () => {
	const source = new JSDOM('<!doctype html><head><link id="sheet" rel="stylesheet" href="/editor.css"><style id="theme">.editor { color: red; }</style></head><body></body>', {
		url: 'https://ash.test/workbench',
	});
	const target = new JSDOM('<!doctype html><head></head><body></body>', { url: 'https://ash.test/popup' });
	using mirror = cloneDocumentStyles(source.window.document, target.window.document);
	try {
		const link = target.window.document.head.querySelector<HTMLLinkElement>('#sheet')!;
		const theme = target.window.document.head.querySelector<HTMLStyleElement>('#theme')!;
		assert.equal(link.href, 'https://ash.test/editor.css');
		let ready = false;
		const loaded = mirror.whenStylesHaveLoaded.then(() => {
			ready = true;
		});
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
		const reloaded = mirror.whenStylesHaveLoaded.then(() => {
			ready = true;
		});
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
