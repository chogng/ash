import { triggerDownload } from '../../../../base/browser/fileAccess.js';
import { basename } from '../../../../base/common/resources.js';
import { listenStream } from '../../../../base/common/stream.js';
import { CancellationTokenSource, type CancellationToken } from '../../../../base/common/cancellation.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import type { IDesktopFileDownloadService } from '../../../../platform/files/common/diskFileSystemProviderClient.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../../platform/files/common/files.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';

/** Imports a local file through the workspace provider with backpressure and cancellable progress. */
export async function importLocalFile(files: IFileService, progressService: IProgressService, target: URI, file: File, lifetime: CancellationToken): Promise<boolean> {
	using cancellation = new CancellationTokenSource(lifetime);
	try {
		await progressService.withProgress({
			location: ProgressLocation.Notification,
			title: localize('files.import.progress', 'Importing {0}', file.name),
			cancellable: true,
		}, async progress => {
			async function* chunks(): AsyncIterable<Uint8Array> {
				const reader = file.stream().getReader();
				try {
					while (true) {
						const chunk = await raceCancellationError(reader.read(), cancellation.token);
						if (chunk.done) return;
						yield chunk.value;
						progress.report({ increment: chunk.value.byteLength, total: file.size });
					}
				} finally {
					await reader.cancel().catch(() => undefined);
					reader.releaseLock();
				}
			}
			await files.importFile(target, chunks(), file.size, cancellation.token);
		}, () => cancellation.cancel());
		return true;
	} catch (error) {
		if (cancellation.token.isCancellationRequested && isCancellationError(error)) return false;
		throw error;
	}
}

export async function copyFileWithProgress(files: IFileService, progressService: IProgressService, source: URI, target: URI, lifetime: CancellationToken): Promise<boolean> {
	using cancellation = new CancellationTokenSource(lifetime);
	const nativeCopy = source.scheme === target.scheme && files.hasCapability(source, FileSystemProviderCapabilities.FileFolderCopy);
	try {
		await progressService.withProgress({
			location: ProgressLocation.Notification,
			title: localize('files.copy.progress', 'Copying {0}', basename(source)),
			cancellable: !nativeCopy,
			delay: 500,
		}, progress => files.copy(source, target, cancellation.token, (increment, total) => progress.report({ increment, total })), () => cancellation.cancel());
		return !cancellation.token.isCancellationRequested;
	} catch (error) {
		if (cancellation.token.isCancellationRequested && isCancellationError(error)) return false;
		throw error;
	}
}

/** Downloads the exact bytes of one workspace file. */
export class FileDownload {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IProgressService private readonly progressService: IProgressService,
	) { }

	public async download(resource: URI, ownerDocument: Document, desktop?: IDesktopFileDownloadService): Promise<void> {
		const name = basename(resource);
		if (!desktop) {
			const { bytes } = await this.fileService.readFileBytes(resource);
			triggerDownload(new Blob([new Uint8Array(bytes)]), name, ownerDocument);
			return;
		}
		await desktop.save(name, target => this.progressService.withProgress({
			location: ProgressLocation.Notification,
			title: localize('files.download.progress', 'Downloading {0}', name),
			cancellable: true,
		}, async progress => {
			const { value, sizeBytes } = await this.fileService.readFileStream(resource, {}, target.token);
			try {
				await new Promise<void>((resolve, reject) => listenStream(value, {
					onData: data => {
						value.pause();
						void target.write(data).then(() => {
							progress.report({ increment: data.byteLength, total: sizeBytes });
							value.resume();
						}).catch(reject);
					},
					onEnd: resolve,
					onError: reject,
				}, target.token));
				await target.finish();
			} finally {
				value.destroy();
			}
		}, target.cancel));
	}
}
