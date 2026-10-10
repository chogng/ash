import { NativeExtensionService } from '../services/extensions/electron-browser/nativeExtensionService.js';
import { IRemoteAuthorityResolverService } from '../../platform/remote/common/remoteAuthorityResolver.js';
import { RemoteAuthorityResolverService } from '../../platform/remote/electron-browser/remoteAuthorityResolverService.js';
import { IRemoteSocketFactoryService } from '../../platform/remote/common/remoteSocketFactoryService.js';
import { IExtensionHostApi } from '../../platform/extensionHost/common/extensionHostApi.js';
import { MutableDisposable, DisposableStore } from '../../base/common/lifecycle.js';
import { FileUserDataProvider } from '../../platform/userData/common/fileUserDataProvider.js';
import { RelayURLService } from '../services/url/electron-browser/urlService.js';
import { IBackupService } from '../../platform/backup/common/backup.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { WORKSPACE_RECOVERY_CHANNEL } from '../../platform/window/common/window.js';
import { serializeWorkspaceIdentifier, type IAnyWorkspaceIdentifier } from '../../platform/workspace/common/workspace.js';
import { WorkingCopyBackupService } from '../services/workingCopy/browser/workingCopyBackupService.js';
import { IndexedDbWorkingCopyBackupService } from '../services/workingCopy/browser/indexedDbWorkingCopyBackupService.js';
import { AppServerProtocolClient } from '../../platform/agentHost/browser/appServerProtocolClient.js';
import { AppServerTextDocumentHost } from '../services/textfile/browser/appServerTextDocumentHost.js';
import { IChatEditingService } from '../contrib/chat/common/editing/chatEditingService.js';
import { addDisposableListener } from '../../base/browser/dom.js';
import { installBaseUiStyles } from '../../base/browser/ui/styles.js';
import { Disposable, DisposableTracker, installDisposableTracker, toDisposable } from '../../base/common/lifecycle.js';
import { onUnexpectedError } from '../../base/common/errors.js';
import { URI } from '../../base/common/uri.js';
import { IFileService } from '../../platform/files/common/files.js';
import { FileService } from '../../platform/files/common/fileService.js';
import { ElectronRendererClipboardService } from '../../platform/clipboard/electron-browser/electronRendererClipboardService.js';
import { validateConfigurationSnapshot } from '../../platform/configuration/common/configurationIpc.js';
import { invoke, subscribe } from '../../platform/ipc/electron-browser/rendererIpc.js';
import { InstantiationService } from '../../platform/instantiation/common/instantiationService.js';
import { IMainProcessService } from '../../platform/ipc/common/mainProcessService.js';
import { ElectronIPCMainProcessService } from '../../platform/ipc/electron-browser/mainProcessService.js';
import { createElectronRendererApi, type ElectronRendererCapabilityContribution } from '../../platform/native/electron-browser/rendererApi.js';
import { parseWorkspace } from '../../platform/workspace/common/workspace.js';
import { showStartupError } from '../browser/startupError.js';
import { NativeHostColorSchemeService } from '../services/themes/electron-browser/nativeHostColorSchemeService.js';
import { startWorkbench, type IStartWorkbenchOptions, type Workbench } from '../browser/workbench.js';
import { ElectronContextMenuService } from '../services/contextmenu/electron-browser/contextMenuService.js';
import { loadUserThemes } from '../services/themes/browser/workbenchThemeService.js';
import { ElectronLifecycleService } from '../services/lifecycle/electron-browser/lifecycleService.js';
import { createElectronTitlebarPartFactory } from '../services/title/electron-browser/titleService.js';
import { NativeDialogHandler } from './parts/dialogs/dialogHandler.js';
import { DirectoryPermissionDialog } from './parts/dialogs/directoryPermissionDialog.js';
import { ElectronWindow } from './window.js';
import { registerLocalTranscriptionService } from '../services/localTranscription/electron-browser/localTranscriptionService.js';
import { NativeWorkbenchStorageService } from '../services/storage/electron-browser/storageService.js';
import { LoggerChannelClient } from '../../platform/log/common/logIpc.js';
import { ElectronWorkbenchEnvironmentService } from '../services/environment/electron-browser/environmentService.js';

/** Owns desktop startup and the resources of one renderer window. */
export class DesktopMain extends Disposable {
	private opened = false;

	constructor(private readonly options: Pick<IStartWorkbenchOptions, 'productName'>, private readonly rendererCapabilities: readonly ElectronRendererCapabilityContribution[]) {
		super();
	}

	public async open(): Promise<void> {
		this.assertNotDisposed();
		if (this.opened) {
			throw new Error('Desktop startup has already begun');
		}
		this.opened = true;
		performance.mark('ash.desktop.open-start');
		installBaseUiStyles();
		const tracker = import.meta.env.DEV ? new DisposableTracker() : undefined;
		const tracking = tracker ? installDisposableTracker(tracker) : undefined;
		try {
			const container = document.querySelector<HTMLElement>('#app') ?? document.body;
			const permissionDialog = this._register(new DirectoryPermissionDialog(container));
			const transcriptionServices = this._register(new InstantiationService());
			const profileServices = this._register(new InstantiationService());
			const windowId = await invoke<unknown>('ash:ipc:window-id');
			if (!Number.isSafeInteger(windowId) || (windowId as number) <= 0) { throw new TypeError('Invalid Main IPC window ID'); }
			const mainProcessService = this._register(profileServices.createInstance(ElectronIPCMainProcessService, windowId as number));
			profileServices.registerInstance(IMainProcessService, mainProcessService);
			const logger = profileServices.createInstance(LoggerChannelClient);
			const resolver = this._register(profileServices.createInstance(RemoteAuthorityResolverService));
			profileServices.registerInstance(IRemoteAuthorityResolverService, resolver);
			const resolverScope = this._register(new MutableDisposable<DisposableStore>());
			let documentClient: AppServerProtocolClient | undefined;
			let localResolver: NativeExtensionService | undefined;
			const api = this._register(await createElectronRendererApi([
				client => { documentClient = client; return {}; },
				...this.rendererCapabilities,
				client => registerLocalTranscriptionService(transcriptionServices, client),
			], { browser: true, textDocuments: true }, permissionDialog, mainProcessService, async (localApi, factories, authority, attempt) => {
				if (!resolverScope.value) {
					const scope = new DisposableStore();
					resolverScope.value = scope;
					const services = scope.add(profileServices.createChild(new ServiceCollection([IExtensionHostApi, localApi], [IRemoteSocketFactoryService, factories])));
					localResolver = scope.add(services.createInstance(NativeExtensionService));
				}
				await localResolver!.resolveAuthority(authority, attempt);
				const address = resolver.getConnectionData(authority);
				if (!address) { throw new Error('Remote address was retired before connecting'); }
				return address;
			}, async (remoteApi, authority) => localResolver!.startRemoteExtensionHost(remoteApi, authority)));
			performance.mark('ash.desktop.api-ready');
			const profileFiles = this._register(profileServices.createInstance(FileService));
			this._register(profileFiles.registerProvider(api.userDataHome.scheme, api.localFiles));
			profileServices.registerInstance(IFileService, profileFiles);
			const userThemes = this._register(await loadUserThemes(profileServices, URI.parse(api.userDataHome.toString().replace(/\/$/u, '') + '/themes')));
			performance.mark('ash.desktop.themes-ready');
			const workspace = parseWorkspace(await api.workspace.getWorkspace());
			performance.mark('ash.desktop.workspace-ready');
			const initialConfigurationSnapshot = validateConfigurationSnapshot(await api.configuration.read());
			performance.mark('ash.desktop.configuration-ready');
			let lifecycleService!: ElectronLifecycleService;
			let desktopWindow!: ElectronWindow;
			const hostColorScheme = await api.nativeHost.getOSColorScheme();
			performance.mark('ash.desktop.workbench-start');
			const workbench = this._register(await startWorkbench({
				...this.options,
				serviceCollection: new ServiceCollection([IMainProcessService, mainProcessService], [IRemoteAuthorityResolverService, resolver]),
				environmentService: new ElectronWorkbenchEnvironmentService(),
				createURLService: services => {
					return services.createInstance(RelayURLService, windowId as number);
				},
				createTextDocumentHost: documentClient ? services => {
					const editing = services.get(IChatEditingService);
					return services.createInstance(AppServerTextDocumentHost, documentClient!, { applyEdits: editing.applyEdits.bind(editing), finishTurn: editing.finishTurn.bind(editing) });
				} : undefined,
				createLogService: () => logger.createLogger('workbench'),
				createWorkingCopyBackupService: (services, workspaceId) => {
					if (!api.backup) return new IndexedDbWorkingCopyBackupService(workspaceId);
					return services.createChild(new ServiceCollection([IBackupService, api.backup])).createInstance(WorkingCopyBackupService);
				},
				createStorageService: async options => {
					const storage = profileServices.createInstance(NativeWorkbenchStorageService, options);
					try { await storage.initialize(); return storage; }
					catch (error) { storage.dispose(); throw error; }
				},
				api,
				browserViewService: api.browserView,
				container,
				workspace,
				createLifecycleService: services => {
					lifecycleService = services.createInstance(ElectronLifecycleService, { ownerWindow: window, onError: onUnexpectedError });
					this._register(lifecycleService.onWillShutdown(event => event.join(logger.flush(), 'Desktop logs flush')));
					return lifecycleService;
				},
				createWindow: services => desktopWindow = services.createInstance(ElectronWindow, { invoke, subscribe }),
				configurationApi: api.configuration,
				initialConfigurationSnapshot,
				createUserDataFileSystemProvider: async () => new FileUserDataProvider(api.localFiles, api.userDataHome),
				keyboardLayoutProvider: api.keyboardLayout,
				userKeyboardLayoutApi: api.userKeyboardLayout,
				nativeHostApi: api.nativeHost,
				createHostColorSchemeService: services => {
					const colors = services.createInstance(NativeHostColorSchemeService, hostColorScheme);
					void colors.initialize().catch(onUnexpectedError);
					return colors;
				},
				clipboardService: new ElectronRendererClipboardService(),
				dialogHandler: new NativeDialogHandler(api.nativeHost, container),
				userThemeService: userThemes,
				createContextMenuService: services => services.createInstance(ElectronContextMenuService, api.nativeContextMenu),
				createTitlebarPart: createElectronTitlebarPartFactory(api.nativeMenubar),
			}));
			performance.mark('ash.desktop.workbench-created');
			const subscription = api.workspace.onDidChange(workspace => {
				void this.updateWorkspace(workbench, workspace);
			});
			this._register(toDisposable(() => subscription.dispose()));
			this._register(addDisposableListener(window, 'pagehide', () => {
				void workbench.shutdown('pageHide').catch(error => console.error('Failed to shut down Workbench', error)).finally(() => {
					try {
						this.dispose();
						tracker?.assertNoLeaks();
					} finally {
						tracking?.[Symbol.dispose]();
					}
				});
			}, { once: true }));
			await lifecycleService.initialize();
			performance.mark('ash.desktop.lifecycle-ready');
			await workbench.whenRestored;
			await desktopWindow.initialize();
			if (api.backup) {
				try {
					const pending = await api.backup.getWorkspaces();
					const workspaces = pending.map(scope => {
						const identifier: IAnyWorkspaceIdentifier = scope.configuration ? { id: scope.id, configPath: scope.configuration }
							: scope.folders.length === 1 ? { id: scope.id, uri: scope.folders[0]! } : { id: scope.id, ...(scope.remoteAuthority ? { remoteAuthority: scope.remoteAuthority } : {}) };
						return serializeWorkspaceIdentifier(identifier);
					});
					await invoke<void>(WORKSPACE_RECOVERY_CHANNEL, workspaces);
				} catch (error) {
					console.error('Failed to reopen backup workspaces', error);
				}
			}
		} catch (error) {
			try {
				this.dispose();
			} finally {
				tracking?.[Symbol.dispose]();
			}
			showStartupError(error, text => invoke<void>('ash:host:writeClipboard', text));
		}
	}

	private async updateWorkspace(workbench: Workbench, workspace: unknown): Promise<void> {
		try {
			await workbench.updateWorkspace(parseWorkspace(workspace));
		} catch (error) {
			if (this.isDisposed) {
				return;
			}
			console.error('Failed to switch Workbench workspace', error);
			window.location.reload();
		}
	}
}

export function main(options: Pick<IStartWorkbenchOptions, 'productName'>, rendererCapabilities: readonly ElectronRendererCapabilityContribution[] = []): Promise<void> {
	return new DesktopMain(options, rendererCapabilities).open();
}
