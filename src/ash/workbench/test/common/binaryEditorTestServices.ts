import { Disposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { Event } from '../../../base/common/event.js';
import type { URI } from '../../../base/common/uri.js';
import { FileKind, FileSystemProviderCapabilities, type IFileSystemProvider, type IFileStat, type IFileBytes, type IFileEntry } from '../../../platform/files/common/files.js';

export class BinaryEditorTestFileSystemProvider implements IFileSystemProvider {
	public readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy;
	public readonly onDidChangeCapabilities = Event.None;
	public watch(): IDisposable { return Disposable.None; }

	public readonly onDidChangeFiles = Event.None;
	constructor(private readonly bytes: Uint8Array) { }
	public async stat(resource: URI): Promise<IFileStat> { return { resource, kind: FileKind.File, sizeBytes: this.bytes.length, readonly: true, modifiedAtMillis: undefined }; }
	public async readFile(resource: URI): Promise<IFileBytes> { return { resource, bytes: this.bytes, revision: 'revision-1' }; }
	public async readDirectory(): Promise<readonly IFileEntry[]> { return []; }
	public async writeFile(): Promise<never> { throw new Error('read only'); }
	public async createFile(): Promise<never> { throw new Error('read only'); }
	public async createDirectory(): Promise<never> { throw new Error('read only'); }
	public async copy(): Promise<void> { throw new Error('Copy is not used in this test'); }
	public async rename(): Promise<never> { throw new Error('read only'); }
	public async delete(): Promise<never> { throw new Error('read only'); }
}
