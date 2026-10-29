import { triggerDownload } from '../../../../base/browser/fileAccess.js';
import { basename } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IFileService } from '../../../../platform/files/common/files.js';

/** Downloads the exact bytes of one workspace file. */
export class FileDownload {
	constructor(private readonly fileService: IFileService) {}

	public async download(resource: URI, ownerDocument: Document): Promise<void> {
		const { bytes } = await this.fileService.readFileBytes(resource);
		triggerDownload(new Blob([new Uint8Array(bytes)]), basename(resource), ownerDocument);
	}
}
