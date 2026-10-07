import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import type { ApplicationChecksums } from '../../common/checksumService.js';
import { ChecksumService, checksumChannel } from '../../node/checksumService.js';

const entrypoints = ['dist/main/src/main.js', 'dist/preload/src/ash/base/parts/sandbox/electron-browser/preload.cjs', 'dist/renderer/ash/electron-browser/workbench/workbench.html'];

test('application checksums compare published files and detect modified and removed files', async () => {
	const root = await mkdtemp(join(tmpdir(), 'ash-checksum-'));
	try {
		const checksums: Record<string, string> = {};
		for (const file of entrypoints) {
			await mkdir(dirname(join(root, file)), { recursive: true });
			await writeFile(join(root, file), file);
			checksums[file] = createHash('sha256').update(file).digest('hex');
		}
		await writeFile(join(root, 'package.json'), JSON.stringify({ checksums }));
		const service = new ChecksumService();
		const channel = checksumChannel(root, true, service);
		const original = await channel.call<ApplicationChecksums>('window:1', 'getApplicationChecksums');
		assert.deepEqual(original.proof.map(pair => pair.actual === pair.expected), [true, true, true]);
		await writeFile(join(root, entrypoints[0]!), 'modified');
		await unlink(join(root, entrypoints[1]!));
		const modified = await checksumChannel(root, true, service).call<ApplicationChecksums>('window:2', 'getApplicationChecksums');
		assert.deepEqual(modified.proof.map(pair => pair.actual === pair.expected), [false, false, true]);
		assert.equal(modified.proof[1]!.actual, null);
		assert.deepEqual(await channel.call('window:3', 'getApplicationChecksums'), original, 'Windows share one startup scan');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('application checksum channel rejects renderer paths and malformed or incomplete persisted manifests', async () => {
	const root = await mkdtemp(join(tmpdir(), 'ash-checksum-'));
	try {
		let accessed = false;
		const service = { _serviceBrand: undefined, checksum: async () => { accessed = true; return '0'.repeat(64); } };
		const channel = checksumChannel(root, true, service);
		await assert.rejects(channel.call('window:1', 'checksum', '/private/file'), /Invalid application checksum read/);
		await assert.rejects(channel.call('window:1', 'getApplicationChecksums', { root: '/' }), /Invalid application checksum read/);
		assert.throws(() => channel.listen('window:1', 'changed'), /no subscription/);
		for (const checksums of [{}, { ...Object.fromEntries(entrypoints.map(file => [file, '0'.repeat(64)])), 'dist/../../private/file': '0'.repeat(64) }]) {
			await writeFile(join(root, 'package.json'), JSON.stringify({ checksums }));
			await assert.rejects(checksumChannel(root, true, service).call('window:1', 'getApplicationChecksums'), /checksum/);
		}
		assert.equal(accessed, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('development checksum reads explicitly omit an installation scan', async () => {
	const result = await checksumChannel('/no-published-installation', false, new ChecksumService()).call('window:1', 'getApplicationChecksums');
	assert.deepEqual(result, { isBuilt: false, proof: [] });
});

test('checksum service hashes actual bytes and rejects non-file resources', async () => {
	const root = await mkdtemp(join(tmpdir(), 'ash-checksum-'));
	try {
		const file = join(root, 'binary');
		await writeFile(file, Buffer.from([0, 255, 128, 1]));
		const service = new ChecksumService();
		assert.equal(await service.checksum(URI.file(file)), createHash('sha256').update(await readFile(file)).digest('hex'));
		await assert.rejects(service.checksum(URI.parse('https://example.com/file')), /local file/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
