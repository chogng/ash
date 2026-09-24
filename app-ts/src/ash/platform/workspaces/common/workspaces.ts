/** How a user-facing launch path should be interpreted. */
export const enum WorkspaceOpenTargetKind {
	Automatic,
	Folder,
	Workspace,
	RemoteFolder,
}

/** One folder or workspace-file target requested by a window launch. */
export interface ILocalWorkspaceOpenTarget {
	readonly kind: WorkspaceOpenTargetKind.Automatic | WorkspaceOpenTargetKind.Folder | WorkspaceOpenTargetKind.Workspace;
	readonly path: string;
}

/** One absolute folder requested through an OpenSSH config host. */
export interface IRemoteFolderWorkspaceOpenTarget {
	readonly kind: WorkspaceOpenTargetKind.RemoteFolder;
	readonly path: string;
	readonly sshHost: string;
}

export type IWorkspaceOpenTarget = ILocalWorkspaceOpenTarget | IRemoteFolderWorkspaceOpenTarget;
