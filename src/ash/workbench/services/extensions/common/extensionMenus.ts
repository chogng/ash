import { MenuId } from '../../../../platform/actions/common/actions.js';

/** Maps public manifest menu names to client-owned menu identities. */
export function extensionMenuId(id: string): MenuId {
	const standard: Record<string, MenuId> = { 'editor/title': MenuId.EditorTitle, 'editor/title/context': MenuId.EditorTitleContext, 'scm/title': MenuId.SCMTitle, 'scm/history/title': MenuId.SCMHistoryTitle, 'scm/historyItem/context': MenuId.SCMHistoryItemContext, 'scm/historyItemRef/context': MenuId.SCMHistoryItemRefContext, 'diffEditor/hunkToolbar': MenuId.DiffEditorHunkToolbar, 'diffEditor/selectionToolbar': MenuId.DiffEditorSelectionToolbar };
	return standard[id] ?? MenuId.for(id);
}
