import type {
	INativeHostApi,
} from "../../../../platform/native/common/nativeHost.js";
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { DialogSeverity, type IDialogService, type IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { HTMLFileSystemProvider } from '../../../../platform/files/browser/htmlFileSystemProvider.js';
import { workspaceFromIdentifier, type IWorkspace } from '../../../../platform/workspace/common/workspace.js';
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

export interface IWebWorkspaceDirectoryList {
	readonly path: string;
	readonly parent: string | null;
	readonly directories: readonly { readonly name: string; readonly path: string }[];
}

export interface IWebWorkspaceClient {
	list(path: string): Promise<IWebWorkspaceDirectoryList>;
	authorize(path: string): Promise<() => void>;
}

/** Selects a server directory and asks the server to authorize a new Web session for it. */
export class WebWorkspaceOpenService implements IWorkspaceOpenService {
	readonly canOpenFolder = true;
	readonly canOpenWorkspace = true;

	constructor(
		private readonly client: IWebWorkspaceClient,
		private readonly fileDialogs: IFileDialogService,
		private readonly dialogs: () => IDialogService,
		private readonly prepareSwitch: () => Promise<boolean>,
	) {}

	async openFolder(): Promise<void> {
		const path = await this.pickFolder();
		if (path) await this.openWorkspace(path);
	}

	async openWorkspace(root: string): Promise<void> {
		const selected = await this.client.list(root);
		const approved = await this.dialogs().confirm({
			title: localize({ bundle: 'ash', key: 'workbench.serverFolderAuthorizeTitle' }, 'Authorize Server Folder'),
			message: localize({ bundle: 'ash', key: 'workbench.serverFolderAuthorizeMessage' }, 'Allow this browser tab to open and change files in {0}?', selected.path),
			detail: localize({ bundle: 'ash', key: 'workbench.serverFolderAuthorizeDetail' }, 'A folder outside the current permission scope also needs approval on the server computer.'),
			primaryButton: localize({ bundle: 'ash', key: 'workbench.serverFolderAuthorizeButton' }, 'Open Folder'),
		});
		if (!approved.confirmed) return;
		const activate = await this.client.authorize(selected.path);
		if (await this.prepareSwitch()) activate();
	}

	async pickFolder(): Promise<string | undefined> {
		return (await this.fileDialogs.showOpenDialog({ canSelectFiles: false, canSelectFolders: true }))?.[0]?.fsPath;
	}
}

/**
 * Projects an optional native folder picker into a host-neutral Workbench API.
 */
export class WorkspaceOpenService implements IWorkspaceOpenService {
	readonly canOpenFolder: boolean;
	readonly canOpenWorkspace: boolean;
	private readonly nativeHostApi: INativeHostApi | undefined;

	constructor(nativeHostApi: INativeHostApi | undefined, private readonly fileDialogs: IFileDialogService | undefined, private readonly dialogs: () => IDialogService) {
		this.nativeHostApi = nativeHostApi;
		this.canOpenFolder = nativeHostApi !== undefined;
		this.canOpenWorkspace = nativeHostApi !== undefined;
	}

	async openFolder(): Promise<void> {
		if (!this.nativeHostApi) {
			throw new Error("Opening folders is unavailable in this Workbench host");
		}
		const path = await this.pickFolder();
		if (!path) return;
		try {
			await this.nativeHostApi.openWorkspace(path);
		} catch (error) {
			if (error instanceof Error && error.message.includes('Directory permissions were not selected')) return;
			if (error instanceof Error && error.message.includes('Finish the active request')) {
				await this.dialogs().showMessage({
					severity: DialogSeverity.Info,
					message: localize({ bundle: 'ash', key: 'workbench.folderOpenBlocked' }, 'Finish the active request before opening another folder.'),
					detail: localize({ bundle: 'ash', key: 'workbench.folderOpenBlockedDetail' }, 'The current Workspace was kept unchanged.'),
				});
				return;
			}
			throw error;
		}
	}

	openWorkspace(root: string): Promise<void> {
		if (!this.nativeHostApi) {
			return Promise.reject(
				new Error("Opening workspaces is unavailable in this Workbench host"),
			);
		}
		return this.nativeHostApi.openWorkspace(root);
	}

	async pickFolder(): Promise<string | undefined> {
		if (!this.fileDialogs) {
			throw new Error("Picking folders is unavailable in this Workbench host");
		}
		return (await this.fileDialogs.showOpenDialog({ canSelectFiles: false, canSelectFolders: true }))?.[0]?.fsPath;
	}
}

/** Opens folders selected and authorized by the browser on this device. */
export class BrowserWorkspaceOpenService implements IWorkspaceOpenService {
	public readonly canOpenFolder = true;
	public readonly canOpenWorkspace = true;

	constructor(
		private readonly provider: HTMLFileSystemProvider,
		private readonly updateWorkspace: (workspace: IWorkspace) => Promise<void>,
		private readonly fileDialogs: IFileDialogService,
	) {}

	public async openFolder(): Promise<void> {
		const resource = await this.pickFolderResource();
		if (resource) await this.openResource(resource);
	}

	public async openWorkspace(root: string): Promise<void> {
		const resource = await this.provider.openDirectory(URI.file(root));
		await this.openResource(resource);
	}

	public async pickFolder(): Promise<string | undefined> {
		return (await this.pickFolderResource())?.fsPath;
	}

	private async pickFolderResource(): Promise<URI | undefined> {
		return (await this.fileDialogs.showOpenDialog({ canSelectFiles: false, canSelectFolders: true }))?.[0];
	}

	private openResource(resource: URI): Promise<void> {
		const identifier = { id: resource.toString(), uri: resource };
		return this.updateWorkspace(workspaceFromIdentifier(identifier));
	}
}
