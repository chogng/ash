import type { URI } from '../../../../base/common/uri.js';
import { parseJsonc } from '../../../../base/common/jsonc.js';
import { basename } from '../../../../base/common/resources.js';
import { IFileService, FileKind } from '../../../../platform/files/common/files.js';
import { parseStoredWorkspaceFolders, toWorkspaceFolders } from '../../../../platform/workspaces/common/workspaces.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IPathService } from '../../../../platform/path/common/pathService.js';
import { localize } from '../../../../nls.js';
import type { HTMLFileSystemProvider } from '../../../../platform/files/browser/htmlFileSystemProvider.js';
import { workspaceFromIdentifier, type IWorkspace } from '../../../../platform/workspace/common/workspace.js';
import { WorkspaceTransitionCommittedError } from '../../workspaces/common/workspaceEditing.js';
import type { IWebWorkspaceClient } from '../../workspaces/browser/appServerWebWorkspaceClient.js';
import { addDisposableListener, hasAppFocus } from '../../../../base/browser/dom.js';
import { getWindows, onDidRegisterWindow, onDidUnregisterWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import type {
	IOpenEmptyWindowOptions,
	IOpenWindowOptions,
	IWindowOpenable,
} from '../../../../platform/window/common/window.js';
import { ILifecycleService, ShutdownVetoError } from '../../lifecycle/common/lifecycle.js';
import { IHostService } from './host.js';
import { VSBuffer } from '../../../../base/common/buffer.js';

export const EMPTY_WORKSPACE_ID_KEY = 'ash.workbench.emptyWorkspaceId';

/** The embedding host owns directory handles or the authenticated server session. */
export interface BrowserHostServiceOptions {
	readonly workspaceProvider?:
		| {
				readonly kind: 'local';
				readonly provider: HTMLFileSystemProvider;
				readonly updateWorkspace: (workspace: IWorkspace, preserveEditors?: boolean) => Promise<void>;
		  }
		| {
				readonly kind: 'server';
				readonly client: IWebWorkspaceClient;
				readonly prepareSwitch: () => Promise<boolean>;
				readonly updateWorkspace?: (workspace: IWorkspace, preserveEditors?: boolean) => Promise<void>;
				readonly validateFolders?: (folders: readonly URI[]) => void;
		  };
}

export class BrowserHostService extends Disposable implements IHostService {
	private readonly focusChanged = this._register(new Emitter<boolean>());
	public readonly onDidChangeFocus = this.focusChanged.event;
	public get hasFocus(): boolean {
		return hasAppFocus();
	}
	private readonly ownerWindow = window;
	constructor(
		private readonly options: BrowserHostServiceOptions,
		@ILifecycleService private readonly lifecycle: ILifecycleService,
		@IDialogService private readonly dialogs: IDialogService,
		@IPathService private readonly paths: IPathService,
		@IFileService private readonly files: IFileService,
	) {
		super();
		let lastFocus = this.hasFocus;
		// Blur and focus can arrive in one window handoff; publish the aggregate after that handoff.
		const scheduler = this._register(
			new RunOnceScheduler(() => {
				const focus = this.hasFocus;
				if (focus === lastFocus) {
					return;
				}
				lastFocus = focus;
				this.focusChanged.fire(focus);
			}, 0),
		);
		const listeners = this._register(new DisposableMap<Window, DisposableStore>());
		const observe = (targetWindow: Window): void => {
			const resources = new DisposableStore();
			resources.add(addDisposableListener(targetWindow, 'focus', () => scheduler.schedule()));
			resources.add(addDisposableListener(targetWindow, 'blur', () => scheduler.schedule()));
			listeners.set(targetWindow, resources);
		};
		for (const registered of getWindows()) {
			observe(registered.window);
		}
		this._register(onDidRegisterWindow(registered => observe(registered.window)));
		this._register(
			onDidUnregisterWindow(targetWindow => {
				listeners.deleteAndDispose(targetWindow);
				scheduler.schedule();
			}),
		);
	}

	public async restart(): Promise<void> {
		return this.reload();
	}

	public async reload(): Promise<void> {
		// A restart retains the workspace and dirty backups; 'load' replaces it.
		try {
			await this.lifecycle.shutdown('reload');
		} catch (error) {
			if (error instanceof ShutdownVetoError) {
				return;
			}
			throw error;
		}
		this.ownerWindow.location.reload();
	}

	public async getScreenshot(): Promise<VSBuffer | undefined> {
		this.assertNotDisposed();
		const resources = this._register(new DisposableStore());
		let stream: MediaStream | undefined;
		const video = this.ownerWindow.document.createElement('video');
		video.muted = true;
		try {
			stream = await this.ownerWindow.navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
			if (resources.isDisposed) return undefined;
			video.srcObject = stream;
			const ready = new Promise<void>((resolve, reject) => {
				resources.add(addDisposableListener(video, 'loadeddata', () => resolve()));
				resources.add(
					addDisposableListener(video, 'error', () =>
						reject(new Error('The screenshot video could not be read')),
					),
				);
				const timeout = this.ownerWindow.setTimeout(
					() => reject(new Error('The screenshot video did not produce a frame')),
					10_000,
				);
				resources.add(toDisposable(() => this.ownerWindow.clearTimeout(timeout)));
				resources.add(toDisposable(() => reject(new Error('The screenshot capture has closed'))));
			});
			await Promise.all([video.play(), ready]);
			const canvas = this.ownerWindow.document.createElement('canvas');
			canvas.width = video.videoWidth;
			canvas.height = video.videoHeight;
			const context = canvas.getContext('2d');
			if (!context || !canvas.width || !canvas.height) throw new Error('The screenshot frame is empty');
			context.drawImage(video, 0, 0);
			const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
			if (!blob) throw new Error('The screenshot could not be encoded');
			return VSBuffer.wrap(new Uint8Array(await blob.arrayBuffer()));
		} catch (error) {
			if (error instanceof DOMException && error.name === 'NotAllowedError') return undefined;
			throw error;
		} finally {
			// Permission may resolve after host disposal. Always stop the returned stream, including that late result.
			stream?.getTracks().forEach(track => track.stop());
			video.pause();
			video.srcObject = null;
			this._store.delete(resources);
			resources.dispose();
		}
	}

	public openWindow(options?: IOpenEmptyWindowOptions): Promise<void>;
	public openWindow(toOpen: readonly IWindowOpenable[], options?: IOpenWindowOptions): Promise<void>;
	public async openWindow(
		toOpenOrOptions: readonly IWindowOpenable[] | IOpenEmptyWindowOptions = {},
		openOptions: IOpenWindowOptions = {},
	): Promise<void> {
		if (Array.isArray(toOpenOrOptions)) {
			if (!this.options.workspaceProvider)
				throw new Error(
					localize('workspace.openUnavailable', 'Opening workspaces is unavailable in this host.'),
				);
			if (toOpenOrOptions.length !== 1)
				throw new Error(localize('workspace.oneWindowTarget', 'Open one workspace per window request.'));
			await this.openWorkspace(toOpenOrOptions[0]!, openOptions);
			return;
		}
		const options = toOpenOrOptions as IOpenEmptyWindowOptions;
		if (options.remoteAuthority !== undefined) throw new Error('This browser host cannot open a Remote window');
		const url = new URL(this.ownerWindow.location.href);
		url.searchParams.delete('folder');
		url.searchParams.delete('workspace');
		if (!options.forceReuseWindow) {
			this.ownerWindow.open(url.href, '_blank');
			return;
		}
		try {
			await this.lifecycle.shutdown('load');
		} catch (error) {
			if (error instanceof ShutdownVetoError) return;
			throw error;
		}
		this.ownerWindow.sessionStorage.setItem(EMPTY_WORKSPACE_ID_KEY, `empty-window-${crypto.randomUUID()}`);
		this.ownerWindow.location.assign(url.href);
	}
	private async openWorkspace(target: IWindowOpenable, options: IOpenWindowOptions): Promise<void> {
		const provider = this.options.workspaceProvider!;
		if (options.forceNewWindow)
			throw new Error(
				localize(
					{ bundle: 'ash', key: 'workbench.newWindowUnavailable' },
					'Opening a new window is unavailable in this host',
				),
			);
		if ('workspaceUri' in target) {
			const resource = target.workspaceUri;
			const document = parseJsonc((await this.files.readFile(resource)).content, resource.toString());
			const folders = toWorkspaceFolders(parseStoredWorkspaceFolders(document, resource.toString()), resource);
			if (provider.kind === 'server') {
				if (!provider.client.updateWorkspace || !provider.updateWorkspace)
					throw new Error(
						localize('workspace.editUnavailable', 'Workspace editing is unavailable in this host.'),
					);
				provider.validateFolders?.(folders.map(folder => folder.uri));
				const selected = await Promise.all(
					folders.map(async folder => {
						const path = await this.paths.getHostPath(folder.uri);
						if (path === undefined)
							throw new TypeError(
								localize('path.platformUnavailable', 'Resource path platform is unavailable'),
							);
						return { path, name: folder.name };
					}),
				);
				if (!options.preserveEditors && !(await provider.prepareSwitch())) return;
				const transition = await provider.client.updateWorkspace(resource, selected);
				try {
					await provider.updateWorkspace(transition.workspace, options.preserveEditors);
				} catch (error) {
					if (error instanceof WorkspaceTransitionCommittedError) {
						try {
							await transition.complete(true);
						} catch {
							/* The recorded outcome is recovered before the next page starts. */
						}
						throw error;
					}
					try {
						await transition.complete(false);
					} catch (rollback) {
						throw new AggregateError(
							[error, rollback],
							localize(
								'workspace.rollbackFailed',
								'Could not restore workspace authorization after the window transition failed.',
							),
						);
					}
					throw error;
				}
				try {
					await transition.complete(true);
				} catch (error) {
					throw new WorkspaceTransitionCommittedError(
						localize(
							'workspace.authorizationRecovery',
							'The workspace changed. Authorization confirmation will be retried when this page reconnects.',
						),
						error,
					);
				}
				return;
			}
			for (const folder of folders) {
				if (folder.uri.scheme !== 'file' || !folder.uri.path.startsWith('/@browser/'))
					throw new TypeError(
						localize(
							'workspace.browserFoldersOnly',
							'Browser workspaces require folders selected through the browser.',
						),
					);
				await provider.provider.openDirectory(folder.uri);
				if ((await this.files.stat(folder.uri)).kind !== FileKind.Directory)
					throw new TypeError(
						localize('workspace.folderNotDirectory', 'Workspace folder must be a directory.'),
					);
			}
			await provider.updateWorkspace(
				{
					id: resource.toString(),
					configuration: resource,
					name: basename(resource).replace(/\.(ash|code)-workspace$/i, ''),
					folders,
				},
				options.preserveEditors,
			);
			return;
		}
		if (provider.kind === 'local') {
			const resource = await provider.provider.openDirectory(target.folderUri);
			await provider.updateWorkspace(workspaceFromIdentifier({ id: resource.toString(), uri: resource }));
			return;
		}
		const resource = target.folderUri;
		const hostPath = await this.paths.getHostPath(resource);
		if (hostPath === undefined)
			throw new TypeError(localize('path.platformUnavailable', 'Resource path platform is unavailable'));
		const selected = await provider.client.list(hostPath);
		const approved = await this.dialogs.confirm({
			title: localize({ bundle: 'ash', key: 'workbench.serverFolderAuthorizeTitle' }, 'Authorize Server Folder'),
			message: localize(
				{ bundle: 'ash', key: 'workbench.serverFolderAuthorizeMessage' },
				'Allow this browser tab to open and change files in {0}?',
				selected.path,
			),
			detail: localize(
				{ bundle: 'ash', key: 'workbench.serverFolderAuthorizeDetail' },
				'A folder outside the current permission scope also needs approval on the server computer.',
			),
			primaryButton: localize({ bundle: 'ash', key: 'workbench.serverFolderAuthorizeButton' }, 'Open Folder'),
		});
		if (!approved.confirmed) return;
		const activate = await provider.client.authorize(selected.path);
		if (await provider.prepareSwitch()) activate();
	}
}
