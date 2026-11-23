import { assertFileReadSize, FileSystemProviderErrorCode, toFileSystemProviderErrorCode, type IFileService } from '../../../../platform/files/common/files.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { localize } from '../../../../nls.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { CODE_EDITOR_ID } from '../../../common/editor/codeEditorId.js';
import type { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import type { IEditorService } from '../../../services/editor/common/editorService.js';

export function mediaPreviewReadErrorMessage(error: unknown, maxBytes: number): string | undefined {
	if (!(error instanceof Error)) return undefined;
	switch (toFileSystemProviderErrorCode(error)) {
		case FileSystemProviderErrorCode.FileNotFound:
			return localize('mediaPreview.fileNotFound', 'The file could not be found.');
		case FileSystemProviderErrorCode.NoPermissions:
			return localize('mediaPreview.readPermissionDenied', 'Permission to read this file was denied.');
		case FileSystemProviderErrorCode.FileTooLarge:
			return localize('mediaPreview.byteLimit', 'The file exceeds the preview limit of {0} MiB.', maxBytes / (1024 * 1024));
		default:
			return undefined;
	}
}

export async function readMediaPreviewBytes(input: IResourceEditorInput, files: IFileService, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
	if (input.initialBytes) {
		assertFileReadSize(input.initialBytes.byteLength, { size: maxBytes });
		return input.initialBytes;
	}
	return (await raceCancellationError(files.readFileBytes(input.resource, { size: maxBytes }), signal)).bytes;
}

/** Open a bounded, read-only text preview; a comparison keeps its original tab. */
export async function reopenInTextEditor(input: IResourceEditorInput, files: IFileService, editors: IEditorService, group: IEditorGroup | undefined, maxBytes: number, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	const bytes = input.initialBytes ?? await readMediaPreviewBytes(input, files, maxBytes, signal);
	signal.throwIfAborted();
	const initialText = new TextDecoder().decode(bytes.subarray(0, 64 * 1024));
	await editors.openEditor({
		resource: input.resource,
		label: input.label,
		contentType: 'text/plain',
		languageId: 'plaintext',
		initialText,
		readOnly: true,
	}, { preferredEditorId: CODE_EDITOR_ID, pinned: true }, group ? { groupId: group.id } : 'activeGroup');
	if (group?.inputs.includes(input)) {
		await group.closeEditor(input);
	}
}
