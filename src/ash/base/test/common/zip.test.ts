import assert from 'node:assert/strict';
import { crc32 as nativeCrc32 } from 'node:zlib';
import { test } from 'mocha';
import { VSBuffer } from '../../common/buffer.js';
import { createZip, crc32 } from '../../common/zip.js';

test('ZIP checksums agree with the native implementation for Unicode and binary payloads', () => {
	for (const bytes of [new Uint8Array(), VSBuffer.fromString('中文🙂').buffer, Uint8Array.from({ length: 10000 }, (_, index) => index % 256)]) assert.equal(crc32(bytes), nativeCrc32(bytes));
});

test('ZIP creation is deterministic and supports an empty archive', () => {
	const empty = createZip([]);
	assert.equal(empty.byteLength, 22);
	assert.equal(new DataView(empty.buffer.buffer).getUint32(0, true), 0x06054b50);
	const files = [{ path: 'word/document.xml', contents: VSBuffer.fromString('中文🙂') }];
	assert.deepEqual(createZip(files).buffer, createZip(files).buffer);
});

test('ZIP creation rejects traversal, ambiguous destinations and invalid metadata', () => {
	const contents = VSBuffer.fromString('body');
	for (const path of ['', '/absolute', '../outside', 'a/../outside', 'a\\b', 'a:b', 'a\0b', 'a//b']) assert.throws(() => createZip([{ path, contents }]), /Invalid ZIP/u);
	assert.throws(() => createZip([{ path: 'A', contents }, { path: 'a', contents }]), /unique/u);
	assert.throws(() => createZip([{ path: '长'.repeat(0x8000), contents }]), /path is too long/u);
});
