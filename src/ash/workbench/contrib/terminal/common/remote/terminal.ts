import type { IWorkspace } from '../../../../../platform/workspace/common/workspace.js';
import { getRemoteAuthority } from '../../../../../platform/remote/common/remoteHosts.js';

/** Identity for a pending create; process authorization stays in the platform adapter. */
export interface ITerminalExecutionScope {
	readonly workspaceId: string;
	readonly remoteAuthority: string | undefined;
	readonly folders: readonly string[];
}

export function terminalExecutionScope(workspace: IWorkspace): ITerminalExecutionScope {
	return Object.freeze({
		workspaceId: workspace.id,
		remoteAuthority: workspace.remoteAuthority ?? (workspace.folders[0] && getRemoteAuthority(workspace.folders[0].uri)),
		folders: Object.freeze(workspace.folders.map(folder => `${folder.id}:${folder.uri.toString()}`)),
	});
}

export function terminalExecutionScopesEqual(left: ITerminalExecutionScope, right: ITerminalExecutionScope): boolean {
	return (
		left.workspaceId === right.workspaceId &&
		left.remoteAuthority === right.remoteAuthority &&
		left.folders.length === right.folders.length &&
		left.folders.every((folder, index) => folder === right.folders[index])
	);
}
