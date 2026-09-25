import type {
	INativeHostApi,
} from "../../../../platform/native/common/nativeHost.js";
import { URI } from '../../../../base/common/uri.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
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

type ServerDirectoryItem = IQuickPickItem & (
	| { readonly kind: 'select'; readonly path: string }
	| { readonly kind: 'parent'; readonly path: string }
	| { readonly kind: 'directory'; readonly path: string }
);

/** Selects a server directory and asks the server to authorize a new Web session for it. */
export class WebWorkspaceOpenService implements IWorkspaceOpenService {
	readonly canOpenFolder = true;
	readonly canOpenWorkspace = true;

	constructor(
		private readonly client: IWebWorkspaceClient,
		private readonly quickInput: () => IQuickInputService,
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
		if (!approved) return;
		const activate = await this.client.authorize(selected.path);
		if (await this.prepareSwitch()) activate();
	}

	async pickFolder(): Promise<string | undefined> {
		let path = '';
		for (;;) {
			const listing = await this.client.list(path);
			const selected = await this.pickDirectory(listing);
			if (!selected) return undefined;
			if (selected.kind === 'select') return selected.path;
			path = selected.path;
		}
	}

	private pickDirectory(listing: IWebWorkspaceDirectoryList): Promise<ServerDirectoryItem | undefined> {
		const picker = this.quickInput().createQuickPick<ServerDirectoryItem>();
		const disposables = new DisposableStore();
		disposables.add(picker);
		picker.placeholder = listing.path;
		picker.ariaLabel = localize({ bundle: 'ash', key: 'workbench.serverFolderChoose' }, 'Choose a server folder');
		picker.items = [
			{ kind: 'select', path: listing.path, label: localize({ bundle: 'ash', key: 'workbench.serverFolderSelect' }, 'Select this folder'), description: listing.path },
			...(listing.parent ? [{ kind: 'parent' as const, path: listing.parent, label: '..', description: listing.parent }] : []),
			...listing.directories.map(directory => ({ kind: 'directory' as const, path: directory.path, label: directory.name })),
		];
		return new Promise(resolve => {
			let settled = false;
			const finish = (item: ServerDirectoryItem | undefined): void => {
				if (settled) return;
				settled = true;
				disposables.dispose();
				resolve(item);
			};
			disposables.add(picker.onDidAccept(item => finish(item)));
			disposables.add(picker.onDidHide(() => finish(undefined)));
			picker.show();
		});
	}
}

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

/** Opens folders selected and authorized by the browser on this device. */
export class BrowserWorkspaceOpenService implements IWorkspaceOpenService {
	public readonly canOpenFolder = true;
	public readonly canOpenWorkspace = true;

	constructor(
		private readonly provider: HTMLFileSystemProvider,
		private readonly updateWorkspace: (workspace: IWorkspace) => Promise<void>,
		private readonly pickDirectory: () => Promise<FileSystemDirectoryHandle>,
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
		let handle: FileSystemDirectoryHandle;
		try { handle = await this.pickDirectory(); }
		catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') return undefined;
			throw error;
		}
		return this.provider.registerDirectoryHandle(handle);
	}

	private openResource(resource: URI): Promise<void> {
		const identifier = { id: resource.toString(), uri: resource };
		return this.updateWorkspace(workspaceFromIdentifier(identifier));
	}
}
