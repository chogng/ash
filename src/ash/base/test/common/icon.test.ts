import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { Icon } from '../../common/icon.js';
import { Lxicon, getAllLxicons } from '../../common/lxicons.js';
import { getLxiconDefinition } from '../../common/lxiconsUtil.js';

test('icon references retain their ID', () => {
	assert.deepEqual(Icon.fromId('search'), { id: 'search' });
});

test('all built-in Lxicons are native font glyphs with stable identities', () => {
	const icons = getAllLxicons();
	assert.deepEqual(icons, Object.values(Lxicon));
	assert.equal(new Set(icons.map(icon => icon.id)).size, icons.length);
	for (const icon of icons) {
		const definition = getLxiconDefinition(icon.id)!;
		assert.ok(Object.keys(definition).every(key => key === 'fontCharacter' || key === 'layers'));
		for (const layer of definition.layers ?? []) assert.equal([...layer.fontCharacter].length, 1);
		assert.equal([...definition.fontCharacter].length, 1);
	}
	assert.deepEqual(getLxiconDefinition(Lxicon.add.id), { fontCharacter: '\ue001' });
	assert.notEqual(icons, getAllLxicons());
});
