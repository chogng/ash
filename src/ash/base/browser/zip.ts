import { crc32, isValidZipPath } from '../common/zip.js';

const decoder = new TextDecoder('utf-8', { fatal: true });
const limit = 64 * 1024 * 1024;

/** Bound decompression before allocating output; never follow ZIP paths on the filesystem. */
export async function unzipFiles(bytes: Uint8Array, signal: AbortSignal): Promise<Map<string, Uint8Array>> {
	if (bytes.length > limit || bytes.length < 22) throw new TypeError('Invalid ZIP size');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let end = bytes.length - 22;
	while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--;
	if (end < Math.max(0, bytes.length - 65557) || view.getUint32(end, true) !== 0x06054b50 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new TypeError('Invalid ZIP directory');
	const count = view.getUint16(end + 10, true), directorySize = view.getUint32(end + 12, true);
	let position = view.getUint32(end + 16, true), total = 0;
	if (count > 2000 || position + directorySize > end) throw new TypeError('Invalid ZIP directory bounds');
	const files = new Map<string, Uint8Array>(), names = new Set<string>();
	for (let index = 0; index < count; index++) {
		signal.throwIfAborted();
		if (position + 46 > end || view.getUint32(position, true) !== 0x02014b50) throw new TypeError('Invalid ZIP entry');
		const flags = view.getUint16(position + 8, true), method = view.getUint16(position + 10, true), checksum = view.getUint32(position + 16, true);
		const size = view.getUint32(position + 24, true), compressed = view.getUint32(position + 20, true), nameLength = view.getUint16(position + 28, true);
		const name = decoder.decode(bytes.subarray(position + 46, position + 46 + nameLength));
		const local = view.getUint32(position + 42, true);
		total += size;
		if (name.length >= 500 || !isValidZipPath(name.endsWith('/') ? name.slice(0, -1) : name) || names.has(name.toLowerCase()) || flags & 1 || ![0, 8].includes(method) || total > limit || local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new TypeError('Unsupported ZIP entry');
		names.add(name.toLowerCase());
		const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
		if (start + compressed > bytes.length) throw new TypeError('Truncated ZIP entry');
		const data = bytes.slice(start, start + compressed);
		let output = data;
		if (method === 8) {
			const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
			const chunks: Uint8Array[] = []; let length = 0;
			try { for (; ;) { signal.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length; if (length > size || length > limit) throw new RangeError('ZIP expansion exceeds declared size'); chunks.push(chunk.value); } }
			finally { await reader.cancel(); }
			output = new Uint8Array(length); let at = 0; for (const chunk of chunks) { output.set(chunk, at); at += chunk.length; }
		}
		if (output.length !== size || crc32(output) !== checksum) throw new TypeError('ZIP checksum mismatch');
		if (!name.endsWith('/')) files.set(name, output);
		else if (size) throw new TypeError('Invalid ZIP directory entry');
		position += 46 + nameLength + view.getUint16(position + 30, true) + view.getUint16(position + 32, true);
	}
	return files;
}
