import { isLinux } from '../../../base/common/platform.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { decodeBase64, encodeBase64, VSBuffer } from '../../../base/common/buffer.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { CancellationToken, CancellationTokenSource, throwIfCancelled } from '../../../base/common/cancellation.js';
import { canceled, isCancellationError } from '../../../base/common/errors.js';
import { DeferredPromise, raceCancellationError } from '../../../base/common/async.js';
import { newWriteableStream, type ReadableStreamEvents } from '../../../base/common/stream.js';
import { isRecord } from '../../../base/common/types.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { IChannel } from '../../../base/parts/ipc/common/ipc.js';
import { URI } from '../../../base/common/uri.js';
import {
	createFileSystemProviderError,
	FileSystemProviderErrorCode,
	toFileSystemProviderErrorCode,
	FileNotFoundError,
	FileRevisionConflictError,
	FileSystemProviderCapabilities,
	type FileDeleteMode,
	type FileExistingTargetBehavior,
	type FileMissingTargetBehavior,
	type IFileBytes,
	type IFileReadLimits,
	type IFileChangeEvent,
	type IFileEntry,
	type IFileSystemProviderWithFileReadStreamCapability,
	type IFileReadStreamOptions,
	type IFileStat,
	type IFileWriteOptions,
	type IFileWriteResult,
	type IWatchOptions,
} from './files.js';

export const LOCAL_FILE_SYSTEM_CHANNEL_NAME = 'localFilesystem';
export const FILE_DOWNLOAD_CHUNK_BYTES = 256 * 1024;

export interface ILocalFileDownload {
	readonly token: CancellationToken;
	write(data: VSBuffer): Promise<void>;
	finish(): Promise<void>;
	cancel(): void;
}

/** Publishes a downloaded file at a location chosen by the desktop user. */
export interface IDesktopFileDownloadService {
	save(name: string, transfer: (target: ILocalFileDownload) => Promise<void>): Promise<void>;
}

export const IDesktopFileDownloadService = createDecorator<IDesktopFileDownloadService>('desktopFileDownload');

/** Borrows the Main-owned download until publication, cancellation, or renderer shutdown. */
export async function saveFileDownload(channel: IChannel, name: string, transfer: (target: ILocalFileDownload) => Promise<void>): Promise<void> {
	const id = generateUuid();
	const ready = new DeferredPromise<boolean>();
	using cancellation = new CancellationTokenSource();
	let failure: Error | undefined;
	using subscription = channel.listen<unknown>('download', { id, name })(value => {
		if (isRecord(value) && (value.kind === 'ready' || value.kind === 'dismissed')) {
			void ready.complete(value.kind === 'ready');
		} else {
			failure = isRecord(value) && value.kind === 'error' && typeof value.message === 'string'
				? new Error(value.message)
				: new TypeError('Invalid download reply');
			void ready.error(failure);
			cancellation.cancel();
		}
	});
	if (!await ready.p) return;

	const token = cancellation.token;
	let cleanup: Promise<void> | undefined;
	let published = false;
	const discard = (): Promise<void> => cleanup ??= channel.call('cancelDownload', { id });
	using cancelRequested = token.onCancellationRequested(() => { void discard().catch(() => undefined); });
	try {
		await transfer({
			token,
			write: async data => {
				for (let offset = 0; offset < data.byteLength; offset += FILE_DOWNLOAD_CHUNK_BYTES) {
					throwIfCancelled(token);
					const bytes = encodeBase64(data.slice(offset, offset + FILE_DOWNLOAD_CHUNK_BYTES));
					await raceCancellationError(channel.call('downloadChunk', { id, bytes }), token);
				}
			},
			finish: async () => {
				throwIfCancelled(token);
				await channel.call('finishDownload', { id });
				published = true;
			},
			cancel: () => cancellation.cancel(),
		});
	} catch (error) {
		if (failure) throw failure;
		if (!token.isCancellationRequested || !isCancellationError(error)) throw error;
	} finally {
		if (!published) await discard();
	}
}

/** URI serialization and error transport for the desktop file provider. */
export class DiskFileSystemProviderClient extends Disposable implements IFileSystemProviderWithFileReadStreamCapability {
	public readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy | FileSystemProviderCapabilities.FileReadStream | (isLinux ? FileSystemProviderCapabilities.PathCaseSensitive : FileSystemProviderCapabilities.None);
	public readonly onDidChangeCapabilities = Event.None;
	private readonly changes = this._register(new Emitter<IFileChangeEvent>());
	public readonly onDidChangeFiles = this.changes.event;
	private readonly reads = this._register(new DisposableMap<object, DisposableStore>());
	private readonly watches = this._register(new DisposableStore());

	constructor(private readonly channel: IChannel, private readonly scheme = 'file') {
		super();
		this._register(channel.listen<unknown>('fileChange')(value => {
			if (value === undefined) { this.changes.fire({ resources: undefined }); return; }
			if (!Array.isArray(value) || value.some(resource => typeof resource !== 'string')) throw new TypeError('Invalid file-change resources');
			const resources = value.map(resource => URI.parse(resource));
			if (resources.some(resource => resource.scheme !== this.scheme || resource.query || resource.fragment)) throw new TypeError('Invalid file-change resource');
			this.changes.fire({ resources });
		}));
	}

	public async stat(resource: URI): Promise<IFileStat> {
		const stat = await this.call<IFileStat>('stat', resource);
		return { ...stat, resource };
	}
	public async readDirectory(resource: URI): Promise<readonly IFileEntry[]> {
		const entries = await this.call<readonly { name: string; kind: IFileEntry['kind']; resource: string; }[]>('readdir', resource);
		return entries.map(entry => ({ ...entry, resource: URI.parse(entry.resource) }));
	}
	public async readFile(resource: URI, limits?: IFileReadLimits): Promise<IFileBytes> {
		const content = await this.call<{ bytes: string; revision: string; }>('readFile', resource, limits ? { options: { limits } } : undefined);
		if (typeof content?.bytes !== 'string' || typeof content.revision !== 'string') throw new TypeError('Invalid file content');
		return { bytes: decodeBase64(content.bytes).buffer, revision: content.revision, resource };
	}

	public readFileStream(resource: URI, options: IFileReadStreamOptions, token: CancellationToken): ReadableStreamEvents<Uint8Array> {
		this.assertNotDisposed();
		const stream = newWriteableStream<Uint8Array>(null);
		const lifetime = new DisposableStore();
		this.reads.set(lifetime, lifetime);
		const destroy = stream.destroy;
		let terminal = false;
		stream.destroy = (): void => { terminal = true; this.reads.deleteAndDispose(lifetime); destroy(); };
		const fail = (error: Error): void => {
			terminal = true;
			stream.error(error);
			stream.end();
			this.reads.deleteAndDispose(lifetime);
		};
		if (token.isCancellationRequested) { fail(canceled()); return stream; }
		lifetime.add(toDisposable(() => { if (!terminal) { stream.error(canceled()); stream.end(); } }));
		lifetime.add(token.onCancellationRequested(() => fail(canceled())));
		try {
			lifetime.add(this.channel.listen<unknown>('readFileStream', { resource: resource.toString(), options })(payload => {
				if (payload === 'end') { terminal = true; stream.end(); this.reads.deleteAndDispose(lifetime); return; }
				if (isRecord(payload) && typeof payload.bytes === 'string') {
					stream.write(decodeBase64(payload.bytes).buffer);
					return;
				}
				if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string' && typeof payload.error.name === 'string') {
					const error = payload.error.name === 'CancellationError' ? canceled() : new Error(payload.error.message);
					error.name = payload.error.name;
					fail(error);
					return;
				}
				fail(new TypeError('Invalid file stream payload'));
			}));
		} catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
		return stream;
	}
	public watch(resource: URI, options: IWatchOptions): IDisposable {
		this.assertNotDisposed();
		if (resource.scheme !== this.scheme || resource.query || resource.fragment) throw new TypeError('Unexpected file resource scheme');
		// The subscription owns the Main-side watch; notifications use the shared fileChange event.
		const watch = this.watches.add(this.channel.listen<void>('watch', { resource: resource.toString(), options })(() => { }));
		return toDisposable(() => { this.watches.delete(watch); watch.dispose(); });
	}
	public async writeFile(resource: URI, bytes: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult> {
		const result = await this.call<IFileWriteResult>('writeFile', resource, { bytes: encodeBase64(VSBuffer.wrap(Uint8Array.from(bytes))), options });
		return { ...result, stat: { ...result.stat, resource } };
	}
	public async createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat> {
		const result = await this.call<IFileStat>('createFile', resource, { existing });
		return { ...result, resource };
	}
	public async createDirectory(resource: URI): Promise<IFileStat> {
		const result = await this.call<IFileStat>('mkdir', resource);
		return { ...result, resource };
	}
	public async copy(source: URI, target: URI): Promise<void> {
		await this.call('copy', source, { target: target.toString() });
	}
	public async rename(source: URI, target: URI, existing: FileExistingTargetBehavior): Promise<void> {
		await this.call('rename', source, { target: target.toString(), existing });
	}
	public async delete(resource: URI, missing: FileMissingTargetBehavior, mode: FileDeleteMode): Promise<void> {
		await this.call('delete', resource, { missing, mode });
	}

	private async call<T>(operation: string, resource: URI, args: object = {}): Promise<T> {
		this.assertNotDisposed();
		try {
			return await this.channel.call<T>(operation, { resource: resource.toString(), ...args });
		} catch (error) {
			if (error instanceof Error && error.name === 'FileNotFoundError') throw new FileNotFoundError(resource);
			if (error instanceof Error && error.name === 'FileRevisionConflictError') throw new FileRevisionConflictError(resource);
			if (error instanceof Error) {
				const code = toFileSystemProviderErrorCode(error);
				if (code === FileSystemProviderErrorCode.FileNotFound) throw new FileNotFoundError(resource);
				if (code !== FileSystemProviderErrorCode.Unknown) throw createFileSystemProviderError(error, code);
			}
			throw error;
		}
	}
}
