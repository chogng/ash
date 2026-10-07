import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { decodeBase64 } from '../../../base/common/buffer.js';
import { canceled } from '../../../base/common/errors.js';
import { Event } from '../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { listenStream, type ReadableStream } from '../../../base/common/stream.js';
import { isRecord } from '../../../base/common/types.js';
import { URI } from '../../../base/common/uri.js';
import type { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import {
	hasFileReadStreamCapability,
	type IFileReadStreamOptions,
	type IFileSystemProvider,
	type IFileWriteOptions,
	type FileExistingTargetBehavior,
	type FileMissingTargetBehavior,
	type FileDeleteMode,
} from '../common/files.js';

/** Owns file operation validation and serialization independently of the IPC host. */
export abstract class AbstractDiskFileSystemProviderChannel<TContext> extends Disposable implements IServerChannel<TContext> {
	private readonly streams = this._register(new DisposableMap<object, DisposableStore>());

	constructor(private readonly provider: IFileSystemProvider) {
		super();
	}

	public listen<T>(_context: TContext, event: string, value?: unknown): Event<T> {
		this.assertNotDisposed();
		if (event === 'readFileStream') {
			if (!isRecord(value) || !hasFileReadStreamCapability(this.provider)) { throw new TypeError('Invalid file stream request'); }
			const provider = this.provider;
			const resource = this.resource(value.resource);
			const options = this.readOptions(value.options);
			return (listener, thisArgs, disposables) => {
				this.assertNotDisposed();
				const lifetime = new DisposableStore();
				this.streams.set(lifetime, lifetime);
				lifetime.add(toDisposable(() => this.streams.deleteAndDispose(lifetime)));
				const cancellation = new CancellationTokenSource();
				lifetime.add(toDisposable(() => cancellation.dispose(true)));
				const deliver = (payload: unknown): void => { if (!lifetime.isDisposed) { listener.call(thisArgs, payload as T); } };
				// The IPC owner records the subscription before a buffered terminal event can arrive.
				queueMicrotask(() => {
					if (lifetime.isDisposed) { return; }
					try {
						const stream = provider.readFileStream(resource, options, cancellation.token);
						lifetime.add(toDisposable(() => (stream as Partial<ReadableStream<Uint8Array>>).destroy?.()));
						listenStream(stream, {
							onData: bytes => deliver({ bytes: Buffer.from(bytes).toString('base64') }),
							onError: error => { deliver({ error: { name: error.name, message: error.message } }); lifetime.dispose(); },
							onEnd: () => { deliver('end'); lifetime.dispose(); },
						}, cancellation.token);
					} catch (error) {
						deliver({ error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) } });
						lifetime.dispose();
					}
				});
				if (Array.isArray(disposables)) { disposables.push(lifetime); } else { disposables?.add(lifetime); }
				return lifetime;
			};
		}
		if (event !== 'fileChange') {
			throw new Error(`Unknown file event: ${event}`);
		}
		return Event.map(this.provider.onDidChangeFiles, change => change.resources?.map(resource => resource.toString())) as Event<T>;
	}

	public async call<T>(_context: TContext, command: string, value?: unknown, token: CancellationToken = CancellationToken.None): Promise<T> {
		this.assertNotDisposed();
		if (token.isCancellationRequested) {
			throw canceled();
		}
		if (!['stat', 'readdir', 'readFile', 'writeFile', 'createFile', 'mkdir', 'copy', 'rename', 'delete'].includes(command)
			|| !isRecord(value) || typeof value.resource !== 'string' || value.resource.length > 8192) {
			throw new TypeError('Invalid file operation or resource');
		}
		const resource = this.resource(value.resource);
		let result: unknown;
		switch (command) {
			case 'stat': result = { ...await this.provider.stat(resource), resource: resource.toString() }; break;
			case 'readdir': result = (await this.provider.readDirectory(resource)).map(entry => ({ ...entry, resource: entry.resource.toString() })); break;
			case 'readFile': {
				const content = await this.provider.readFile(resource);
				result = { resource: resource.toString(), bytes: Buffer.from(content.bytes).toString('base64'), revision: content.revision };
				break;
			}
			case 'writeFile': {
				if (typeof value.bytes !== 'string' || value.bytes.length > Math.ceil(50 * 1024 * 1024 / 3) * 4 || value.bytes.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value.bytes)
					|| !isRecord(value.options) || typeof value.options.create !== 'boolean' || typeof value.options.overwrite !== 'boolean'
					|| (value.options.expectedRevision !== undefined && typeof value.options.expectedRevision !== 'string')) {
					throw new TypeError('Invalid file write');
				}
				const bytes = decodeBase64(value.bytes).buffer;
				if (bytes.byteLength > 50 * 1024 * 1024) { throw new TypeError('File write is too large'); }
				const written = await this.provider.writeFile(resource, bytes, value.options as unknown as IFileWriteOptions);
				result = { ...written, stat: { ...written.stat, resource: resource.toString() } };
				break;
			}
			case 'createFile': {
				const stat = await this.provider.createFile(resource, this.existing(value.existing));
				result = { ...stat, resource: resource.toString() };
				break;
			}
			case 'mkdir': result = { ...await this.provider.createDirectory(resource), resource: resource.toString() }; break;
			case 'copy': result = await this.provider.copy(resource, this.resource(value.target)); break;
			case 'rename': result = await this.provider.rename(resource, this.resource(value.target), this.existing(value.existing)); break;
			case 'delete': {
				if (!['error', 'ignore'].includes(value.missing as string) || !['fileOrEmptyDirectory', 'recursive'].includes(value.mode as string)) {
					throw new TypeError('Invalid file delete');
				}
				result = await this.provider.delete(resource, value.missing as FileMissingTargetBehavior, value.mode as FileDeleteMode);
				break;
			}
		}
		return result as T;
	}

	private resource(value: unknown): URI {
		if (typeof value !== 'string' || value.length > 8192) { throw new TypeError('Invalid file resource'); }
		const resource = URI.parse(value);
		if (resource.scheme !== 'file' || resource.query || resource.fragment) { throw new TypeError('Expected a local file resource'); }
		return resource;
	}

	private readOptions(value: unknown): IFileReadStreamOptions {
		if (!isRecord(value) || (value.limits !== undefined && !isRecord(value.limits))) { throw new TypeError('Invalid file read options'); }
		const size = isRecord(value.limits) ? value.limits.size : undefined;
		for (const count of [value.position, value.length, size]) {
			if (count !== undefined && (!Number.isSafeInteger(count) || (count as number) < 0)) { throw new TypeError('Invalid file read range or size'); }
		}
		return value as IFileReadStreamOptions;
	}

	private existing(value: unknown): FileExistingTargetBehavior {
		if (value !== 'error' && value !== 'overwrite' && value !== 'ignore') { throw new TypeError('Invalid existing target behavior'); }
		return value;
	}
}
