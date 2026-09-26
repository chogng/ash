/** The folder or workspace requested by one desktop launch. */
export const enum WorkspaceOpenTargetKind {
	Automatic,
	Folder,
	Workspace,
	RemoteFolder,
}

export interface ILocalWorkspaceOpenTarget {
	readonly kind: WorkspaceOpenTargetKind.Automatic | WorkspaceOpenTargetKind.Folder | WorkspaceOpenTargetKind.Workspace;
	readonly path: string;
}

export interface IRemoteFolderWorkspaceOpenTarget {
	readonly kind: WorkspaceOpenTargetKind.RemoteFolder;
	readonly path: string;
	readonly sshHost: string;
}

export type IWorkspaceOpenTarget = ILocalWorkspaceOpenTarget | IRemoteFolderWorkspaceOpenTarget;
