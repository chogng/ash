import assert from 'node:assert/strict';
import test from 'node:test';
import { inputEdit, sourceOffset } from '../../extensions/markdown-language-features/src/sourceEdits.js';
import { readParseResponse } from '../../extensions/markdown-language-features/src/parseResponse.js';

test('a parse provider cannot inject executable elements or ranges for another document version', () => {
	const snapshot = { uri: 'file:///synthetic.md', version: 4, text: '中文😀' };
	const result = { protocol_version: 1, uri: snapshot.uri, version: 4, blocks: [{ start: 0, end: 4, content: { kind: 'text', value: snapshot.text } }] };
	assert.deepEqual(readParseResponse(result, snapshot), result.blocks);
	assert.throws(() => readParseResponse({ ...result, version: 3 }, snapshot));
	assert.throws(() => readParseResponse({ ...result, uri: 'file:///other.md' }, snapshot));
	assert.throws(() => readParseResponse({ ...result, blocks: [{ start: 0, end: 4, content: { kind: 'element', tag: 'script', children: [] } }] }, snapshot));
	assert.throws(() => readParseResponse({ ...result, blocks: [{ start: 0, end: 2, content: result.blocks[0]!.content }] }, snapshot));
});

function apply(source: string, input: string): string {
	const edit = inputEdit(source, input);
	return source.slice(0, edit.start) + edit.text + source.slice(edit.end);
}

test('unchanged textarea content preserves mixed line endings, BOM, escapes and reference syntax', () => {
	const source = '\uFEFF# 标题\r\n中文😀  \r\n[id]: <https://example.com> "title"\n\\*literal\\*\r';
	assert.equal(apply(source, source.replace(/\r\n?/gu, '\n')), source);
});

test('a Chinese input commit changes only its source range and retains CRLF', () => {
	const source = '中文段落 **原样**\r\n换行。\r\n';
	assert.equal(apply(source, '中文输入😀段落 **原样**\n换行。\n'), '中文输入😀段落 **原样**\r\n换行。\r\n');
	assert.equal(sourceOffset('a\r\n中😀', 3), 4);
});

test('emoji replacement does not split surrogate pairs or alter surrounding Markdown', () => {
	const source = '**😀**\r\n[id]: https://example.com\r\n';
	assert.equal(apply(source, '**😁**\n[id]: https://example.com\n'), '**😁**\r\n[id]: https://example.com\r\n');
	const edit = inputEdit('😀', '😁');
	assert.deepEqual(edit, { start: 0, end: 2, text: '😁' });
});
