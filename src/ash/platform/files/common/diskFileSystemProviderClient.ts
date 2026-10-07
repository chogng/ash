import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { FileNotFoundError, FileRevisionConflictError, FileSystemProviderCapabilities, type FileDeleteMode, type FileExistingTargetBehavior, type FileMissingTargetBehavior, type IFileBytes, type IFileChangeEvent, type IFileEntry, type IFileSystemProvider, type IFileStat, type IFileWriteOptions, type IFileWriteResult, type IWatchOptions } from './files.js';

export const LOCAL_FILE_SYSTEM_CHANNEL_NAME = 'ash:files';
export const LOCAL_FILE_SYSTEM_CHANGED_CHANNEL = 'ash:files:changed';

/** URI serialization and error transport for the desktop file provider. */
export class DiskFileSystemProviderClient extends Disposable implements IFileSystemProvider {
	public readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy;
	public readonly onDidChangeCapabilities = Event.None;
	private readonly changes = this._register(new Emitter<IFileChangeEvent>());
	public readonly onDidChangeFiles = this.changes.event;

	constructor(private readonly invoke: (request: unknown) => Promise<unknown>, onDidChange: (listener: (resources: unknown) => void) => { dispose(): void; }) {
		super();
		const subscription = onDidChange(value => {
			if (value === undefined) { this.changes.fire({ resources: undefined }); return; }
			if (!Array.isArray(value) || value.some(resource => typeof resource !== 'string')) throw new TypeError('Invalid file-change resources');
			const resources = value.map(resource => URI.parse(resource));
			if (resources.some(resource => resource.scheme !== 'file' || resource.query || resource.fragment)) throw new TypeError('Invalid file-change resource');
			this.changes.fire({ resources });
		});
		this._register(toDisposable(() => subscription.dispose()));
	}

	public async stat(resource: URI): Promise<IFileStat> {
		const stat = await this.call<IFileStat>('stat', resource);
		return { ...stat, resource };
	}
	public async readDirectory(resource: URI): Promise<readonly IFileEntry[]> {
		const entries = await this.call<readonly { name: string; kind: IFileEntry['kind']; resource: string; }[]>('readDirectory', resource);
		return entries.map(entry => ({ ...entry, resource: URI.parse(entry.resource) }));
	}
	public async readFile(resource: URI): Promise<IFileBytes> {
		const content = await this.call<IFileBytes>('readFile', resource);
		return { ...content, resource };
	}
	public watch(resource: URI, _options: IWatchOptions): IDisposable {
		this.assertNotDisposed();
		if (resource.scheme !== 'file' || resource.query || resource.fragment) throw new TypeError('Expected a local file resource');
		// The window's host provider continuously watches its granted profile root.
		return Disposable.None;
	}
	public async writeFile(resource: URI, bytes: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult> {
		const result = await this.call<IFileWriteResult>('writeFile', resource, { bytes, options });
		this.changes.fire({ resources: [resource] });
		return { ...result, stat: { ...result.stat, resource } };
	}
	public async createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat> {
		const result = await this.call<IFileStat>('createFile', resource, { existing });
		this.changes.fire({ resources: [resource] });
		return { ...result, resource };
	}
	public async createDirectory(resource: URI): Promise<IFileStat> {
		const result = await this.call<IFileStat>('createDirectory', resource);
		this.changes.fire({ resources: [resource] });
		return { ...result, resource };
	}
	public async copy(source: URI, target: URI): Promise<void> {
		await this.call('copy', source, { target: target.toString() });
		this.changes.fire({ resources: [target] });
	}
	public async rename(source: URI, target: URI, existing: FileExistingTargetBehavior): Promise<void> {
		await this.call('rename', source, { target: target.toString(), existing });
		this.changes.fire({ resources: [source, target] });
	}
	public async delete(resource: URI, missing: FileMissingTargetBehavior, mode: FileDeleteMode): Promise<void> {
		await this.call('delete', resource, { missing, mode });
		this.changes.fire({ resources: [resource] });
	}

	private async call<T>(operation: string, resource: URI, args: object = {}): Promise<T> {
		const result = await this.invoke({ operation, resource: resource.toString(), ...args });
		if (!result || typeof result !== 'object' || !('ok' in result)) throw new Error('Invalid file provider response');
		if (result.ok === false && 'code' in result && 'message' in result) {
			if (result.code === 'notFound') throw new FileNotFoundError(resource);
			if (result.code === 'conflict') throw new FileRevisionConflictError(resource);
			throw new Error(String(result.message));
		}
		if (result.ok !== true || !('value' in result)) throw new Error('Invalid file provider result');
		return result.value as T;
	}
}
