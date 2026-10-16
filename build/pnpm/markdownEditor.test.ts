import assert from 'node:assert/strict';
import test from 'node:test';
import { inputEdit, sourceOffset, textEdit } from '../../extensions/markdown-language-features/src/sourceEdits.js';

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

test('range messages preserve exact mixed line endings and whole surrogate pairs', () => {
	const source = '# 😀\r\n\n[id]: x\r';
	const next = source.replace('😀', '😁');
	const edit = textEdit(source, next);
	assert.deepEqual(edit, { start: 2, end: 4, text: '😁' });
	assert.equal(source.slice(0, edit.start) + edit.text + source.slice(edit.end), next);
});
