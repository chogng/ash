import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setNlsMessages, resetNlsResolver } from '../../../../nls.js';
import type { IFileApi, IFileSystemDirectory } from '../../common/fileApi.js';
import { InMemoryFileSystemProvider } from '../../common/inMemoryFilesystemProvider.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { type IFileWriteOptions, type IWatchOptions, FileSystemProviderCapabilities } from '../../common/files.js';
import { FileService } from '../../../../platform/files/common/fileService.js';
import { FileOperationNotSupportedError, type IFileSystemProvider, type FileDeleteMode, type FileExistingTargetBehavior, type FileMissingTargetBehavior, type IFileBytes, type IFileChangeEvent, type IFileEntry, type IFileStat, type IFileWriteResult } from '../../../../platform/files/common/files.js';
import assert from "node:assert/strict";
import { suite, test } from "mocha";
import { Emitter, Event } from "../../../../base/common/event.js";
import { URI } from "../../../../base/common/uri.js";
import { AppServerRemoteError } from "../../../agentHost/common/appServerError.js";
import { createDisconnectedFileApi } from "../../../../platform/files/browser/fileApi.js";
import { AgentHostFileSystemProvider, type IRemoteFilesystemConnection } from "../../../agentHost/common/agentHostFileSystemProvider.js";
import { workspaceResourceFromPath } from "../../../workspace/common/workspace.js";
import { FileKind, FileNotFoundError, FileRevisionConflictError } from "../../../../platform/files/common/files.js";
import type { FsChanged } from "../../../../../../.build/protocol/typescript/index.js";
import { workspaceRelativePath, type IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { TestWorkspaceService } from "../../../../workbench/services/configuration/test/common/testServices.js";
import { createSshRemoteWorkspaceUri } from "../../../../platform/remote/common/remote.js";
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { WorkspaceWatcher } from '../../../../workbench/contrib/files/browser/workspaceWatcher.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { consumeStream } from '../../../../base/common/stream.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { CancellationError } from '../../../../base/common/errors.js';

test("disconnected file API declines system file paste without requiring App Server", async () => {
	const api = createDisconnectedFileApi(() => { throw new Error("App Server unavailable"); });
	assert.equal(await api.pasteSystemFiles({ dirId: "root", path: ".", moveRequested: false }), false);
});

test("AgentHostFileSystemProvider passes the paste destination and move request to App Server", async () => {
	using workspace = new TestWorkspaceService({ id: 'project', uri: URI.file('/project') });
	const requests: unknown[] = [];
	using service = new AgentHostFileSystemProvider({
		directories: () => workspace.getWorkspace().folders.map(folder => ({ uri: folder.uri, target: { type: 'environment', dirId: folder.id } })),
		resourceApi: unavailableResourceApi(),
		api: {
			...unavailableFileApi(),
			pasteSystemFiles: async params => { requests.push(params); return true; },
		},
	});
	assert.equal(await service.pasteSystemFiles(URI.file('/project/destination'), true), true);
	assert.deepEqual(requests, [{ dirId: 'project', path: 'destination', moveRequested: true }]);
});

test('workspace configuration access follows the current metadata file without authorizing sibling files', async () => {
	let configuration = URI.file('/metadata/first.ash-workspace');
	const bytes = new TextEncoder().encode('{"folders":[]}');
	using changes = new Emitter<void>();
	const reads: URI[] = [];
	const writes: URI[] = [];
	const stat = (resource: URI): IFileStat => ({ resource, kind: FileKind.File, sizeBytes: bytes.length, readonly: false, modifiedAtMillis: undefined });
	using provider = new AgentHostFileSystemProvider({
		api: unavailableFileApi(),
		resourceApi: unavailableResourceApi(),
		configuration: () => configuration,
		configurationFiles: {
			onDidChange: changes.event,
			read: async resource => { reads.push(resource); return { resource, bytes, revision: '1', stat: stat(resource) }; },
			write: async resource => { writes.push(resource); return { stat: stat(resource), revision: '2' }; },
		},
	});
	const changed: (readonly URI[] | undefined)[] = [];
	using listener = provider.onDidChangeFiles(event => changed.push(event.resources));
	await provider.resolvePathIdentity(configuration);
	assert.equal((await provider.readTextFile(configuration, 'utf8')).content, '{"folders":[]}');
	assert.equal((await provider.writeTextFile(configuration, '{}', 'utf8', { create: false, overwrite: true })).revision, '2');
	assert.deepEqual(reads, [configuration]);
	assert.deepEqual(writes, [configuration]);
	const previous = configuration;
	configuration = URI.file('/metadata/second.ash-workspace');
	changes.fire();
	assert.deepEqual(changed, [[configuration]]);
	assert.deepEqual(await provider.stat(configuration), stat(configuration));
	await assert.rejects(provider.readFile(previous), /no authorized directory/);
	await assert.rejects(provider.readFile(URI.file('/metadata/sibling.txt')), /no authorized directory/);
});

test("workspaceRelativePath confines resources to the folder", () => {
	const root = URI.parse("file:///C:/project");
	const releasedResources: string[] = [];
	assert.equal(workspaceRelativePath(root, URI.parse("file:///C:/project")), ".");
	assert.equal(
		workspaceRelativePath(root, URI.parse("file:///C:/project/src/main.ts")),
		"src/main.ts",
	);
	assert.throws(
		() => workspaceRelativePath(root, URI.parse("file:///C:/project-other/file.ts")),
		/outside/,
	);
});

test("workspaceRelativePath preserves case-sensitive Remote resource identity", () => {
	const root = createSshRemoteWorkspaceUri("work-server", "/home/ash/Project");
	assert.equal(workspaceRelativePath(root, root), ".");
	assert.equal(workspaceRelativePath(root, root.with({ path: '/home/ash/Project/src/main.ts' })), 'src/main.ts');
	assert.throws(() => workspaceRelativePath(root, root.with({ path: '/home/ash/project/src/main.ts' })), /outside/);
	assert.throws(() => workspaceRelativePath(root, createSshRemoteWorkspaceUri("other-server", "/home/ash/Project/src/main.ts")), /current workspace/);
});

test("workspace paths preserve backslashes as POSIX filename characters for Remote resources", () => {
	const root = createSshRemoteWorkspaceUri("work-server", "/home/ash/Project");
	const resource = root.with({ path: '/home/ash/Project/src\\generated/main.ts' });

	assert.equal(workspaceRelativePath(root, resource), "src\\generated/main.ts");
	assert.equal(workspaceResourceFromPath(root, "src\\generated/main.ts")?.toString(), resource.toString());
	assert.equal(workspaceResourceFromPath(URI.parse("file:///C:/project"), "src\\generated\\main.ts")?.toString(), "file:///C:/project/src/generated/main.ts");
});

test("workspaceResourceFromPath rejects invalid protocol path segments", () => {
	for (const root of [URI.parse("file:///C:/project"), createSshRemoteWorkspaceUri("work-server", "/home/ash/Project")]) {
		for (const path of ["", "/main.ts", "src/", "src//main.ts", "./main.ts", "../main.ts", "src/../main.ts"]) {
			assert.equal(workspaceResourceFromPath(root, path), undefined, path);
		}
	}
	assert.equal(workspaceResourceFromPath(URI.parse("file:///C:/project"), "src\\..\\main.ts"), undefined);
});

test('AppServer file operations and notifications preserve POSIX basenames on disk', async () => {
	const root = URI.parse('file:///work');
	const originalName = 'part\\name.txt';
	const renamedName = `renamed-${originalName}`;
	const source = root.joinPathSegment(originalName);
	const target = root.joinPathSegment(renamedName);
	using workspace = new TestWorkspaceService({ id: 'project', uri: root });
	using changes = new Emitter<FsChanged>();
	const requests: unknown[] = [];
	using provider = new AgentHostFileSystemProvider({
		directories: () => workspace.getWorkspace().folders.map(folder => ({ uri: folder.uri, target: { type: 'environment', dirId: folder.id } })),
		resourceApi: unavailableResourceApi(),
		onDidChange: changes.event,
		api: {
			...createDisconnectedFileApi(() => { throw new Error('Unexpected file operation'); }),
			createFile: async params => {
				requests.push(params);
				return { fileType: 'file', sizeBytes: 0, readonly: false, modifiedAtMillis: null };
			},
			rename: async params => { requests.push(params); },
			readDirectory: async () => ({ entries: [{ name: renamedName, fileType: 'file' }] }),
		},
	});
	const notifications: string[][] = [];
	using listener = provider.onDidChangeFiles(event => notifications.push(event.resources?.map(resource => resource.path) ?? []));
	await provider.createFile(source, 'error');
	await provider.rename(source, target, 'error');
	changes.fire({ type: 'pathsChanged', dirId: 'project', paths: [renamedName] });
	assert.deepEqual(requests, [
		{ dirId: 'project', path: originalName, existing: 'error' },
		{ dirId: 'project', source: originalName, target: renamedName, existing: 'error' },
	]);
	assert.deepEqual((await provider.readDirectory(root)).map(entry => ({ name: entry.name, path: entry.resource.path })), [{ name: renamedName, path: target.path }]);
	assert.deepEqual(notifications, [[target.path]]);
});

test("AgentHostFileSystemProvider maps wire entries back to resource URIs", async () => {
	const root = URI.parse("file:///C:/project");
	const releasedResources: string[] = [];
	using workspaceContextService: IWorkspaceContextService =
		new TestWorkspaceService({ id: "workspace", uri: root });
	const service = new AgentHostFileSystemProvider({
		directories: () => workspaceContextService.getWorkspace().folders.map(folder => ({ uri: folder.uri, target: { type: 'environment', dirId: folder.id } })),
		api: {
			...unavailableFileApi(),
			getMetadata: async ({ path }) => {
				assert.equal(path, ".");
				return {
					fileType: "directory",
					sizeBytes: 0,
					readonly: false,
					modifiedAtMillis: null,
				};
			},
			readDirectory: async ({ path }) => {
				assert.equal(path, "src");
				return {
					entries: [{ name: "main.ts", fileType: "file" }],
				};
			},
			readFile: async () => { throw new Error('Provider reads must use the binary endpoint'); },
			readBinaryFile: async ({ path }) => {
				if (path === 'src/main.ts') return {
					resource: { resourceId: 'resource-text', mimeType: 'text/plain', size: 10, sha256: 'sha256:text' }, revision: 'revision-read',
				};
				assert.equal(path, "paper.pdf");
				return {
					resource: { resourceId: "resource-pdf", mimeType: "application/octet-stream", size: 9, sha256: "sha256:pdf" },
					revision: "revision-binary",
				};
			},
			writeFile: async () => { throw new Error('Provider writes must use the binary endpoint'); },
			writeFileElevated: async () => { throw new Error('Unexpected elevated write'); },
			writeBinaryFile: async ({ path, dataBase64, options }) => {
				if (path === 'src/main.ts') {
					assert.equal(Buffer.from(dataBase64, 'base64').toString('utf8'), 'export const saved = true;');
					assert.deepEqual(options, { mode: 'createOrReplace', expectedRevision: 'revision-read' });
					return { metadata: { fileType: 'file', sizeBytes: 26, readonly: false, modifiedAtMillis: 123 }, revision: 'revision-write' };
				}
				assert.deepEqual({ path, dataBase64 }, { path: 'payload.bin', dataBase64: 'AP8q' });
				assert.deepEqual(options, { mode: 'create' });
				return { metadata: { fileType: 'file', sizeBytes: 3, readonly: false, modifiedAtMillis: null }, revision: 'revision-bytes' };
			},
			createFile: async ({ path }) => ({ fileType: "file", sizeBytes: path.length - path.length, readonly: false, modifiedAtMillis: null }),
			createDirectory: async ({ path }) => {
				assert.equal(path, 'new-folder');
				return { fileType: 'directory', sizeBytes: 0, readonly: false, modifiedAtMillis: null };
			},
			copy: async () => { throw new Error('not used'); },
			pasteSystemFiles: async () => false,
			rename: async () => { },
			delete: async () => { },
		},
		resourceApi: {
			connectionGeneration: 0,
			metadata: async () => { throw new Error("not used"); },
			read: async ({ resourceId, offset, maxBytes }) => {
				if (resourceId === 'resource-text') return { resourceId, offset, dataBase64: 'ZXhwb3J0IHt9Ow==', decodedLength: 10, eof: true };
				assert.equal(resourceId, "resource-pdf");
				assert.equal(offset, 0);
				assert.equal(maxBytes, 9);
				return { resourceId, offset, dataBase64: "JVBERi0xLjcK", decodedLength: 9, eof: true };
			},
			release: async ({ resourceId }) => { releasedResources.push(resourceId); },
		},
	});

	assert.equal((await service.stat(root)).kind, FileKind.Directory);
	assert.deepEqual(
		(await service.readDirectory(URI.parse("file:///C:/project/src"))).map(entry => ({ ...entry, resource: entry.resource.toString() })),
		[{
			resource: URI.parse("file:///C:/project/src/main.ts").toString(),
			name: "main.ts",
			kind: FileKind.File,
		}],
	);
	assert.deepEqual(
		await service.readFile(URI.parse("file:///C:/project/src/main.ts")),
		{ resource: URI.parse("file:///C:/project/src/main.ts"), bytes: new TextEncoder().encode('export {};'), revision: "revision-read" },
	);
	assert.deepEqual(
		await service.readFile(URI.parse("file:///C:/project/paper.pdf")),
		{ resource: URI.parse("file:///C:/project/paper.pdf"), bytes: new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10]), revision: "revision-binary" },
	);
	assert.deepEqual(releasedResources, ['resource-text', "resource-pdf"]);
	assert.equal((await service.createDirectory(URI.parse('file:///C:/project/new-folder'))).kind, FileKind.Directory);
	assert.deepEqual(
		await service.writeFile(URI.parse("file:///C:/project/src/main.ts"), new TextEncoder().encode("export const saved = true;"), { create: true, overwrite: true, expectedRevision: "revision-read" }),
		{
			stat: {
				resource: URI.parse("file:///C:/project/src/main.ts"),
				kind: FileKind.File,
				sizeBytes: 26,
				readonly: false,
				modifiedAtMillis: 123,
			},
			revision: "revision-write",
		},
	);
	assert.deepEqual(await service.writeFile(URI.parse('file:///C:/project/payload.bin'), new Uint8Array([0, 255, 42]), { create: true, overwrite: false }), {
		stat: { resource: URI.parse('file:///C:/project/payload.bin'), kind: FileKind.File, sizeBytes: 3, readonly: false, modifiedAtMillis: undefined },
		revision: 'revision-bytes',
	});
});

test('workspace stream cancellation releases a snapshot allocated after the caller stops', async () => {
	using workspace = new TestWorkspaceService({ id: 'project', uri: URI.file('/project') });
	using cancellation = new CancellationTokenSource();
	const allocated = new DeferredPromise<{ resource: { resourceId: string; mimeType: string; size: number; sha256: string; }; revision: string; }>();
	const released: string[] = [];
	using provider = new AgentHostFileSystemProvider({
		directories: () => workspace.getWorkspace().folders.map(folder => ({ uri: folder.uri, target: { type: 'environment', dirId: folder.id } })),
		api: { ...unavailableFileApi(), readBinaryFile: () => allocated.p },
		resourceApi: {
			connectionGeneration: 0,
			metadata: async () => { throw new Error('not used'); },
			read: async () => { throw new Error('Cancelled snapshot must not be read'); },
			release: async ({ resourceId }) => { released.push(resourceId); },
		},
	});
	const stream = provider.readFileStream(URI.file('/project/paper.pdf'), {}, cancellation.token);
	const consumed = consumeStream(stream);
	cancellation.cancel();
	await allocated.complete({ resource: { resourceId: 'late', mimeType: 'application/pdf', size: 1, sha256: 'sha256:late' }, revision: 'revision' });
	await assert.rejects(consumed, CancellationError);
	assert.deepEqual(released, ['late']);
});

test('workspace stream cancellation stops requesting chunks and releases its snapshot', async () => {
	using workspace = new TestWorkspaceService({ id: 'project', uri: URI.file('/project') });
	using cancellation = new CancellationTokenSource();
	const requested: number[] = [];
	const released: string[] = [];
	using provider = new AgentHostFileSystemProvider({
		directories: () => workspace.getWorkspace().folders.map(folder => ({ uri: folder.uri, target: { type: 'environment', dirId: folder.id } })),
		api: { ...unavailableFileApi(), readBinaryFile: async () => ({ resource: { resourceId: 'chunks', mimeType: 'application/pdf', size: 600000, sha256: 'sha256:chunks' }, revision: 'revision' }) },
		resourceApi: {
			connectionGeneration: 0,
			metadata: async () => { throw new Error('not used'); },
			read: async ({ resourceId, offset, maxBytes }) => {
				requested.push(offset);
				const data = new Uint8Array(maxBytes);
				return { resourceId, offset, dataBase64: Buffer.from(data).toString('base64'), decodedLength: data.byteLength, eof: false };
			},
			release: async ({ resourceId }) => { released.push(resourceId); },
		},
	});
	const stream = provider.readFileStream(URI.file('/project/paper.pdf'), {}, cancellation.token);
	stream.on('data', () => cancellation.cancel());
	await assert.rejects(consumeStream(stream), CancellationError);
	assert.deepEqual({ requested, released }, { requested: [0], released: ['chunks'] });
});

suite('AgentHost file resource connection ownership', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const mode of ['bytes', 'stream'] as const) {
		for (const stage of ['allocation', 'chunk', 'release'] as const) {
			for (const replacement of [false, true]) {
				test(`${mode} discards a late ${stage} after ${replacement ? 'connection replacement' : 'close without a generation change'}`, async () => {
					using changed = new Emitter<void>();
					const entered = new DeferredPromise<void>();
					const finish = new DeferredPromise<void>();
					let generation = 1;
					const requested: number[] = [];
					const released: number[] = [];
					using provider = new AgentHostFileSystemProvider({
						directories: () => [{ uri: URI.file('/project'), target: { type: 'environment', dirId: 'root' } }],
						api: {
							...unavailableFileApi(),
							get connectionGeneration() { return generation; },
							onDidChangeConnection: changed.event,
							readBinaryFile: async () => {
								if (stage === 'allocation') { await entered.complete(); await finish.p; }
								return { resource: { resourceId: 'reused-id', mimeType: 'application/pdf', size: 1, sha256: 'sha256:old' }, revision: 'old' };
							},
						},
						resourceApi: {
							get connectionGeneration() { return generation; },
							metadata: async () => { throw new Error('Unexpected metadata read'); },
							read: async ({ resourceId, offset }) => {
								requested.push(generation);
								if (stage === 'chunk') { await entered.complete(); await finish.p; }
								return { resourceId, offset, dataBase64: 'QQ==', decodedLength: 1, eof: true };
							},
							release: async () => {
								released.push(generation);
								if (stage === 'release') { await entered.complete(); await finish.p; }
							},
						},
					});
					const resource = URI.file('/project/paper.pdf');
					const reading = mode === 'bytes' ? provider.readFile(resource) : consumeStream(provider.readFileStream(resource, {}, CancellationToken.None));
					const rejected = assert.rejects(reading, CancellationError);
					await entered.p;
					if (replacement) generation++;
					changed.fire();
					await finish.complete();
					await rejected;
					assert.deepEqual({ requested, released }, {
						requested: stage === 'allocation' ? [] : [1],
						released: stage === 'release' ? [1] : [],
					});
				});
			}
		}

		for (const retired of [false, true]) {
			test(`${mode} ${retired ? 'cancels an obsolete' : 'preserves a current'} resource release failure`, async () => {
				using changed = new Emitter<void>();
				const entered = new DeferredPromise<void>();
				const finish = new DeferredPromise<void>();
				const failure = new Error('Resource release failed');
				using provider = new AgentHostFileSystemProvider({
					directories: () => [{ uri: URI.file('/project'), target: { type: 'environment', dirId: 'root' } }],
					api: {
						...unavailableFileApi(),
						onDidChangeConnection: changed.event,
						readBinaryFile: async () => ({ resource: { resourceId: 'empty', mimeType: 'application/pdf', size: 0, sha256: 'sha256:empty' }, revision: 'old' }),
					},
					resourceApi: {
						...unavailableResourceApi(),
						release: async () => { await entered.complete(); await finish.p; throw failure; },
					},
				});
				const resource = URI.file('/project/empty.pdf');
				const reading = mode === 'bytes' ? provider.readFile(resource) : consumeStream(provider.readFileStream(resource, {}, CancellationToken.None));
				const rejected = assert.rejects(reading, error => retired ? error instanceof CancellationError : error === failure);
				await entered.p;
				if (retired) { changed.fire(); }
				await finish.complete();
				await rejected;
			});
		}
	}
});

test("AgentHostFileSystemProvider maps App Server revision conflicts to the file contract", async () => {
	const resource = URI.parse("file:///C:/project/src/main.ts");
	using workspaceContextService: IWorkspaceContextService = new TestWorkspaceService({ id: "workspace", uri: URI.parse("file:///C:/project") });
	const service = new AgentHostFileSystemProvider({
		directories: () => workspaceContextService.getWorkspace().folders.map(folder => ({ uri: folder.uri, target: { type: 'environment', dirId: folder.id } })),
		resourceApi: unavailableResourceApi(),
		api: {
			...unavailableFileApi(),
			getMetadata: async () => { throw new Error("unavailable"); },
			readDirectory: async () => { throw new Error("unavailable"); },
			readFile: async () => { throw new Error("unavailable"); },
			readBinaryFile: async () => { throw new Error("unavailable"); },
			writeFile: async () => { throw new Error('unavailable'); },
			writeFileElevated: async () => { throw new Error('Unexpected elevated write'); },
			writeBinaryFile: async () => { throw new AppServerRemoteError(-32000, "Revision conflict", { kind: "FileSystemRevisionConflict" }); },
			createFile: async () => { throw new Error("unavailable"); },
			createDirectory: async () => { throw new Error('unavailable'); },
			copy: async () => { throw new Error('unavailable'); },
			pasteSystemFiles: async () => false,
			rename: async () => { throw new Error("unavailable"); },
			delete: async () => { throw new Error("unavailable"); },
		},
	});

	await assert.rejects(service.writeFile(resource, new TextEncoder().encode("local"), { create: true, overwrite: true, expectedRevision: "stale" }), FileRevisionConflictError);
});

test('AgentHostFileSystemProvider reports missing entries through the file contract for every read operation', async () => {
	using workspace = new TestWorkspaceService({ id: 'project', uri: URI.file('/project') });
	const resource = URI.file('/project/missing');
	let error: Error = new AppServerRemoteError(-32000, 'Missing entry', { kind: 'FileSystemNotFound' });
	const missing = async (): Promise<never> => { throw error; };
	using service = new AgentHostFileSystemProvider({
		directories: () => workspace.getWorkspace().folders.map(folder => ({ uri: folder.uri, target: { type: 'environment', dirId: folder.id } })),
		resourceApi: unavailableResourceApi(),
		api: { ...unavailableFileApi(), getMetadata: missing, readDirectory: missing, readFile: missing, readBinaryFile: missing },
	});
	const reads = [() => service.stat(resource), () => service.readDirectory(resource), () => service.readFile(resource)];
	for (const read of reads) {
		await assert.rejects(read, value => value instanceof FileNotFoundError && value.resource.toString() === resource.toString());
	}
	error = new Error('Read access failed');
	for (const read of reads) { await assert.rejects(read, value => value === error); }
});

test("AgentHostFileSystemProvider reads connection-owned binary resources in bounded chunks", async () => {
	const root = URI.parse("file:///C:/project");
	const resource = URI.parse("file:///C:/project/large.pdf");
	const bytes = new Uint8Array(17 * 1024 * 1024 + 1);
	bytes[0] = 37;
	bytes[bytes.length - 1] = 70;
	const readOffsets: number[] = [];
	const releasedResources: string[] = [];
	using workspaceContextService: IWorkspaceContextService = new TestWorkspaceService({ id: "workspace", uri: root });
	const service = new AgentHostFileSystemProvider({
		directories: () => workspaceContextService.getWorkspace().folders.map(folder => ({ uri: folder.uri, target: { type: 'environment', dirId: folder.id } })),
		api: {
			...unavailableFileApi(),
			getMetadata: async () => { throw new Error("not used"); },
			readDirectory: async () => { throw new Error("not used"); },
			readFile: async () => { throw new Error("not used"); },
			readBinaryFile: async () => ({
				resource: { resourceId: "resource-large", mimeType: "application/octet-stream", size: bytes.length, sha256: "sha256:large" },
				revision: "revision-large",
			}),
			writeFile: async () => { throw new Error("not used"); },
			writeFileElevated: async () => { throw new Error('Unexpected elevated write'); },
			writeBinaryFile: async () => { throw new Error('not used'); },
			createFile: async () => { throw new Error("not used"); },
			createDirectory: async () => { throw new Error('not used'); },
			copy: async () => { throw new Error('not used'); },
			pasteSystemFiles: async () => false,
			rename: async () => { throw new Error("not used"); },
			delete: async () => { throw new Error("not used"); },
		},
		resourceApi: {
			connectionGeneration: 0,
			metadata: async () => { throw new Error("not used"); },
			read: async ({ resourceId, offset, maxBytes }) => {
				assert.equal(resourceId, "resource-large");
				readOffsets.push(offset);
				const data = bytes.slice(offset, offset + maxBytes);
				return {
					resourceId,
					offset,
					dataBase64: Buffer.from(data).toString("base64"),
					decodedLength: data.length,
					eof: offset + data.length === bytes.length,
				};
			},
			release: async ({ resourceId }) => { releasedResources.push(resourceId); },
		},
	});

	assert.deepEqual((await service.readFile(resource)).bytes, bytes);
	assert.deepEqual(readOffsets, Array.from({ length: Math.ceil(bytes.length / 262_144) }, (_, index) => index * 262_144));
	assert.deepEqual(releasedResources, ["resource-large"]);
});

test("AgentHostFileSystemProvider maps App Server invalidations to workspace resources", () => {
	const root = URI.parse("file:///C:/project");
	using workspaceContextService: IWorkspaceContextService = new TestWorkspaceService({ id: "workspace", uri: root });
	using changes = new Emitter<FsChanged>();
	using service = new AgentHostFileSystemProvider({
		directories: () => workspaceContextService.getWorkspace().folders.map(folder => ({ uri: folder.uri, target: { type: 'environment', dirId: folder.id } })),
		resourceApi: unavailableResourceApi(),
		api: unavailableFileApi(),
		onDidChange: changes.event,
	});
	const observed: (readonly URI[] | undefined)[] = [];
	using listener = service.onDidChangeFiles(event => observed.push(event.resources));

	changes.fire({ type: "pathsChanged", paths: ["src/main.ts", "src/main.ts", "README.md"] });
	changes.fire({ type: "rescanRequired" });

	assert.deepEqual(observed, [[URI.parse("file:///C:/project/src/main.ts"), URI.parse("file:///C:/project/README.md")], undefined]);
});

test("AgentHostFileSystemProvider routes nested multi-root resources by Workspace folder id", async () => {
	using workspaceContextService: IWorkspaceContextService = new TestWorkspaceService({
		id: "multi-root",
		folders: [
			{ id: "parent", uri: URI.parse("file:///C:/project"), name: "parent", index: 0 },
			{ id: "nested", uri: URI.parse("file:///C:/project/packages/nested"), name: "nested", index: 1 },
		],
		configuration: URI.parse("file:///C:/project.code-workspace"),
	});
	const requests: { readonly dirId?: string; readonly path: string; }[] = [];
	const copies: unknown[] = [];
	const pastes: unknown[] = [];
	const service = new AgentHostFileSystemProvider({
		directories: () => workspaceContextService.getWorkspace().folders.map(folder => ({ uri: folder.uri, target: { type: 'environment', dirId: folder.id } })),
		resourceApi: { ...unavailableResourceApi(), release: async () => { } },
		api: {
			...unavailableFileApi(),
			readBinaryFile: async params => {
				requests.push(params);
				return { resource: { resourceId: params.path, mimeType: 'text/plain', size: 0, sha256: 'sha256:empty' }, revision: 'revision' };
			},
			copy: async params => { copies.push(params); },
			pasteSystemFiles: async params => { pastes.push(params); return true; },
		},
	});

	await service.readFile(URI.parse("file:///C:/project/README.md"));
	await service.readFile(URI.parse("file:///C:/project/packages/nested/src/main.ts"));

	assert.deepEqual(requests, [
		{ dirId: "parent", path: "README.md" },
		{ dirId: "nested", path: "src/main.ts" },
	]);
	await service.copy(URI.parse("file:///C:/project/README.md"), URI.parse("file:///C:/project/packages/nested/README.md"));
	assert.deepEqual(copies, [{ sourceDirId: 'parent', source: 'README.md', targetDirId: 'nested', target: 'README.md' }]);
	assert.equal(await service.pasteSystemFiles(URI.parse('file:///C:/project/packages/nested'), true), true);
	assert.deepEqual(pastes, [{ dirId: 'nested', path: '.', moveRequested: true }]);
	await assert.rejects(service.pasteSystemFiles(URI.parse('file:///C:/outside'), false), /no authorized directory/);
	await assert.rejects(service.rename(URI.parse("file:///C:/project/README.md"), URI.parse("file:///C:/project/packages/nested/README.md"), "error"), /across authorized directories/i);
});

function unavailableFileApi() {
	return {
		connectionGeneration: 0,
		onDidChangeConnection: Event.None,
		resolvePath: async () => { throw new Error('Resource has no authorized directory'); },
		readPathCaseSensitivity: async () => { throw new Error('unavailable'); },
		getMetadata: async () => { throw new Error("unavailable"); },
		readDirectory: async () => { throw new Error("unavailable"); },
		readFile: async () => { throw new Error("unavailable"); },
		readBinaryFile: async () => { throw new Error("unavailable"); },
		writeFile: async () => { throw new Error("unavailable"); },
		writeFileElevated: async () => { throw new Error('Unexpected elevated write'); },
		writeBinaryFile: async () => { throw new Error('unavailable'); },
		createFile: async () => { throw new Error("unavailable"); },
		createDirectory: async () => { throw new Error('unavailable'); },
		copy: async () => { throw new Error('unavailable'); },
		pasteSystemFiles: async () => false,
		rename: async () => { throw new Error("unavailable"); },
		delete: async () => { throw new Error("unavailable"); },
	};
}

function unavailableResourceApi() {
	return {
		connectionGeneration: 0,
		metadata: async () => { throw new Error("unavailable"); },
		read: async () => { throw new Error("unavailable"); },
		release: async () => { throw new Error("unavailable"); },
	};
}

test('FileService routes exact schemes and forwards provider invalidations', async () => {
	using fallback = new TestFileProvider('fallback');
	using virtual = new TestFileProvider('virtual');
	using service = new FileService();
	using workspaceRegistration = service.registerProvider('file', fallback);
	using registration = service.registerProvider('ash-test', virtual);
	const workspaceResource = URI.file('/workspace/file.txt');
	const virtualResource = URI.parse('ash-test:/resource.txt');
	const observed: string[] = [];
	using listener = service.onDidChangeFiles(event => observed.push(event.resources?.[0]?.toString() ?? '*'));
	assert.deepEqual([service.hasProvider(virtualResource), service.hasProvider(workspaceResource)], [true, true]);

	assert.equal((await service.readFile(workspaceResource)).content, 'fallback:file:///workspace/file.txt');
	assert.equal((await service.readFile(virtualResource)).content, 'virtual:ash-test:/resource.txt');
	virtual.emit(virtualResource);
	assert.deepEqual(observed, ['ash-test:/resource.txt']);
	assert.throws(() => service.rename(virtualResource, workspaceResource, 'overwrite'), /across file system providers/);
	assert.throws(() => service.registerProvider('ash-test', virtual), /already registered/);

	registration.dispose();
	assert.equal(service.hasProvider(virtualResource), false);
	assert.throws(() => service.readFile(virtualResource), FileOperationNotSupportedError);
	assert.throws(() => service.readFile(URI.parse('unknown:/resource.txt')), FileOperationNotSupportedError);
	virtual.emit(virtualResource);
	assert.deepEqual(observed, ['ash-test:/resource.txt']);
});

test('FileService decodes text from provider bytes without changing revisions or binary reads', async () => {
	using provider = new TestFileProvider('exact-byte-revision');
	using service = new FileService();
	using registration = service.registerProvider('file', provider);
	const resource = URI.file('/workspace/bom.txt');
	const bytes = new TextEncoder().encode('\uFEFF你好\r\n');
	provider.addFile(resource, bytes);
	assert.deepEqual(await service.readFile(resource), { resource, content: '\uFEFF你好\r\n', revision: 'exact-byte-revision' });
	assert.deepEqual(await service.readFileBytes(resource), { resource, bytes, revision: 'exact-byte-revision' });
	const binary = URI.file('/workspace/binary.bin');
	provider.addFile(binary, new Uint8Array([0xff, 0x00, 0x80]));
	assert.deepEqual((await service.readFileBytes(binary)).bytes, new Uint8Array([0xff, 0x00, 0x80]));
	await assert.rejects(service.readFile(binary), TypeError);
});

test('AgentHostFileSystemProvider releases a byte resource when reading its content fails', async () => {
	using workspace = new TestWorkspaceService({ id: 'read-failure', uri: URI.file('/workspace') });
	const failure = new Error('Resource read failed');
	const released: string[] = [];
	using provider = new AgentHostFileSystemProvider({
		directories: () => workspace.getWorkspace().folders.map(folder => ({ uri: folder.uri, target: { type: 'environment', dirId: folder.id } })),
		api: { ...unavailableFileApi(), readBinaryFile: async () => ({ resource: { resourceId: 'failed-read', mimeType: 'application/octet-stream', size: 1, sha256: 'sha256:failed' }, revision: 'raw-revision' }) },
		resourceApi: { ...unavailableResourceApi(), read: async () => { throw failure; }, release: async request => { released.push(request.resourceId); } },
	});
	await assert.rejects(provider.readFile(URI.file('/workspace/file.txt')), error => error === failure);
	assert.deepEqual(released, ['failed-read']);
});

test('FileService shares a subscription across schemes and releases it after the last registration', () => {
	using provider = new TestFileProvider('workspace');
	using service = new FileService();
	using local = service.registerProvider('file', provider);
	using remote = service.registerProvider('ash-remote', provider);
	const observed: IFileChangeEvent[] = [];
	using listener = service.onDidChangeFiles(event => observed.push(event));
	const localResource = URI.file('/workspace/file.txt');
	const remoteResource = URI.parse('ash-remote://server/workspace/file.txt');
	provider.emit(undefined);
	provider.emit(remoteResource);
	local.dispose();
	provider.emit(localResource);
	provider.emit(remoteResource);
	assert.deepEqual(observed, [{ resources: undefined }, { resources: [remoteResource] }, { resources: [remoteResource] }]);
	assert.equal(provider.hasListeners, true);
	remote.dispose();
	assert.equal(provider.hasListeners, false);
});

test('FileService disposal releases registrations without disposing caller-owned providers', async () => {
	using provider = new TestFileProvider('workspace');
	using service = new FileService();
	using registration = service.registerProvider('file', provider);
	const resource = URI.file('/workspace/file.txt');
	service.dispose();
	assert.deepEqual({ registered: service.hasProvider(resource), subscribed: provider.hasListeners }, { registered: false, subscribed: false });
	assert.throws(() => service.readFile(resource), ReferenceError);
	assert.throws(() => service.registerProvider('file', provider), ReferenceError);
	assert.equal(new TextDecoder().decode((await provider.readFile(resource)).bytes), 'workspace:file:///workspace/file.txt');
});

test('FileService copies directory bytes across file system providers', async () => {
	using workspace = new TestFileProvider('workspace');
	using virtual = new TestFileProvider('virtual');
	using service = new FileService();
	using workspaceRegistration = service.registerProvider('file', workspace);
	using registration = service.registerProvider('ash-test', virtual);
	const source = URI.parse('ash-test:/source');
	const file = URI.joinPath(source, '100% ready.bin');
	const target = URI.file('/workspace/copied');
	virtual.addDirectory(source, [{ resource: file, name: '100% ready.bin', kind: FileKind.File }]);
	virtual.addFile(file, new Uint8Array([0, 255, 42]));

	await service.copy(source, target);

	assert.equal((await workspace.stat(target)).kind, FileKind.Directory);
	assert.deepEqual((await workspace.readFile(URI.joinPath(target, '100% ready.bin'))).bytes, new Uint8Array([0, 255, 42]));
	await assert.rejects(service.copy(source, target), /already exists/);
});

test('FileService removes an incomplete cross-provider copy', async () => {
	using workspace = new TestFileProvider('workspace');
	using virtual = new TestFileProvider('virtual');
	using service = new FileService();
	using workspaceRegistration = service.registerProvider('file', workspace);
	using registration = service.registerProvider('ash-test', virtual);
	const source = URI.parse('ash-test:/source');
	const first = URI.joinPath(source, 'first.bin');
	const second = URI.joinPath(source, 'second.bin');
	const target = URI.file('/workspace/copied');
	virtual.addDirectory(source, [
		{ resource: first, name: 'first.bin', kind: FileKind.File },
		{ resource: second, name: 'second.bin', kind: FileKind.File },
	]);
	virtual.addFile(first, new Uint8Array([42]));
	virtual.addFile(second, new Uint8Array([43]));
	virtual.failRead(second);

	await assert.rejects(service.copy(source, target), /read failed/);
	await assert.rejects(workspace.stat(target), FileNotFoundError);
	await assert.rejects(workspace.stat(URI.joinPath(target, 'first.bin')), FileNotFoundError);
	assert.equal((await virtual.stat(first)).kind, FileKind.File);
});

suite('FileService capability and watch ownership', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('registration and capability events describe every scheme and stop after the last unregister', () => {
		using provider = new TestFileProvider('workspace');
		using service = new FileService();
		const registrations: unknown[] = [];
		const capabilities: string[] = [];
		using registrationListener = service.onDidChangeFileSystemProviderRegistrations(event => {
			registrations.push([event.scheme, event.added, event.provider === provider, service.hasProvider(URI.parse(`${event.scheme}:/file`))]);
		});
		using capabilityListener = service.onDidChangeFileSystemProviderCapabilities(event => capabilities.push(event.scheme));
		const first = service.registerProvider('first', provider);
		const second = service.registerProvider('second', provider);
		provider.setCapabilities(provider.capabilities | FileSystemProviderCapabilities.PathCaseSensitive);
		first.dispose();
		provider.setCapabilities(provider.capabilities);
		second.dispose();
		provider.setCapabilities(provider.capabilities);
		assert.deepEqual(registrations, [['first', true, true, true], ['second', true, true, true], ['first', false, true, false], ['second', false, true, false]]);
		assert.deepEqual(capabilities, ['first', 'second', 'second']);
	});

	test('text saves preserve BOM and revision while binary imports require an absent target', async () => {
		using provider = new TestFileProvider('workspace');
		using service = new FileService();
		using registration = service.registerProvider('file', provider);
		const text = URI.file('/workspace/text.txt');
		const binary = URI.file('/workspace/empty.bin');
		await service.writeFile({ resource: text, content: '\uFEFFsaved', expectedRevision: 'previous' });
		provider.addFile(binary, new Uint8Array());
		await assert.rejects(service.writeFileBytes(binary, new Uint8Array([255])), /already exists/);
		assert.deepEqual((await provider.readFile(binary)).bytes, new Uint8Array());
		await service.writeFileBytes(URI.file('/workspace/new.bin'), new Uint8Array([0, 255]));
		assert.deepEqual(provider.writeRequests, [
			{ resource: text, bytes: new TextEncoder().encode('\uFEFFsaved'), options: { create: true, overwrite: true, expectedRevision: 'previous' } },
			{ resource: URI.file('/workspace/new.bin'), bytes: new Uint8Array([0, 255]), options: { create: true, overwrite: false } },
		]);
	});

	test('ordinary unlock requires an explicit provider capability before forwarding the save', async () => {
		using provider = new TestFileProvider('workspace');
		using service = new FileService();
		using registration = service.registerProvider('file', provider);
		const resource = URI.file('/workspace/text.txt');
		const bytes = new Uint8Array([42]);
		const options = { create: false, overwrite: true, expectedRevision: 'previous', unlock: true };
		provider.addFile(resource, new Uint8Array([1]));
		assert.throws(() => service.writeFileBytes(resource, bytes, options), FileOperationNotSupportedError);
		assert.deepEqual(provider.writeRequests, []);
		provider.setCapabilities(provider.capabilities | FileSystemProviderCapabilities.FileWriteUnlock);
		await service.writeFileBytes(resource, bytes, options);
		assert.deepEqual(provider.writeRequests, [{ resource, bytes, options }]);
	});

	test('live capability changes invalidate metadata and prevent readonly mutations', async () => {
		using provider = new TestFileProvider('workspace');
		using service = new FileService();
		using registration = service.registerProvider('file', provider);
		const resource = URI.file('/workspace/text.txt');
		provider.addFile(resource, new Uint8Array([42]));
		const changes: IFileChangeEvent[] = [];
		using listener = service.onDidChangeFiles(event => changes.push(event));
		provider.setCapabilities(FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.Readonly);
		assert.equal(service.hasCapability(resource, FileSystemProviderCapabilities.Readonly), true);
		assert.equal((await service.stat(resource)).readonly, true);
		assert.throws(() => service.writeFile({ resource, content: 'blocked' }), FileOperationNotSupportedError);
		assert.throws(() => service.delete(resource, 'error', 'recursive'), FileOperationNotSupportedError);
		assert.deepEqual(provider.writeRequests, []);
		provider.setCapabilities(FileSystemProviderCapabilities.FileReadWrite);
		assert.equal((await service.stat(resource)).readonly, false);
		assert.deepEqual(changes, [{ resources: undefined }, { resources: undefined }]);
		registration.dispose();
		assert.equal(service.hasCapability(resource, FileSystemProviderCapabilities.FileReadWrite), false);
	});

	test('equivalent watches share one provider handle until the last caller releases it', () => {
		using provider = new TestFileProvider('workspace');
		using service = new FileService();
		using registration = service.registerProvider('file', provider);
		const resource = URI.file('/workspace');
		using first = service.watch(resource, { recursive: true, excludes: ['b', 'a', 'b'] });
		using second = service.watch(resource, { recursive: true, excludes: ['a', 'b'] });
		using shallow = service.watch(resource);
		assert.deepEqual(provider.watchRequests.map(request => request.options), [{ recursive: true, excludes: ['a', 'b'] }, { recursive: false, excludes: [] }]);
		first.dispose();
		assert.equal(provider.watchRequests[0].disposed, false);
		second.dispose();
		assert.equal(provider.watchRequests[0].disposed, true);
		assert.equal(provider.watchRequests[1].disposed, false);
		shallow.dispose();
		assert.equal(provider.watchRequests[1].disposed, true);
	});

	test('provider replacement and service disposal release watches without stale handle interference', () => {
		using first = new TestFileProvider('first');
		using second = new TestFileProvider('second');
		using service = new FileService();
		using original = service.registerProvider('file', first);
		const resource = URI.file('/workspace');
		using oldWatch = service.watch(resource);
		original.dispose();
		assert.equal(first.watchRequests[0].disposed, true);
		using replacement = service.registerProvider('file', second);
		using newWatch = service.watch(resource);
		oldWatch.dispose();
		assert.equal(second.watchRequests[0].disposed, false);
		service.dispose();
		assert.equal(second.watchRequests[0].disposed, true);
	});

	test('workspace replacement releases old roots and forwards only current workspace changes', async () => {
		using provider = new TestFileProvider('workspace');
		using service = new FileService();
		using registration = service.registerProvider('file', provider);
		using workspace = new TestWorkspaceService({ id: 'first', uri: URI.file('/first') });
		using watcher = new WorkspaceWatcher(service, workspace);
		const observed: (readonly URI[] | undefined)[] = [];
		const changed = new DeferredPromise<void>();
		using listener = watcher.onDidChange(event => { observed.push(event); void changed.complete(); });
		workspace.updateWorkspace({ id: 'second', uri: URI.file('/second') });
		provider.emit(URI.file('/first/old.txt'));
		provider.emit(URI.file('/second/new.txt'));
		assert.deepEqual(provider.watchRequests.map(request => ({ resource: request.resource, options: request.options, disposed: request.disposed })), [
			{ resource: URI.file('/first'), options: { recursive: true, excludes: [] }, disposed: true },
			{ resource: URI.file('/second'), options: { recursive: true, excludes: [] }, disposed: false },
		]);
		await changed.p;
		assert.deepEqual(observed, [[URI.file('/second/new.txt')]]);
		watcher.dispose();
		assert.equal(provider.watchRequests[1].disposed, true);
	});

	test('a failed exclusive copy preserves a file published by an intervening writer', async () => {
		using source = new TestFileProvider('source');
		using target = new TestFileProvider('target');
		using service = new FileService();
		using sourceRegistration = service.registerProvider('file', source);
		using targetRegistration = service.registerProvider('ash-test', target);
		const from = URI.file('/workspace/from.bin');
		const to = URI.parse('ash-test:/to.bin');
		source.addFile(from, new Uint8Array([42]));
		const stat = target.stat.bind(target);
		let published = false;
		target.stat = async resource => {
			if (!published) {
				published = true;
				target.addFile(resource, new Uint8Array([43]));
				throw new FileNotFoundError(resource);
			}
			return stat(resource);
		};
		await assert.rejects(service.copy(from, to), /already exists/);
		assert.deepEqual((await target.readFile(to)).bytes, new Uint8Array([43]));
	});
});

class TestFileProvider implements IFileSystemProvider {
	public capabilities: FileSystemProviderCapabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy;
	private readonly capabilitiesChanged = new Emitter<void>();
	public readonly onDidChangeCapabilities = this.capabilitiesChanged.event;
	public readonly watchRequests: { resource: URI; options: IWatchOptions; disposed: boolean; }[] = [];
	public readonly writeRequests: { resource: URI; bytes: Uint8Array; options: IFileWriteOptions; }[] = [];

	private readonly changes = new Emitter<IFileChangeEvent>();
	private readonly files = new Map<string, Uint8Array>();
	private readonly directories = new Map<string, readonly IFileEntry[]>();
	private failingRead: string | undefined;
	public readonly onDidChangeFiles = this.changes.event;

	constructor(private readonly label: string) { }

	public watch(resource: URI, options: IWatchOptions): IDisposable {
		const request = { resource, options, disposed: false };
		this.watchRequests.push(request);
		return toDisposable(() => { request.disposed = true; });
	}

	public setCapabilities(capabilities: FileSystemProviderCapabilities): void {
		this.capabilities = capabilities;
		this.capabilitiesChanged.fire();
	}

	public get hasListeners(): boolean {
		return this.changes.hasListeners();
	}

	public emit(resource: URI | undefined): void {
		this.changes.fire({ resources: resource ? [resource] : undefined });
	}

	public addFile(resource: URI, bytes: Uint8Array): void {
		this.files.set(resource.toString(), bytes);
	}

	public addDirectory(resource: URI, entries: readonly IFileEntry[]): void {
		this.directories.set(resource.toString(), entries);
	}

	public failRead(resource: URI): void {
		this.failingRead = resource.toString();
	}

	public async stat(resource: URI): Promise<IFileStat> {
		const file = this.files.get(resource.toString());
		const kind = file ? FileKind.File : this.directories.has(resource.toString()) ? FileKind.Directory : undefined;
		if (!kind) throw new FileNotFoundError(resource);
		return { resource, kind, sizeBytes: file?.length ?? 0, readonly: false, modifiedAtMillis: undefined };
	}

	public readDirectory(resource: URI): Promise<readonly IFileEntry[]> {
		return Promise.resolve(this.directories.get(resource.toString()) ?? []);
	}

	public readFile(resource: URI): Promise<IFileBytes> {
		if (resource.toString() === this.failingRead) throw new Error('read failed');
		return Promise.resolve({ resource, bytes: this.files.get(resource.toString()) ?? new TextEncoder().encode(`${this.label}:${resource.toString()}`), revision: this.label });
	}

	public async writeFile(resource: URI, bytes: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult> {
		if (this.files.has(resource.toString()) && !options.overwrite) throw new Error('File already exists');
		if (!this.files.has(resource.toString()) && !options.create) throw new FileNotFoundError(resource);
		this.writeRequests.push({ resource, bytes, options });
		this.files.set(resource.toString(), bytes);
		return { stat: await this.stat(resource), revision: this.label };
	}

	public createFile(resource: URI, _existing: FileExistingTargetBehavior): Promise<IFileStat> {
		return this.stat(resource);
	}

	public createDirectory(resource: URI): Promise<IFileStat> {
		this.directories.set(resource.toString(), []);
		return this.stat(resource);
	}

	public copy(_source: URI, _target: URI): Promise<void> { return Promise.resolve(); }

	public rename(_source: URI, _target: URI, _existing: FileExistingTargetBehavior): Promise<void> {
		return Promise.resolve();
	}

	public delete(resource: URI, _missing: FileMissingTargetBehavior, mode: FileDeleteMode): Promise<void> {
		const prefix = `${resource.toString()}/`;
		for (const key of this.files.keys()) {
			if (key === resource.toString() || mode === 'recursive' && key.startsWith(prefix)) this.files.delete(key);
		}
		for (const key of this.directories.keys()) {
			if (key === resource.toString() || mode === 'recursive' && key.startsWith(prefix)) this.directories.delete(key);
		}
		return Promise.resolve();
	}

	public dispose(): void {
		this.changes.dispose();
		this.capabilitiesChanged.dispose();
	}

	public [Symbol.dispose](): void {
		this.dispose();
	}
}

test('file text codec requests preserve logical text and backend encoding metadata through the provider', async () => {
	using workspace = new TestWorkspaceService({ id: 'project', uri: URI.file('/project') });
	const resource = URI.file('/project/encoding.txt');
	const requests: unknown[] = [];
	using provider = new AgentHostFileSystemProvider({
		directories: () => workspace.getWorkspace().folders.map(folder => ({ uri: folder.uri, target: { type: 'environment', dirId: folder.id } })), resourceApi: unavailableResourceApi(),
		api: {
			...unavailableFileApi(),
			readFile: async params => { requests.push(params); return { content: '中文', encoding: 'gbk', revision: 'bytes-revision' }; },
			writeFile: async params => { requests.push(params); return { metadata: { fileType: 'file', sizeBytes: 4, readonly: false, modifiedAtMillis: null }, revision: 'encoded-revision' }; },
		},
	});
	using files = new FileService();
	using registration = files.registerProvider('file', provider);
	assert.deepEqual(await files.readFile(resource, 'gbk'), { resource, content: '中文', encoding: 'gbk', revision: 'bytes-revision' });
	const saved = await files.writeFile({ resource, content: '中文', encoding: 'gbk', expectedRevision: 'bytes-revision' }, { create: false, overwrite: true });
	assert.equal(saved.revision, 'encoded-revision');
	assert.deepEqual(requests, [{ dirId: 'project', path: 'encoding.txt', encoding: 'gbk' }, { dirId: 'project', path: 'encoding.txt', content: '中文', encoding: 'gbk', options: { mode: 'replace', expectedRevision: 'bytes-revision' } }]);
});

test('file text codec errors retain their domain category and conflicts protect encoding-only saves', async () => {
	const { FileSystemProviderErrorCode, toFileSystemProviderErrorCode } = await import('../../common/files.js');
	using workspace = new TestWorkspaceService({ id: 'project', uri: URI.file('/project') });
	const resource = URI.file('/project/encoding.txt');
	using provider = new AgentHostFileSystemProvider({
		directories: () => workspace.getWorkspace().folders.map(folder => ({ uri: folder.uri, target: { type: 'environment', dirId: folder.id } })), resourceApi: unavailableResourceApi(),
		api: {
			...unavailableFileApi(),
			readFile: async () => { throw new AppServerRemoteError(-32000, 'Invalid text', { kind: 'FileSystemInvalidText' }); },
			writeFile: async () => { throw new AppServerRemoteError(-32000, 'Revision conflict', { kind: 'FileSystemRevisionConflict' }); },
		},
	});
	await assert.rejects(provider.readTextFile(resource, 'auto'), error => toFileSystemProviderErrorCode(error as Error) === FileSystemProviderErrorCode.FileNotText);
	await assert.rejects(provider.writeTextFile(resource, '中文', 'gbk', { create: false, overwrite: true, expectedRevision: 'stale' }), FileRevisionConflictError);
});

test('shared resource routing keeps conversation files independent of Workspace selection and rechecks backend access', async () => {
	using workspace = new TestWorkspaceService({ id: 'source', uri: URI.file('/source') });
	const calls: unknown[] = [];
	let writable = true;
	let resolutions = 0;
	using changes = new Emitter<FsChanged>();
	using provider = new AgentHostFileSystemProvider({
		directories: () => workspace.getWorkspace().folders.map(folder => ({ uri: folder.uri, target: { type: 'environment', dirId: folder.id } })),
		resourceApi: unavailableResourceApi(),
		onDidChange: changes.event,
		api: {
			...unavailableFileApi(),
			async resolvePath(resource) {
				resolutions++;
				const name = resource.path.split('/')[2];
				if (!['a', 'b'].includes(name)) { throw new Error('PermissionRequired'); }
				return { uri: URI.file(`/managed/${name}`), target: { type: 'session', sessionId: name, path: `/managed/${name}` } };
			},
			async readPathCaseSensitivity(params) { calls.push(params); return { scopes: [{ path: '.', sensitivity: 'sensitive' }] }; },
			async createFile(params) { calls.push(params); return { fileType: 'file', sizeBytes: 0, readonly: false, modifiedAtMillis: null }; },
			async writeFile(params) {
				calls.push(params);
				if (!writable) { throw new Error('PermissionRequired'); }
				return { metadata: { fileType: 'file', sizeBytes: params.content.length, readonly: false, modifiedAtMillis: null }, revision: 'saved' };
			},
		},
	});
	using files = new FileService();
	using registration = files.registerProvider('file', provider);
	const a = URI.file('/managed/a/hundred.txt');
	const b = URI.file('/managed/b/other.txt');
	assert.equal(workspace.getWorkspaceFolder(a), null);
	await files.resolvePathIdentity(a);
	await files.createFile(a, 'error');
	await files.createFile(b, 'error');
	workspace.updateWorkspace({ id: 'other-project', uri: URI.file('/elsewhere') });
	await provider.writeTextFile(a, 'retained dirty buffer\n', 'utf8', { create: true, overwrite: true, expectedRevision: 'before' });
	assert.deepEqual(calls.map(call => (call as { sessionDirectory: unknown; }).sessionDirectory), [
		{ sessionId: 'a', path: '/managed/a' }, { sessionId: 'a', path: '/managed/a' },
		{ sessionId: 'b', path: '/managed/b' }, { sessionId: 'a', path: '/managed/a' },
	]);
	assert.equal(resolutions, 2);
	writable = false;
	await assert.rejects(provider.writeTextFile(a, 'unsaved', 'utf8', { create: true, overwrite: true }), /PermissionRequired/);
	await assert.rejects(files.createFile(URI.file('/ungranted/file'), 'error'), /PermissionRequired/);
	const invalidations: unknown[] = [];
	using listener = files.onDidChangeFiles(event => invalidations.push(event.resources));
	changes.fire({ type: 'pathsChanged', dirId: 'managed-dir-id', paths: ['hundred.txt'] });
	assert.deepEqual(invalidations, [undefined], 'Unknown watcher roots invalidate open models without guessing a selected directory');
});

test('resource discovery rejects stale connections and disposal before dispatching a write', async () => {
	using changed = new Emitter<void>();
	let generation = 1;
	let resolve!: (root: IFileSystemDirectory) => void;
	let writes = 0;
	using provider = new AgentHostFileSystemProvider({
		resourceApi: unavailableResourceApi(),
		api: {
			...unavailableFileApi(),
			get connectionGeneration() { return generation; },
			onDidChangeConnection: changed.event,
			resolvePath: () => new Promise(result => { resolve = result; }),
			async createFile() { writes++; return { fileType: 'file', sizeBytes: 0, readonly: false, modifiedAtMillis: null }; },
		},
	});
	const root: IFileSystemDirectory = { uri: URI.file('/managed/a'), target: { type: 'session', sessionId: 'a', path: '/managed/a' } };
	const resource = URI.joinPath(root.uri, 'new.txt');
	const old = assert.rejects(provider.createFile(resource, 'error'), { name: 'CancellationError' });
	generation++;
	changed.fire();
	resolve(root);
	await old;
	const disposed = assert.rejects(provider.createFile(resource, 'error'), { name: 'CancellationError' });
	provider.dispose();
	resolve(root);
	await disposed;
	assert.equal(writes, 0);
});

test('resource discovery preserves host authority and reports invalid routes in Chinese', async () => {
	const translations = JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/workbench.json', 'utf8'));
	setNlsMessages('zh-CN', translations);
	try {
		let discoveries = 0;
		using provider = new AgentHostFileSystemProvider({
			resourceApi: unavailableResourceApi(),
			api: {
				...unavailableFileApi(),
				async resolvePath() {
					discoveries++;
					return { uri: URI.file('/wrong-root'), target: { type: 'environment', dirId: 'wrong-root' } };
				},
			},
		});
		await assert.rejects(provider.createFile(URI.parse('ash-remote://another-host/managed/new.txt'), 'error'), /找不到此资源所属主机的文件系统路由/);
		assert.equal(discoveries, 0, 'A foreign host must never be resolved on this connection');
		await assert.rejects(provider.createFile(URI.file('/managed/new.txt'), 'error'), /文件系统返回的目录不包含所请求的资源/);
		assert.equal(discoveries, 1);
	} finally { resetNlsResolver(); }
});

for (const sameAuthority of [false, true]) {
	test(`FileService copies mounted connection files and directories across ${sameAuthority ? 'roots on one authority' : 'different authorities'}`, async () => {
		const sourceRoot = createSshRemoteWorkspaceUri('source-host', '/source');
		const targetRoot = createSshRemoteWorkspaceUri(sameAuthority ? 'source-host' : 'target-host', '/target');
		using sourceStorage = new InMemoryFileSystemProvider();
		using targetStorage = new InMemoryFileSystemProvider();
		await sourceStorage.createDirectory(sourceRoot);
		await targetStorage.createDirectory(targetRoot);
		const sourceHost = copyConnection(sourceStorage, sourceRoot, 'source');
		const targetHost = copyConnection(targetStorage, targetRoot, 'target');
		using provider = new AgentHostFileSystemProvider({ api: unavailableFileApi(), resourceApi: unavailableResourceApi() });
		using sourceMount = provider.registerAuthority(sourceRoot.authority, sourceHost.connection);
		using targetMount = provider.registerAuthority(targetRoot.authority, targetHost.connection);
		using files = new FileService();
		using registration = files.registerProvider('ash-remote', provider);
		const source = URI.joinPath(sourceRoot, 'folder');
		const nested = URI.joinPath(source, 'nested');
		const sourceFile = URI.joinPath(nested, '100% ready.bin');
		const bytes = new Uint8Array([0, 255, 128, 42]);
		await sourceStorage.createDirectory(nested);
		await sourceStorage.writeFile(sourceFile, bytes, { create: true, overwrite: false });
		const target = URI.joinPath(targetRoot, 'copied');

		await files.copy(source, target);
		assert.deepEqual(Uint8Array.from((await files.readFileBytes(URI.joinPath(target, 'nested', '100% ready.bin'))).bytes), bytes);
		const direct = URI.joinPath(targetRoot, 'direct.bin');
		await files.copy(sourceFile, direct);
		assert.deepEqual(Uint8Array.from((await files.readFileBytes(direct)).bytes), bytes);
		await assert.rejects(files.copy(sourceFile, direct), /already exists/);
		assert.deepEqual(Uint8Array.from((await targetStorage.readFile(direct)).bytes), bytes);
		assert.deepEqual(Uint8Array.from((await sourceStorage.readFile(sourceFile)).bytes), bytes);
		assert.equal(sourceHost.nativeCopies + targetHost.nativeCopies, 0);
		assert.equal(sourceHost.resources.size + targetHost.resources.size, 0);
	});
}

test('FileService rolls back a failed mounted directory copy without replaying native or byte writes', async () => {
	const sourceRoot = createSshRemoteWorkspaceUri('source-host', '/source');
	const targetRoot = createSshRemoteWorkspaceUri('target-host', '/target');
	using sourceStorage = new InMemoryFileSystemProvider();
	using targetStorage = new InMemoryFileSystemProvider();
	await sourceStorage.createDirectory(sourceRoot);
	await targetStorage.createDirectory(targetRoot);
	const sourceHost = copyConnection(sourceStorage, sourceRoot, 'source');
	const targetHost = copyConnection(targetStorage, targetRoot, 'target');
	const failure = new Error('Publication failed after storage accepted the bytes');
	const failedPath = 'copied/second.bin';
	const write = targetHost.connection.api.writeBinaryFile;
	const attempts: string[] = [];
	targetHost.connection.api.writeBinaryFile = async params => {
		attempts.push(params.path);
		const written = await write(params);
		if (params.path === failedPath) { throw failure; }
		return written;
	};
	using provider = new AgentHostFileSystemProvider({ api: unavailableFileApi(), resourceApi: unavailableResourceApi() });
	using sourceMount = provider.registerAuthority(sourceRoot.authority, sourceHost.connection);
	using targetMount = provider.registerAuthority(targetRoot.authority, targetHost.connection);
	using files = new FileService();
	using registration = files.registerProvider('ash-remote', provider);
	const source = URI.joinPath(sourceRoot, 'folder');
	await sourceStorage.createDirectory(source);
	for (const name of ['first.bin', 'second.bin']) {
		await sourceStorage.writeFile(URI.joinPath(source, name), new Uint8Array([42]), { create: true, overwrite: false });
	}
	const target = URI.joinPath(targetRoot, 'copied');

	await assert.rejects(files.copy(source, target), error => error === failure);
	assert.deepEqual(attempts, ['copied/first.bin', failedPath]);
	await assert.rejects(targetStorage.stat(target), FileNotFoundError);
	assert.equal((await sourceStorage.readDirectory(source)).length, 2);
	assert.equal(sourceHost.nativeCopies + targetHost.nativeCopies, 0);
	assert.equal(sourceHost.resources.size + targetHost.resources.size, 0);
});

test('FileService rejects generic directory copies into themselves before publishing a destination', async () => {
	using storage = new TestFileProvider('generic');
	storage.setCapabilities(FileSystemProviderCapabilities.FileReadWrite);
	using files = new FileService();
	using registration = files.registerProvider('file', storage);
	const source = URI.file('/source');
	storage.addDirectory(source, []);
	const target = URI.joinPath(source, 'child');

	await assert.rejects(files.copy(source, target), FileOperationNotSupportedError);
	await assert.rejects(storage.stat(target), FileNotFoundError);
	assert.deepEqual(storage.writeRequests, []);
});

test('FileService resumes native host copies after the final mounted connection is released', async () => {
	const remoteRoot = createSshRemoteWorkspaceUri('other-host', '/project');
	using remoteStorage = new InMemoryFileSystemProvider();
	await remoteStorage.createDirectory(remoteRoot);
	const remote = copyConnection(remoteStorage, remoteRoot, 'remote');
	const calls: unknown[] = [];
	const nativeFailure = new Error('Native copy outcome is unknown');
	let failNativeCopy = false;
	using provider = new AgentHostFileSystemProvider({
		api: { ...unavailableFileApi(), copy: async params => { calls.push(params); if (failNativeCopy) { throw nativeFailure; } } },
		resourceApi: unavailableResourceApi(),
		directories: () => [{ uri: URI.file('/primary'), target: { type: 'environment', dirId: 'primary' } }],
	});
	using files = new FileService();
	using localRegistration = files.registerProvider('file', provider);
	using remoteRegistration = files.registerProvider('ash-remote', provider);
	const source = URI.file('/primary/source.bin');
	const target = URI.file('/primary/target.bin');
	using mount = provider.registerAuthority(remoteRoot.authority, remote.connection);
	assert.equal(files.hasCapability(source, FileSystemProviderCapabilities.FileFolderCopy), false);
	mount.dispose();
	assert.equal(files.hasCapability(source, FileSystemProviderCapabilities.FileFolderCopy), true);

	await files.copy(source, target);
	assert.deepEqual(calls, [{ sourceDirId: 'primary', source: 'source.bin', targetDirId: 'primary', target: 'target.bin' }]);
	failNativeCopy = true;
	await assert.rejects(files.copy(source, target), error => error === nativeFailure);
	assert.equal(calls.length, 2);
});

function copyConnection(storage: InMemoryFileSystemProvider, root: URI, id: string) {
	let nextResource = 0;
	let nativeCopies = 0;
	const resources = new Map<string, Uint8Array>();
	const resource = (params: Parameters<IFileApi['getMetadata']>[0]): URI => {
		assert.equal(params.dirId, id);
		const result = workspaceResourceFromPath(root, params.path);
		assert.ok(result);
		return result;
	};
	const metadata = (stat: IFileStat) => ({
		fileType: stat.kind === FileKind.Directory ? 'directory' as const : 'file' as const,
		sizeBytes: stat.sizeBytes,
		readonly: stat.readonly,
		modifiedAtMillis: stat.modifiedAtMillis ?? null,
	});
	const connection: IRemoteFilesystemConnection = {
		directories: () => [{ uri: root, target: { type: 'environment', dirId: id } }],
		api: {
			...unavailableFileApi(),
			getMetadata: async params => metadata(await storage.stat(resource(params))),
			readDirectory: async params => {
				const entries = await storage.readDirectory(resource(params));
				return { entries: entries.map(entry => ({ name: entry.name, fileType: entry.kind === FileKind.Directory ? 'directory' as const : 'file' as const })) };
			},
			readBinaryFile: async params => {
				const content = await storage.readFile(resource(params));
				const resourceId = `${id}:${++nextResource}`;
				resources.set(resourceId, content.bytes);
				return { resource: { resourceId, mimeType: 'application/octet-stream', size: content.bytes.byteLength, sha256: `sha256:${createHash('sha256').update(content.bytes).digest('hex')}` }, revision: content.revision };
			},
			writeBinaryFile: async params => {
				assert.equal(params.options?.mode, 'create');
				const written = await storage.writeFile(resource(params), Buffer.from(params.dataBase64, 'base64'), { create: true, overwrite: false });
				return { metadata: metadata(written.stat), revision: written.revision };
			},
			createDirectory: async params => metadata(await storage.createDirectory(resource(params))),
			delete: async params => storage.delete(resource(params), params.missing, params.mode),
			copy: async () => { nativeCopies++; throw new Error('Mounted connection must use generic copying'); },
		},
		resourceApi: {
			...unavailableResourceApi(),
			read: async params => {
				const bytes = resources.get(params.resourceId);
				assert.ok(bytes);
				const chunk = bytes.subarray(params.offset, params.offset + params.maxBytes);
				return { resourceId: params.resourceId, offset: params.offset, dataBase64: Buffer.from(chunk).toString('base64'), decodedLength: chunk.byteLength, eof: params.offset + chunk.byteLength === bytes.byteLength };
			},
			release: async params => { assert.equal(resources.delete(params.resourceId), true); },
		},
	};
	return { connection, resources, get nativeCopies() { return nativeCopies; } };
}

suite('FileService pinned copy scopes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('retiring the target during a source read cannot publish into its replacement connection', async () => {
		using fixture = await copyScopeFixture();
		const pendingRead = pauseCopySource(fixture.sourceHost.connection);
		const writes: string[] = [];
		const write = fixture.targetHost.connection.api.writeBinaryFile;
		fixture.targetHost.connection.api.writeBinaryFile = async params => { writes.push('old'); return write(params); };
		const copying = fixture.files.copy(fixture.source, fixture.target);
		const rejected = assert.rejects(copying, CancellationError);
		await pendingRead.started.p;
		fixture.targetMount!.dispose();
		const replacement = copyConnection(fixture.replacementStorage, fixture.targetRoot, 'replacement');
		const replacementWrite = replacement.connection.api.writeBinaryFile;
		replacement.connection.api.writeBinaryFile = async params => { writes.push('new'); return replacementWrite(params); };
		using mounted = fixture.provider.registerAuthority(fixture.targetRoot.authority, replacement.connection);
		try {
			await rejected;
			assert.equal(pendingRead.resume.isSettled, false);
		} finally { await pendingRead.resume.complete(); }
		await pendingRead.released.p;
		assert.deepEqual(writes, []);
		assert.deepEqual(await fixture.replacementStorage.readDirectory(fixture.targetRoot), []);
	});

	test('a failed directory copy cannot roll back a replacement connection directory', async () => {
		using fixture = await copyScopeFixture();
		const started = new DeferredPromise<void>();
		const resume = new DeferredPromise<void>();
		const finished = new DeferredPromise<void>();
		const sourceDirectory = URI.joinPath(fixture.sourceRoot, 'directory');
		await fixture.sourceStorage.createDirectory(sourceDirectory);
		fixture.sourceHost.connection.api.readDirectory = async () => {
			void started.complete();
			try { await resume.p; throw new Error('Old source enumeration failed'); }
			finally { void finished.complete(); }
		};
		const deletes: string[] = [];
		const originalDelete = fixture.targetHost.connection.api.delete;
		fixture.targetHost.connection.api.delete = async params => { deletes.push('old'); await originalDelete(params); };
		const copying = fixture.files.copy(sourceDirectory, fixture.target);
		const rejected = assert.rejects(copying, CancellationError);
		await started.p;
		fixture.targetMount!.dispose();
		await fixture.replacementStorage.createDirectory(fixture.target);
		const retained = URI.joinPath(fixture.target, 'keep.txt');
		await fixture.replacementStorage.writeFile(retained, new Uint8Array([42]), { create: true, overwrite: false });
		const replacement = copyConnection(fixture.replacementStorage, fixture.targetRoot, 'replacement');
		const replacementDelete = replacement.connection.api.delete;
		replacement.connection.api.delete = async params => { deletes.push('new'); await replacementDelete(params); };
		using mounted = fixture.provider.registerAuthority(fixture.targetRoot.authority, replacement.connection);
		try { await rejected; }
		finally { await resume.complete(); }
		await finished.p;
		assert.deepEqual(deletes, []);
		assert.deepEqual((await fixture.replacementStorage.readFile(retained)).bytes, new Uint8Array([42]));
	});

	test('mounting and retiring an unrelated route leaves a valid copy running', async () => {
		using fixture = await copyScopeFixture();
		const pendingRead = pauseCopySource(fixture.sourceHost.connection);
		const copying = fixture.files.copy(fixture.source, fixture.target);
		await pendingRead.started.p;
		const unrelatedRoot = createSshRemoteWorkspaceUri('unrelated', '/other');
		const unrelated = copyConnection(fixture.replacementStorage, unrelatedRoot, 'unrelated');
		using mounted = fixture.provider.registerAuthority(unrelatedRoot.authority, unrelated.connection);
		mounted.dispose();
		await pendingRead.resume.complete();
		await copying;
		assert.deepEqual(Uint8Array.from((await fixture.targetStorage.readFile(fixture.target)).bytes), new Uint8Array([1, 2, 3]));
		assert.equal(fixture.sourceHost.resources.size, 0);
	});

	for (const primary of [false, true]) {
		test(`a same-generation ${primary ? 'primary' : 'selected route'} reconnect retires the copy before publication`, async () => {
			using fixture = await copyScopeFixture(primary);
			const pendingRead = pauseCopySource(fixture.sourceHost.connection);
			let writes = 0;
			const write = fixture.targetHost.connection.api.writeBinaryFile;
			fixture.targetHost.connection.api.writeBinaryFile = async params => { writes++; return write(params); };
			const copying = fixture.files.copy(fixture.source, fixture.target);
			const rejected = assert.rejects(copying, CancellationError);
			await pendingRead.started.p;
			fixture.targetChanged.fire();
			try {
				await rejected;
				assert.equal(pendingRead.resume.isSettled, false);
			} finally { await pendingRead.resume.complete(); }
			await pendingRead.released.p;
			assert.equal(writes, 0);
			await assert.rejects(fixture.targetStorage.stat(fixture.target), FileNotFoundError);
		});
	}
});

async function copyScopeFixture(primary = false) {
	const resources = new DisposableStore();
	try {
		const sourceRoot = createSshRemoteWorkspaceUri('source', '/source');
		const targetRoot = createSshRemoteWorkspaceUri('target', '/target');
		const sourceStorage = resources.add(new InMemoryFileSystemProvider());
		const targetStorage = resources.add(new InMemoryFileSystemProvider());
		const replacementStorage = resources.add(new InMemoryFileSystemProvider());
		await sourceStorage.createDirectory(sourceRoot);
		await targetStorage.createDirectory(targetRoot);
		await replacementStorage.createDirectory(targetRoot);
		const source = URI.joinPath(sourceRoot, 'source.bin');
		const target = URI.joinPath(targetRoot, 'copied');
		await sourceStorage.writeFile(source, new Uint8Array([1, 2, 3]), { create: true, overwrite: false });
		const sourceHost = copyConnection(sourceStorage, sourceRoot, 'source');
		let targetHost = copyConnection(targetStorage, targetRoot, 'target');
		const targetChanged = resources.add(new Emitter<void>());
		targetHost = { ...targetHost, connection: { ...targetHost.connection, api: { ...targetHost.connection.api, onDidChangeConnection: targetChanged.event } } };
		const provider = resources.add(new AgentHostFileSystemProvider(primary ? targetHost.connection : { api: unavailableFileApi(), resourceApi: unavailableResourceApi() }));
		resources.add(provider.registerAuthority(sourceRoot.authority, sourceHost.connection));
		const targetMount = primary ? undefined : resources.add(provider.registerAuthority(targetRoot.authority, targetHost.connection));
		const files = resources.add(new FileService());
		resources.add(files.registerProvider('ash-remote', provider));
		return { ...toDisposable(() => resources.dispose()), provider, files, sourceRoot, targetRoot, source, target, sourceStorage, targetStorage, replacementStorage, sourceHost, targetHost, targetMount, targetChanged };
	} catch (error) { resources.dispose(); throw error; }
}

function pauseCopySource(connection: IRemoteFilesystemConnection) {
	const started = new DeferredPromise<void>();
	const resume = new DeferredPromise<void>();
	const released = new DeferredPromise<void>();
	const read = connection.api.readBinaryFile;
	const release = connection.resourceApi.release;
	connection.api.readBinaryFile = async params => { void started.complete(); await resume.p; return read(params); };
	connection.resourceApi.release = async params => { await release(params); await released.complete(); };
	return { started, resume, released };
}
