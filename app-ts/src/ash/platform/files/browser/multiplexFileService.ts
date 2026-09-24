import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { URI } from '../../../base/common/uri.js';
import type { IFileSystemProvider, IFileSystemProviderService } from '../common/fileSystemProviderService.js';
import type { FileDeleteMode, FileExistingTargetBehavior, FileMissingTargetBehavior, IFileBytes, IFileChangeEvent, IFileContent, IFileEntry, IFileService, IFileStat, IFileWriteRequest, IFileWriteResult } from '../common/files.js';

interface ProviderRegistration {
	readonly provider: IFileSystemProvider;
	readonly listener: IDisposable;
}

/** Routes registered virtual schemes before falling back to workspace file storage. */
export class MultiplexFileService extends Disposable implements IFileService, IFileSystemProviderService {
	private readonly changeEmitter = this._register(new Emitter<IFileChangeEvent>());
	private readonly providers = new Map<string, ProviderRegistration>();

	public readonly onDidChangeFiles = this.changeEmitter.event;

	constructor(private readonly fallback: IFileService) {
		super();
		if (!fallback || typeof fallback.readFile !== 'function' || typeof fallback.onDidChangeFiles !== 'function') {
			this.dispose();
			throw new TypeError('Multiplex file service requires a fallback file service');
		}
		this._register(fallback.onDidChangeFiles(event => this.changeEmitter.fire(event)));
		this._register(toDisposable(() => {
			for (const registration of this.providers.values()) registration.listener.dispose();
			this.providers.clear();
		}));
	}

	public registerProvider(scheme: string, provider: IFileSystemProvider): IDisposable {
		this.assertNotDisposed();
		if (!/^[a-z][a-z0-9+.-]*$/u.test(scheme)) throw new TypeError(`Invalid file system provider scheme: ${scheme}`);
		if (!provider || typeof provider.readFile !== 'function' || typeof provider.onDidChangeFiles !== 'function') {
			throw new TypeError(`File system provider '${scheme}' does not implement the file service contract`);
		}
		if (this.providers.has(scheme)) throw new Error(`File system provider is already registered: ${scheme}`);
		const listener = provider.onDidChangeFiles(event => this.acceptProviderChange(scheme, event));
		const registration = { provider, listener };
		this.providers.set(scheme, registration);
		return toDisposable(() => {
			if (this.providers.get(scheme) !== registration) return;
			this.providers.delete(scheme);
			listener.dispose();
		});
	}

	public stat(resource: URI): Promise<IFileStat> {
		return this.provider(resource).stat(resource);
	}

	public readDirectory(resource: URI): Promise<readonly IFileEntry[]> {
		return this.provider(resource).readDirectory(resource);
	}

	public readFile(resource: URI): Promise<IFileContent> {
		return this.provider(resource).readFile(resource);
	}

	public readFileBytes(resource: URI): Promise<IFileBytes> {
		return this.provider(resource).readFileBytes(resource);
	}

	public writeFile(request: IFileWriteRequest): Promise<IFileWriteResult> {
		return this.provider(request.resource).writeFile(request);
	}

	public createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat> {
		return this.provider(resource).createFile(resource, existing);
	}

	public rename(source: URI, target: URI, existing: FileExistingTargetBehavior): Promise<void> {
		const provider = this.provider(source);
		if (provider !== this.provider(target)) throw new Error('Renaming across file system providers is not supported');
		return provider.rename(source, target, existing);
	}

	public delete(resource: URI, missing: FileMissingTargetBehavior, mode: FileDeleteMode): Promise<void> {
		return this.provider(resource).delete(resource, missing, mode);
	}

	private provider(resource: URI): IFileService {
		return this.providers.get(resource.scheme)?.provider ?? this.fallback;
	}

	private acceptProviderChange(scheme: string, event: IFileChangeEvent): void {
		if (event.resources?.some(resource => resource.scheme !== scheme)) {
			throw new TypeError(`File system provider '${scheme}' emitted a resource from another scheme`);
		}
		this.changeEmitter.fire(event);
	}
}
