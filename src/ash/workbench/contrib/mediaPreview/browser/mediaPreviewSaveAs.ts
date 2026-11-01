import { extUri } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
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
