import assert from 'node:assert/strict';
import { test } from 'mocha';
import { VSBuffer } from '../../common/buffer.js';
import { createZip } from '../../common/zip.js';
import { unzipFiles } from '../../browser/zip.js';

test('browser ZIP extraction reads the common writer without losing Unicode, empty files or binary bytes', async () => {
	const files = [
		{ path: '资料/中文.txt', contents: VSBuffer.fromString('内容🙂') },
		{ path: 'empty', contents: VSBuffer.alloc(0) },
		{ path: 'binary', contents: VSBuffer.wrap(new Uint8Array([0, 127, 255])) },
	];
	const result = await unzipFiles(createZip(files).buffer, new AbortController().signal);
	assert.deepEqual([...result.keys()], files.map(file => file.path));
	for (const file of files) assert.deepEqual(result.get(file.path), file.contents.buffer);
});

test('browser ZIP extraction rejects damaged payloads and cancellation', async () => {
	const archive = createZip([{ path: 'a', contents: VSBuffer.fromString('body') }]).buffer;
	archive[31] ^= 1;
	await assert.rejects(unzipFiles(archive, new AbortController().signal), /checksum/u);
	const controller = new AbortController(); controller.abort();
	await assert.rejects(unzipFiles(createZip([{ path: 'b', contents: VSBuffer.fromString('body') }]).buffer, controller.signal), { name: 'AbortError' });
});
