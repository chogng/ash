import { VSBuffer } from './buffer.js';

const maxArchiveBytes = 64 * 1024 * 1024;
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	return value >>> 0;
});

/** ZIP's checksum is shared by stored-file creation and browser extraction. */
export function crc32(bytes: Uint8Array): number {
	let value = 0xffffffff;
	for (const byte of bytes) value = crcTable[(value ^ byte) & 255]! ^ (value >>> 8);
	return (value ^ 0xffffffff) >>> 0;
}

/** Package paths are relative and cannot escape their archive root. */
export function isValidZipPath(path: string): boolean {
	return !!path && !path.startsWith('/') && !/[\\:\0]/u.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..');
}

/** Create a bounded, uncompressed ZIP in memory. Browser APIs and ZIP64 are not required. */
export function createZip(files: readonly { readonly path: string; readonly contents: VSBuffer; }[]): VSBuffer {
	if (files.length >= 0xffff) throw new RangeError('Too many ZIP entries');
	const names = new Set<string>();
	let payloadLength = 0, directoryLength = 0;
	const entries = files.map(file => {
		if (!isValidZipPath(file.path)) throw new TypeError('Invalid ZIP part path');
		if (names.has(file.path.toLowerCase())) throw new TypeError('ZIP paths must be unique');
		names.add(file.path.toLowerCase());
		const name = encoder.encode(file.path);
		if (name.length > 0xffff) throw new RangeError('ZIP part path is too long');
		payloadLength += 30 + name.length + file.contents.byteLength;
		directoryLength += 46 + name.length;
		if (payloadLength + directoryLength + 22 > maxArchiveBytes) throw new RangeError('ZIP exceeds 64 MiB');
		return { name, bytes: file.contents.buffer };
	});
	const result = VSBuffer.alloc(payloadLength + directoryLength + 22);
	const view = new DataView(result.buffer.buffer);
	let offset = 0, directory = payloadLength;
	for (const { name, bytes } of entries) {
		const checksum = crc32(bytes);
		// Stored entries have no descriptor: the local and central headers both
		// contain final sizes. A fixed DOS date keeps repeated exports deterministic.
		view.setUint32(offset, 0x04034b50, true);
		view.setUint16(offset + 4, 20, true);
		view.setUint16(offset + 6, 0x800, true);
		view.setUint16(offset + 12, 0x21, true);
		view.setUint32(offset + 14, checksum, true);
		view.setUint32(offset + 18, bytes.length, true);
		view.setUint32(offset + 22, bytes.length, true);
		view.setUint16(offset + 26, name.length, true);
		result.buffer.set(name, offset + 30);
		result.buffer.set(bytes, offset + 30 + name.length);

		view.setUint32(directory, 0x02014b50, true);
		view.setUint16(directory + 4, 20, true);
		view.setUint16(directory + 6, 20, true);
		view.setUint16(directory + 8, 0x800, true);
		view.setUint16(directory + 14, 0x21, true);
		view.setUint32(directory + 16, checksum, true);
		view.setUint32(directory + 20, bytes.length, true);
		view.setUint32(directory + 24, bytes.length, true);
		view.setUint16(directory + 28, name.length, true);
		view.setUint32(directory + 42, offset, true);
		result.buffer.set(name, directory + 46);
		offset += 30 + name.length + bytes.length;
		directory += 46 + name.length;
	}
	view.setUint32(directory, 0x06054b50, true);
	view.setUint16(directory + 8, entries.length, true);
	view.setUint16(directory + 10, entries.length, true);
	view.setUint32(directory + 12, directoryLength, true);
	view.setUint32(directory + 16, payloadLength, true);
	return result;
}
