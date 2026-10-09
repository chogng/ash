import { Emitter } from '../../../base/common/event.js';
import { bufferToStream, VSBuffer, type VSBufferReadableStream } from '../../../base/common/buffer.js';
import { raceCancellationError } from '../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { canceled } from '../../../base/common/errors.js';
import { transform } from '../../../base/common/stream.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import {
	createFileSystemProviderError,
	FileSystemProviderErrorCode,
	FileKind,
	FileNotFoundError,
	FileOperationNotSupportedError,
	FileSystemProviderCapabilities,
	hasFileReadStreamCapability,
	type FileDeleteMode,
	type FileExistingTargetBehavior,
	type FileMissingTargetBehavior,
	type IFileBytes,
	type IFileChangeEvent,
	type IFileContent,
	type IFileEntry,
	type IFileService,
	type IFileStreamContent,
	type IReadFileStreamOptions,
	type IFileSystemProvider,
	type IFileSystemProviderRegistrationEvent,
	type IFileSystemProviderCapabilitiesChangeEvent,
	type IFileStat,
	type IFileWriteRequest,
	type IFileWriteOptions,
	type IFileWriteResult,
	type IWatchOptions,
} from './files.js';

interface ProviderRegistration {
	readonly provider: IFileSystemProvider;
}

interface WatchRegistration extends IDisposable {
	readonly registration: ProviderRegistration;
	users: number;
}

/** Owns scheme routing and subscriptions; providers retain their storage lifetimes. */
export class FileService extends Disposable implements IFileService {
	private readonly changeEmitter = this._register(new Emitter<IFileChangeEvent>());
	private readonly registrationEmitter = this._register(new Emitter<IFileSystemProviderRegistrationEvent>());
	private readonly capabilitiesEmitter = this._register(new Emitter<IFileSystemProviderCapabilitiesChangeEvent>());
	private readonly providers = new Map<string, ProviderRegistration>();
	private readonly providerListeners = this._register(new DisposableMap<IFileSystemProvider>());
	private readonly watches = this._register(new DisposableMap<string, WatchRegistration>());
	private readonly reads = this._register(new DisposableMap<object, DisposableStore>());

	public readonly onDidChangeFiles = this.changeEmitter.event;
	public readonly onDidChangeFileSystemProviderRegistrations = this.registrationEmitter.event;
	public readonly onDidChangeFileSystemProviderCapabilities = this.capabilitiesEmitter.event;

	constructor() {
		super();
		this._register(toDisposable(() => this.providers.clear()));
	}

	public registerProvider(scheme: string, provider: IFileSystemProvider): IDisposable {
		this.assertNotDisposed();
		if (!/^[a-z][a-z0-9+.-]*$/u.test(scheme)) {
			throw new TypeError(`Invalid file system provider scheme: ${scheme}`);
		}
		if (!provider || typeof provider.readFile !== 'function' || typeof provider.watch !== 'function' || typeof provider.onDidChangeFiles !== 'function' || typeof provider.onDidChangeCapabilities !== 'function' || !Number.isInteger(provider.capabilities)) {
			throw new TypeError(`File system provider '${scheme}' does not implement the file service contract`);
		}
		if (this.providers.has(scheme)) {
			throw new Error(`File system provider is already registered: ${scheme}`);
		}
		// A workspace provider serves both local and remote resources with one event source.
		if (!this.providerListeners.has(provider)) {
			const listeners = new DisposableStore();
			this.providerListeners.set(provider, listeners);
			listeners.add(provider.onDidChangeFiles(event => this.acceptProviderChange(provider, event)));
			listeners.add(provider.onDidChangeCapabilities(() => {
				for (const [scheme, registration] of this.providers) {
					if (registration.provider === provider) this.capabilitiesEmitter.fire({ scheme, provider });
				}
				this.acceptProviderChange(provider, { resources: undefined });
			}));
		}
		const registration = { provider };
		this.providers.set(scheme, registration);
		this.registrationEmitter.fire({ scheme, provider, added: true });
		return toDisposable(() => {
			if (this.providers.get(scheme) !== registration) {
				return;
			}
			this.providers.delete(scheme);
			for (const [key, watch] of this.watches) {
				if (watch.registration === registration) this.watches.deleteAndDispose(key);
			}
			if (![...this.providers.values()].some(current => current.provider === provider)) {
				this.providerListeners.deleteAndDispose(provider);
			}
			this.registrationEmitter.fire({ scheme, provider, added: false });
		});
	}

	public hasProvider(resource: URI): boolean {
		return this.providers.has(resource.scheme);
	}

	public hasCapability(resource: URI, capability: FileSystemProviderCapabilities): boolean {
		const provider = this.providers.get(resource.scheme)?.provider;
		return provider !== undefined && (provider.capabilities & capability) === capability;
	}

	public watch(resource: URI, options: IWatchOptions = { recursive: false, excludes: [] }): IDisposable {
		this.provider(resource);
		const registration = this.providers.get(resource.scheme)!;
		const normalized = { recursive: options.recursive, excludes: [...new Set(options.excludes)].sort() };
		const key = JSON.stringify([resource.toString(), normalized]);
		let watch = this.watches.get(key);
		if (!watch) {
			const handle = registration.provider.watch(resource, normalized);
			watch = Object.assign(toDisposable(() => handle.dispose()), { registration, users: 0 });
			this.watches.set(key, watch);
		}
		watch.users++;
		const shared = watch;
		return toDisposable(() => {
			// A late handle must not release a watch acquired after provider replacement.
			if (this.watches.get(key) !== shared) return;
			if (--shared.users === 0) this.watches.deleteAndDispose(key);
		});
	}

	public stat(resource: URI): Promise<IFileStat> {
		const provider = this.provider(resource);
		return provider.stat(resource).then(stat => ({ ...stat, readonly: stat.readonly || !!(provider.capabilities & FileSystemProviderCapabilities.Readonly) }));
	}

	public readDirectory(resource: URI): Promise<readonly IFileEntry[]> {
		return this.provider(resource).readDirectory(resource);
	}

	public readFile(resource: URI): Promise<IFileContent> {
		// Keep the BOM in text so editor format detection remains owned by TextFileService.
		return this.readFileBytes(resource).then(content => ({
			resource, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content.bytes), revision: content.revision,
		}));
	}

	public readFileBytes(resource: URI): Promise<IFileBytes> {
		const provider = this.provider(resource);
		if (!this.hasCapability(resource, FileSystemProviderCapabilities.FileReadWrite)) throw new FileOperationNotSupportedError(resource, 'readFile');
		return provider.readFile(resource);
	}

	public async readFileStream(resource: URI, options: IReadFileStreamOptions = {}, token: CancellationToken = CancellationToken.None): Promise<IFileStreamContent> {
		const provider = this.provider(resource);
		for (const value of [options.position, options.length, options.limits?.size]) {
			if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) { throw new RangeError('Invalid file read range or size'); }
		}
		if (token.isCancellationRequested) { throw canceled(); }
		const lifetime = new DisposableStore();
		this.reads.set(lifetime, lifetime);
		const cancellation = new CancellationTokenSource(token);
		lifetime.add(toDisposable(() => cancellation.dispose(true)));
		try {
			const stat = await raceCancellationError(this.stat(resource), cancellation.token);
			if (stat.kind !== FileKind.File) {
				throw createFileSystemProviderError('Expected a file', stat.kind === FileKind.Directory ? FileSystemProviderErrorCode.FileIsADirectory : FileSystemProviderErrorCode.Unavailable);
			}
			if (options.limits?.size !== undefined && stat.sizeBytes > options.limits.size) {
				throw createFileSystemProviderError('File exceeds the read size limit', FileSystemProviderErrorCode.FileTooLarge);
			}
			let value: VSBufferReadableStream;
			if (hasFileReadStreamCapability(provider)) {
				value = transform(provider.readFileStream(resource, options, cancellation.token), { data: bytes => VSBuffer.wrap(Uint8Array.from(bytes)) }, chunks => VSBuffer.concat(chunks));
			} else {
				if (!(provider.capabilities & FileSystemProviderCapabilities.FileReadWrite)) { throw new FileOperationNotSupportedError(resource, 'readFileStream'); }
				const content = await raceCancellationError(provider.readFile(resource), cancellation.token);
				const start = options.position ?? 0;
				const bytes = content.bytes.subarray(start, options.length === undefined ? undefined : start + options.length);
				value = bufferToStream(VSBuffer.wrap(Uint8Array.from(bytes)));
			}
			const destroy = value.destroy;
			value.destroy = (): void => { this.reads.deleteAndDispose(lifetime); destroy(); };
			lifetime.add(toDisposable(destroy));
			// Terminal delivery must reach every consumer before cleanup destroys the stream.
			const release = (): void => { queueMicrotask(() => this.reads.deleteAndDispose(lifetime)); };
			value.on('error', release);
			value.on('end', release);
			return { ...stat, value };
		} catch (error) {
			this.reads.deleteAndDispose(lifetime);
			throw error;
		}
	}

	public writeFile(request: IFileWriteRequest): Promise<IFileWriteResult> {
		return this.writableProvider(request.resource, 'writeFile').writeFile(request.resource, new TextEncoder().encode(request.content), { create: true, overwrite: true, expectedRevision: request.expectedRevision });
	}

	public writeFileBytes(resource: URI, bytes: Uint8Array, options: IFileWriteOptions = { create: true, overwrite: false }, signal?: AbortSignal): Promise<IFileWriteResult> {
		const provider = this.writableProvider(resource, 'writeFile');
		if (options.writeElevated && !(provider.capabilities & FileSystemProviderCapabilities.FileWriteElevated)) {
			throw new FileOperationNotSupportedError(resource, 'writeFileElevated');
		}
		if (options.unlock && !(provider.capabilities & FileSystemProviderCapabilities.FileWriteUnlock)) {
			throw new FileOperationNotSupportedError(resource, 'unlock');
		}
		return provider.writeFile(resource, bytes, options, signal);
	}

	public createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat> {
		return this.writableProvider(resource, 'createFile').createFile(resource, existing);
	}

	public createDirectory(resource: URI): Promise<IFileStat> {
		return this.writableProvider(resource, 'createDirectory').createDirectory(resource);
	}

	public async copy(source: URI, target: URI): Promise<void> {
		const sourceProvider = this.provider(source);
		const targetProvider = this.writableProvider(target, 'copy');
		if (sourceProvider === targetProvider && this.hasCapability(source, FileSystemProviderCapabilities.FileFolderCopy)) {
			return sourceProvider.copy(source, target);
		}
		await this.copyBetweenProviders(sourceProvider, targetProvider, source, target);
	}

	public rename(source: URI, target: URI, existing: FileExistingTargetBehavior): Promise<void> {
		const provider = this.writableProvider(source, 'rename');
		if (provider !== this.writableProvider(target, 'rename')) {
			throw new Error('Renaming across file system providers is not supported');
		}
		return provider.rename(source, target, existing);
	}

	public delete(resource: URI, missing: FileMissingTargetBehavior, mode: FileDeleteMode): Promise<void> {
		return this.writableProvider(resource, 'delete').delete(resource, missing, mode);
	}

	private writableProvider(resource: URI, operation: string): IFileSystemProvider {
		const provider = this.provider(resource);
		if (!(provider.capabilities & FileSystemProviderCapabilities.FileReadWrite) || provider.capabilities & FileSystemProviderCapabilities.Readonly) {
			throw new FileOperationNotSupportedError(resource, operation);
		}
		return provider;
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
			// Storage owns failed publication cleanup; deleting here could remove an intervening writer's file.
			await targetProvider.writeFile(target, bytes, { create: true, overwrite: false });
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
