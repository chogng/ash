import { triggerDownload } from '../../../../base/browser/fileAccess.js';
import { basename } from '../../../../base/common/resources.js';
import { listenStream } from '../../../../base/common/stream.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import type { IDesktopFileDownloadService } from '../../../../platform/files/common/diskFileSystemProviderClient.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';

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
