import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ThemeColor, themeColorFromId, ThemeIcon } from '../../common/themables.js';

test('ThemeIcon parses, modifies, compares, and emits stable classes', () => {
	const color = themeColorFromId('editor.foreground');
	const icon = { id: 'symbol-method~spin', color };
	assert.equal(ThemeColor.isThemeColor(color), true);
	assert.equal(ThemeIcon.isThemeIcon(icon), true);
	assert.deepEqual(ThemeIcon.fromString('$(symbol-method~spin)'), { id: 'symbol-method~spin' });
	assert.equal(ThemeIcon.getModifier(icon), 'spin');
	assert.deepEqual(ThemeIcon.modify(icon, 'disabled'), { id: 'symbol-method~disabled', color });
	assert.equal(ThemeIcon.isEqual(icon, { id: 'symbol-method~spin', color: { id: 'editor.foreground' } }), true);
	assert.deepEqual(ThemeIcon.asClassNameArray(icon), ['ash-icon', 'ash-icon-symbol-method', 'ash-icon-modifier-spin']);
	assert.equal(ThemeIcon.asCSSSelector(icon), '.ash-icon.ash-icon-symbol-method.ash-icon-modifier-spin');
});
