import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** The signed package carries the native library compressed; never download executable code. */
export function prepareNativeCanvas(): () => void {
	const metadata = JSON.parse(readFileSync(new URL('./native.json', import.meta.url), 'utf8')) as {
		bytes: number;
		sha256: string;
	};
	if (
		!Number.isSafeInteger(metadata.bytes) ||
		metadata.bytes <= 0 ||
		metadata.bytes > 64 * 1024 * 1024 ||
		!/^[a-f0-9]{64}$/u.test(metadata.sha256)
	)
		throw new Error('Invalid packaged canvas metadata');
	const compressed = readFileSync(new URL('./canvas.node.gz', import.meta.url));
	if (compressed.length > 16 * 1024 * 1024) throw new Error('Packaged canvas exceeds its compressed budget');
	const bytes = gunzipSync(compressed, { maxOutputLength: metadata.bytes });
	if (bytes.length !== metadata.bytes || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256)
		throw new Error('Packaged canvas integrity check failed');
	const directory = mkdtempSync(join(tmpdir(), 'ash-pdf-canvas-'));
	const cleanup = (): void => rmSync(directory, { recursive: true, force: true });
	try {
		const path = join(directory, 'canvas.node');
		writeFileSync(path, bytes, { mode: 0o600 });
		// Canvas and PDF.js honor this upstream loader hook in every owned parser worker.
		process.env.NAPI_RS_NATIVE_LIBRARY_PATH = path;
		return cleanup;
	} catch (error) {
		cleanup();
		throw error;
	}
}
