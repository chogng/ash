import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { URI } from '../../../../base/common/uri.js';

/** Edits workspace metadata through its owning host; directory authorization remains separate. */
export interface IWorkspaceEditingService {
	validateFolders(folders: readonly URI[]): void;
	addFolders(folders: readonly { readonly uri: URI; readonly name?: string; }[]): Promise<void>;
	removeFolders(folders: readonly URI[]): Promise<void>;
	updateFolders(index: number, deleteCount?: number, foldersToAdd?: readonly { readonly uri: URI; readonly name?: string; }[]): Promise<void>;
	/** Enters an existing workspace through the current window's host. */
	enterWorkspace(path: URI): Promise<void>;
	saveAndEnterWorkspace(path: URI): Promise<void>;
	pickNewWorkspacePath(): Promise<URI | undefined>;
}

export const IWorkspaceEditingService = createServiceIdentifier<IWorkspaceEditingService>('workspaceEditingService');
