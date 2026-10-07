import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { ProductIconThemeData } from '../../browser/productIconThemeData.js';

test('extension product icon themes load SVG resources and reject executable artwork', async () => {
	const document = new JSDOM('<!doctype html><body></body>').window.document;
	const resources = new Map([
		['icons/chevron.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path stroke="currentColor" d="M2 5l6 6 6-6"/></svg>'],
		['icons/script.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><script>alert(1)</script></svg>'],
		['icons/remote.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="url(https://example.com/a.svg)" d="M0 0"/></svg>'],
	]);
	const readResource = async (path: string): Promise<Uint8Array> => {
		const content = resources.get(path);
		if (!content) throw new Error(`Missing test resource: ${path}`);
		return new TextEncoder().encode(content);
	};
	const theme = await ProductIconThemeData.load('test-svg-icons', 'SVG Icons', { iconDefinitions: { 'folding-expanded': { iconPath: './icons/chevron.svg' } } }, readResource, document);
	assert.equal(theme.id, 'test-svg-icons');
	assert.match(theme.icons.get('folding-expanded')!(), /<path/);
	for (const iconPath of ['./icons/script.svg', './icons/remote.svg', '../outside.svg']) {
		await assert.rejects(ProductIconThemeData.load('invalid-svg-icons', 'Invalid', { iconDefinitions: { 'folding-expanded': { iconPath } } }, readResource, document));
	}
});
