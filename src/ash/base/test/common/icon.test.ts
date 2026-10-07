import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { Icon } from '../../common/icon.js';
import { Lxicon, getAllLxicons } from '../../common/lxicons.js';
import { getLxiconDefinition } from '../../common/lxiconsUtil.js';

test('icon references retain their ID', () => {
	assert.deepEqual(Icon.fromId('search'), { id: 'search' });
});

test('Lxicon lists repository-owned SVG definitions', () => {
	assert.deepEqual(getAllLxicons(), Object.values(Lxicon));
	for (const icon of getAllLxicons()) {
		const markup = getLxiconDefinition(icon.id)?.();
		assert.match(markup ?? '', /^<svg\b[^>]*>/);
		assert.match(markup ?? '', /<\/svg>$/);
	}
});
