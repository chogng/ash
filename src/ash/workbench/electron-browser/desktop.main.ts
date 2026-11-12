import { createDirectoryPermissionRequestService, WorkspaceTrustPrompt } from '../contrib/workspace/browser/workspace.contribution.js';
import { registerBrowserNetworkHost } from '../../platform/browserView/electron-browser/browserNetworkHost.js';
import { IAgentHostConnectionsService } from '../../platform/agentHost/common/agentHostConnectionsService.js';
import { IBrowserViewWorkbenchService } from '../contrib/browserView/common/browserView.js';
import { ElectronAuxiliaryWindowService } from '../services/auxiliaryWindow/electron-browser/auxiliaryWindowService.js';
import { NativeExtensionService } from '../services/extensions/electron-browser/nativeExtensionService.js';
import { IPolicyService } from '../../platform/policy/common/policy.js';
import { PolicyChannelClient } from '../../platform/policy/common/policyIpc.js';
import { IRemoteAuthorityResolverService } from '../../platform/remote/common/remoteAuthorityResolver.js';
import { RemoteAuthorityResolverService } from '../../platform/remote/electron-browser/remoteAuthorityResolverService.js';
import { IRemoteSocketFactoryService } from '../../platform/remote/common/remoteSocketFactoryService.js';
import { IExtensionHostApi } from '../../platform/extensions/common/extensionHostApi.js';
import { MutableDisposable, DisposableStore } from '../../base/common/lifecycle.js';
import { FileUserDataProvider } from '../../platform/userData/common/fileUserDataProvider.js';
import { RelayURLService } from '../services/url/electron-browser/urlService.js';
import { IBackupService } from '../../platform/backup/common/backup.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import { IWorkspaceEditingService } from '../services/workspaces/common/workspaceEditing.js';
import { WorkspaceEditingService } from '../services/workspaces/electron-browser/workspaceEditingService.js';
import { IContextKeyService } from '../../platform/contextkey/browser/contextKeyService.js';
import { IWorkspaceContextService } from '../../platform/workspace/common/workspace.js';
import { EnterMultiRootWorkspaceSupportContext } from '../common/contextkeys.js';
import { WORKSPACE_EDIT_ERROR_CHANNEL } from '../../platform/workspace/common/workspaceIpc.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { OPEN_EXTENSIONS_COMMAND_ID, OPEN_IDE_EXTENSIONS_CHANNEL, validateExtensionsOpenOptions } from '../../platform/extensionManagement/common/extensionManagementService.js';
import { localize } from '../../nls.js';
import { WORKSPACE_RECOVERY_CHANNEL, WINDOW_TERMINAL_TRANSFER_STARTUP_CHANNEL } from '../../platform/window/common/window.js';
import { serializeWorkspaceIdentifier, type IAnyWorkspaceIdentifier } from '../../platform/workspace/common/workspace.js';
import { WorkingCopyBackupService } from '../services/workingCopy/browser/workingCopyBackupService.js';
import { IndexedDbWorkingCopyBackupService } from '../services/workingCopy/browser/indexedDbWorkingCopyBackupService.js';
import { AppServerProtocolClient } from '../../platform/agentHost/browser/appServerProtocolClient.js';
import { AppServerTextDocumentHost } from '../services/textfile/browser/appServerTextDocumentHost.js';
import { AppServerIdeHost } from '../services/editor/browser/appServerIdeHost.js';
import { EnvironmentVariableMutatorType } from '../../platform/terminal/common/environmentVariable.js';
import { IEnvironmentVariableService } from '../contrib/terminal/common/environmentVariable.js';
import { IChatEditingService } from '../contrib/chat/common/editing/chatEditingService.js';
import { addDisposableListener } from '../../base/browser/dom.js';
import { installBaseUiStyles } from '../../base/browser/ui/styles.js';
import { Disposable, DisposableTracker, installDisposableTracker, toDisposable } from '../../base/common/lifecycle.js';
import { DeferredPromise, timeout } from '../../base/common/async.js';
import { CancellationError, onUnexpectedError } from '../../base/common/errors.js';
import { URI } from '../../base/common/uri.js';
import { Schemas } from '../../base/common/network.js';
import { IFileService } from '../../platform/files/common/files.js';
import { FileService } from '../../platform/files/common/fileService.js';
import { ElectronRendererClipboardService } from '../../platform/clipboard/electron-browser/electronRendererClipboardService.js';
import { invoke, subscribe } from '../../platform/ipc/electron-browser/rendererIpc.js';
import { InstantiationService } from '../../platform/instantiation/common/instantiationService.js';
import { IMainProcessService } from '../../platform/ipc/common/mainProcessService.js';
import { ISecretStorageService } from '../../platform/secrets/common/secrets.js';
import { SecretStorageService } from '../services/secrets/electron-browser/secretStorageService.js';
import { ElectronIPCMainProcessService } from '../../platform/ipc/electron-browser/mainProcessService.js';
import { createElectronRendererApi, ElectronRendererLocalApi, type ElectronRendererCapabilityContribution } from './rendererApi.js';
import { getWorkspaceRemoteAuthority, parseWorkspace } from '../../platform/workspace/common/workspace.js';
import { NativeHostColorSchemeService } from '../services/themes/electron-browser/nativeHostColorSchemeService.js';
import type { IStartWorkbenchOptions, IWorkbenchStartupHost, Workbench } from '../browser/workbench.js';
import { ElectronContextMenuService } from '../services/contextmenu/electron-browser/contextMenuService.js';
import { loadUserThemes } from '../services/themes/browser/workbenchThemeService.js';
import { ElectronLifecycleService } from '../services/lifecycle/electron-browser/lifecycleService.js';
import { createElectronTitlebarPartFactory } from '../services/title/electron-browser/titleService.js';
import { ElectronTitleService } from './parts/titlebar/titlebarPart.js';
import { NativeDialogHandler } from './parts/dialogs/dialogHandler.js';
import { readDirectoryPermissionPrompt } from '../../platform/workspace/electron-browser/workspaceContextApi.js';
import { ElectronWindow } from './window.js';
import { registerLocalTranscriptionService } from '../services/localTranscription/electron-browser/localTranscriptionService.js';
import { NativeWorkbenchStorageService } from '../services/storage/electron-browser/storageService.js';
import { NativeLogService } from '../services/log/electron-browser/logService.js';
import { ILoggerService } from '../../platform/log/common/log.js';
import { IWorkbenchEnvironmentService } from '../services/environment/common/environmentService.js';
import { ElectronWorkbenchEnvironmentService } from '../services/environment/electron-browser/environmentService.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { IBrowserPasswordService } from '../../platform/browserView/common/browserPasswordService.js';
import { IBrowserViewService, ipcBrowserViewChannelName } from '../../platform/browserView/common/browserView.js';
import { IPlaywrightService } from '../../platform/browserView/common/playwrightService.js';
import { registerAppServerBrowserHost } from '../../platform/agentHost/electron-browser/appServerBrowserHost.js';
import { IAgentHostCanvasCollection } from '../contrib/canvases/common/agentHostCanvas.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { getSingletonServiceDescriptors } from '../../platform/instantiation/common/extensions.js';
import { sandboxProcess } from '../../base/parts/sandbox/electron-browser/globals.js';
import { IQuickInputService } from '../../platform/quickinput/common/quickInput.js';
import { IDialogService } from '../../platform/dialogs/common/dialogs.js';
import { IHostService } from '../services/host/browser/host.js';
import { openPickedFolder } from '../services/dialogs/browser/abstractFileDialogService.js';
import { showLocalOpenDialog } from '../services/dialogs/electron-browser/fileDialogService.js';
import type { ColorScheme } from '../../platform/theme/common/theme.js';
import type { createStartupCommandPalette } from './startupCommandPalette.js';

type DesktopOptions = Pick<IStartWorkbenchOptions, 'productName'> & { readonly splashTheme: ColorScheme; };

/** Owns desktop startup and the resources of one renderer window. */
export class DesktopMain extends Disposable {
	private opened = false;

	constructor(private readonly options: DesktopOptions, private readonly rendererCapabilities: readonly ElectronRendererCapabilityContribution[]) {
		super();
	}

	public async open(loadContributions: () => Promise<void>): Promise<void> {
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
			const permissionDialog = this._register(new WorkspaceTrustPrompt(container));
			const workspaceTrust = createDirectoryPermissionRequestService(container, (request, handler, signal) =>
				permissionDialog.show(() => readDirectoryPermissionPrompt(request), handler, signal));
			const transcriptionServices = this._register(new InstantiationService());
			// Browser requests arrive during backend initialization, before the Parts exist.
			const profileServices = this._register(new InstantiationService());
			const windowId = await invoke<unknown>('ash:ipc:window-id');
			if (!Number.isSafeInteger(windowId) || (windowId as number) <= 0) { throw new TypeError('Invalid Main IPC window ID'); }
			// The scope releases its dependent services before closing their Main connection.
			profileServices.registerSingleton(IMainProcessService, () => profileServices.createInstance(ElectronIPCMainProcessService, windowId as number));
			const mainProcessService = profileServices.get(IMainProcessService);
			const local = this._register(profileServices.createInstance(ElectronRendererLocalApi));
			const resolver = this._register(profileServices.createInstance(RemoteAuthorityResolverService));
			profileServices.registerInstance(IRemoteAuthorityResolverService, resolver);
			const resolverScope = this._register(new MutableDisposable<DisposableStore>());
			let documentClient: AppServerProtocolClient | undefined;
			let localBrowserClient: AppServerProtocolClient | undefined;
			let localResolver: NativeExtensionService | undefined;
			const apiReady = createElectronRendererApi([
				(client, _appServer, localClient) => { documentClient = client; localBrowserClient = localClient; return {}; },
				...this.rendererCapabilities,
				(_client, _appServer, localClient) => registerLocalTranscriptionService(transcriptionServices, localClient),
			], { browser: true, textDocuments: true, agentHosts: true, transportHandshake: true }, workspaceTrust, mainProcessService, async (localApi, factories, authority, attempt) => {
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
			}, async (remoteApi, authority) => localResolver!.startRemoteExtensionHost(remoteApi, authority), local).then(api => {
				if (this.isDisposed) {
					api.dispose();
					throw new CancellationError();
				}
				performance.mark('ash.desktop.api-ready');
				return this._register(api);
			});
			void apiReady.catch(() => undefined);
			// Request the backend connection before evaluating Workbench registrations.
			const contributionsReady = loadContributions();
			void contributionsReady.catch(() => undefined);
			const workbenchModule = import('../browser/workbench.js');
			void workbenchModule.catch(() => undefined);
			const profileReady = local.paths.then(([userDataHome]) => {
				this.assertNotDisposed();
				const files = this._register(profileServices.createInstance(FileService));
				const provider = this._register(new FileUserDataProvider(local.localFiles, userDataHome));
				this._register(files.registerProvider(Schemas.vscodeUserData, provider));
				profileServices.registerInstance(IFileService, files);
			});
			const userThemesReady = profileReady.then(async () => {
				this.assertNotDisposed();
				const themes = await loadUserThemes(profileServices, URI.from({ scheme: Schemas.vscodeUserData, path: '/user/themes' }));
				if (this.isDisposed) {
					themes.dispose();
					throw new CancellationError();
				}
				performance.mark('ash.desktop.themes-ready');
				return this._register(themes);
			});
			void userThemesReady.catch(() => undefined);
			const workspaceReady = local.workspace.getWorkspace().then(value => {
				performance.mark('ash.desktop.workspace-ready');
				return parseWorkspace(value);
			});
			const startupStorage = this._register(new MutableDisposable<NativeWorkbenchStorageService>());
			const storageReady = workspaceReady.then(async workspace => {
				this.assertNotDisposed();
				const storage = startupStorage.value = profileServices.createInstance(NativeWorkbenchStorageService, { ownerWindow: window, workspaceId: workspace.id });
				await storage.initialize();
				return storage;
			});
			const palette = this._register(new MutableDisposable<ReturnType<typeof createStartupCommandPalette>>());
			let startingCommands = true;
			let pickingFolder = false;
			let pickedFolder: URI | undefined;
			let openFolder: ((folder: URI) => Promise<void>) | undefined;
			const pickFolder = async (): Promise<void> => {
				if (pickingFolder || pickedFolder) return;
				pickingFolder = true;
				try {
					const [folder] = await showLocalOpenDialog(local.nativeHost, { canSelectFiles: false, canSelectFolders: true }) ?? [];
					if (!folder || this.isDisposed) return;
					performance.mark('ash.desktop.startup-folder-selected');
					if (openFolder) await openFolder(folder);
					else pickedFolder = folder;
				} finally {
					pickingFolder = false;
				}
			};
			void Promise.all([workspaceReady, storageReady, profileReady, contributionsReady]).then(async ([workspace, storage]) => {
				if (getWorkspaceRemoteAuthority(workspace) || !startingCommands || this.isDisposed) return;
				const { createStartupCommandPalette } = await import('./startupCommandPalette.js');
				if (startingCommands && !this.isDisposed) palette.value = createStartupCommandPalette(profileServices, window, local, storage, this.options.splashTheme, pickFolder);
			}).catch(error => { if (!this.isDisposed) onUnexpectedError(error); });
			const [expectsTerminalTransfer, defaultLogLevels, workspace, userThemes, hostColorScheme, { startWorkbench }] = await Promise.all([
				invoke<unknown>(WINDOW_TERMINAL_TRANSFER_STARTUP_CHANNEL),
				mainProcessService.getChannel('logger').call<unknown>('getDefaultLogLevels'),
				workspaceReady,
				userThemesReady,
				local.nativeHost.getOSColorScheme(),
				workbenchModule,
				contributionsReady,
				storageReady,
			]);
			this.assertNotDisposed();
			if (typeof expectsTerminalTransfer !== 'boolean') throw new TypeError('Invalid terminal window startup intent');
			const environment = new ElectronWorkbenchEnvironmentService(defaultLogLevels, expectsTerminalTransfer, sandboxProcess.isBuilt);
			profileServices.registerInstance(IWorkbenchEnvironmentService, environment);
			const logger = this._register(profileServices.createInstance(NativeLogService, 'workbench'));
			profileServices.registerCollection(new ServiceCollection(...getSingletonServiceDescriptors().filter(([id]) => id === IPlaywrightService)));
			const playwrightService = profileServices.get(IPlaywrightService);
			let lifecycleService!: ElectronLifecycleService;
			let desktopWindow!: ElectronWindow;
			const startupFileRequestsReady = new DeferredPromise<void>();
			this._register(toDisposable(() => { void startupFileRequestsReady.complete(); }));
			let restorePalette: ((query: string) => void) | undefined;
			let applyFolder!: (folder: URI) => Promise<void>;
			let query: string | undefined;
			const host = apiReady.then(async (api): Promise<IWorkbenchStartupHost> => {
				// Give the grant check a chance to queue directory binding before synchronous
				// Workbench construction. A slow check must not hold back the shell.
				const deadline = timeout(16);
				const [workspace] = await Promise.all([
					api.workspace.getWorkspace().then(value => parseWorkspace(value)),
					Promise.race([api.workspaceStartupScheduled, deadline]).finally(() => deadline.cancel()),
				]);
				this.assertNotDisposed();
				startingCommands = false;
				query = palette.value?.query;
				palette.clear();
				performance.mark('ash.desktop.configuration-ready');
				performance.mark('ash.desktop.workbench-start');
				return {
					api,
					workspace,
					workspaceDirectoriesReady: api.workspaceDirectoriesReady,
					createTextDocumentHost: documentClient ? services => {
						const editing = services.get(IChatEditingService);
						const hosts = new DisposableStore();
						hosts.add(services.createInstance(AppServerTextDocumentHost, documentClient!, { applyEdits: editing.applyEdits.bind(editing), finishTurn: editing.finishTurn.bind(editing) }));
						const ide = hosts.add(services.createInstance(AppServerIdeHost, documentClient!));
						hosts.add(services.get(IEnvironmentVariableService).registerCollectionProvider('ash.ide', async () => {
							const key = await ide.readTerminalWindowKey();
							return {
								persistent: false,
								map: key ? new Map([['ASH_IDE_WINDOW', { variable: 'ASH_IDE_WINDOW', type: EnvironmentVariableMutatorType.Replace, value: key }]]) : new Map(),
							};
						}));
						return hosts;
					} : undefined,
					createBrowserHost: documentClient ? services => {
						const browsers = services.get(IBrowserViewWorkbenchService);
						const networkHost = registerBrowserNetworkHost(services.get(IMainProcessService), services.get(IAgentHostConnectionsService), services.get(IWorkspaceContextService), api.localTcp, localBrowserClient);
						const browserHost = registerAppServerBrowserHost(documentClient!, playwrightService, mainProcessService, services.get(IConfigurationService), services.get(IAgentHostCanvasCollection), owner => browsers.resolveNetwork(owner));
						return toDisposable(() => { browserHost.dispose(); networkHost.dispose(); });
					} : undefined,
					createWorkingCopyBackupService: (services, workspaceId) => {
						if (!api.backup) return new IndexedDbWorkingCopyBackupService(workspaceId);
						return services.createChild(new ServiceCollection([IBackupService, api.backup])).createInstance(WorkingCopyBackupService);
					},
				};
			});
			const workbench = this._register(await startWorkbench({
				productName: this.options.productName,
				serviceCollection: new ServiceCollection(
					[IWorkspaceEditingService, new SyncDescriptor(WorkspaceEditingService, [local.workspace])],
					[ILoggerService, logger],
					[IPolicyService, this._register(new PolicyChannelClient(mainProcessService.getChannel('policy')))],
					[IBrowserPasswordService, ProxyChannel.toService<IBrowserPasswordService>(mainProcessService.getChannel('browserPasswords'))],
					[IBrowserViewService, ProxyChannel.toService<IBrowserViewService>(mainProcessService.getChannel(ipcBrowserViewChannelName))],
					[IMainProcessService, mainProcessService],
					[ISecretStorageService, this._register(profileServices.createInstance(SecretStorageService))],
					[IRemoteAuthorityResolverService, resolver],
					[IPlaywrightService, playwrightService],
				),
				environmentService: environment,
				createURLService: services => {
					return services.createInstance(RelayURLService, windowId as number);
				},
				createLogService: () => {
					// The factory owns failure cleanup and transfers the logger to the Workbench.
					this._store.delete(logger);
					return logger;
				},
				createStorageService: async () => startupStorage.clearAndLeak()!,
				host,
				container,
				workspace,
				createLifecycleService: services => {
					lifecycleService = services.createInstance(ElectronLifecycleService, { ownerWindow: window, onError: onUnexpectedError });
					this._register(lifecycleService.onWillShutdown(event => event.join(logger.flush().catch(error => console.error('Could not flush Desktop logs during shutdown', error)), 'Desktop logs flush')));
					return lifecycleService;
				},
				createWindow: services => {
					if (query !== undefined) restorePalette = value => services.get(IQuickInputService).quickAccess.show(`>${value.replace(/^>/u, '')}`);
					applyFolder = async folder => {
						const dialogs = services.get(IDialogService);
						try { await openPickedFolder(folder, services.get(IHostService), () => dialogs); }
						catch (error) { if (!this.isDisposed) await dialogs.error(error instanceof Error ? error.message : String(error)); }
					};
					const context = services.get(IWorkspaceContextService);
					if (local.workspace.onWillChangeFolders) this._register(local.workspace.onWillChangeFolders(event => {
						try { services.get(IWorkspaceEditingService).validateFolders(event.folders); }
						catch (error) { event.veto(error instanceof Error ? error : new Error(String(error))); }
					}));
					const support = EnterMultiRootWorkspaceSupportContext.bindTo(services.get(IContextKeyService));
					const update = () => support.set(true);
					update();
					this._register(context.onDidChangeWorkspace(update));
					this._register(toDisposable(() => support.reset()));
					const errors = subscribe(WORKSPACE_EDIT_ERROR_CHANNEL, value => {
						if (typeof value === 'string') services.get(INotificationService).error(localize('workspace.reloadFailed', 'Could not update workspace folders. The last accepted folders were kept. {0}', value));
					});
					this._register(toDisposable(() => errors.dispose()));
					const extensions = subscribe(OPEN_IDE_EXTENSIONS_CHANNEL, value => {
						void Promise.resolve().then(() => services.get(ICommandService).executeCommand(OPEN_EXTENSIONS_COMMAND_ID, validateExtensionsOpenOptions(value))).catch(onUnexpectedError);
					});
					this._register(toDisposable(() => extensions.dispose()));
					return desktopWindow = services.createInstance(ElectronWindow, { invoke, subscribe });
				},
				startupFileRequestsReady: startupFileRequestsReady.p,
				createUserDataFileSystemProvider: async () => new FileUserDataProvider(local.localFiles, (await local.paths)[0]),
				keyboardLayoutProvider: local.keyboardLayout,
				userKeyboardLayoutApi: local.userKeyboardLayout,
				nativeHostApi: local.nativeHost,
				createHostColorSchemeService: services => {
					const colors = services.createInstance(NativeHostColorSchemeService, hostColorScheme);
					void colors.initialize().catch(onUnexpectedError);
					return colors;
				},
				clipboardService: new ElectronRendererClipboardService(),
				dialogHandler: new NativeDialogHandler(local.nativeHost, container),
				userThemeService: userThemes,
				createContextMenuService: services => services.createInstance(ElectronContextMenuService, local.nativeContextMenu),
				createAuxiliaryWindowService: (owner, root, services) => services.createInstance(ElectronAuxiliaryWindowService, owner, root),
				createTitleService: (container, productName, groups, services) => services.createInstance(ElectronTitleService, container, productName, createElectronTitlebarPartFactory(), groups),
			}));
			const api = await apiReady;
			if (query !== undefined) restorePalette?.(query);
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
			api.startWorkspaceDirectories();
			performance.mark('ash.desktop.lifecycle-ready');
			await desktopWindow.initialize(workbench.whenRestored).finally(() => startupFileRequestsReady.complete());
			await workbench.whenRestored;
			// Directory permissions and editor backups are owned by the connected Workbench.
			openFolder = applyFolder;
			if (pickedFolder) {
				void openFolder(pickedFolder).catch(onUnexpectedError);
				pickedFolder = undefined;
			}
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
			throw error;
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

export function main(options: DesktopOptions, rendererCapabilities: readonly ElectronRendererCapabilityContribution[], loadContributions: () => Promise<void>): Promise<void> {
	return new DesktopMain(options, rendererCapabilities).open(loadContributions);
}
