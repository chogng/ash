import { PassThrough } from 'node:stream';
import { URI } from '../../../base/common/uri.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { canceled } from '../../../base/common/errors.js';
import type { Event } from '../../../base/common/event.js';
import { DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { dirname } from '../../../base/common/resources.js';
import { isRecord } from '../../../base/common/types.js';
import { isUuid } from '../../../base/common/uuid.js';
import { FILE_DOWNLOAD_CHUNK_BYTES } from '../common/diskFileSystemProviderClient.js';
import { AbstractDiskFileSystemProviderChannel } from '../node/diskFileSystemProviderServer.js';
import { DiskFileSystemProvider } from '../node/diskFileSystemProvider.js';

interface Download {
	readonly input: PassThrough;
	readonly cancellation: CancellationTokenSource;
	completion?: Promise<void>;
	writing: boolean;
}

/** Adds the desktop profile and OS home locations to the validated storage channel. */
export class DiskFileSystemProviderChannel extends AbstractDiskFileSystemProviderChannel<string> {
	private readonly downloads = this._register(new DisposableMap<string, DisposableStore & { readonly download: Download; }>());

	constructor(provider: DiskFileSystemProvider, private readonly userDataHome: URI, private readonly userHome: URI,
		private readonly chooseDownloadTarget?: (context: string, name: string) => Promise<URI | undefined>,
	) {
		super(provider);
	}

	public override listen<T>(context: string, event: string, value?: unknown): Event<T> {
		if (event !== 'download') return super.listen(context, event, value);
		this.assertNotDisposed();
		const chooseTarget = this.chooseDownloadTarget;
		if (!chooseTarget || !isRecord(value) || !isUuid(value.id)
			|| typeof value.name !== 'string' || value.name.length > 255) {
			throw new TypeError('Invalid file download request');
		}
		const key = `${context}:${value.id}`;
		const name = value.name.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_');
		return (listener, thisArgs, disposables) => {
			this.assertNotDisposed();
			if (this.downloads.has(key)) throw new Error('File download already exists');
			const download: Download = { input: new PassThrough({ highWaterMark: 64 * 1024 }), cancellation: new CancellationTokenSource(), writing: false };
			const lifetime = Object.assign(new DisposableStore(), { download });
			this.downloads.set(key, lifetime);
			lifetime.add(toDisposable(() => {
				download.cancellation.dispose(true);
				download.input.destroy();
				this.downloads.deleteAndDispose(key);
			}));
			// The IPC subscription owns the writer even if the renderer window closes mid-transfer.
			queueMicrotask(async () => {
				const send = (message: unknown): void => {
					if (!lifetime.isDisposed) listener.call(thisArgs, message as T);
				};
				try {
					if (lifetime.isDisposed) return;
					const destination = await chooseTarget(context, name && name !== '.' && name !== '..' ? name : 'download');
					if (lifetime.isDisposed) return;
					if (!destination) { send({ kind: 'dismissed' }); return; }
					using provider = new DiskFileSystemProvider([dirname(destination)]);
					download.completion = provider.writeFileStream(destination, download.input, download.cancellation.token);
					send({ kind: 'ready' });
					await download.completion;
				} catch (error) {
					send({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
				} finally {
					lifetime.dispose();
				}
			});
			if (Array.isArray(disposables)) disposables.push(lifetime);
			else disposables?.add(lifetime);
			return lifetime;
		};
	}

	public override async call<T>(context: string, command: string, value?: unknown, token: CancellationToken = CancellationToken.None): Promise<T> {
		this.assertNotDisposed();
		if (command === 'downloadChunk' || command === 'finishDownload' || command === 'cancelDownload') {
			if (token.isCancellationRequested) throw canceled();
			if (!isRecord(value) || !isUuid(value.id)) throw new TypeError('Invalid download operation');
			const lifetime = this.downloads.get(`${context}:${value.id}`);
			const download = lifetime?.download;
			if (command === 'cancelDownload') {
				lifetime?.dispose();
				await download?.completion?.catch(() => undefined);
				return undefined as T;
			}
			if (!download?.completion || download.writing || download.input.writableEnded) throw new Error('File download is unavailable');
			if (command === 'finishDownload') {
				download.input.end();
				await download.completion;
				return undefined as T;
			}
			const bytes = value.bytes;
			if (typeof bytes !== 'string' || bytes.length > Math.ceil(FILE_DOWNLOAD_CHUNK_BYTES / 3) * 4 || bytes.length % 4 !== 0
				|| !/^[A-Za-z0-9+/]*={0,2}$/u.test(bytes)) throw new TypeError('Invalid download chunk');
			const chunk = Buffer.from(bytes, 'base64');
			if (chunk.byteLength > FILE_DOWNLOAD_CHUNK_BYTES) throw new TypeError('Invalid download chunk');
			download.writing = true;
			try {
				await new Promise<void>((resolve, reject) => {
					const closed = (): void => reject(canceled());
					download.input.once('close', closed);
					download.input.write(chunk, error => {
						download.input.off('close', closed);
						if (error) reject(error);
						else resolve();
					});
				});
			} finally {
				download.writing = false;
			}
			return undefined as T;
		}
		if (command === 'userDataHome' || command === 'userHome') {
			if (token.isCancellationRequested) { throw canceled(); }
			if (value !== undefined) { throw new TypeError('No arguments expected'); }
			return (command === 'userDataHome' ? this.userDataHome : this.userHome).toString() as T;
		}
		return super.call(context, command, value, token);
	}
}
