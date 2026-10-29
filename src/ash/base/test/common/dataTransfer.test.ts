import assert from 'node:assert/strict';
import { test } from 'mocha';
import { createFileDataTransferItem, createStringDataTransferItem, matchesMimeType, UriList, VSDataTransfer } from '../../common/dataTransfer.js';
import { URI } from '../../common/uri.js';

test('VSDataTransfer stores MIME types case-insensitively and preserves item order', async () => {
	const transfer = new VSDataTransfer();
	transfer.append('Text/Plain', createStringDataTransferItem('first'));
	transfer.append('text/plain', createStringDataTransferItem(Promise.resolve('second')));

	assert.equal(transfer.size, 1);
	assert.equal(transfer.has('TEXT/PLAIN'), true);
	assert.equal(await transfer.get('text/plain')?.asString(), 'first');
	assert.deepEqual(await Promise.all([...transfer].map(([, item]) => item.asString())), ['first', 'second']);
});

test('VSDataTransfer replaces and deletes all items for a MIME type', async () => {
	const transfer = new VSDataTransfer();
	transfer.append('text/plain', createStringDataTransferItem('first'));
	transfer.append('text/plain', createStringDataTransferItem('second'));
	transfer.replace('TEXT/PLAIN', createStringDataTransferItem('replacement'));

	assert.deepEqual(await Promise.all([...transfer].map(([, item]) => item.asString())), ['replacement']);
	transfer.delete('Text/Plain');
	assert.deepEqual([...transfer], []);
});

test('VSDataTransfer matches exact, wildcard, and file data types', async () => {
	const transfer = new VSDataTransfer();
	const file = createFileDataTransferItem('sample.txt', URI.file('/sample.txt'), async () => new Uint8Array([1, 2, 3]));
	transfer.append('application/octet-stream', file);

	assert.deepEqual({
		exact: transfer.matches('APPLICATION/OCTET-STREAM'),
		wildcard: transfer.matches('application/*'),
		file: transfer.matches('files'),
		missing: transfer.matches('image/*'),
		bytes: [...await file.asFile()!.data()],
	}, { exact: true, wildcard: true, file: true, missing: false, bytes: [1, 2, 3] });
});

test('matchesMimeType and UriList preserve their wire semantics', () => {
	const first = URI.parse('file:///first.ts');
	assert.deepEqual({
		matches: matchesMimeType('text/*', ['TEXT/PLAIN']),
		list: UriList.create([first, first, 'file:///second.ts']),
		parsed: UriList.parse('file:///first.ts\r# comment\r\nfile:///second.ts'),
	}, {
		matches: true,
		list: 'file:///first.ts\r\nfile:///second.ts',
		parsed: ['file:///first.ts', 'file:///second.ts'],
	});
});
