import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Color } from '../../../../../base/common/color.js';
import { FontStyle, type LanguageId, TokenMetadata } from '../../../../common/encodedTokenAttributes.js';
import { TokenTheme } from '../../../../common/languages/supports/tokenization.js';

test('token rules inherit properties by scope and preserve segment boundaries', () => {
	const theme = TokenTheme.createFromRawTokenTheme([
		{ token: '', foreground: '101010', background: 'fafafa' },
		{ token: 'entity.member', fontStyle: '', background: 'dadada' },
		{ token: 'entity', foreground: '123456', fontStyle: 'bold italic' },
		{ token: 'entity.member', foreground: '654321' },
	], []);
	const colors = theme.getColorMap();
	const member = theme.match(17 as LanguageId, 'entity.member.function');
	assert.equal(TokenMetadata.getLanguageId(member), 17);
	assert.equal(TokenMetadata.getFontStyle(member), FontStyle.None);
	assert.equal(Color.Format.CSS.formatHex(colors[TokenMetadata.getForeground(member)]!), '#654321');
	assert.equal(Color.Format.CSS.formatHex(colors[TokenMetadata.getBackground(member)]!), '#dadada');
	const inherited = theme.match(18 as LanguageId, 'entity.local');
	assert.equal(TokenMetadata.getFontStyle(inherited), FontStyle.Bold | FontStyle.Italic);
	assert.equal(Color.Format.CSS.formatHex(colors[TokenMetadata.getForeground(inherited)]!), '#123456');
	const unrelated = theme.match(18 as LanguageId, 'entityName');
	assert.equal(Color.Format.CSS.formatHex(colors[TokenMetadata.getForeground(unrelated)]!), '#101010');
	assert.equal(TokenMetadata.getLanguageId(theme.match(23 as LanguageId, 'entity.member.function')), 23);
});

test('token colors retain seeded indices and compilation owns its rule values', () => {
	const rule = { token: 'constant', foreground: 'abcdef', fontStyle: 'underline strikethrough' };
	const theme = TokenTheme.createFromRawTokenTheme([rule], ['112233', 'abcdef']);
	rule.foreground = 'ffffff';
	const token = theme.match(2 as LanguageId, 'constant');
	assert.equal(TokenMetadata.getForeground(token), 2);
	assert.equal(TokenMetadata.getFontStyle(token), FontStyle.Underline | FontStyle.Strikethrough);
	const colors = theme.getColorMap();
	colors.splice(0);
	assert.equal(Color.Format.CSS.formatHex(theme.getColorMap()[2]!), '#abcdef');
	assert.throws(() => TokenTheme.createFromRawTokenTheme([{ token: '', foreground: 'invalid' }], []), /Invalid token color/);
});
