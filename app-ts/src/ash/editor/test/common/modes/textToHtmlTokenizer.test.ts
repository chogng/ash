import assert from 'node:assert/strict';
import { test } from 'mocha';
import { FontStyle, LanguageId, MetadataConsts } from '../../../common/encodedTokenAttributes.js';
import { tokenizeLineToHTML } from '../../../common/languages/textToHtmlTokenizer.js';
import { LineTokens } from '../../../common/tokens/lineTokens.js';

const codec = { encodeLanguageId: () => LanguageId.PlainText, decodeLanguageId: () => 'plaintext' };

test('HTML token fragments clip across token boundaries without changing UTF-16 text or tabs', () => {
	const tokens = LineTokens.createFromTextAndMetadata([
		{ text: '<tag>', metadata: (3 << MetadataConsts.FOREGROUND_OFFSET) | (FontStyle.Bold << MetadataConsts.FONT_STYLE_OFFSET) },
		{ text: '😀\t&"\'', metadata: (4 << MetadataConsts.FOREGROUND_OFFSET) | (FontStyle.Underline << MetadataConsts.FONT_STYLE_OFFSET) },
	], codec);
	const colors = ['', '', '', '#123456', '#654321'];
	assert.equal(tokenizeLineToHTML(tokens.getLineContent(), tokens, colors, 2, 9, 4, false),
		'<span style="color: #123456;font-weight: bold;">ag&gt;</span><span style="color: #654321;text-decoration: underline;">😀\t&amp;</span>');
	assert.equal(tokenizeLineToHTML(tokens.getLineContent(), tokens, colors, 3, 3, 4, false), '');
});

test('HTML token fragments keep font styles when the color map has no matching entry', () => {
	const tokens = LineTokens.createFromTextAndMetadata([{
		text: 'value',
		metadata: (5 << MetadataConsts.FOREGROUND_OFFSET) | ((FontStyle.Bold | FontStyle.Italic | FontStyle.Underline | FontStyle.Strikethrough) << MetadataConsts.FONT_STYLE_OFFSET),
	}], codec);
	assert.equal(tokenizeLineToHTML('value', tokens, [], 0, 5, 4, false),
		'<span style="font-style: italic;font-weight: bold;text-decoration: underline line-through;">value</span>');
});

test('HTML token fragments escape content and style attributes', () => {
	const text = '<img src=x> & "\'';
	const tokens = LineTokens.createFromTextAndMetadata([{ text, metadata: 1 << MetadataConsts.FOREGROUND_OFFSET }], codec);
	assert.equal(tokenizeLineToHTML(text, tokens, ['', '" onmouseover="bad'], 0, text.length, 4, false),
		'<span style="color: &quot; onmouseover=&quot;bad;">&lt;img src=x&gt; &amp; &quot;&#39;</span>');
	assert.equal(tokenizeLineToHTML(text, tokens, [], 0, text.length, 4, false), '&lt;img src=x&gt; &amp; &quot;&#39;');
});

test('Nonbreaking whitespace accounts for the unselected prefix and token boundaries', () => {
	const tokens = LineTokens.createFromTextAndMetadata([{ text: '  \t', metadata: 0 }, { text: ' x', metadata: 0 }], codec);
	assert.equal(tokenizeLineToHTML('  \t x', tokens, [], 2, 5, 4, true), '\u00a0\u00a0\u00a0x');
	assert.equal(tokenizeLineToHTML('  \t x', tokens, [], 2, 5, 4, false), '\t x');
});
