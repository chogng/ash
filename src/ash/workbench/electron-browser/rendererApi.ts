import { DeferredPromise, raceCancellationError } from '../../base/common/async.js';
import type {
	IRuntimeEnvironment,
} from '../../base/common/environment.js';
import type { INativeKeyboardLayoutApi } from '../../platform/keyboardLayout/common/nativeKeyboardLayout.js';
import type { IUserKeyboardLayoutApi } from '../../platform/keyboardLayout/common/userKeyboardLayout.js';
import type {
	INativeContextMenuApi,
} from '../../base/parts/contextmenu/common/contextmenu.js';
import type {
	IWorkspaceContextApi,
} from '../../platform/workspace/common/workspaceIpc.js';
import type { IFileSystemProvider } from '../../platform/files/common/files.js';
import type { IWorkspaceFolder } from '../../platform/workspace/common/workspace.js';
import type {
	INativeHostApi,
} from '../../platform/native/common/nativeHost.js';
import { RemoteAgentHostService } from '../../platform/agentHost/electron-browser/remoteAgentHostService.js';
import { registerAppServerBrowserHost } from '../../platform/agentHost/electron-browser/appServerBrowserHost.js';
import { AppServerTcpService } from '../../platform/network/browser/appServerTcpService.js';
import { AppServerGeneratedFileCatalog } from '../../platform/generatedFiles/browser/appServerGeneratedFileCatalog.js';
import { isSSHAgentHost, remoteAgentHostRoot } from '../../platform/agentHost/common/remoteAgentHostService.js';
import { APP_SERVER_METHODS, type EnvDirSetEntry } from '../../../../.build/protocol/typescript/index.js';
import { TERMINAL_WINDOW_LIFETIME_CHANNEL } from '../../platform/terminal/common/terminal.js';
import { localize } from '../../nls.js';
import { throwIfCancelled } from '../../base/common/cancellation.js';
import { Emitter, Event } from '../../base/common/event.js';
import type { RemoteConnectionDefinition } from '../../platform/remote/common/remoteConnectionService.js';
import { createSshRemoteWorkspaceUri } from '../../platform/remote/common/remote.js';
import { AppServerChannelService } from '../../platform/collab/browser/appServerChannelService.js';
import type { AppServerProtocolClient } from '../../platform/agentHost/browser/appServerProtocolClient.js';
import type { IExtensionHostApi } from '../../platform/extensions/common/extensionHostApi.js';
import type { IAddress } from '../../platform/remote/common/remoteAgentConnection.js';
import { IRemoteSocketFactoryService, RemoteSocketFactoryService } from '../../platform/remote/common/remoteSocketFactoryService.js';
import { AppServerSymphonyService } from '../../platform/symphony/browser/appServerSymphonyService.js';
import { EDIT_USER_CONFIGURATION_CHANNEL } from '../../platform/native/common/nativeHost.js';
import { REQUEST_MICROPHONE_ACCESS_CHANNEL } from '../../platform/native/common/native.js';
import { AppServerBackupService } from '../../platform/backup/browser/appServerBackupService.js';
import { AppServerCallService } from '../../platform/call/browser/appServerCallService.js';
import { AppServerAgentVoiceService } from '../../platform/agentHost/browser/appServerAgentService.js';
import { createAppServerVoiceCodeTranscriptionBackend } from '../../platform/dictation/browser/appServerVoiceCodeTranscriptionBackend.js';
import { AppServerMemoriesService } from '../../platform/memories/browser/appServerMemoriesService.js';
import { AppServerMemoryDiagnosticsService } from '../../platform/memory/browser/appServerMemoryDiagnosticsService.js';
import type { MemoryObservation } from '../../platform/memory/common/memoryDiagnosticsService.js';
import { LocalAgentHostServiceClient } from '../../platform/agentHost/electron-browser/localAgentHostService.js';
import { WorkbenchAgentHostService } from '../services/agentHost/electron-browser/agentHostService.js';
import type { RendererCapabilityContribution } from '../browser/webRendererApi.js';
import { ElectronRendererClipboardService } from '../../platform/clipboard/electron-browser/electronRendererClipboardService.js';
import { createDisconnectedRendererApi } from '../browser/rendererApi.js';
import { AppServerAutomationService } from '../../platform/automations/browser/appServerAutomationService.js';
import { registerAppServerWorkspaceHost, initializeWorkspace, initializeWorkspaceDirectories } from '../../platform/workspaces/electron-browser/appServerWorkspaceHost.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import type { IWorkbenchHost } from '../browser/rendererApi.js';
import { invoke } from '../../platform/ipc/electron-browser/rendererIpc.js';
import { subscribe } from '../../platform/ipc/electron-browser/rendererIpc.js';
import { ReconnectableTerminalProcessService } from '../../platform/terminal/browser/reconnectableTerminalProcessService.js';
import { operatingSystemFromNodePlatform } from '../../base/common/environment.js';
import { sandboxProcess } from '../../base/parts/sandbox/electron-browser/globals.js';
import { ILogService } from '../../platform/log/common/log.js';
import { popup as popupContextMenu, close as closeContextMenu, presentWindow as presentContextMenuWindow } from '../../base/parts/contextmenu/electron-browser/contextmenu.js';
import { createNativeKeyboardLayoutApi } from '../../platform/keyboardLayout/electron-browser/nativeKeyboardLayoutApi.js';
import { createUserKeyboardLayoutApi } from '../../platform/keyboardLayout/electron-browser/userKeyboardLayoutApi.js';
import { DiskFileSystemProviderClient, LOCAL_FILE_SYSTEM_CHANNEL_NAME } from '../../platform/files/common/diskFileSystemProviderClient.js';
import { URI } from '../../base/common/uri.js';
import { createWorkspaceContextApi } from '../../platform/workspace/electron-browser/workspaceContextApi.js';
import { createNativeHostApi } from '../../platform/native/electron-browser/nativeHostApi.js';
import { IMainProcessService } from '../../platform/ipc/common/mainProcessService.js';
import { LoggerChannelClient } from '../../platform/log/common/logIpc.js';
import type { IAppServerConnectionRecovery } from '../../platform/agentHost/common/appServerApi.js';
import { createRemoteAgentApi } from '../../platform/remote/electron-browser/remoteAgentApi.js';
import { createRemoteConnectionApi } from '../../platform/remote/electron-browser/remoteConnectionApi.js';
import { hasDevelopmentPermissions, type IDirectoryPermissionRequestService } from '../../platform/workspace/common/workspaceTrust.js';
import { InstantiationService } from '../../platform/instantiation/common/instantiationService.js';
import { InstantiationType } from '../../platform/instantiation/common/extensions.js';
import { IWebWorkerService } from '../../platform/webWorker/browser/webWorkerService.js';
import { WebWorkerService } from '../../platform/webWorker/browser/webWorkerServiceImpl.js';
import { isCancellationError, CancellationError } from '../../base/common/errors.js';

/** Desktop startup capabilities assembled by the Electron host. */
export interface AshElectronRendererApi extends IWorkbenchHost {
	readonly environment: IRuntimeEnvironment;
	readonly keyboardLayout: INativeKeyboardLayoutApi;
	readonly userKeyboardLayout: IUserKeyboardLayoutApi;
	readonly nativeContextMenu: INativeContextMenuApi;
	readonly nativeHost: INativeHostApi;
	readonly localFiles: IFileSystemProvider;
	readonly userDataHome: URI;
	readonly workspace: IWorkspaceContextApi;
	/** Settles once the initial binding is queued, needs a visible prompt, or has ended. */
	readonly workspaceStartupScheduled: Promise<void>;
	/** Settles after the first directory binding, including a declined startup prompt. */
	readonly workspaceDirectoriesReady: Promise<void>;
	/** Releases any startup authorization decision once the window is ready. */
	readonly startWorkspaceDirectories: (options?: WorkspaceStartupOptions) => void;
	readonly reloadWorkspaceDirectories: () => Promise<void>;
	readonly bindLocalWorkspaceFolder: (folder: IWorkspaceFolder) => Promise<boolean>;
}

export type ElectronRendererCapabilityContribution = (client: AppServerProtocolClient, appServer: Parameters<RendererCapabilityContribution>[1], localClient: AppServerProtocolClient) => ReturnType<RendererCapabilityContribution>;

/** Main-owned resources used by the renderer before and after App Server initialization. */
export class ElectronRendererLocalApi extends Disposable {
	readonly workspace = createWorkspaceContextApi();
	readonly nativeHost: INativeHostApi;
	readonly localFiles: DiskFileSystemProviderClient;
	readonly keyboardLayout: INativeKeyboardLayoutApi;
	readonly userKeyboardLayout: IUserKeyboardLayoutApi;
	readonly paths: Promise<readonly [userDataHome: URI, localUserHome: URI]>;
	readonly nativeContextMenu = { popup: popupContextMenu, close: closeContextMenu, presentWindow: presentContextMenuWindow };

	constructor(@IMainProcessService main: IMainProcessService) {
		super();
		this.nativeHost = createNativeHostApi(main);
		this.keyboardLayout = createNativeKeyboardLayoutApi(main);
		this.userKeyboardLayout = createUserKeyboardLayoutApi(main);
		const channel = main.getChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME);
		this.localFiles = this._register(new DiskFileSystemProviderClient(channel));
		this.paths = Promise.all([
			channel.call<string>('userDataHome').then(URI.parse),
			channel.call<string>('userHome').then(URI.parse),
		]);
		void this.paths.catch(() => undefined);
	}
}

interface WorkspaceStartupOptions {
	readonly discardUntrustedWorkspace?: () => Promise<void>;
	readonly onTrustDeclined?: () => Promise<void>;
}

/** Composes Electron renderer capabilities from domain-owned IPC adapters. */
export async function createElectronRendererApi(contributions: readonly ElectronRendererCapabilityContribution[], hostCapabilities: { readonly browser: boolean; readonly textDocuments?: boolean; readonly appTools?: boolean; readonly agentHosts?: boolean; readonly transportHandshake?: boolean; readonly backupClientId?: 'ash-editor' | 'ash-sessions'; }, workspaceTrust: IDirectoryPermissionRequestService, mainProcessService: IMainProcessService, resolveRemoteAuthority?: (api: IExtensionHostApi, factories: IRemoteSocketFactoryService, authority: string, attempt: number) => Promise<IAddress>, initializeRemoteExtensions?: (api: IExtensionHostApi, authority: string) => Promise<IExtensionHostApi>, localApi?: ElectronRendererLocalApi): Promise<AshElectronRendererApi & IDisposable> {
	performance.mark('ash.rendererApi.start');
	const resources = new DisposableStore();
	const local = localApi ?? resources.add(new ElectronRendererLocalApi(mainProcessService));
	const { workspace: workspaceApi, nativeHost, localFiles } = local;
	try {
		const remoteConnection = await createRemoteAgentApi().getConnection();
		const connectionServices = resources.add(new InstantiationService());
		// Connections are created before the Workbench window and own an independent service scope.
		connectionServices.registerSingleton(IWebWorkerService, () => connectionServices.createInstance(WebWorkerService), { instantiation: InstantiationType.Delayed });
		connectionServices.registerInstance(IMainProcessService, mainProcessService);
		const connectionLogger = resources.add(new LoggerChannelClient(mainProcessService.getChannel('logger'))).createLogger('app-server', { hidden: true });
		connectionServices.registerInstance(ILogService, connectionLogger);
		connectionServices.registerSingleton(IRemoteSocketFactoryService, () => connectionServices.createInstance(RemoteSocketFactoryService));
		const agentHost = resources.add(connectionServices.createInstance(WorkbenchAgentHostService, {
			connection: remoteConnection,
			capabilities: hostCapabilities,
			transportHandshake: hostCapabilities.transportHandshake,
			onDidSuspendOS: listener => nativeHost.onDidSuspendOS(listener),
			onDidResumeOS: listener => nativeHost.onDidResumeOS(listener),
			resolveRemoteAuthority,
			initializeRemoteExtensions,
		} satisfies ConstructorParameters<typeof WorkbenchAgentHostService>[0]));
		const localConnection = agentHost.localConnection;
		const localClient = localConnection.client;

		performance.mark('ash.rendererApi.connect-start');
		// Connect while the Workbench domain adapters load. The wire handshake only
		// needs the connection services above.
		const [enabled, [userDataHome, localUserHome], { createRendererHost }] = await Promise.all([
			agentHost.connect(), local.paths, import('../browser/webRendererApi.js'),
		]);
		const connection = agentHost.connection;
		const client = agentHost.client;
		let backend: IWorkbenchHost;
		const workspaceChanges = resources.add(new Emitter<void>());
		const workspaceWindowReady = new DeferredPromise<WorkspaceStartupOptions | undefined>();
		const workspaceStartupScheduled = new DeferredPromise<void>();
		const finishWorkspaceScheduling = (): void => {
			if (workspaceStartupScheduled.isSettled) return;
			performance.mark('ash.rendererApi.workspace-startup-scheduled');
			void workspaceStartupScheduled.complete();
		};
		resources.add(toDisposable(() => {
			void workspaceWindowReady.complete(undefined);
			void workspaceStartupScheduled.complete();
		}));
		let workspaceDirectoriesReady = Promise.resolve();
		// Files and terminals can remain open after switching away from a draft.
		const additionalFolders = new Map<string, IWorkspaceFolder>();
		let workspaceInitialization: { readonly generation: number; readonly promise: Promise<void>; state: 'restoring' | 'ready' | 'failed'; needsTrust: boolean; error?: unknown; } | undefined;
		const trackWorkspaceInitialization = (promise: Promise<void>): NonNullable<typeof workspaceInitialization> => {
			const attempt: NonNullable<typeof workspaceInitialization> = {
				generation: client.generation, state: 'restoring', needsTrust: false, promise,
			};
			workspaceInitialization = attempt;
			workspaceChanges.fire();
			void promise.then(() => {
				if (resources.isDisposed || workspaceInitialization !== attempt || client.generation !== attempt.generation) return;
				attempt.state = 'ready';
				workspaceChanges.fire();
			}, error => {
				if (resources.isDisposed || workspaceInitialization !== attempt || client.generation !== attempt.generation) return;
				attempt.state = 'failed';
				attempt.error = error;
				workspaceChanges.fire();
			});
			return attempt;
		};
		const restoreWorkspace = ({ retry = false, force = false, startup = false } = {}): Promise<void> => {
			// Terminals and reconnect listeners share one binding attempt per generation.
			if (force || workspaceInitialization?.generation !== client.generation || retry && workspaceInitialization.state === 'failed') {
				let remoteHostLabel: string | undefined;
				if (remoteConnection.kind === 'ssh') {
					remoteHostLabel = remoteConnection.host;
				} else if (remoteConnection.kind === 'remote') {
					remoteHostLabel = remoteConnection.authority;
				}
				if (resources.isDisposed) throw new CancellationError();
				const startupTrust: IDirectoryPermissionRequestService = {
					requiresDevelopmentTrust: workspaceTrust.requiresDevelopmentTrust,
					async requestDirectoryPermissions(request, signal) {
						finishWorkspaceScheduling();
						// Only the prompt needs the window. Saved grants can bind during startup.
						const startupOptions = await (signal ? raceCancellationError(workspaceWindowReady.p, signal) : workspaceWindowReady.p);
						if (resources.isDisposed) throw new CancellationError();
						const setNeedsTrust = (value: boolean): void => {
							if (workspaceInitialization !== attempt || attempt.generation !== client.generation || attempt.needsTrust === value) return;
							attempt.needsTrust = value;
							workspaceChanges.fire();
						};
						setNeedsTrust(workspaceTrust.requiresDevelopmentTrust === true);
						let declined = false;
						try {
							const choice = await workspaceTrust.requestDirectoryPermissions(request, signal);
							declined = choice === 'cancel' && !signal?.aborted;
							if (startup && declined && workspaceInitialization === attempt) await startupOptions?.onTrustDeclined?.();
							return choice;
						} finally {
							// A declined workspace stays available for retry until its context changes.
							if (!declined) setNeedsTrust(false);
						}
					},
				};
				const generation = client.generation;
				const previous = workspaceInitialization?.generation === generation ? workspaceInitialization.promise : undefined;
				const initialize = async (): Promise<void> => {
					await previous?.catch(() => undefined);
					if (resources.isDisposed || client.generation !== generation) throw new CancellationError();
					await initializeWorkspace(client, startupTrust, backend.workspaceTrust, workspaceApi, {
						remoteHostLabel,
						additionalFolders: [...additionalFolders.values()],
						onBindingQueued: finishWorkspaceScheduling,
						discardUntrustedWorkspace: startup ? async signal => {
							finishWorkspaceScheduling();
							const options = await raceCancellationError(workspaceWindowReady.p, signal);
							if (resources.isDisposed || workspaceInitialization !== attempt) throw new CancellationError();
							if (!options?.discardUntrustedWorkspace) return false;
							await options.discardUntrustedWorkspace();
							return true;
						} : undefined,
					});
				};
				const attempt = trackWorkspaceInitialization(initialize());
				return attempt.promise;
			}
			return workspaceInitialization.promise;
		};
		const setWorkspaceFolders = (folders: readonly EnvDirSetEntry[]): Promise<unknown> => {
			const generation = client.generation;
			// Reconnection still reads the old Main identity until the transition commits.
			// Drain that restoration before replacing its roots, and make later callers
			// join the replacement instead of replaying the previous directory snapshot.
			const operation = Promise.resolve(workspaceInitialization?.promise).catch(() => undefined).then(() => {
				if (resources.isDisposed || client.generation !== generation || client.state !== 'ready') throw new CancellationError();
				return client.request(APP_SERVER_METHODS['env/dirs/set'], { dirs: [...folders] });
			});
			trackWorkspaceInitialization(operation.then(() => { }));
			return operation;
		};
		// Preserve the user-triggered cause until both transport and directory setup settle.
		let permissionRecoveries = 0;
		const recovery: IAppServerConnectionRecovery = {
			get phase() {
				if (permissionRecoveries > 0) return 'permissions';
				if (connection.recovery.status !== 'idle' || workspaceInitialization?.generation !== client.generation
					|| workspaceInitialization.state === 'ready') return 'connection';
				return workspaceInitialization.needsTrust ? 'workspaceTrust' : 'workspace';
			},
			get status() {
				const status = connection.recovery.status;
				if (status === 'idle' && permissionRecoveries > 0) return 'recovering';
				if (status !== 'idle' || workspaceInitialization?.generation !== client.generation) return status;
				return workspaceInitialization.state === 'restoring' ? 'recovering' : workspaceInitialization.state === 'failed' ? 'failed' : 'idle';
			},
			get error() {
				const attempt = workspaceInitialization;
				if (connection.recovery.status !== 'idle' || attempt?.generation !== client.generation || attempt.state !== 'failed') {
					return connection.recovery.error;
				}
				if (attempt.needsTrust) return undefined;
				return String(attempt.error instanceof Error ? attempt.error.message : attempt.error);
			},
			onDidChange: Event.any(connection.recovery.onDidChange, workspaceChanges.event),
			reconnect: async options => {
				const permissions = options?.reason === 'permissions';
				if (permissions) { permissionRecoveries++; workspaceChanges.fire(); }
				try {
					// A ready carrier needs only its failed directory binding retried.
					const bindingPending = workspaceInitialization?.generation === client.generation && workspaceInitialization.state !== 'ready';
					if (connection.recovery.status !== 'idle' || !bindingPending) await connection.recovery.reconnect();
					await restoreWorkspace({ retry: true });
				} finally {
					if (permissions) { permissionRecoveries--; workspaceChanges.fire(); }
				}
			},
		};
		if (enabled) {
			performance.mark('ash.rendererApi.initialized');
			backend = createRendererHost(client, {
				externalOpener: { openExternal: target => invoke<boolean>('ash:host:openExternal', target) },
				callbackHost: {
					listen: options => invoke('ash:oauth-callback:listen', options),
					wait: id => invoke('ash:oauth-callback:wait', { id }),
					close: id => invoke('ash:oauth-callback:close', { id }),
				},
				clipboardService: new ElectronRendererClipboardService(),
			}, contributions.map(contribution => (client, appServer) => contribution(client, appServer, localClient)), remoteConnection.kind === 'ssh' ? remoteConnection.host : undefined, recovery);
			resources.add(backend.mcpServerManagement);
			if (backend.contextResourceHost) { resources.add(backend.contextResourceHost); }
			resources.add(registerAppServerWorkspaceHost(() => connection.whenConnected(), workspaceTrust, backend.workspaceTrust, setWorkspaceFolders, folders => workspaceApi.validateFolders(folders), path => remoteConnection.kind === 'ssh' ? createSshRemoteWorkspaceUri(remoteConnection.host, path) : URI.file(path)));
			// Editor recovery belongs to this Desktop profile, including SSH workspaces.
			backend = { ...backend, localTcp: new AppServerTcpService(localClient), backup: new AppServerBackupService(localClient, hostCapabilities.backupClientId ?? 'ash-editor'), generatedFiles: localClient.capabilities?.contracts.generatedFiles?.version === 1 ? new AppServerGeneratedFileCatalog(localClient) : undefined, ...(agentHost.windowExtensions ? { extensionHost: agentHost.windowExtensions } : {}) };
			if (client.capabilities?.memories) { backend = { ...backend, memories: resources.add(new AppServerMemoriesService(client)) }; }
			if (client.capabilities?.contracts.memoryDiagnostics?.version === 1) { backend = { ...backend, memoryDiagnostics: resources.add(new AppServerMemoryDiagnosticsService(client, 'electron', () => invoke<MemoryObservation[]>('ash:memory:collect'))) }; }
			// Device ownership stays on this computer when the workspace connection is remote.
			if (localClient.capabilities?.contracts.channels?.version === 1) { backend = { ...backend, channels: resources.add(new AppServerChannelService(localClient)) }; }
			if (localClient.capabilities?.contracts.calls?.version === 1) { backend = { ...backend, calls: resources.add(new AppServerCallService(localClient)) }; }
			if (remoteConnection.kind === 'local' && AppServerAgentVoiceService.isSupported(client)) {
				backend = { ...backend, agentVoice: resources.add(new AppServerAgentVoiceService(client, () => invoke<boolean>(REQUEST_MICROPHONE_ACCESS_CHANNEL))) };
			}
			backend = { ...backend, dictation: createAppServerVoiceCodeTranscriptionBackend(localClient) };
			if (client.capabilities?.contracts.symphony?.version === 1) { backend = { ...backend, symphony: resources.add(new AppServerSymphonyService(client)) }; }
			if (client.capabilities?.contracts.automation?.version === 1) { backend = { ...backend, automation: resources.add(new AppServerAutomationService(client)) }; }
			const terminals = resources.add(new ReconnectableTerminalProcessService(client, {
				whenDirectoriesReady: async () => { await connection.whenConnected(); await restoreWorkspace(); },
				lifetimeToken: remoteConnection.kind === 'local' ? () => invoke<string>(TERMINAL_WINDOW_LIFETIME_CHANNEL) : undefined,
			}));
			backend = { ...backend, terminal: terminals };
			const replacement = subscribe('ash:terminal:prepareReplacement', () => terminals.prepareForServerReplacement());
			resources.add(toDisposable(() => replacement.dispose()));
			// Publish the pending binding before Workbench services read connection recovery state.
			// The window releases the prompt after its shell and theme are ready.
			workspaceDirectoriesReady = restoreWorkspace({ startup: true }).catch(error => {
				if (!isCancellationError(error)) throw error;
			});
			void workspaceDirectoriesReady.catch(() => undefined);
			void workspaceDirectoriesReady.then(finishWorkspaceScheduling, finishWorkspaceScheduling);
			// The selected execution host needs its roots after a runtime replacement,
			// including SSH and extension hosts; local device recovery is independent.
			resources.add(connection.onDidReconnect(() => {
				void restoreWorkspace()
					.catch(error => { if (!resources.isDisposed && !isCancellationError(error)) connectionLogger.error('app-server', 'Workspace recovery failed', error); });
			}));
			void workspaceDirectoriesReady.then(() => performance.mark('ash.rendererApi.workspace-initialized'), () => undefined);
		} else {
			// Desktop supports server features even when the UI development host starts disconnected.
			backend = createDisconnectedRendererApi(true);
			finishWorkspaceScheduling();
		}

		const agentHosts = hostCapabilities.agentHosts ? resources.add(connectionServices.createInstance(RemoteAgentHostService, {
			browser: hostCapabilities.browser,
			requiresDevelopmentTrust: workspaceTrust.requiresDevelopmentTrust,
			onDidSuspendOS: listener => nativeHost.onDidSuspendOS(listener),
			onDidResumeOS: listener => nativeHost.onDidResumeOS(listener),
			initializeDirectories: (client, trust, directories) => initializeWorkspaceDirectories(client, workspaceTrust, trust, directories),
			createApi: (lease, target, hostResources, id) => {
				let api = createRendererHost(lease.client, {
					externalOpener: { openExternal: value => invoke<boolean>('ash:host:openExternal', value) },
					callbackHost: {
						listen: options => invoke('ash:oauth-callback:listen', options),
						wait: id => invoke('ash:oauth-callback:wait', { id }),
						close: id => invoke('ash:oauth-callback:close', { id })
					},
					clipboardService: new ElectronRendererClipboardService(),
				}, [], isSSHAgentHost(target) ? target.host : { authority: remoteAgentHostRoot(target, id).authority }, lease.recovery);
				hostResources.add(api.mcpServerManagement);
				if (api.contextResourceHost) { hostResources.add(api.contextResourceHost); }
				if (lease.client.capabilities?.contracts.automation?.version === 1) {
					api = { ...api, automation: hostResources.add(new AppServerAutomationService(lease.client)) };
				}
				return {
					...api,
					browserHost: hostCapabilities.browser ? { register: (playwright, configuration, canvases, browserScope, resolveNetwork) => hostResources.add(registerAppServerBrowserHost(lease.client, playwright, mainProcessService, configuration, canvases, resolveNetwork, browserScope)) } : undefined,
				};
			},
		} satisfies ConstructorParameters<typeof RemoteAgentHostService>[0])) : undefined;

		return {
			...backend,

			dispose: () => resources.dispose(),
			[Symbol.dispose]: () => resources.dispose(),
			environment: {
				runtime: 'electron',
				os: operatingSystemFromNodePlatform(sandboxProcess.platform),
				arch: sandboxProcess.arch,
			},
			remote: createRemoteAgentApi(),
			remoteConnections: createRemoteConnectionApi(),
			agentHosts,
			keyboardLayout: local.keyboardLayout,
			userKeyboardLayout: local.userKeyboardLayout,
			nativeContextMenu: local.nativeContextMenu,
			nativeHost,
			editUserConfiguration: () => invoke<void>(EDIT_USER_CONFIGURATION_CHANNEL),
			localFiles,
			userDataHome,
			localUserHome,
			workspace: workspaceApi,
			workspaceStartupScheduled: workspaceStartupScheduled.p,
			workspaceDirectoriesReady,
			startWorkspaceDirectories: options => { void workspaceWindowReady.complete(options); },
			reloadWorkspaceDirectories: async () => { if (enabled) await restoreWorkspace({ force: true }); },
			bindLocalWorkspaceFolder: async folder => {
				if (!enabled || remoteConnection.kind !== 'local') return false;
				await workspaceDirectoriesReady;
				if (resources.isDisposed || client.state !== 'ready') return false;
				if (additionalFolders.has(folder.id) && hasDevelopmentPermissions(await backend.workspaceTrust.readWorkspaceDirectory(folder.id))) return true;
				const existing = await backend.workspaceTrust.readDirectory(folder.uri.fsPath);
				if (!hasDevelopmentPermissions(existing.permissions)) return false;
				additionalFolders.set(folder.id, folder);
				try {
					await restoreWorkspace({ force: true });
					return hasDevelopmentPermissions(await backend.workspaceTrust.readWorkspaceDirectory(folder.id));
				} catch (error) {
					if (additionalFolders.get(folder.id) === folder) additionalFolders.delete(folder.id);
					throw error;
				}
			},
			workspaceConfigurationFiles: workspaceApi.configurationFiles,
		};
	} catch (error) {
		resources.dispose();
		throw error;
	}
}
