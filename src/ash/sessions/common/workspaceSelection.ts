import type { URI } from '../../base/common/uri.js';
import type { SessionExecutionTarget } from '../services/sessions/common/session.js';

export const enum WorkspaceSelectionOrigin {
	None = 'none',
	WindowContext = 'windowContext',
	AgentsRecent = 'agentsRecent',
	User = 'user',
}

export type WorkspaceHistoryLoadState = 'loading' | 'loaded' | 'error';

/** Picker state is transient; it never grants filesystem access or replaces a draft's workspace. */
export interface IWorkspaceSelectionSnapshot {
	readonly folderUri: URI | undefined;
	readonly origin: WorkspaceSelectionOrigin;
	readonly state: 'none' | 'noWorkspace' | 'selected' | 'unresolved';
	readonly historyState: WorkspaceHistoryLoadState;
	readonly target?: SessionExecutionTarget;
}
