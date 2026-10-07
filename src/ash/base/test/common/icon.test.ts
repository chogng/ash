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

test('derived Lxicons retain component IDs while reusing SVG artwork', () => {
	assert.deepEqual(Lxicon.dialogError, { id: 'dialog-error' });
	assert.equal(getLxiconDefinition(Lxicon.dialogError.id), getLxiconDefinition(Lxicon.error.id));
	assert.equal(getLxiconDefinition(Lxicon.menuSubmenu.id), getLxiconDefinition(Lxicon.chevronRight.id));
});

test('enumerating Lxicons returns an isolated list of unique identities', () => {
	const icons = getAllLxicons();
	assert.equal(new Set(icons.map(icon => icon.id)).size, icons.length);
	assert.notEqual(icons, getAllLxicons());
});
