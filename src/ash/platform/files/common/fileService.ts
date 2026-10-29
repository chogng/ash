import type { IFileReadOptions } from './files.js';
import { Emitter } from '../../../base/common/event.js';
import { bufferToStream, VSBuffer, type VSBufferReadableStream } from '../../../base/common/buffer.js';
import { raceCancellationError } from '../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource, throwIfCancelled } from '../../../base/common/cancellation.js';
import { canceled } from '../../../base/common/errors.js';
import { transform } from '../../../base/common/stream.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { dirname, extUri } from '../../../base/common/resources.js';
import { generateUuid } from '../../../base/common/uuid.js';
import {
	createFileSystemProviderError,
	FileSystemProviderErrorCode,
	FileKind,
	FileNotFoundError,
	FileOperationNotSupportedError,
	FileSystemProviderCapabilities,
	hasFileReadStreamCapability,
	hasPathIdentityCapability,
	hasCopyScopeCapability,
	type IFilePathIdentity,
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
	type IFileSystemProviderCopyScope,
	type IFileSystemProviderRegistrationEvent,
	type IFileSystemProviderCapabilitiesChangeEvent,
	type IFileSystemProviderPathIdentityChangeEvent,
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
	private readonly pathIdentityEmitter = this._register(new Emitter<IFileSystemProviderPathIdentityChangeEvent>());
	private readonly providers = new Map<string, ProviderRegistration>();
	private readonly providerListeners = this._register(new DisposableMap<IFileSystemProvider>());
	private readonly watches = this._register(new DisposableMap<string, WatchRegistration>());
	private readonly reads = this._register(new DisposableMap<object, DisposableStore>());

	public readonly onDidChangeFiles = this.changeEmitter.event;
	public readonly onDidChangeFileSystemProviderRegistrations = this.registrationEmitter.event;
	public readonly onDidChangeFileSystemProviderCapabilities = this.capabilitiesEmitter.event;
	public readonly onDidChangeFileSystemProviderPathIdentity = this.pathIdentityEmitter.event;

	constructor() {
		super();
		this._register(toDisposable(() => this.providers.clear()));
	}

	public registerProvider(scheme: string, provider: IFileSystemProvider): IDisposable {
		this.assertNotDisposed();
		if (!/^[a-z][a-z0-9+.-]*$/u.test(scheme)) {
			throw new TypeError(`Invalid file system provider scheme: ${scheme}`);
		}
		if (
			!provider ||
			typeof provider.readFile !== 'function' ||
			typeof provider.watch !== 'function' ||
			typeof provider.onDidChangeFiles !== 'function' ||
			typeof provider.onDidChangeCapabilities !== 'function' ||
			!Number.isInteger(provider.capabilities)
		) {
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
			listeners.add(
				provider.onDidChangeCapabilities(() => {
					for (const [scheme, registration] of this.providers) {
						if (registration.provider === provider) this.capabilitiesEmitter.fire({ scheme, provider });
					}
					this.acceptProviderChange(provider, { resources: undefined });
				}),
			);
			if (hasPathIdentityCapability(provider)) {
				listeners.add(
					provider.onDidChangePathIdentity(() => {
						for (const [scheme, registration] of this.providers) {
							if (registration.provider === provider) {
								this.pathIdentityEmitter.fire({ scheme, provider });
							}
						}
					}),
				);
			}
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

	public resolvePathIdentity(resource: URI, signal?: AbortSignal): Promise<void> | undefined {
		this.assertNotDisposed();
		if (signal) throwIfCancelled(signal);
		const registration = this.providers.get(resource.scheme);
		const provider = registration?.provider;
		if (provider && hasPathIdentityCapability(provider)) {
			const pending = provider.resolvePathIdentity(resource).then(() => {
				if (this.isDisposed || this.providers.get(resource.scheme) !== registration) {
					throw canceled();
				}
			});
			return signal ? raceCancellationError(pending, signal) : pending;
		}
		return undefined;
	}

	public retainPathIdentity(resource: URI): IDisposable {
		this.assertNotDisposed();
		const provider = this.providers.get(resource.scheme)?.provider;
		return provider && hasPathIdentityCapability(provider) ? provider.retainPathIdentity(resource) : Disposable.None;
	}

	public getPathIdentity(resource: URI): IFilePathIdentity | undefined {
		const provider = this.providers.get(resource.scheme)?.provider;
		return provider && hasPathIdentityCapability(provider) ? provider.getPathIdentity(resource) : undefined;
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
			watch = Object.assign(
				toDisposable(() => handle.dispose()),
				{ registration, users: 0 },
			);
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
		return provider.stat(resource).then(stat => ({
			...stat,
			readonly: stat.readonly || !!(provider.capabilities & FileSystemProviderCapabilities.Readonly),
		}));
	}

	public readDirectory(resource: URI): Promise<readonly IFileEntry[]> {
		return this.provider(resource).readDirectory(resource);
	}

	public readFile(resource: URI, encoding?: string, options?: IFileReadOptions): Promise<IFileContent> {
		const provider = this.provider(resource);
		if (!this.hasCapability(resource, FileSystemProviderCapabilities.FileReadWrite)) throw new FileOperationNotSupportedError(resource, 'readFile');
		if (encoding !== undefined && provider.readTextFile) return provider.readTextFile(resource, encoding, options);
		if (encoding !== undefined && !['auto', 'utf8', 'utf8bom'].includes(encoding)) throw new FileOperationNotSupportedError(resource, 'readTextFile');
		return this.readFileBytes(resource).then(content => {
			const bom = content.bytes[0] === 0xef && content.bytes[1] === 0xbb && content.bytes[2] === 0xbf;
			return {
				resource,
				content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(encoding !== undefined && bom ? content.bytes.subarray(3) : content.bytes),
				revision: content.revision,
				...(encoding === undefined ? {} : { encoding: bom ? 'utf8bom' : 'utf8' }),
			};
		});
	}

	public readFileBytes(resource: URI): Promise<IFileBytes> {
		const provider = this.provider(resource);
		if (!this.hasCapability(resource, FileSystemProviderCapabilities.FileReadWrite)) throw new FileOperationNotSupportedError(resource, 'readFile');
		return provider.readFile(resource);
	}

	public async readFileStream(resource: URI, options: IReadFileStreamOptions = {}, token: CancellationToken = CancellationToken.None): Promise<IFileStreamContent> {
		const provider = this.provider(resource);
		for (const value of [options.position, options.length, options.limits?.size]) {
			if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
				throw new RangeError('Invalid file read range or size');
			}
		}
		if (token.isCancellationRequested) {
			throw canceled();
		}
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
				if (!(provider.capabilities & FileSystemProviderCapabilities.FileReadWrite)) {
					throw new FileOperationNotSupportedError(resource, 'readFileStream');
				}
				const content = await raceCancellationError(provider.readFile(resource), cancellation.token);
				const start = options.position ?? 0;
				const bytes = content.bytes.subarray(start, options.length === undefined ? undefined : start + options.length);
				value = bufferToStream(VSBuffer.wrap(Uint8Array.from(bytes)));
			}
			const destroy = value.destroy;
			value.destroy = (): void => {
				this.reads.deleteAndDispose(lifetime);
				destroy();
			};
			lifetime.add(toDisposable(destroy));
			// Terminal delivery must reach every consumer before cleanup destroys the stream.
			const release = (): void => {
				queueMicrotask(() => this.reads.deleteAndDispose(lifetime));
			};
			value.on('error', release);
			value.on('end', release);
			return { ...stat, value };
		} catch (error) {
			this.reads.deleteAndDispose(lifetime);
			throw error;
		}
	}

	public writeFile(request: IFileWriteRequest, options: IFileWriteOptions = { create: true, overwrite: true }, signal?: AbortSignal): Promise<IFileWriteResult> {
		const provider = this.writableProvider(request.resource, 'writeFile');
		const writeOptions = { ...options, expectedRevision: request.expectedRevision ?? options.expectedRevision };
		if (options.writeElevated && !(provider.capabilities & FileSystemProviderCapabilities.FileWriteElevated)) throw new FileOperationNotSupportedError(request.resource, 'writeFileElevated');
		if (options.unlock && !(provider.capabilities & FileSystemProviderCapabilities.FileWriteUnlock)) throw new FileOperationNotSupportedError(request.resource, 'unlock');
		if (request.encoding !== undefined && provider.writeTextFile) return provider.writeTextFile(request.resource, request.content, request.encoding, writeOptions, signal);
		if (request.encoding !== undefined && !['utf8', 'utf8bom'].includes(request.encoding)) throw new FileOperationNotSupportedError(request.resource, 'writeTextFile');
		return provider.writeFile(request.resource, new TextEncoder().encode(request.encoding === 'utf8bom' ? '\uFEFF' + request.content : request.content), writeOptions, signal);
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
		using sourceScope = acquireCopyScope(sourceProvider, source);
		using targetScope = acquireCopyScope(targetProvider, target);
		using cancellation = new CancellationTokenSource(sourceScope.token);
		using targetRetired = targetScope.token.onCancellationRequested(() => cancellation.cancel());
		await this.copyBetweenProviders(sourceScope, targetScope, source, target, sourceProvider === targetProvider, cancellation.token);
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

	private async copyBetweenProviders(
		sourceProvider: IFileSystemProviderCopyScope,
		targetProvider: IFileSystemProviderCopyScope,
		source: URI,
		target: URI,
		sameProvider: boolean,
		token: CancellationToken,
		staged = false,
	): Promise<void> {
		const run = <T>(operation: () => Promise<T>): Promise<T> => {
			throwIfCancelled(token);
			return raceCancellationError(operation(), token);
		};
		const sourceStat = await run(() => sourceProvider.stat(source, token));
		if (sourceStat.kind === FileKind.Directory && sameProvider && extUri.isEqualOrParent(target, source)) {
			// The generic traversal must never enumerate a destination that it just created inside its source.
			throw new FileOperationNotSupportedError(source, 'copy');
		}
		try {
			await run(() => targetProvider.stat(target, token));
			throw new Error(`Copy target already exists: ${target.toString()}`);
		} catch (error) {
			if (!(error instanceof FileNotFoundError)) {
				throw error;
			}
		}
		if (sourceStat.kind === FileKind.File) {
			const { bytes } = await run(() => sourceProvider.readFile(source, token));
			// Storage owns failed publication cleanup; deleting here could remove an intervening writer's file.
			await run(() => targetProvider.writeFile(target, bytes, { create: true, overwrite: false }, token));
			return;
		}
		if (sourceStat.kind !== FileKind.Directory) {
			throw new FileOperationNotSupportedError(source, 'copy');
		}
		if (!staged) {
			// Each traversal owns a private sibling. A failed or losing copy must never
			// recursively delete the published destination of a concurrent writer.
			const temporary = URI.joinPath(dirname(target), `.ash-copy-${generateUuid()}`);
			try {
				await this.copyBetweenProviders(sourceProvider, targetProvider, source, temporary, sameProvider, token, true);
				await run(() => targetProvider.rename(temporary, target, 'error', token));
			} catch (error) {
				// Cleanup stays on the original connection and cannot mask the copy failure.
				if (!targetProvider.token.isCancellationRequested) {
					await targetProvider.delete(temporary, 'ignore', 'recursive').catch(() => {});
				}
				throw error;
			}
			return;
		}
		await run(() => targetProvider.createDirectory(target, token));
		for (const entry of await run(() => sourceProvider.readDirectory(source, token))) {
			await this.copyBetweenProviders(sourceProvider, targetProvider, entry.resource, URI.joinPath(target, entry.name), sameProvider, token, true);
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

function acquireCopyScope(provider: IFileSystemProvider, resource: URI): IFileSystemProviderCopyScope {
	if (hasCopyScopeCapability(provider)) {
		return provider.acquireCopyScope(resource);
	}
	return Object.assign(
		toDisposable(() => {}),
		{
			token: CancellationToken.None,
			stat: provider.stat.bind(provider),
			readDirectory: provider.readDirectory.bind(provider),
			readFile: provider.readFile.bind(provider),
			writeFile: (uri: URI, bytes: Uint8Array, options: IFileWriteOptions) => provider.writeFile(uri, bytes, options),
			createDirectory: provider.createDirectory.bind(provider),
			rename: provider.rename.bind(provider),
			delete: provider.delete.bind(provider),
		},
	);
}
