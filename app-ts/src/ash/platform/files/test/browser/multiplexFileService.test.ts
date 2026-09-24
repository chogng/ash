import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { MultiplexFileService } from '../../../../platform/files/browser/multiplexFileService.js';
import type { IFileSystemProvider } from '../../../../platform/files/common/fileSystemProviderService.js';
import { FileKind, type FileDeleteMode, type FileExistingTargetBehavior, type FileMissingTargetBehavior, type IFileBytes, type IFileChangeEvent, type IFileContent, type IFileEntry, type IFileStat, type IFileWriteRequest, type IFileWriteResult } from '../../../../platform/files/common/files.js';

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

class TestFileProvider implements IFileSystemProvider {
	private readonly changes = new Emitter<IFileChangeEvent>();
	public readonly onDidChangeFiles = this.changes.event;

	constructor(private readonly label: string) {}

	public emit(resource: URI): void {
		this.changes.fire({ resources: [resource] });
	}

	public stat(resource: URI): Promise<IFileStat> {
		return Promise.resolve({ resource, kind: FileKind.File, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined });
	}

	public readDirectory(_resource: URI): Promise<readonly IFileEntry[]> {
		return Promise.resolve([]);
	}

	public readFile(resource: URI): Promise<IFileContent> {
		return Promise.resolve({ resource, content: `${this.label}:${resource.toString()}`, revision: this.label });
	}

	public readFileBytes(resource: URI): Promise<IFileBytes> {
		return Promise.resolve({ resource, bytes: new Uint8Array(), revision: this.label });
	}

	public writeFile(request: IFileWriteRequest): Promise<IFileWriteResult> {
		return Promise.resolve({ stat: { resource: request.resource, kind: FileKind.File, sizeBytes: request.content.length, readonly: false, modifiedAtMillis: undefined }, revision: this.label });
	}

	public createFile(resource: URI, _existing: FileExistingTargetBehavior): Promise<IFileStat> {
		return this.stat(resource);
	}

	public rename(_source: URI, _target: URI, _existing: FileExistingTargetBehavior): Promise<void> {
		return Promise.resolve();
	}

	public delete(_resource: URI, _missing: FileMissingTargetBehavior, _mode: FileDeleteMode): Promise<void> {
		return Promise.resolve();
	}

	public dispose(): void {
		this.changes.dispose();
	}

	public [Symbol.dispose](): void {
		this.dispose();
	}
}
