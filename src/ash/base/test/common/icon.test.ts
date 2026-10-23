import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { Icon } from '../../common/icon.js';
import { Lxicon, getAllLxicons } from '../../common/lxicons.js';
import { getLxiconDefinition } from '../../common/lxiconsUtil.js';

test('icon references retain their ID', () => {
	assert.deepEqual(Icon.fromId('search'), { id: 'search' });
});

test('Lxicon lists repository-owned font definitions with source artwork', () => {
	const icons = getAllLxicons();
	assert.deepEqual(icons, Object.values(Lxicon));
	assert.equal(new Set(icons.map(icon => icon.id)).size, icons.length);
	for (const icon of icons) {
		const definition = getLxiconDefinition(icon.id)!;
		const markup = typeof definition === 'function' ? definition() : definition.fallback?.();
		assert.match(markup ?? '', /^<svg\b[^>]*>/);
		assert.match(markup ?? '', /<\/svg>$/);
	}
	assert.notEqual(icons, getAllLxicons());
});
