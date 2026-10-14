import { type IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import type { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';

export interface AppServerLanguageDirAccess {
	readonly workspaceId: string;
	readonly allowed: boolean;
}

/** Resolves whether every folder may start executable language services. */
export async function resolveAppServerLanguageDirAccess(workspaceContext: IWorkspaceContextService, workspaceTrust: IWorkspaceTrustManagementService, checkWorkspaceTrust: boolean): Promise<AppServerLanguageDirAccess> {
	const workspace = workspaceContext.getWorkspace();
	// Browser handle identities cannot authorize a server process to read the local directory.
	if (workspace.folders.length === 0 || workspace.folders.some(folder => folder.uri.scheme !== "file" || folder.uri.path.startsWith('/@browser/'))) return { workspaceId: workspace.id, allowed: false };
	if (!checkWorkspaceTrust) return { workspaceId: workspace.id, allowed: true };
	const permissions = await Promise.all(workspace.folders.map(async folder => (await workspaceTrust.getUriTrustInfo(folder.uri)).permissions));
	return {
		workspaceId: workspace.id,
		allowed: permissions.every(entry => entry?.includes("useLanguageServices") && entry.includes("executeCommands")),
	};
}
