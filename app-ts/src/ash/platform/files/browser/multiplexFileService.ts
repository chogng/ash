import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import type { IFileSystemProvider, IFileSystemProviderService } from '../common/fileSystemProviderService.js';
import { FileKind, FileNotFoundError, FileOperationNotSupportedError, type FileDeleteMode, type FileExistingTargetBehavior, type FileMissingTargetBehavior, type IFileBytes, type IFileChangeEvent, type IFileContent, type IFileEntry, type IFileService, type IFileStat, type IFileWriteRequest, type IFileWriteResult } from '../common/files.js';

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

	public writeFileBytes(resource: URI, bytes: Uint8Array): Promise<IFileWriteResult> {
		return this.provider(resource).writeFileBytes(resource, bytes);
	}

	public createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat> {
		return this.provider(resource).createFile(resource, existing);
	}

	public createDirectory(resource: URI): Promise<IFileStat> {
		return this.provider(resource).createDirectory(resource);
	}

	public async copy(source: URI, target: URI): Promise<void> {
		const sourceProvider = this.provider(source);
		const targetProvider = this.provider(target);
		if (sourceProvider === targetProvider) return sourceProvider.copy(source, target);
		await this.copyBetweenProviders(sourceProvider, targetProvider, source, target);
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

	private async copyBetweenProviders(sourceProvider: IFileService, targetProvider: IFileService, source: URI, target: URI): Promise<void> {
		const sourceStat = await sourceProvider.stat(source);
		try {
			await targetProvider.stat(target);
			throw new Error(`Copy target already exists: ${target.toString()}`);
		} catch (error) {
			if (!(error instanceof FileNotFoundError)) throw error;
		}
		if (sourceStat.kind === FileKind.File) {
			const { bytes } = await sourceProvider.readFileBytes(source);
			try {
				await targetProvider.writeFileBytes(target, bytes);
			} catch (error) {
				await targetProvider.delete(target, 'ignore', 'fileOrEmptyDirectory');
				throw error;
			}
			return;
		}
		if (sourceStat.kind !== FileKind.Directory) throw new FileOperationNotSupportedError(source, 'copy');
		await targetProvider.createDirectory(target);
		try {
			for (const entry of await sourceProvider.readDirectory(source)) {
				await this.copyBetweenProviders(sourceProvider, targetProvider, entry.resource, URI.joinPath(target, entry.name));
			}
		} catch (error) {
			await targetProvider.delete(target, 'error', 'recursive');
			throw error;
		}
	}

	private acceptProviderChange(scheme: string, event: IFileChangeEvent): void {
		if (event.resources?.some(resource => resource.scheme !== scheme)) {
			throw new TypeError(`File system provider '${scheme}' emitted a resource from another scheme`);
		}
		this.changeEmitter.fire(event);
	}
}
