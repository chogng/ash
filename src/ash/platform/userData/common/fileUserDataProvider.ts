import { extUri } from '../../../base/common/resources.js';
import { Disposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import { Schemas } from '../../../base/common/network.js';
import type { IFileSystemProvider, IFileStat, IFileEntry, IFileBytes, IFileWriteOptions, IFileWriteResult, IFileChangeEvent, IWatchOptions, FileSystemProviderCapabilities, FileExistingTargetBehavior, FileMissingTargetBehavior, FileDeleteMode } from '../../files/common/files.js';

/** Maps the UI profile scheme to the host's granted user-data directory. */
export class FileUserDataProvider extends Disposable implements IFileSystemProvider {
	public get capabilities(): FileSystemProviderCapabilities { return this.files.capabilities; }
	public get onDidChangeCapabilities(): Event<void> { return this.files.onDidChangeCapabilities; }
	private readonly changes = this._register(new Emitter<IFileChangeEvent>());
	public readonly onDidChangeFiles = this.changes.event;

	constructor(private readonly files: IFileSystemProvider, private readonly home: URI) {
		super();
		this._register(files.onDidChangeFiles(event => {
			if (!event.resources) { this.changes.fire(event); return; }
			const resources = event.resources.filter(resource => extUri.isEqualOrParent(resource, home)).map(resource =>
				URI.from({ scheme: Schemas.vscodeUserData, path: '/user' + resource.path.slice(home.path.replace(/\/$/u, '').length) }));
			if (resources.length) {
				this.changes.fire({ resources });
			}
		}));
	}

	public async stat(resource: URI): Promise<IFileStat> {
		return { ...await this.files.stat(this.toFile(resource)), resource };
	}

	public async readDirectory(resource: URI): Promise<readonly IFileEntry[]> {
		return (await this.files.readDirectory(this.toFile(resource))).map(entry => ({ ...entry, resource: URI.joinPath(resource, entry.name) }));
	}

	public async readFile(resource: URI): Promise<IFileBytes> {
		return { ...await this.files.readFile(this.toFile(resource)), resource };
	}

	public watch(resource: URI, options: IWatchOptions): IDisposable {
		return this.files.watch(this.toFile(resource), options);
	}

	public async writeFile(resource: URI, bytes: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult> {
		const result = await this.files.writeFile(this.toFile(resource), bytes, options);
		return { ...result, stat: { ...result.stat, resource } };
	}

	public async createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat> {
		return { ...await this.files.createFile(this.toFile(resource), existing), resource };
	}

	public async createDirectory(resource: URI): Promise<IFileStat> {
		return { ...await this.files.createDirectory(this.toFile(resource)), resource };
	}

	public copy(source: URI, target: URI): Promise<void> {
		return this.files.copy(this.toFile(source), this.toFile(target));
	}

	public rename(source: URI, target: URI, existing: FileExistingTargetBehavior): Promise<void> {
		return this.files.rename(this.toFile(source), this.toFile(target), existing);
	}

	public delete(resource: URI, missing: FileMissingTargetBehavior, mode: FileDeleteMode): Promise<void> {
		return this.files.delete(this.toFile(resource), missing, mode);
	}

	private toFile(resource: URI): URI {
		const segments = resource.path.split('/').slice(2);
		if (resource.scheme !== Schemas.vscodeUserData || resource.authority || resource.query || resource.fragment ||
			(resource.path !== '/user' && !resource.path.startsWith('/user/')) || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) {
			throw new TypeError('Expected a current-profile resource');
		}
		return URI.joinPath(this.home, ...segments);
	}
}
