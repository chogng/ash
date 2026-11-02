import { ConfirmResult } from '../../../../../platform/dialogs/common/dialogs.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { CHAT_VIEW_ID } from '../../common/chat.js';
import type { IChatViewPane } from '../chat.js';
import { ChatEditorInput } from '../widgetHosts/editor/chatEditorInput.js';

const pending = new WeakSet<ChatEditorInput>();

/** Replaces one editor presentation while the Session owner retains its history and draft. */
export async function clearChatEditor(accessor: ServicesAccessor, chatEditorInput?: ChatEditorInput): Promise<void> {
	const editors = accessor.get(IEditorService);
	const groups = accessor.get(IEditorGroupsService);
	const views = accessor.get(IViewsService);
	const input = chatEditorInput ?? editors.activeEditor;
	if (!(input instanceof ChatEditorInput) || pending.has(input)) return;
	const group = groups.groups.find(candidate => candidate.inputs.includes(input));
	if (!group) return;
	pending.add(input);
	try {
		// Capture attachment preparation before the old editor host is released.
		if (await input.closeHandler?.confirm([{ editor: input, groupId: group.id }]) === ConfirmResult.CANCEL) return;
		const view = await views.openView<IChatViewPane>(CHAT_VIEW_ID, false);
		if (!view || !group.inputs.includes(input) || groups.getGroup(group.id) !== group) return;
		const index = group.inputs.indexOf(input);
		const replacement = view.createNewChatEditorInput(input);
		await editors.openEditor(replacement, { pinned: true, index, ignoreError: true }, { groupId: group.id });
		if (group.isSticky(input)) group.stickEditor(replacement);
		await group.closeEditor(input, { skipConfirmation: true, reason: 'replace' });
	} finally {
		pending.delete(input);
	}
}
