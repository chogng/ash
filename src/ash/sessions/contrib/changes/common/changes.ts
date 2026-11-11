import type { ISessionFileChange } from '../../../services/sessions/common/session.js';
import type { TurnChangeFile, TurnChangeSetSummary } from '../../../../workbench/services/chat/common/chatService.js';
import { StorageScope, type IStorageService } from '../../../../platform/storage/common/storage.js';
import { getMultiDiffEditorFileListViewMode, setMultiDiffEditorFileListViewMode } from '../../../../workbench/contrib/multiDiffEditor/common/multiDiffEditor.js';

// Layout and accessibility consumers use identities without loading contribution registrations.
export const CHANGES_VIEW_CONTAINER_ID = 'workbench.sessions.auxiliaryBar.changesContainer';
export const CHANGES_VIEW_ID = 'sessions.changes';
export const VIEW_SESSION_CHANGES_COMMAND_ID = 'workbench.agentSessions.action.viewChanges';

export const enum ChangesViewMode {
	List = 'list',
	Tree = 'tree',
}

export function getChangesViewMode(storage: IStorageService): ChangesViewMode {
	const shared = getMultiDiffEditorFileListViewMode(storage);
	if (shared !== undefined) return shared === 'tree' ? ChangesViewMode.Tree : ChangesViewMode.List;
	const previous = storage.get('sessions.changes.viewMode', StorageScope.PROFILE);
	if (previous === 'list' || previous === 'tree') setMultiDiffEditorFileListViewMode(storage, previous);
	return previous === 'tree' ? ChangesViewMode.Tree : ChangesViewMode.List;
}

/** A Turn can have a separate capture for each repository it changed. */
export function getCapturedTurnIds(captures: readonly TurnChangeSetSummary[]): string[] {
	return [...new Set(captures.filter(capture => capture.captureState !== 'discarded' && capture.statistics.files > 0).map(capture => capture.turnId))];
}

/** Backend checkpoint files have no single Turn capture or commit selection. */
export interface IChangesThreadFileItem extends Pick<ISessionFileChange, 'uri' | 'originalUri' | 'modifiedUri' | 'insertions' | 'deletions'> {
	readonly type: 'file';
	readonly id: string;
	readonly sessionId: string;
	readonly threadId: string;
	readonly repositoryId: string;
	readonly repositoryLabel?: string;
	readonly revision: string;
	readonly file: TurnChangeFile;
	readonly warnings: readonly string[];
}
