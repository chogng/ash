import { extUri } from '../../../base/common/resources.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import { Schemas } from '../../../base/common/network.js';
import type { IFileSystemProvider, IFileStat, IFileEntry, IFileBytes, IFileWriteRequest, IFileWriteResult, IFileChangeEvent, FileExistingTargetBehavior, FileMissingTargetBehavior, FileDeleteMode } from '../../files/common/files.js';

/** Maps the UI profile scheme to the host's granted user-data directory. */
export class FileUserDataProvider extends Disposable implements IFileSystemProvider {
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

	public async writeFile(request: IFileWriteRequest): Promise<IFileWriteResult> {
		const result = await this.files.writeFile({ ...request, resource: this.toFile(request.resource) });
		return { ...result, stat: { ...result.stat, resource: request.resource } };
	}

	public async writeFileBytes(resource: URI, bytes: Uint8Array): Promise<IFileWriteResult> {
		const result = await this.files.writeFileBytes(this.toFile(resource), bytes);
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
