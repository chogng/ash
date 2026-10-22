const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const limit = 64 * 1024 * 1024;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
	for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	return value >>> 0;
});
function crc(bytes: Uint8Array): number {
	let value = 0xffffffff;
	for (const byte of bytes) value = crcTable[(value ^ byte) & 255]! ^ (value >>> 8);
	return (value ^ 0xffffffff) >>> 0;
}
function nameValid(name: string): boolean { return !!name && name.length < 500 && !name.startsWith('/') && !name.includes('\\') && !name.includes(':') && !name.split('/').some(part => !part || part === '.' || part === '..'); }
export function zipFiles(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
	let offset = 0;
	const local: Uint8Array[] = [], central: Uint8Array[] = [];
	for (const [name, bytes] of files) {
		if (!nameValid(name) || bytes.length > limit || files.size > 2000) throw new TypeError('Invalid ZIP part');
		const encoded = encoder.encode(name), checksum = crc(bytes);
		const header = new Uint8Array(30 + encoded.length), view = new DataView(header.buffer);
		view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true);
		view.setUint32(14, checksum, true); view.setUint32(18, bytes.length, true); view.setUint32(22, bytes.length, true); view.setUint16(26, encoded.length, true); header.set(encoded, 30);
		local.push(header, bytes);
		const directory = new Uint8Array(46 + encoded.length), info = new DataView(directory.buffer);
		info.setUint32(0, 0x02014b50, true); info.setUint16(4, 20, true); info.setUint16(6, 20, true); info.setUint16(8, 0x800, true);
		info.setUint32(16, checksum, true); info.setUint32(20, bytes.length, true); info.setUint32(24, bytes.length, true); info.setUint16(28, encoded.length, true); info.setUint32(42, offset, true); directory.set(encoded, 46);
		central.push(directory); offset += header.length + bytes.length;
	}
	const centralLength = central.reduce((sum, bytes) => sum + bytes.length, 0);
	if (offset + centralLength > limit) throw new RangeError('ZIP exceeds 64 MiB');
	const end = new Uint8Array(22), view = new DataView(end.buffer);
	view.setUint32(0, 0x06054b50, true); view.setUint16(8, files.size, true); view.setUint16(10, files.size, true); view.setUint32(12, centralLength, true); view.setUint32(16, offset, true);
	const output = new Uint8Array(offset + centralLength + 22);
	let position = 0;
	for (const bytes of [...local, ...central, end]) { output.set(bytes, position); position += bytes.length; }
	return output;
}

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
		if (!nameValid(name.endsWith('/') ? name.slice(0, -1) : name) || names.has(name.toLowerCase()) || flags & 1 || ![0, 8].includes(method) || total > limit || local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new TypeError('Unsupported ZIP entry');
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
		if (output.length !== size || crc(output) !== checksum) throw new TypeError('ZIP checksum mismatch');
		if (!name.endsWith('/')) files.set(name, output);
		else if (size) throw new TypeError('Invalid ZIP directory entry');
		position += 46 + nameLength + view.getUint16(position + 30, true) + view.getUint16(position + 32, true);
	}
	return files;
}
