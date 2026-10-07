import assert from 'node:assert/strict';
import { test } from 'mocha';
import { escapeMarkdownSyntaxTokens, isMarkdownString, MarkdownString, parseHrefAndDimensions } from '../../common/htmlContent.js';
import { URI } from '../../common/uri.js';

test('MarkdownString distinguishes escaped text from trusted markdown fragments', () => {
	const markdown = new MarkdownString('', { supportThemeIcons: true });
	markdown.appendText('a *literal* line\nnext').appendMarkdown('\n**strong**').appendCodeblock('ts', '```\ncode').appendLink('https://example.com/a_(b)', 'link]');
	assert.match(markdown.value, /\\\*literal\\\*/);
	assert.match(markdown.value, /\*\*strong\*\*/);
	assert.match(markdown.value, /````ts/);
	assert.match(markdown.value, /\[link\\\]\]/);
	assert.equal(isMarkdownString(markdown), true);
	assert.equal(isMarkdownString({ value: 1 }), false);
	assert.equal(escapeMarkdownSyntaxTokens('- item'), '\\- item');
});

test('MarkdownString lift preserves resource context and options', () => {
	const baseUri = URI.parse('https://example.com/docs/');
	const lifted = MarkdownString.lift({ value: 'content', isTrusted: { enabledCommands: ['open'] }, supportHtml: true, supportAlertSyntax: true, baseUri });
	assert.equal(lifted.baseUri, baseUri);
	assert.equal(lifted.supportHtml, true);
	assert.equal(lifted.supportAlertSyntax, true);
	assert.deepEqual(lifted.isTrusted, { enabledCommands: ['open'] });
});

test('MarkdownString validates trusted commands and rendering options', () => {
	assert.equal(isMarkdownString({ value: 'content', isTrusted: { enabledCommands: ['ash.open'] }, supportAlertSyntax: true }), true);
	assert.equal(isMarkdownString({ value: 'content', isTrusted: { enabledCommands: [1] } }), false);
	assert.equal(isMarkdownString({ value: 'content', supportAlertSyntax: 'yes' }), false);
});

test('Markdown image destinations separate numeric dimensions from the resource URI', () => {
	assert.deepEqual(parseHrefAndDimensions('https://example.com/a.png|height=200,width=100px'), {
		href: 'https://example.com/a.png',
		dimensions: ['width="100"', 'height="200"'],
	});
	assert.deepEqual(parseHrefAndDimensions('https://example.com/a.png|width="1" onerror="alert(1)'), {
		href: 'https://example.com/a.png',
		dimensions: [],
	});
});
