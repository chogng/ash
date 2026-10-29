import { URI } from '../../base/common/uri.js';
import { ASH_REMOTE_SCHEME, withRemoteWorkspacePath } from '../../platform/remote/common/remote.js';
import type { ISessionWorkspace } from '../services/sessions/common/session.js';

/** Provider authorities are opaque resource identities. SessionDirectory supplies routing/permissions. */
export function sessionWorkspaceUri(workspace: ISessionWorkspace): URI {
	if (workspace.authorityId === 'local') {
		return URI.file(workspace.root);
	}
	return withRemoteWorkspacePath(URI.from({ scheme: ASH_REMOTE_SCHEME, authority: workspace.authorityId }), workspace.root);
}
