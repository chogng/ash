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

/** Validated desktop requests, independent of Electron's process arguments. */
export interface IParsedLaunchArguments {
	readonly paths: readonly string[];
	readonly urls: readonly string[];
	readonly workspace?: IWorkspaceOpenTarget;
	readonly newWindow: boolean;
	readonly reuseWindow: boolean;
	readonly goto: boolean;
	readonly wait: boolean;
	readonly waitMarkerFilePath?: string;
}
