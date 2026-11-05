import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IWorkspace } from '../../../../platform/workspace/common/workspace.js';

export const ISessionsWorkspaceContextService = createServiceIdentifier<ISessionsWorkspaceContextService>('sessionsWorkspaceContextService');

/** Host workspace and publication of the Explorer's window-local workspace projection. */
export interface ISessionsWorkspaceContextService {
	getHostWorkspace(): IWorkspace;
	updateWorkspace(workspace: IWorkspace): void;
}
