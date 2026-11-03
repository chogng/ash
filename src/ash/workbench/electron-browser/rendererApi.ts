import { DeferredPromise } from '../../base/common/async.js';
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
import type {
	INativeHostApi,
} from '../../platform/native/common/nativeHost.js';
import { RemoteAgentHostService } from '../../platform/agentHost/electron-browser/remoteAgentHostService.js';
import { registerAppServerBrowserHost } from '../../platform/agentHost/electron-browser/appServerBrowserHost.js';
import { AppServerTcpService } from '../../platform/network/browser/appServerTcpService.js';
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
import { AppServerBackupService } from '../../platform/backup/browser/appServerBackupService.js';
import { AppServerCallService } from '../../platform/call/browser/appServerCallService.js';
import { AppServerAgentVoiceService } from '../../platform/agentHost/browser/appServerAgentService.js';
import { createAppServerVoiceCodeTranscriptionBackend } from '../../platform/dictation/browser/appServerVoiceCodeTranscriptionBackend.js';
import { AppServerMemoriesService } from '../../platform/memories/browser/appServerMemoriesService.js';
import { AppServerMemoryDiagnosticsService } from '../../platform/memory/browser/appServerMemoryDiagnosticsService.js';
import type { MemoryObservation } from '../../platform/memory/common/memoryDiagnosticsService.js';
import { LocalAgentHostServiceClient } from '../../platform/agentHost/electron-browser/localAgentHostService.js';
import { WorkbenchAgentHostService } from '../services/agentHost/electron-browser/agentHostService.js';
import { createRendererHost, type RendererCapabilityContribution } from '../browser/webRendererApi.js';
import { ElectronRendererClipboardService } from '../../platform/clipboard/electron-browser/electronRendererClipboardService.js';
import { createDisconnectedRendererApi } from '../browser/rendererApi.js';
import { AppServerAutomationService } from '../../platform/automations/browser/appServerAutomationService.js';
import { registerAppServerWorkspaceHost, initializeWorkspace, initializeWorkspaceDirectories } from '../../platform/workspaces/electron-browser/appServerWorkspaceHost.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import type { IWorkbenchHost } from '../browser/rendererApi.js';
import { invoke } from '../../platform/ipc/electron-browser/rendererIpc.js';
import { subscribe } from '../../platform/ipc/electron-browser/rendererIpc.js';
import { ReconnectableTerminalProcessService } from '../../platform/terminal/browser/reconnectableTerminalProcessService.js';
import { operatingSystemFromNodePlatform } from '../../base/common/environment.js';
import { sandboxProcess } from '../../base/parts/sandbox/electron-browser/globals.js';
import { ConfigurationService } from '../../platform/configuration/common/configurationService.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { IPolicyService } from '../../platform/policy/common/policy.js';
import { PolicyChannelClient } from '../../platform/policy/common/policyIpc.js';
import { FileService } from '../../platform/files/common/fileService.js';
import { IFileService } from '../../platform/files/common/files.js';
import { FileUserDataProvider } from '../../platform/userData/common/fileUserDataProvider.js';
import { ILogService, NullLoggerService } from '../../platform/log/common/log.js';
import { Schemas } from '../../base/common/network.js';
import { popup as popupContextMenu, close as closeContextMenu } from '../../base/parts/contextmenu/electron-browser/contextmenu.js';
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
import type { IDirectoryPermissionRequestService } from '../../platform/workspace/common/workspaceTrust.js';
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
	/** Settles after the first directory binding, including a declined startup prompt. */
	readonly workspaceDirectoriesReady: Promise<void>;
	readonly startWorkspaceDirectories: () => void;
	readonly reloadWorkspaceDirectories: () => Promise<void>;
}

export type ElectronRendererCapabilityContribution = (client: AppServerProtocolClient, appServer: Parameters<RendererCapabilityContribution>[1], localClient: AppServerProtocolClient) => ReturnType<RendererCapabilityContribution>;

/** Composes Electron renderer capabilities from domain-owned IPC adapters. */
export async function createElectronRendererApi(contributions: readonly ElectronRendererCapabilityContribution[], hostCapabilities: { readonly browser: boolean; readonly textDocuments?: boolean; readonly appTools?: boolean; readonly agentHosts?: boolean; }, workspaceTrust: IDirectoryPermissionRequestService, mainProcessService: IMainProcessService, resolveRemoteAuthority?: (api: IExtensionHostApi, factories: IRemoteSocketFactoryService, authority: string, attempt: number) => Promise<IAddress>, initializeRemoteExtensions?: (api: IExtensionHostApi, authority: string) => Promise<IExtensionHostApi>): Promise<AshElectronRendererApi & IDisposable> {
	performance.mark('ash.rendererApi.start');
	const resources = new DisposableStore();
	const workspaceApi = createWorkspaceContextApi();
	const nativeHost = createNativeHostApi(mainProcessService);
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
		onDidSuspendOS: listener => nativeHost.onDidSuspendOS(listener),
		onDidResumeOS: listener => nativeHost.onDidResumeOS(listener),
		resolveRemoteAuthority,
		initializeRemoteExtensions,
	} satisfies ConstructorParameters<typeof WorkbenchAgentHostService>[0]));
	const localConnection = agentHost.localConnection;
	const localClient = localConnection.client;

	try {
		const localFiles = resources.add(new DiskFileSystemProviderClient(mainProcessService.getChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME)));
		const userDataHome = URI.parse(await mainProcessService.getChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME).call<string>('userDataHome'));
		const profileFiles = resources.add(new FileService());
		const profileProvider = resources.add(new FileUserDataProvider(localFiles, userDataHome));
		resources.add(profileFiles.registerProvider(Schemas.vscodeUserData, profileProvider));
		const configurationServices = resources.add(new InstantiationService());
		configurationServices.registerInstance(IFileService, profileFiles);
		configurationServices.registerInstance(ILogService, new NullLoggerService());
		configurationServices.registerInstance(IPolicyService, resources.add(new PolicyChannelClient(mainProcessService.getChannel('policy'))));
		const configuration = resources.add(configurationServices.createInstance(ConfigurationService, URI.from({ scheme: Schemas.vscodeUserData, path: '/user/settings.json' })));
		await configuration.initialize();
		performance.mark('ash.rendererApi.connect-start');
		const enabled = await agentHost.connect();
		const connection = agentHost.connection;
		const client = agentHost.client;
		let backend: IWorkbenchHost;
		const workspaceChanges = resources.add(new Emitter<void>());
		const workspaceWindowReady = new DeferredPromise<void>();
		resources.add(toDisposable(() => { void workspaceWindowReady.complete(); }));
		let workspaceDirectoriesReady = Promise.resolve();
		let workspaceInitialization: { readonly generation: number; readonly promise: Promise<void>; state: 'restoring' | 'ready' | 'failed'; error?: unknown; } | undefined;
		const trackWorkspaceInitialization = (promise: Promise<void>): Promise<void> => {
			const attempt: NonNullable<typeof workspaceInitialization> = {
				generation: client.generation, state: 'restoring', promise,
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
			return promise;
		};
		const restoreWorkspace = (retry = false, force = false): Promise<void> => {
			// Terminals and reconnect listeners share one binding attempt per generation.
			if (force || workspaceInitialization?.generation !== client.generation || retry && workspaceInitialization.state === 'failed') {
				let remoteHostLabel: string | undefined;
				if (remoteConnection.kind === 'ssh') {
					remoteHostLabel = remoteConnection.host;
				} else if (remoteConnection.kind === 'remote') {
					remoteHostLabel = remoteConnection.authority;
				}
				return trackWorkspaceInitialization(workspaceWindowReady.p.then(() => {
					if (resources.isDisposed) throw new CancellationError();
					return initializeWorkspace(client, workspaceTrust, backend.workspaceTrust, workspaceApi, { remoteHostLabel });
				}));
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
				return connection.recovery.status === 'idle' && workspaceInitialization?.generation === client.generation
					&& workspaceInitialization.state !== 'ready' ? 'workspace' : 'connection';
			},
			get status() {
				const status = connection.recovery.status;
				if (status === 'idle' && permissionRecoveries > 0) return 'recovering';
				if (status !== 'idle' || workspaceInitialization?.generation !== client.generation) return status;
				return workspaceInitialization.state === 'restoring' ? 'recovering' : workspaceInitialization.state === 'failed' ? 'failed' : 'idle';
			},
			get error() {
				return connection.recovery.status === 'idle' && workspaceInitialization?.generation === client.generation && workspaceInitialization.state === 'failed'
					? String(workspaceInitialization.error instanceof Error ? workspaceInitialization.error.message : workspaceInitialization.error)
					: connection.recovery.error;
			},
			onDidChange: Event.any(connection.recovery.onDidChange, workspaceChanges.event),
			reconnect: async options => {
				const permissions = options?.reason === 'permissions';
				if (permissions) { permissionRecoveries++; workspaceChanges.fire(); }
				try {
					// A ready carrier needs only its failed directory binding retried.
					const bindingPending = workspaceInitialization?.generation === client.generation && workspaceInitialization.state !== 'ready';
					if (connection.recovery.status !== 'idle' || !bindingPending) await connection.recovery.reconnect();
					await restoreWorkspace(true);
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
			backend = { ...backend, localTcp: new AppServerTcpService(localClient), backup: new AppServerBackupService(localClient, 'ash-editor'), ...(agentHost.windowExtensions ? { extensionHost: agentHost.windowExtensions } : {}) };
			if (client.capabilities?.memories) { backend = { ...backend, memories: resources.add(new AppServerMemoriesService(client)) }; }
			if (client.capabilities?.contracts.memoryDiagnostics?.version === 1) { backend = { ...backend, memoryDiagnostics: resources.add(new AppServerMemoryDiagnosticsService(client, 'electron', () => invoke<MemoryObservation[]>('ash:memory:collect'))) }; }
			// Device ownership stays on this computer when the workspace connection is remote.
			if (localClient.capabilities?.contracts.channels?.version === 1) { backend = { ...backend, channels: resources.add(new AppServerChannelService(localClient)) }; }
			if (localClient.capabilities?.contracts.calls?.version === 1) { backend = { ...backend, calls: resources.add(new AppServerCallService(localClient)) }; }
			if (remoteConnection.kind === 'local' && client.capabilities?.contracts.voiceConversation?.version === 1) { backend = { ...backend, agentVoice: resources.add(new AppServerAgentVoiceService(client)) }; }
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
			workspaceDirectoriesReady = restoreWorkspace().catch(error => {
				if (!isCancellationError(error)) throw error;
			});
			void workspaceDirectoriesReady.catch(() => undefined);
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
			keyboardLayout: createNativeKeyboardLayoutApi(mainProcessService),
			userKeyboardLayout: createUserKeyboardLayoutApi(mainProcessService),
			nativeContextMenu: { popup: popupContextMenu, close: closeContextMenu },
			nativeHost,
			editUserConfiguration: () => invoke<void>(EDIT_USER_CONFIGURATION_CHANNEL),
			localFiles,
			userDataHome,
			localUserHome: URI.parse(await mainProcessService.getChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME).call<string>('userHome')),
			workspace: workspaceApi,
			workspaceDirectoriesReady,
			startWorkspaceDirectories: () => { void workspaceWindowReady.complete(); },
			reloadWorkspaceDirectories: async () => { if (enabled) await restoreWorkspace(false, true); },
			workspaceConfigurationFiles: workspaceApi.configurationFiles,
		};
	} catch (error) {
		resources.dispose();
		throw error;
	}
}
