import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { DiskFileSystemProviderClient, LOCAL_FILE_SYSTEM_CHANNEL_NAME } from '../../common/diskFileSystemProviderClient.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IPCClient } from '../../../../base/parts/ipc/common/ipc.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { consumeStream, listenStream } from '../../../../base/common/stream.js';
import { FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../common/files.js';
import { FileKind, FileNotFoundError, FileRevisionConflictError } from '../../common/files.js';
import { DiskFileSystemProviderChannel } from '../../electron-main/diskFileSystemProviderServer.js';
import { DiskFileSystemProvider } from '../../node/diskFileSystemProvider.js';

test('desktop file transport preserves resources, revisions, and root boundaries', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-local-files-'));
	using provider = new DiskFileSystemProvider([URI.file(directory)]);
	using incoming = new Emitter<VSBuffer>();
	using outgoing = new Emitter<VSBuffer>();
	using server = new IPCClient({ onMessage: incoming.event, send: value => outgoing.fire(value) }, 'window:1');
	using peer = new IPCClient({ onMessage: outgoing.event, send: value => incoming.fire(value) }, 'window:1');
	using channel = new DiskFileSystemProviderChannel(provider, URI.file(directory));
	server.registerChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME, channel);
	using client = new DiskFileSystemProviderClient(peer.getChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME));
	try {
		const resource = URI.file(join(directory, 'test.json'));
		await client.createFile(resource, 'error');
		const empty = await client.readFile(resource);
		await client.writeFile(resource, new TextEncoder().encode('{"test":true}'), { create: true, overwrite: true, expectedRevision: empty.revision });
		const loaded = await client.readFile(resource);
		const streamed = await consumeStream(client.readFileStream(resource, { position: 1, length: 6 }, CancellationToken.None), chunks => Buffer.concat(chunks));
		assert.equal(streamed.toString(), '"test"');
		await assert.rejects(consumeStream(client.readFileStream(resource, { limits: { size: 0 } }, CancellationToken.None)),
			error => error instanceof Error && toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.FileTooLarge);
		assert.throws(() => channel.listen('window:1', 'readFileStream', { resource: resource.toString(), options: { length: 0.5 } }), /Invalid file read/);
		await assert.rejects(client.writeFile(resource, new Uint8Array(), { create: true, overwrite: false }), error => error instanceof Error && toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.FileExists);
		assert.equal(loaded.resource.toString(), resource.toString());
		assert.equal(new TextDecoder().decode(loaded.bytes), '{"test":true}');
		await assert.rejects(client.writeFile(resource, new TextEncoder().encode('stale'), { create: true, overwrite: true, expectedRevision: empty.revision }), FileRevisionConflictError);
		await assert.rejects(client.readFile(URI.file(join(directory, '..', 'outside.json'))), /outside the granted roots/);
		await assert.rejects(client.readFile(URI.file(join(directory, 'missing.json'))), FileNotFoundError);
		assert.equal(extUriBiasedIgnorePathCase.isEqual((await client.readDirectory(URI.file(directory)))[0]?.resource, resource), true);
		const folder = URI.file(join(directory, 'new-folder'));
		assert.equal((await client.createDirectory(folder)).kind, FileKind.Directory);
		const binary = URI.file(join(folder.fsPath, 'bytes.bin'));
		await writeFile(binary.fsPath, Buffer.from([0, 255, 1]));
		const copiedFolder = URI.file(join(directory, 'copied-folder'));
		await client.copy(folder, copiedFolder);
		assert.deepEqual(await readFile(join(copiedFolder.fsPath, 'bytes.bin')), Buffer.from([0, 255, 1]));
		await assert.rejects(client.copy(folder, copiedFolder), /already exists|target exists/i);
		await client.delete(copiedFolder, 'error', 'recursive');
		await client.delete(binary, 'error', 'fileOrEmptyDirectory');
		await client.delete(folder, 'error', 'fileOrEmptyDirectory');
		const target = URI.file(join(directory, 'target.json'));
		await writeFile(target.fsPath, 'keep');
		await assert.rejects(client.rename(resource, target, 'error'));
		assert.equal(await readFile(target.fsPath, 'utf8'), 'keep');
		await client.delete(target, 'error', 'fileOrEmptyDirectory');
		await client.rename(resource, target, 'error');
		assert.deepEqual((await client.readFile(target)).bytes, loaded.bytes);
		await client.delete(target, 'error', 'fileOrEmptyDirectory');
		assert.deepEqual(await client.readDirectory(URI.file(directory)), []);
		await assert.rejects(peer.getChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME).call('execute', { resource: resource.toString() }), /Invalid file operation/);
		await assert.rejects(peer.getChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME).call('writeFile', { resource: resource.toString(), bytes: 'broken', options: { create: true, overwrite: true } }), /Invalid file write/);
		await assert.rejects(peer.getChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME).call('rename', { resource: resource.toString(), target: URI.parse('https://example.test/file').toString(), existing: 'error' }), /local file resource/);
		assert.equal(await peer.getChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME).call('userDataHome'), URI.file(directory).toString());
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('desktop file provider rejects directory links outside the granted root', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-local-links-'));
	using provider = new DiskFileSystemProvider([URI.file(directory)]);
	try {
		await symlink(tmpdir(), join(directory, 'linked'), 'junction');
		await assert.rejects(provider.readDirectory(URI.file(join(directory, 'linked'))), /Symbolic links/);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('desktop stream cancellation and owner disposal close the server descriptor', async () => {
	for (const owner of ['consumer', 'channel', 'provider']) {
		const directory = await mkdtemp(join(tmpdir(), 'ash-local-stream-'));
		const closed = new DeferredPromise<void>();
		let reads = 0;
		let closes = 0;
		class TrackingProvider extends DiskFileSystemProvider {
			public override async read(fd: number, position: number, data: Uint8Array, offset: number, length: number): Promise<number> {
				reads++;
				return super.read(fd, position, data, offset, length);
			}
			public override async close(fd: number): Promise<void> {
				await super.close(fd);
				closes++;
				await closed.complete();
			}
		}
		using provider = new TrackingProvider([URI.file(directory)]);
		using incoming = new Emitter<VSBuffer>();
		using outgoing = new Emitter<VSBuffer>();
		using server = new IPCClient({ onMessage: incoming.event, send: value => outgoing.fire(value) }, 'window:1');
		using peer = new IPCClient({ onMessage: outgoing.event, send: value => incoming.fire(value) }, 'window:1');
		using channel = new DiskFileSystemProviderChannel(provider, URI.file(directory));
		server.registerChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME, channel);
		using client = new DiskFileSystemProviderClient(peer.getChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME));
		using cancellation = new CancellationTokenSource();
		try {
			const resource = URI.file(join(directory, 'large.bin'));
			await writeFile(resource.fsPath, Buffer.alloc(1024 * 1024));
			const failed = new DeferredPromise<Error>();
			listenStream(client.readFileStream(resource, {}, cancellation.token), {
				onData: () => {
					if (owner === 'provider') {
						provider.dispose();
					} else {
						if (owner === 'channel') { channel.dispose(); }
						cancellation.cancel();
					}
				},
				onError: error => { void failed.complete(error); },
				onEnd: () => { void failed.error(new Error('Cancelled stream unexpectedly completed')); },
			});
			assert.equal((await failed.p).name, 'CancellationError');
			await closed.p;
			assert.equal(reads, 1);
			assert.equal(closes, 1);
		} finally { await rm(directory, { recursive: true, force: true }); }
	}
});

test('desktop providers serialize competing saves and recover after a rejected revision', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-local-save-'));
	using first = new DiskFileSystemProvider([URI.file(directory)]);
	using second = new DiskFileSystemProvider([URI.file(directory)]);
	try {
		const resource = URI.file(join(directory, 'shared.json'));
		await writeFile(resource.fsPath, 'before');
		const initial = await first.readFile(resource);
		const results = await Promise.allSettled([
			first.writeFile(resource, new TextEncoder().encode('first'), { create: true, overwrite: true, expectedRevision: initial.revision }),
			second.writeFile(resource, new TextEncoder().encode('second'), { create: true, overwrite: true, expectedRevision: initial.revision }),
		]);
		assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
		const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
		assert.equal(rejected.reason instanceof FileRevisionConflictError, true);
		const latest = await first.readFile(resource);
		await second.writeFile(resource, new TextEncoder().encode('recovered'), { create: true, overwrite: true, expectedRevision: latest.revision });
		assert.equal(await readFile(resource.fsPath, 'utf8'), 'recovered');
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('desktop file events retain exact resources and reject malformed transport data', () => {
	const listeners = new Set<(value: unknown) => void>();
	const changes: Event<unknown> = listener => {
		listeners.add(listener);
		return toDisposable(() => listeners.delete(listener));
	};
	const notify = (value: unknown): void => { for (const listener of listeners) listener(value); };
	using client = new DiskFileSystemProviderClient({ call: async <T>() => undefined as T, listen: <T>() => changes as Event<T> });
	const observed: Array<readonly string[] | undefined> = [];
	using subscription = client.onDidChangeFiles(event => observed.push(event.resources?.map(resource => resource.toString())));
	const resource = URI.file('/profile/keybindings.json');
	notify([resource.toString()]);
	notify(undefined);
	assert.deepEqual(observed, [[resource.toString()], undefined]);
	assert.throws(() => notify([42]), /Invalid file-change/u);
	assert.throws(() => notify(['https://example.test/file']), /Invalid file-change/u);
	client.dispose();
	assert.equal(listeners.size, 0);
});
