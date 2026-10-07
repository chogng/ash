import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { type IFileWriteOptions, type IWatchOptions, FileSystemProviderCapabilities } from '../../common/files.js';
import { FileService } from '../../../../platform/files/common/fileService.js';
import { FileOperationNotSupportedError, type IFileSystemProvider, type FileDeleteMode, type FileExistingTargetBehavior, type FileMissingTargetBehavior, type IFileBytes, type IFileChangeEvent, type IFileEntry, type IFileStat, type IFileWriteResult } from '../../../../platform/files/common/files.js';
import assert from "node:assert/strict";
import { suite, test } from "mocha";
import { Emitter, Event } from "../../../../base/common/event.js";
import { URI } from "../../../../base/common/uri.js";
import { AppServerRemoteError } from "../../../../platform/app-server/common/appServerError.js";
import { createDisconnectedFileApi } from "../../../../platform/files/browser/fileApi.js";
import { BrowserFileService, workspaceResourceFromPath } from "../../../../platform/files/browser/fileService.js";
import { FileKind, FileNotFoundError, FileRevisionConflictError } from "../../../../platform/files/common/files.js";
import type { FsChanged } from "../../../../../../.build/protocol/typescript/index.js";
import { workspaceRelativePath, type IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { WorkspaceContextService } from "../../../../workbench/services/workspaces/browser/workspaceContextService.js";
import { createSshRemoteWorkspaceUri } from "../../../../platform/remote/common/remote.js";
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { WorkspaceWatcher } from '../../../../workbench/contrib/files/browser/workspaceWatcher.js';

test("disconnected file API declines system file paste without requiring App Server", async () => {
	const api = createDisconnectedFileApi(() => { throw new Error("App Server unavailable"); });
	assert.equal(await api.pasteSystemFiles({ dirId: "root", path: ".", moveRequested: false }), false);
});

test("BrowserFileService passes the paste destination and move request to App Server", async () => {
	using workspace = new WorkspaceContextService({ id: 'project', uri: URI.file('/project') });
	const requests: unknown[] = [];
	using service = new BrowserFileService({
		workspaceContextService: workspace,
		resourceApi: unavailableResourceApi(),
		api: {
			...unavailableFileApi(),
			pasteSystemFiles: async params => { requests.push(params); return true; },
		},
	});
	assert.equal(await service.pasteSystemFiles(URI.file('/project/destination'), true), true);
	assert.deepEqual(requests, [{ dirId: 'project', path: 'destination', moveRequested: true }]);
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

test("BrowserFileService maps wire entries back to resource URIs", async () => {
	const root = URI.parse("file:///C:/project");
	const releasedResources: string[] = [];
	using workspaceContextService: IWorkspaceContextService =
		new WorkspaceContextService({ id: "workspace", uri: root });
	const service = new BrowserFileService({
		workspaceContextService,
		api: {
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

test("BrowserFileService maps App Server revision conflicts to the file contract", async () => {
	const resource = URI.parse("file:///C:/project/src/main.ts");
	using workspaceContextService: IWorkspaceContextService = new WorkspaceContextService({ id: "workspace", uri: URI.parse("file:///C:/project") });
	const service = new BrowserFileService({
		workspaceContextService,
		resourceApi: unavailableResourceApi(),
		api: {
			getMetadata: async () => { throw new Error("unavailable"); },
			readDirectory: async () => { throw new Error("unavailable"); },
			readFile: async () => { throw new Error("unavailable"); },
			readBinaryFile: async () => { throw new Error("unavailable"); },
			writeFile: async () => { throw new Error('unavailable'); },
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

test('BrowserFileService reports missing entries through the file contract for every read operation', async () => {
	using workspace = new WorkspaceContextService({ id: 'project', uri: URI.file('/project') });
	const resource = URI.file('/project/missing');
	let error: Error = new AppServerRemoteError(-32000, 'Missing entry', { kind: 'FileSystemNotFound' });
	const missing = async (): Promise<never> => { throw error; };
	using service = new BrowserFileService({
		workspaceContextService: workspace,
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

test("BrowserFileService reads connection-owned binary resources in bounded chunks", async () => {
	const root = URI.parse("file:///C:/project");
	const resource = URI.parse("file:///C:/project/large.pdf");
	const bytes = new Uint8Array(17 * 1024 * 1024 + 1);
	bytes[0] = 37;
	bytes[bytes.length - 1] = 70;
	const readOffsets: number[] = [];
	const releasedResources: string[] = [];
	using workspaceContextService: IWorkspaceContextService = new WorkspaceContextService({ id: "workspace", uri: root });
	const service = new BrowserFileService({
		workspaceContextService,
		api: {
			getMetadata: async () => { throw new Error("not used"); },
			readDirectory: async () => { throw new Error("not used"); },
			readFile: async () => { throw new Error("not used"); },
			readBinaryFile: async () => ({
				resource: { resourceId: "resource-large", mimeType: "application/octet-stream", size: bytes.length, sha256: "sha256:large" },
				revision: "revision-large",
			}),
			writeFile: async () => { throw new Error("not used"); },
			writeBinaryFile: async () => { throw new Error('not used'); },
			createFile: async () => { throw new Error("not used"); },
			createDirectory: async () => { throw new Error('not used'); },
			copy: async () => { throw new Error('not used'); },
			pasteSystemFiles: async () => false,
			rename: async () => { throw new Error("not used"); },
			delete: async () => { throw new Error("not used"); },
		},
		resourceApi: {
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

test("BrowserFileService maps App Server invalidations to workspace resources", () => {
	const root = URI.parse("file:///C:/project");
	using workspaceContextService: IWorkspaceContextService = new WorkspaceContextService({ id: "workspace", uri: root });
	using changes = new Emitter<FsChanged>();
	using service = new BrowserFileService({
		workspaceContextService,
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

test("BrowserFileService routes nested multi-root resources by Workspace folder id", async () => {
	using workspaceContextService: IWorkspaceContextService = new WorkspaceContextService({
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
	const service = new BrowserFileService({
		workspaceContextService,
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
	assert.throws(() => service.pasteSystemFiles(URI.parse('file:///C:/outside'), false), /current workspace folder/);
	assert.throws(() => service.rename(URI.parse("file:///C:/project/README.md"), URI.parse("file:///C:/project/packages/nested/README.md"), "error"), /across workspace folders/i);
});

function unavailableFileApi() {
	return {
		getMetadata: async () => { throw new Error("unavailable"); },
		readDirectory: async () => { throw new Error("unavailable"); },
		readFile: async () => { throw new Error("unavailable"); },
		readBinaryFile: async () => { throw new Error("unavailable"); },
		writeFile: async () => { throw new Error("unavailable"); },
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

test('BrowserFileService releases a byte resource when reading its content fails', async () => {
	using workspace = new WorkspaceContextService({ id: 'read-failure', uri: URI.file('/workspace') });
	const failure = new Error('Resource read failed');
	const released: string[] = [];
	using provider = new BrowserFileService({
		workspaceContextService: workspace,
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

	test('workspace replacement releases old roots and forwards only current workspace changes', () => {
		using provider = new TestFileProvider('workspace');
		using service = new FileService();
		using registration = service.registerProvider('file', provider);
		using workspace = new WorkspaceContextService({ id: 'first', uri: URI.file('/first') });
		using watcher = new WorkspaceWatcher(service, workspace);
		const observed: (readonly URI[] | undefined)[] = [];
		using listener = watcher.onDidChange(event => observed.push(event));
		workspace.updateWorkspace({ id: 'second', uri: URI.file('/second') });
		provider.emit(URI.file('/first/old.txt'));
		provider.emit(URI.file('/second/new.txt'));
		assert.deepEqual(provider.watchRequests.map(request => ({ resource: request.resource, options: request.options, disposed: request.disposed })), [
			{ resource: URI.file('/first'), options: { recursive: true, excludes: [] }, disposed: true },
			{ resource: URI.file('/second'), options: { recursive: true, excludes: [] }, disposed: false },
		]);
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
