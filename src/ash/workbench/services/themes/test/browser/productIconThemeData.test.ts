import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ProductIconThemeData } from '../../browser/productIconThemeData.js';

test('product themes load prepared font glyphs without a document or SVG parser', async () => {
	const paths: string[] = [];
	const theme = await ProductIconThemeData.load('test-font-icons', 'Font Icons', {
		fonts: [{ id: 'test', src: [{ path: './icons/font.woff2', format: 'woff2' }] }],
		iconDefinitions: { 'folding-expanded': { fontCharacter: '\\e001', fontId: 'test' } },
	}, async path => { paths.push(path); return new Uint8Array([1, 2, 3]); });
	assert.deepEqual(paths, ['icons/font.woff2']);
	assert.equal(theme.icons.get('folding-expanded')?.fontCharacter, '\ue001');
	assert.equal(theme.fonts?.length, 1);
});

test('product themes reject SVG paths before reading any artwork', async () => {
	for (const iconPath of ['./icons/icon.svg', '../outside.svg', 'https://example.test/icon.svg']) {
		await assert.rejects(ProductIconThemeData.load('invalid-icons', 'Invalid', {
			iconDefinitions: { add: { iconPath } },
		}, async () => { throw new Error('SVG resources must not be read'); }), /prepared font glyph/);
	}
});
