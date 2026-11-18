import { MenuId } from '../../../../platform/actions/common/actions.js';

const extensionMenuIds = new Map<string, MenuId>([
	['commandPalette', MenuId.CommandPalette],
	['editor/title', MenuId.EditorTitle],
	['editor/title/context', MenuId.EditorTitleContext],
	['scm/title', MenuId.SCMTitle],
	['scm/history/title', MenuId.SCMHistoryTitle],
	['scm/historyItem/context', MenuId.SCMHistoryItemContext],
	['scm/historyItemRef/context', MenuId.SCMHistoryItemRefContext],
	['scm/historyItemChange/context', MenuId.SCMHistoryItemChangeContext],
	['diffEditor/hunkToolbar', MenuId.DiffEditorHunkToolbar],
	['diffEditor/selectionToolbar', MenuId.DiffEditorSelectionToolbar],
	['chat/input/status', MenuId.ChatInputStatus],
]);

/** Maps extension menu names to the menu identities used by the Workbench. */
export function extensionMenuId(id: string): MenuId {
	return extensionMenuIds.get(id) ?? MenuId.for(id);
}
