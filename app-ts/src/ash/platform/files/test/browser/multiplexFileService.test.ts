import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { MultiplexFileService } from '../../../../platform/files/browser/multiplexFileService.js';
import type { IFileSystemProvider } from '../../../../platform/files/common/fileSystemProviderService.js';
import { FileKind, FileNotFoundError, type FileDeleteMode, type FileExistingTargetBehavior, type FileMissingTargetBehavior, type IFileBytes, type IFileChangeEvent, type IFileContent, type IFileEntry, type IFileStat, type IFileWriteRequest, type IFileWriteResult } from '../../../../platform/files/common/files.js';

test('MultiplexFileService routes exact schemes and forwards provider invalidations', async () => {
	using fallback = new TestFileProvider('fallback');
	using virtual = new TestFileProvider('virtual');
	using service = new MultiplexFileService(fallback);
	using registration = service.registerProvider('ash-test', virtual);
	const workspaceResource = URI.file('/workspace/file.txt');
	const virtualResource = URI.parse('ash-test:/resource.txt');
	const observed: string[] = [];
	using listener = service.onDidChangeFiles(event => observed.push(event.resources?.[0]?.toString() ?? '*'));

	assert.equal((await service.readFile(workspaceResource)).content, 'fallback:file:///workspace/file.txt');
	assert.equal((await service.readFile(virtualResource)).content, 'virtual:ash-test:/resource.txt');
	virtual.emit(virtualResource);
	assert.deepEqual(observed, ['ash-test:/resource.txt']);
	assert.throws(() => service.rename(virtualResource, workspaceResource, 'overwrite'), /across file system providers/);
	assert.throws(() => service.registerProvider('ash-test', virtual), /already registered/);

	registration.dispose();
	assert.equal((await service.readFile(virtualResource)).content, 'fallback:ash-test:/resource.txt');
});

test('MultiplexFileService copies directory bytes across file system providers', async () => {
	using workspace = new TestFileProvider('workspace');
	using virtual = new TestFileProvider('virtual');
	using service = new MultiplexFileService(workspace);
	using registration = service.registerProvider('ash-test', virtual);
	const source = URI.parse('ash-test:/source');
	const file = URI.joinPath(source, '100% ready.bin');
	const target = URI.file('/workspace/copied');
	virtual.addDirectory(source, [{ resource: file, name: '100% ready.bin', kind: FileKind.File }]);
	virtual.addFile(file, new Uint8Array([0, 255, 42]));

	await service.copy(source, target);

	assert.equal((await workspace.stat(target)).kind, FileKind.Directory);
	assert.deepEqual((await workspace.readFileBytes(URI.joinPath(target, '100% ready.bin'))).bytes, new Uint8Array([0, 255, 42]));
	await assert.rejects(service.copy(source, target), /already exists/);
});

test('MultiplexFileService removes an incomplete cross-provider copy', async () => {
	using workspace = new TestFileProvider('workspace');
	using virtual = new TestFileProvider('virtual');
	using service = new MultiplexFileService(workspace);
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

class TestFileProvider implements IFileSystemProvider {
	private readonly changes = new Emitter<IFileChangeEvent>();
	private readonly files = new Map<string, Uint8Array>();
	private readonly directories = new Map<string, readonly IFileEntry[]>();
	private failingRead: string | undefined;
	public readonly onDidChangeFiles = this.changes.event;

	constructor(private readonly label: string) {}

	public emit(resource: URI): void {
		this.changes.fire({ resources: [resource] });
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

	public readFile(resource: URI): Promise<IFileContent> {
		return Promise.resolve({ resource, content: `${this.label}:${resource.toString()}`, revision: this.label });
	}

	public readFileBytes(resource: URI): Promise<IFileBytes> {
		if (resource.toString() === this.failingRead) throw new Error('read failed');
		return Promise.resolve({ resource, bytes: this.files.get(resource.toString()) ?? new Uint8Array(), revision: this.label });
	}

	public writeFile(request: IFileWriteRequest): Promise<IFileWriteResult> {
		return Promise.resolve({ stat: { resource: request.resource, kind: FileKind.File, sizeBytes: request.content.length, readonly: false, modifiedAtMillis: undefined }, revision: this.label });
	}

	public writeFileBytes(resource: URI, bytes: Uint8Array): Promise<IFileWriteResult> {
		this.files.set(resource.toString(), bytes);
		return Promise.resolve({ stat: { resource, kind: FileKind.File, sizeBytes: bytes.length, readonly: false, modifiedAtMillis: undefined }, revision: this.label });
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
	}

	public [Symbol.dispose](): void {
		this.dispose();
	}
}
