import { decodeBase64 } from '../../../../base/common/buffer.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import {
	FileKind, FileNotFoundError, FileOperationNotSupportedError, FileSystemProviderCapabilities,
	IFileService, type IFileBytes, type IFileStat, type IFileSystemProvider,
} from '../../../../platform/files/common/files.js';
import { EDIT_SESSIONS_SCHEME, IEditSessionsStorageService } from '../common/editSessions.js';

export function editSessionPreviewResource(repositoryId: string, revision: string, path: string, side: 'before' | 'after'): URI {
	return URI.from({
		scheme: EDIT_SESSIONS_SCHEME,
		authority: repositoryId,
		path: `/${path}`,
		query: new URLSearchParams({ revision, side }).toString(),
	});
}

/** Binds read-only editor resources to one saved revision without serializing file contents into editor state. */
export class EditSessionsFileSystemProvider extends Disposable implements IFileSystemProvider {
	readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.Readonly |
		FileSystemProviderCapabilities.PathCaseSensitive;
	readonly onDidChangeCapabilities = Event.None;
	readonly onDidChangeFiles = Event.None;

	constructor(
		@IFileService files: IFileService,
		@IEditSessionsStorageService private readonly storage: IEditSessionsStorageService,
	) {
		super();
		this._register(files.registerProvider(EDIT_SESSIONS_SCHEME, this));
	}

	async readFile(resource: URI): Promise<IFileBytes> {
		const query = new URLSearchParams(resource.query);
		const side = query.get('side');
		const revision = query.get('revision');
		if (!/^[a-f0-9]{64}$/u.test(resource.authority) || !revision || (side !== 'before' && side !== 'after')) {
			throw new FileNotFoundError(resource);
		}
		const slot = await this.storage.read(resource.authority);
		const change = slot.kind === 'saved' && slot.revision === revision && slot.session.changes.find(change => `/${change.path}` === resource.path);
		if (!change) throw new FileNotFoundError(resource);
		const content = change[side];
		return { resource, revision, bytes: content === null ? new Uint8Array() : decodeBase64(content).buffer };
	}

	async stat(resource: URI): Promise<IFileStat> {
		const { bytes } = await this.readFile(resource);
		return { resource, kind: FileKind.File, sizeBytes: bytes.byteLength, readonly: true, modifiedAtMillis: undefined };
	}

	watch(): typeof Disposable.None { return Disposable.None; }
	async readDirectory(resource: URI): Promise<never> { throw new FileOperationNotSupportedError(resource, 'readDirectory'); }
	async writeFile(resource: URI): Promise<never> { throw new FileOperationNotSupportedError(resource, 'writeFile'); }
	async createFile(resource: URI): Promise<never> { throw new FileOperationNotSupportedError(resource, 'createFile'); }
	async createDirectory(resource: URI): Promise<never> { throw new FileOperationNotSupportedError(resource, 'createDirectory'); }
	async copy(resource: URI): Promise<never> { throw new FileOperationNotSupportedError(resource, 'copy'); }
	async rename(resource: URI): Promise<never> { throw new FileOperationNotSupportedError(resource, 'rename'); }
	async delete(resource: URI): Promise<never> { throw new FileOperationNotSupportedError(resource, 'delete'); }
}
