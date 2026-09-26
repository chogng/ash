import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { DiskFileSystemProviderClient, LOCAL_FILE_SYSTEM_CHANNEL_NAME } from '../../common/diskFileSystemProviderClient.js';
import { FileNotFoundError, FileRevisionConflictError } from '../../common/files.js';
import { diskFileSystemProviderRoutes } from '../../electron-main/diskFileSystemProviderServer.js';
import { DiskFileSystemProvider } from '../../node/diskFileSystemProvider.js';

test('desktop file transport preserves resources, revisions, and root boundaries', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-local-files-'));
	using provider = new DiskFileSystemProvider([URI.file(directory)]);
	const route = diskFileSystemProviderRoutes(provider, URI.file(directory)).find(route => route.channel === LOCAL_FILE_SYSTEM_CHANNEL_NAME)!;
	using client = new DiskFileSystemProviderClient(async request => structuredClone(await route.invoke(route.validate(structuredClone(request)))), () => ({ dispose() {} }));
	try {
		const resource = URI.file(join(directory, 'test.json'));
		await client.createFile(resource, 'error');
		const empty = await client.readFile(resource);
		await client.writeFile({ resource, content: '{"test":true}', expectedRevision: empty.revision });
		const loaded = await client.readFile(resource);
		assert.equal(loaded.resource.toString(), resource.toString());
		assert.equal(loaded.content, '{"test":true}');
		await assert.rejects(client.writeFile({ resource, content: 'stale', expectedRevision: empty.revision }), FileRevisionConflictError);
		await assert.rejects(client.readFile(URI.file(join(directory, '..', 'outside.json'))), /outside the granted roots/);
		await assert.rejects(client.readFile(URI.file(join(directory, 'missing.json'))), FileNotFoundError);
		assert.equal((await client.readDirectory(URI.file(directory)))[0]?.resource.toString(), resource.toString());
		const target = URI.file(join(directory, 'target.json'));
		await writeFile(target.fsPath, 'keep');
		await assert.rejects(client.rename(resource, target, 'error'));
		assert.equal(await readFile(target.fsPath, 'utf8'), 'keep');
		await client.delete(target, 'error', 'fileOrEmptyDirectory');
		await client.rename(resource, target, 'error');
		assert.equal((await client.readFile(target)).content, loaded.content);
		await client.delete(target, 'error', 'fileOrEmptyDirectory');
		assert.deepEqual(await client.readDirectory(URI.file(directory)), []);
		assert.throws(() => route.validate({ operation: 'execute', resource: resource.toString() }), /Invalid file operation/);
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
