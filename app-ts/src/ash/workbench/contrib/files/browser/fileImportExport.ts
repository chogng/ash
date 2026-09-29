import { triggerDownload } from '../../../../base/browser/fileAccess.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IFileService } from '../../../../platform/files/common/files.js';

/** Downloads the exact bytes of one workspace file. */
export class FileDownload {
	constructor(private readonly fileService: IFileService) {}

	public async download(resource: URI, ownerDocument: Document): Promise<void> {
		const { bytes } = await this.fileService.readFileBytes(resource);
		const encodedPath = resource.toEncodedComponents().path;
		const name = decodeURIComponent(encodedPath.slice(encodedPath.lastIndexOf('/') + 1));
		triggerDownload(new Blob([new Uint8Array(bytes)]), name, ownerDocument);
	}
}
