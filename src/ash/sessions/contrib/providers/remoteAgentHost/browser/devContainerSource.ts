import { URI } from '../../../../../base/common/uri.js';
import { getRemoteWorkspacePath, isRemoteResource } from '../../../../../platform/remote/common/remote.js';

/** The injected host scope supplies authority; only its native source path crosses the runtime port. */
export function devContainerSourcePath(workspaceUri: URI): string {
	if (workspaceUri.scheme === 'file') return workspaceUri.fsPath;
	if (isRemoteResource(workspaceUri)) return getRemoteWorkspacePath(workspaceUri);
	throw new TypeError('Unsupported Dev Container source');
}
