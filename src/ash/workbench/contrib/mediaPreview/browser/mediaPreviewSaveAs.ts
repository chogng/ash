import { extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { triggerDownload } from '../../../../base/browser/fileAccess.js';
import { getExtensionForMimeType, getMediaMime } from '../../../../base/common/mime.js';
import { isNative } from '../../../../base/common/platform.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import type { IResourceEditorInput } from '../../../common/editor.js';

/** The editor host picks and confirms the destination before calling the pane's Save As. */
export async function saveMediaFileAs(input: IResourceEditorInput, target: URI, files: IFileService): Promise<void> {
	if (extUri.isEqual(input.resource, target)) {
		return;
	}
	// Revision-backed previews can supply immutable bytes without a filesystem provider.
	const bytes = input.initialBytes ?? (await files.readFileBytes(input.resource)).bytes;
	await files.writeFileBytes(target, bytes, { create: true, overwrite: true });
}

export function mediaImageFileName(name: string, mimeType: string): string {
	const safeName = name.split(/[\\/]/u).at(-1)?.replace(/[<>:"|?*\u0000-\u001f]/gu, '_').replace(/[. ]+$/u, '') || 'image';
	const extension = getExtensionForMimeType(mimeType);
	return extension && getMediaMime(safeName) !== mimeType ? `${safeName}${extension}` : safeName;
}

/** A preview has original bytes but no editable file resource. */
export async function saveMediaImageAs(accessor: ServicesAccessor, image: Blob, name: string, document: Document): Promise<void> {
	if (!isNative) {
		triggerDownload(image, name, document);
		return;
	}
	const dialogs = accessor.get(IFileDialogService);
	const files = accessor.get(IFileService);
	const target = await dialogs.pickFileToSave(URI.file(`/${name}`));
	if (target) await files.writeFileBytes(target, new Uint8Array(await image.arrayBuffer()), { create: true, overwrite: true });
}
