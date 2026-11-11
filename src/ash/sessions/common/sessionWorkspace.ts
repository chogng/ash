import type { IAgentConnection } from '../../platform/agentHost/common/agentService.js';
import { createServiceIdentifier } from '../../platform/instantiation/common/instantiation.js';
import { URI } from '../../base/common/uri.js';
import { ASH_REMOTE_SCHEME, withRemoteWorkspacePath } from '../../platform/remote/common/remote.js';
import type { ISessionWorkspace, IUntitledChatSession } from '../services/sessions/common/session.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from './agentHostSessionsProvider.js';

/** A local Code draft needs a project selection in addition to its execution directory. */
export function hasSelectedCodeWorkspace({ providerId, projectId, workspace }: IUntitledChatSession): boolean {
	return (!!projectId || (!!providerId && providerId !== LOCAL_AGENT_HOST_PROVIDER_ID))
		&& workspace.type !== 'current'
		&& (workspace.type !== 'multiple' || workspace.folders.length > 0);
}

export interface ISessionFolderAuthorizationService {
	/** Checks existing local directory permissions without prompting or granting access. */
	isTrusted(path: string): Promise<boolean>;

	/** Checks development permissions and confirms all missing grants on the same host in one prompt. */
	authorize(paths: readonly string[], signal: AbortSignal, options?: {
		readonly host?: { readonly api: IAgentConnection; readonly label: string; };
		/** Require a grant that can bind the directory as a workspace root. */
		readonly explicitGrant?: boolean;
		readonly onTrustDeclined?: () => void;
	}): Promise<boolean>;
}

export const ISessionFolderAuthorizationService = createServiceIdentifier<ISessionFolderAuthorizationService>('sessionFolderAuthorizationService');

/** Provider authorities are opaque resource identities. SessionDirectory supplies routing/permissions. */
export function sessionWorkspaceUri(workspace: ISessionWorkspace): URI {
	if (workspace.authorityId === 'local') { return URI.file(workspace.root); }
	return withRemoteWorkspacePath(URI.from({ scheme: ASH_REMOTE_SCHEME, authority: workspace.authorityId }), workspace.root);
}
