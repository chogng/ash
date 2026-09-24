import assert from 'node:assert/strict';
import { test } from 'mocha';
import { decodeBase64, encodeHex, VSBuffer } from '../../common/buffer.js';

test('VSBuffer converts strings and concatenates buffers', () => {
	const first = VSBuffer.fromString('Ash ');
	const second = VSBuffer.fromString('文');
	const result = VSBuffer.concat([first, second]);

	assert.equal(result.byteLength, first.byteLength + second.byteLength);
	assert.equal(result.toString(), 'Ash 文');
});

test('decodeBase64 accepts standard and URL-safe unpadded input', () => {
	assert.deepEqual(decodeBase64('AP+A').buffer, new Uint8Array([0, 255, 128]));
	assert.deepEqual(decodeBase64('AP-A').buffer, new Uint8Array([0, 255, 128]));
});

test('encodeHex emits two lowercase digits per byte', () => {
	assert.equal(encodeHex(VSBuffer.wrap(new Uint8Array([0, 15, 16, 255]))), '000f10ff');
});
