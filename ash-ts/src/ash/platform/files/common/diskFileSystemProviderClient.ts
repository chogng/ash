import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { FileNotFoundError, FileRevisionConflictError, type FileDeleteMode, type FileExistingTargetBehavior, type FileMissingTargetBehavior, type IFileBytes, type IFileChangeEvent, type IFileContent, type IFileEntry, type IFileService, type IFileStat, type IFileWriteRequest, type IFileWriteResult } from './files.js';

export const LOCAL_FILE_SYSTEM_CHANNEL_NAME = 'ash:files';

/** URI serialization and error transport for the desktop file provider. */
export class DiskFileSystemProviderClient extends Disposable implements IFileService {
	private readonly changes = this._register(new Emitter<IFileChangeEvent>());
	public readonly onDidChangeFiles = this.changes.event;

	constructor(private readonly invoke: (request: unknown) => Promise<unknown>) { super(); }

	public async stat(resource: URI): Promise<IFileStat> {
		const stat = await this.call<IFileStat>('stat', resource);
		return { ...stat, resource };
	}
	public async readDirectory(resource: URI): Promise<readonly IFileEntry[]> {
		const entries = await this.call<readonly { name: string; kind: IFileEntry['kind']; resource: string }[]>('readDirectory', resource);
		return entries.map(entry => ({ ...entry, resource: URI.parse(entry.resource) }));
	}
	public async readFile(resource: URI): Promise<IFileContent> {
		const content = await this.call<IFileContent>('readFile', resource);
		return { ...content, resource };
	}
	public async readFileBytes(resource: URI): Promise<IFileBytes> {
		const content = await this.call<IFileBytes>('readFileBytes', resource);
		return { ...content, resource };
	}
	public async writeFile(request: IFileWriteRequest): Promise<IFileWriteResult> {
		const result = await this.call<IFileWriteResult>('writeFile', request.resource, { content: request.content, expectedRevision: request.expectedRevision });
		this.changes.fire({ resources: [request.resource] });
		return { ...result, stat: { ...result.stat, resource: request.resource } };
	}
	public async createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat> {
		const result = await this.call<IFileStat>('createFile', resource, { existing });
		this.changes.fire({ resources: [resource] });
		return { ...result, resource };
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
