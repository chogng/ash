import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter } from "../../../../base/common/event.js";
import { URI } from "../../../../base/common/uri.js";
import { AppServerRemoteError } from "../../../../platform/app-server/common/appServerError.js";
import { createDisconnectedFileApi } from "../../../../platform/files/browser/fileApi.js";
import { BrowserFileService, workspaceResourceFromPath } from "../../../../platform/files/browser/fileService.js";
import { FileKind, FileRevisionConflictError } from "../../../../platform/files/common/files.js";
import type { FsChanged } from "../../../app-server/common/generated/index.js";
import { workspaceRelativePath, type IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { WorkspaceContextService } from "../../../../workbench/services/workspaces/browser/workspaceContextService.js";
import { createSshRemoteWorkspaceUri } from "../../../../platform/remote/common/remote.js";

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
	const root = URI.file("C:/project");
	assert.equal(workspaceRelativePath(root, URI.file("C:/project")), ".");
	assert.equal(
		workspaceRelativePath(root, URI.file("C:/project/src/main.ts")),
		"src/main.ts",
	);
	assert.throws(
		() => workspaceRelativePath(root, URI.file("C:/project-other/file.ts")),
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
	assert.equal(workspaceResourceFromPath(URI.file("C:/project"), "src\\generated\\main.ts")?.toString(), "file:///C:/project/src/generated/main.ts");
});

test("BrowserFileService maps wire entries back to resource URIs", async () => {
	const root = URI.file("C:/project");
	const releasedResources: string[] = [];
	using workspaceContextService: IWorkspaceContextService =
		new WorkspaceContextService({ id: "workspace", uri: root });
	using service = new BrowserFileService({
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
			readFile: async ({ path }) => {
				assert.equal(path, "src/main.ts");
				return { content: "export {};", revision: "revision-read" };
			},
			readBinaryFile: async ({ path }) => {
				assert.equal(path, "paper.pdf");
				return {
					resource: { resourceId: "resource-pdf", mimeType: "application/octet-stream", size: 9, sha256: "sha256:pdf" },
					revision: "revision-binary",
				};
			},
			writeFile: async ({ path, content, expectedRevision }) => {
				assert.equal(path, "src/main.ts");
				assert.equal(content, "export const saved = true;");
				assert.equal(expectedRevision, "revision-read");
				return {
					metadata: {
						fileType: "file",
						sizeBytes: content.length,
						readonly: false,
						modifiedAtMillis: 123,
					},
					revision: "revision-write",
				};
			},
			writeBinaryFile: async ({ path, dataBase64 }) => {
				assert.deepEqual({ path, dataBase64 }, { path: 'payload.bin', dataBase64: 'AP8q' });
				return { metadata: { fileType: 'file', sizeBytes: 3, readonly: false, modifiedAtMillis: null }, revision: 'revision-bytes' };
			},
			createFile: async ({ path }) => ({ fileType: "file", sizeBytes: path.length - path.length, readonly: false, modifiedAtMillis: null }),
			createDirectory: async ({ path }) => {
				assert.equal(path, 'new-folder');
				return { fileType: 'directory', sizeBytes: 0, readonly: false, modifiedAtMillis: null };
			},
			copy: async () => { throw new Error('not used'); },
			pasteSystemFiles: async () => false,
			rename: async () => {},
			delete: async () => {},
		},
		resourceApi: {
			metadata: async () => { throw new Error("not used"); },
			read: async ({ resourceId, offset, maxBytes }) => {
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
		(await service.readDirectory(URI.file("C:/project/src"))).map(entry => ({ ...entry, resource: entry.resource.toString() })),
		[{
			resource: URI.file("C:/project/src/main.ts").toString(),
			name: "main.ts",
			kind: FileKind.File,
		}],
	);
	assert.deepEqual(
		await service.readFile(URI.file("C:/project/src/main.ts")),
		{ resource: URI.file("C:/project/src/main.ts"), content: "export {};", revision: "revision-read" },
	);
	assert.deepEqual(
		await service.readFileBytes(URI.file("C:/project/paper.pdf")),
		{ resource: URI.file("C:/project/paper.pdf"), bytes: new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10]), revision: "revision-binary" },
	);
	assert.deepEqual(releasedResources, ["resource-pdf"]);
	assert.equal((await service.createDirectory(URI.file('C:/project/new-folder'))).kind, FileKind.Directory);
	assert.deepEqual(
		await service.writeFile({
			resource: URI.file("C:/project/src/main.ts"),
			content: "export const saved = true;",
			expectedRevision: "revision-read",
		}),
		{
			stat: {
				resource: URI.file("C:/project/src/main.ts"),
				kind: FileKind.File,
				sizeBytes: 26,
				readonly: false,
				modifiedAtMillis: 123,
			},
			revision: "revision-write",
		},
	);
	assert.deepEqual(await service.writeFileBytes(URI.file('C:/project/payload.bin'), new Uint8Array([0, 255, 42])), {
		stat: { resource: URI.file('C:/project/payload.bin'), kind: FileKind.File, sizeBytes: 3, readonly: false, modifiedAtMillis: undefined },
		revision: 'revision-bytes',
	});
});

test("BrowserFileService maps App Server revision conflicts to the file contract", async () => {
	const resource = URI.file("C:/project/src/main.ts");
	using workspaceContextService: IWorkspaceContextService = new WorkspaceContextService({ id: "workspace", uri: URI.file("C:/project") });
	using service = new BrowserFileService({
		workspaceContextService,
		resourceApi: unavailableResourceApi(),
		api: {
			getMetadata: async () => { throw new Error("unavailable"); },
			readDirectory: async () => { throw new Error("unavailable"); },
			readFile: async () => { throw new Error("unavailable"); },
			readBinaryFile: async () => { throw new Error("unavailable"); },
			writeFile: async () => { throw new AppServerRemoteError(-32000, "Revision conflict", { kind: "FileSystemRevisionConflict" }); },
			writeBinaryFile: async () => { throw new Error('unavailable'); },
			createFile: async () => { throw new Error("unavailable"); },
			createDirectory: async () => { throw new Error('unavailable'); },
			copy: async () => { throw new Error('unavailable'); },
			pasteSystemFiles: async () => false,
			rename: async () => { throw new Error("unavailable"); },
			delete: async () => { throw new Error("unavailable"); },
		},
	});

	await assert.rejects(service.writeFile({ resource, content: "local", expectedRevision: "stale" }), FileRevisionConflictError);
});

test("BrowserFileService reads connection-owned binary resources in bounded chunks", async () => {
	const root = URI.file("C:/project");
	const resource = URI.file("C:/project/large.pdf");
	const bytes = new Uint8Array(262_145);
	bytes[0] = 37;
	bytes[262_144] = 70;
	const readOffsets: number[] = [];
	const releasedResources: string[] = [];
	using workspaceContextService: IWorkspaceContextService = new WorkspaceContextService({ id: "workspace", uri: root });
	using service = new BrowserFileService({
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

	assert.deepEqual((await service.readFileBytes(resource)).bytes, bytes);
	assert.deepEqual(readOffsets, [0, 262_144]);
	assert.deepEqual(releasedResources, ["resource-large"]);
});

test("BrowserFileService maps App Server invalidations to workspace resources", () => {
	const root = URI.file("C:/project");
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

	assert.deepEqual(observed, [[URI.file("C:/project/src/main.ts"), URI.file("C:/project/README.md")], undefined]);
});

test("BrowserFileService routes nested multi-root resources by Workspace folder id", async () => {
	using workspaceContextService: IWorkspaceContextService = new WorkspaceContextService({
		id: "multi-root",
		folders: [
			{ id: "parent", uri: URI.file("C:/project"), name: "parent", index: 0 },
			{ id: "nested", uri: URI.file("C:/project/packages/nested"), name: "nested", index: 1 },
		],
		configuration: URI.file("C:/project.code-workspace"),
	});
	const requests: { readonly dirId?: string; readonly path: string }[] = [];
	const copies: unknown[] = [];
	const pastes: unknown[] = [];
	using service = new BrowserFileService({
		workspaceContextService,
		resourceApi: unavailableResourceApi(),
		api: {
			...unavailableFileApi(),
			readFile: async params => {
				requests.push(params);
				return { content: params.path, revision: "revision" };
			},
			copy: async params => { copies.push(params); },
			pasteSystemFiles: async params => { pastes.push(params); return true; },
		},
	});

	await service.readFile(URI.file("C:/project/README.md"));
	await service.readFile(URI.file("C:/project/packages/nested/src/main.ts"));

	assert.deepEqual(requests, [
		{ dirId: "parent", path: "README.md" },
		{ dirId: "nested", path: "src/main.ts" },
	]);
	await service.copy(URI.file("C:/project/README.md"), URI.file("C:/project/packages/nested/README.md"));
	assert.deepEqual(copies, [{ sourceDirId: 'parent', source: 'README.md', targetDirId: 'nested', target: 'README.md' }]);
	assert.equal(await service.pasteSystemFiles(URI.file('C:/project/packages/nested'), true), true);
	assert.deepEqual(pastes, [{ dirId: 'nested', path: '.', moveRequested: true }]);
	assert.throws(() => service.pasteSystemFiles(URI.file('C:/outside'), false), /current workspace folder/);
	assert.throws(() => service.rename(URI.file("C:/project/README.md"), URI.file("C:/project/packages/nested/README.md"), "error"), /across workspace folders/i);
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
