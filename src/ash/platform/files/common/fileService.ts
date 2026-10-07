import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableMap, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { FileKind, FileNotFoundError, FileOperationNotSupportedError, type FileDeleteMode, type FileExistingTargetBehavior, type FileMissingTargetBehavior, type IFileBytes, type IFileChangeEvent, type IFileContent, type IFileEntry, type IFileService, type IFileSystemProvider, type IFileStat, type IFileWriteRequest, type IFileWriteResult } from './files.js';

interface ProviderRegistration {
	readonly provider: IFileSystemProvider;
}

/** Owns scheme routing and subscriptions; providers retain their storage lifetimes. */
export class FileService extends Disposable implements IFileService {
	private readonly changeEmitter = this._register(new Emitter<IFileChangeEvent>());
	private readonly providers = new Map<string, ProviderRegistration>();
	private readonly providerListeners = this._register(new DisposableMap<IFileSystemProvider>());

	public readonly onDidChangeFiles = this.changeEmitter.event;

	constructor() {
		super();
		this._register(toDisposable(() => this.providers.clear()));
	}

	public registerProvider(scheme: string, provider: IFileSystemProvider): IDisposable {
		this.assertNotDisposed();
		if (!/^[a-z][a-z0-9+.-]*$/u.test(scheme)) {
			throw new TypeError(`Invalid file system provider scheme: ${scheme}`);
		}
		if (!provider || typeof provider.readFile !== 'function' || typeof provider.onDidChangeFiles !== 'function') {
			throw new TypeError(`File system provider '${scheme}' does not implement the file service contract`);
		}
		if (this.providers.has(scheme)) {
			throw new Error(`File system provider is already registered: ${scheme}`);
		}
		// A workspace provider serves both local and remote resources with one event source.
		if (!this.providerListeners.has(provider)) {
			this.providerListeners.set(provider, provider.onDidChangeFiles(event => this.acceptProviderChange(provider, event)));
		}
		const registration = { provider };
		this.providers.set(scheme, registration);
		return toDisposable(() => {
			if (this.providers.get(scheme) !== registration) {
				return;
			}
			this.providers.delete(scheme);
			if (![...this.providers.values()].some(current => current.provider === provider)) {
				this.providerListeners.deleteAndDispose(provider);
			}
		});
	}

	public hasProvider(resource: URI): boolean {
		return this.providers.has(resource.scheme);
	}

	public stat(resource: URI): Promise<IFileStat> {
		return this.provider(resource).stat(resource);
	}

	public readDirectory(resource: URI): Promise<readonly IFileEntry[]> {
		return this.provider(resource).readDirectory(resource);
	}

	public readFile(resource: URI): Promise<IFileContent> {
		// Keep the BOM in text so editor format detection remains owned by TextFileService.
		return this.provider(resource).readFile(resource).then(content => ({
			resource, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content.bytes), revision: content.revision,
		}));
	}

	public readFileBytes(resource: URI): Promise<IFileBytes> {
		return this.provider(resource).readFile(resource);
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
		if (sourceProvider === targetProvider) {
			return sourceProvider.copy(source, target);
		}
		await this.copyBetweenProviders(sourceProvider, targetProvider, source, target);
	}

	public rename(source: URI, target: URI, existing: FileExistingTargetBehavior): Promise<void> {
		const provider = this.provider(source);
		if (provider !== this.provider(target)) {
			throw new Error('Renaming across file system providers is not supported');
		}
		return provider.rename(source, target, existing);
	}

	public delete(resource: URI, missing: FileMissingTargetBehavior, mode: FileDeleteMode): Promise<void> {
		return this.provider(resource).delete(resource, missing, mode);
	}

	private provider(resource: URI): IFileSystemProvider {
		this.assertNotDisposed();
		const registration = this.providers.get(resource.scheme);
		if (!registration) {
			throw new FileOperationNotSupportedError(resource, 'access');
		}
		return registration.provider;
	}

	private async copyBetweenProviders(sourceProvider: IFileSystemProvider, targetProvider: IFileSystemProvider, source: URI, target: URI): Promise<void> {
		const sourceStat = await sourceProvider.stat(source);
		try {
			await targetProvider.stat(target);
			throw new Error(`Copy target already exists: ${target.toString()}`);
		} catch (error) {
			if (!(error instanceof FileNotFoundError)) {
				throw error;
			}
		}
		if (sourceStat.kind === FileKind.File) {
			const { bytes } = await sourceProvider.readFile(source);
			try {
				await targetProvider.writeFileBytes(target, bytes);
			} catch (error) {
				await targetProvider.delete(target, 'ignore', 'fileOrEmptyDirectory');
				throw error;
			}
			return;
		}
		if (sourceStat.kind !== FileKind.Directory) {
			throw new FileOperationNotSupportedError(source, 'copy');
		}
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

	private acceptProviderChange(provider: IFileSystemProvider, event: IFileChangeEvent): void {
		if (!event.resources) {
			this.changeEmitter.fire(event);
			return;
		}
		const resources = event.resources.filter(resource => this.providers.get(resource.scheme)?.provider === provider);
		if (resources.length > 0) {
			this.changeEmitter.fire({ resources });
		}
	}
}
