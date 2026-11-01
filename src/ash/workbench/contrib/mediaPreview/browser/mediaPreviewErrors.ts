import type { IFileService } from '../../../../platform/files/common/files.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { CODE_EDITOR_ID } from '../../../common/editor/codeEditorId.js';
import type { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import type { IEditorService } from '../../../services/editor/common/editorService.js';

/** Open a bounded, read-only text preview; a comparison keeps its original tab. */
export async function reopenInTextEditor(input: IResourceEditorInput, files: IFileService, editors: IEditorService, group: IEditorGroup | undefined, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	const bytes = input.initialBytes ?? (await raceCancellationError(files.readFileBytes(input.resource), signal)).bytes;
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
