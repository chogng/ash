import type {
	INativeHostApi,
} from "../../../../platform/native/common/nativeHost.js";
import {
	createServiceIdentifier,
} from "../../../../platform/instantiation/common/instantiation.js";

/** Host capability used by Workbench views to select a workspace folder. */
export interface IWorkspaceOpenService {
	readonly canOpenFolder: boolean;
	readonly canOpenWorkspace: boolean;
	openFolder(): Promise<void>;
	openWorkspace(root: string): Promise<void>;
	pickFolder(): Promise<string | undefined>;
}

export const IWorkspaceOpenService =
	createServiceIdentifier<IWorkspaceOpenService>("workspaceOpenService");

/**
 * Projects an optional native folder picker into a host-neutral Workbench API.
 */
export class WorkspaceOpenService implements IWorkspaceOpenService {
	readonly canOpenFolder: boolean;
	readonly canOpenWorkspace: boolean;
	private readonly nativeHostApi: INativeHostApi | undefined;

	constructor(nativeHostApi: INativeHostApi | undefined) {
		this.nativeHostApi = nativeHostApi;
		this.canOpenFolder = nativeHostApi !== undefined;
		this.canOpenWorkspace = nativeHostApi !== undefined;
	}

	openFolder(): Promise<void> {
		if (!this.nativeHostApi) {
			return Promise.reject(
				new Error("Opening folders is unavailable in this Workbench host"),
			);
		}
		return this.nativeHostApi.openFolder();
	}

	openWorkspace(root: string): Promise<void> {
		if (!this.nativeHostApi) {
			return Promise.reject(
				new Error("Opening workspaces is unavailable in this Workbench host"),
			);
		}
		return this.nativeHostApi.openWorkspace(root);
	}

	pickFolder(): Promise<string | undefined> {
		if (!this.nativeHostApi) {
			return Promise.reject(
				new Error("Picking folders is unavailable in this Workbench host"),
			);
		}
		return this.nativeHostApi.pickFolder();
	}
}
