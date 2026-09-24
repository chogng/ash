import assert from 'node:assert/strict';
import { test } from 'mocha';
import { escapeMarkdownSyntaxTokens, isMarkdownString, MarkdownString } from '../../common/htmlContent.js';
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
	const lifted = MarkdownString.lift({ value: 'content', isTrusted: { enabledCommands: ['open'] }, supportHtml: true, baseUri });
	assert.equal(lifted.baseUri, baseUri);
	assert.equal(lifted.supportHtml, true);
	assert.deepEqual(lifted.isTrusted, { enabledCommands: ['open'] });
});
