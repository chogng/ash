import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DocsCommentState, readDocsCommentEvent, writeDocsCommentEvent, type DocsCommentEvent } from '../../../../../workbench/contrib/markdown/common/arkdownComments.js';

const base = { version: 1 as const, id: '11111111-1111-4111-8111-111111111111', threadId: '22222222-2222-4222-8222-222222222222', clock: 1 };
const message = { id: '33333333-3333-4333-8333-333333333333', authorId: '44444444-4444-4444-8444-444444444444', body: '中文🙂\n<script>plain text</script>\n```', createdAt: 1234 };

test('comment records round trip each operation with Unicode, fences and CRLF', () => {
	const values: DocsCommentEvent[] = [
		{ ...base, op: 'create', message, quote: 'Selected text' }, { ...base, op: 'reply', message },
		{ ...base, op: 'edit', messageId: message.id, body: 'Edited', editedAt: 1235 },
		{ ...base, op: 'state', state: DocsCommentState.Resolved }, { ...base, op: 'delete_message', messageId: message.id }, { ...base, op: 'delete_thread' },
	];
	for (const value of values) {
		const source = writeDocsCommentEvent(value);
		assert.deepEqual(readDocsCommentEvent(source), value);
		assert.deepEqual(readDocsCommentEvent(source.replaceAll('\n', '\r\n')), value);
	}
});

test('comment persistence rejects unknown schemas, identifiers, operations, sizes and timestamps', () => {
	const create = { ...base, op: 'create', message };
	const invalid = [null, [], {}, { ...create, version: 2 }, { ...create, id: 'bad" onclick="bad()' }, { ...create, threadId: null },
		{ ...create, clock: 0 }, { ...create, clock: 0.5 }, { ...create, clock: Number.MAX_SAFE_INTEGER }, { ...create, op: 'unknown' },
		{ ...create, message: { ...message, body: ' ' } }, { ...create, message: { ...message, body: 'x'.repeat(8001) } },
		{ ...create, message: { ...message, createdAt: -1 } }, { ...create, message: { ...message, authorId: 'unknown' } },
		{ ...create, quote: 'x'.repeat(1001) }, { ...base, op: 'state', state: 'other' }];
	for (const value of invalid) assert.equal(readDocsCommentEvent('```ash-comments\n' + JSON.stringify(value) + '\n```'), undefined);
	assert.equal(readDocsCommentEvent('```ash-comments\n{broken}\n```'), undefined);
	assert.equal(readDocsCommentEvent('```json\n' + JSON.stringify(create) + '\n```'), undefined);
	assert.throws(() => writeDocsCommentEvent({ ...base, op: 'reply', message: { ...message, body: '' } }));
});
