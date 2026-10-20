import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { Icon } from '../../common/icon.js';
import { Lxicon, getAllLxicons } from '../../common/lxicons.js';
import { getLxiconDefinition } from '../../common/lxiconsUtil.js';

test('icon references retain their ID', () => {
	assert.deepEqual(Icon.fromId('search'), { id: 'search' });
});

test('Lxicon lists repository-owned SVG definitions', () => {
	const icons = getAllLxicons();
	assert.deepEqual(icons, Object.values(Lxicon));
	assert.equal(new Set(icons.map(icon => icon.id)).size, icons.length);
	for (const icon of icons) {
		const markup = getLxiconDefinition(icon.id)?.();
		assert.match(markup ?? '', /^<svg\b[^>]*>/);
		assert.match(markup ?? '', /<\/svg>$/);
	}
	assert.notEqual(icons, getAllLxicons());
});
