import { extUriBiasedIgnorePathCase } from '../../../base/common/resources.js';
import type { URI } from '../../../base/common/uri.js';
import { isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier, type IAnyWorkspaceIdentifier } from '../../workspace/common/workspace.js';

interface IWindowWithWorkspace {
	readonly openedWorkspace: IAnyWorkspaceIdentifier;
}

/** Finds the first live window whose workspace file or folder is this resource. */
export function findWindowOnWorkspaceOrFolder<TWindow extends IWindowWithWorkspace>(windows: readonly TWindow[], resource: URI): TWindow | undefined {
	return windows.find(window => {
		const workspace = window.openedWorkspace;
		if (isWorkspaceIdentifier(workspace)) return extUriBiasedIgnorePathCase.isEqual(workspace.configPath, resource);
		if (isSingleFolderWorkspaceIdentifier(workspace)) return extUriBiasedIgnorePathCase.isEqual(workspace.uri, resource);
		return false;
	});
}
