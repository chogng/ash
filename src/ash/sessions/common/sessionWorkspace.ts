import { URI } from '../../base/common/uri.js';
import { createSshRemoteWorkspaceUri } from '../../platform/remote/common/remote.js';
import type { ISessionWorkspace } from '../services/sessions/common/session.js';

/** Provider authorities are opaque resource identities. SessionDirectory supplies routing/permissions. */
export function sessionWorkspaceUri(workspace: ISessionWorkspace): URI {
	if (workspace.authorityId === 'local') { return URI.file(workspace.root); }
	if (workspace.authorityId.startsWith('provider+')) {
		return URI.from({ scheme: 'ash-remote', authority: workspace.authorityId, path: workspace.root });
	}
	return createSshRemoteWorkspaceUri(workspace.authorityId, workspace.root);
}
