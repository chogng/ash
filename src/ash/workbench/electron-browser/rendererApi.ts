import { localize } from '../../nls.js';
import { throwIfCancelled } from '../../base/common/cancellation.js';
import { generateUuid } from '../../base/common/uuid.js';
import { DeferredPromise, raceCancellationError } from '../../base/common/async.js';
import { Emitter } from '../../base/common/event.js';
import { agentHostConnectionAddress } from '../../platform/agentHost/common/agentHostConnectionsService.js';
import type { RemoteConnectionDefinition } from '../../platform/remote/common/remoteConnectionService.js';
import { REMOTE_AGENT_HOST_OPEN_CHANNEL, REMOTE_AGENT_HOST_CLOSE_CHANNEL } from '../../platform/remote/common/remoteConnectionIpc.js';
import { createSshRemoteWorkspaceUri } from '../../platform/remote/common/remote.js';
import { AppServerChannelService } from "../../platform/collaboration/browser/appServerChannelService.js";
import type { AppServerProtocolClient } from '../../platform/agentHost/browser/appServerProtocolClient.js';
import type { IExtensionHostApi } from '../../platform/agentHost/common/extensionHostApi.js';
import type { IAddress } from '../../platform/remote/common/remoteAgentConnection.js';
import { IRemoteSocketFactoryService, RemoteSocketFactoryService } from '../../platform/remote/common/remoteSocketFactoryService.js';
import { AppServerSymphonyService } from '../../platform/symphony/browser/appServerSymphonyService.js';
import { EDIT_USER_CONFIGURATION_CHANNEL } from '../../platform/native/common/nativeHost.js';
import { AppServerBackupService } from '../../platform/backup/browser/appServerBackupService.js';
import { AppServerCallService } from '../../platform/call/browser/appServerCallService.js';
import { AppServerAgentVoiceService } from '../../platform/agentHost/browser/appServerAgentService.js';
import { createAppServerVoiceCodeTranscriptionBackend } from '../../platform/renderer/browser/appServerVoiceCodeTranscriptionBackend.js';
import { AppServerMemoriesService } from '../../platform/memories/browser/appServerMemoriesService.js';
import { AppServerMemoryDiagnosticsService } from '../../platform/memory/browser/appServerMemoryDiagnosticsService.js';
import type { MemoryObservation } from '../../platform/memory/common/memoryDiagnosticsService.js';
import { LocalAgentHostServiceClient } from '../../platform/agentHost/electron-browser/localAgentHostService.js';
import { WorkbenchAgentHostService } from '../services/agentHost/electron-browser/agentHostService.js';
import { createRendererHost, type RendererCapabilityContribution } from '../browser/webRendererApi.js';
import { ElectronRendererClipboardService } from '../../platform/clipboard/electron-browser/electronRendererClipboardService.js';
import { createDisconnectedRendererApi } from '../browser/rendererApi.js';
import { AppServerAutomationService } from '../../platform/agentHost/browser/appServerAutomationService.js';
import { registerAppServerWorkspaceHost, initializeWorkspace, initializeWorkspaceDirectories } from '../../platform/workspaces/electron-browser/appServerWorkspaceHost.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import type { IRendererHost, IRendererAgentHost } from '../../platform/renderer/common/rendererHost.js';
import { invoke } from '../../platform/ipc/electron-browser/rendererIpc.js';
import { subscribe } from '../../platform/ipc/electron-browser/rendererIpc.js';
import { ReconnectableTerminalProcessService } from '../../platform/terminal/browser/reconnectableTerminalProcessService.js';
import { operatingSystemFromNodePlatform } from "../../base/common/environment.js";
import { sandboxProcess } from "../../base/parts/sandbox/electron-browser/globals.js";
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
import { createNativeKeyboardLayoutApi } from "../../platform/keyboardLayout/electron-browser/nativeKeyboardLayoutApi.js";
import { createUserKeyboardLayoutApi } from "../../platform/keyboardLayout/electron-browser/userKeyboardLayoutApi.js";
import { DiskFileSystemProviderClient, LOCAL_FILE_SYSTEM_CHANNEL_NAME } from "../../platform/files/common/diskFileSystemProviderClient.js";
import { URI } from "../../base/common/uri.js";
import { createWorkspaceContextApi } from "../../platform/workspace/electron-browser/workspaceContextApi.js";
import type { AshElectronRendererApi } from "../../platform/native/common/rendererApi.js";
import { createNativeHostApi } from "../../platform/native/electron-browser/nativeHostApi.js";
import { IMainProcessService } from '../../platform/ipc/common/mainProcessService.js';
import { LoggerChannelClient } from '../../platform/log/common/logIpc.js';
import type { IAppServerApi } from "../../platform/agentHost/common/appServerApi.js";
import type { RendererHostCapabilities } from "../../platform/renderer/common/rendererHost.js";
import { createRemoteAgentApi } from "../../platform/remote/electron-browser/remoteAgentApi.js";
import { createRemoteConnectionApi } from "../../platform/remote/electron-browser/remoteConnectionApi.js";
import { SSH_REMOTE_INITIALIZE_TIMEOUT_MS } from '../../platform/remote/common/remote.js';
import type { IWorkspaceTrustRequestService } from '../../platform/workspace/common/workspaceTrust.js';
import { InstantiationService } from '../../platform/instantiation/common/instantiationService.js';
import { InstantiationType } from '../../platform/instantiation/common/extensions.js';
import { IWebWorkerService } from '../../platform/webWorker/browser/webWorkerService.js';
import { WebWorkerService } from '../../platform/webWorker/browser/webWorkerServiceImpl.js';
import { isCancellationError, CancellationError } from '../../base/common/errors.js';

export type ElectronRendererCapabilityContribution = (client: AppServerProtocolClient, appServer: Parameters<RendererCapabilityContribution>[1], localClient: AppServerProtocolClient) => ReturnType<RendererCapabilityContribution>;

/** Composes Electron renderer capabilities from domain-owned IPC adapters. */
export async function createElectronRendererApi(contributions: readonly ElectronRendererCapabilityContribution[], hostCapabilities: { readonly browser: boolean; readonly textDocuments?: boolean; readonly appTools?: boolean; readonly agentHosts?: boolean; }, workspaceTrust: IWorkspaceTrustRequestService, mainProcessService: IMainProcessService, resolveRemoteAuthority?: (api: IExtensionHostApi, factories: IRemoteSocketFactoryService, authority: string, attempt: number) => Promise<IAddress>, initializeRemoteExtensions?: (api: IExtensionHostApi, authority: string) => Promise<IExtensionHostApi>): Promise<AshElectronRendererApi & IDisposable> {
	performance.mark('ash.rendererApi.start');
	const resources = new DisposableStore();
	const workspaceApi = createWorkspaceContextApi();
	const nativeHost = createNativeHostApi(mainProcessService);
	const remoteConnection = await createRemoteAgentApi().getConnection();
	const connectionServices = resources.add(new InstantiationService());
	// Connections are created before the Workbench window and own an independent service scope.
	connectionServices.registerSingleton(IWebWorkerService, () => connectionServices.createInstance(WebWorkerService), { instantiation: InstantiationType.Delayed });
	connectionServices.registerInstance(IMainProcessService, mainProcessService);
	const connectionLogger = resources.add(connectionServices.createInstance(LoggerChannelClient)).createLogger('app-server', { hidden: true });
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
		let backend: IRendererHost;
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
			}, contributions.map(contribution => (client, appServer) => contribution(client, appServer, localClient)), remoteConnection.kind === 'ssh' ? remoteConnection.host : undefined, connection.recovery);
			resources.add(backend.mcpServerManagement);
			if (backend.contextResourceHost) { resources.add(backend.contextResourceHost); }
			resources.add(registerAppServerWorkspaceHost(client, () => connection.whenConnected(), workspaceTrust, backend.workspaceTrust, folders => workspaceApi.validateFolders(folders), path => remoteConnection.kind === 'ssh' ? createSshRemoteWorkspaceUri(remoteConnection.host, path) : URI.file(path)));
			// Editor recovery belongs to this Desktop profile, including SSH workspaces.
			backend = { ...backend, backup: new AppServerBackupService(localClient, 'ash-editor'), ...(agentHost.windowExtensions ? { extensionHost: agentHost.windowExtensions } : {}) };
			if (client.capabilities?.memories) { backend = { ...backend, memories: resources.add(new AppServerMemoriesService(client)) }; }
			if (client.capabilities?.contracts.memoryDiagnostics?.version === 1) { backend = { ...backend, memoryDiagnostics: resources.add(new AppServerMemoryDiagnosticsService(client, 'electron', () => invoke<MemoryObservation[]>('ash:memory:collect'))) }; }
			// Device ownership stays on this computer when the workspace connection is remote.
			if (localClient.capabilities?.contracts.channels?.version === 1) { backend = { ...backend, channels: resources.add(new AppServerChannelService(localClient)) }; }
			if (localClient.capabilities?.contracts.calls?.version === 1) { backend = { ...backend, calls: resources.add(new AppServerCallService(localClient)) }; }
			if (remoteConnection.kind === 'local' && client.capabilities?.contracts.voiceConversation?.version === 1) { backend = { ...backend, agentVoice: resources.add(new AppServerAgentVoiceService(client)) }; }
			backend = { ...backend, dictation: createAppServerVoiceCodeTranscriptionBackend(localClient) };
			if (client.capabilities?.contracts.symphony?.version === 1) { backend = { ...backend, symphony: resources.add(new AppServerSymphonyService(client)) }; }
			if (client.capabilities?.contracts.automation?.version === 1) { backend = { ...backend, automation: resources.add(new AppServerAutomationService(client)) }; }
			const terminals = resources.add(new ReconnectableTerminalProcessService(client));
			backend = { ...backend, terminal: terminals };
			const replacement = subscribe('ash:terminal:prepareReplacement', () => terminals.prepareForServerReplacement());
			resources.add(toDisposable(() => replacement.dispose()));
			await initializeWorkspace(client, workspaceTrust, backend.workspaceTrust, workspaceApi);
			// The selected execution host needs its roots after a runtime replacement,
			// including SSH and extension hosts; local device recovery is independent.
			resources.add(connection.onDidReconnect(() => {
				void initializeWorkspace(client, workspaceTrust, backend.workspaceTrust, workspaceApi)
					.catch(error => { if (!resources.isDisposed && !isCancellationError(error)) connectionLogger.error('app-server', 'Workspace recovery failed', error); });
			}));
			performance.mark('ash.rendererApi.workspace-initialized');
		} else {
			backend = createDisconnectedRendererApi();
		}

		interface HostScope {
			readonly id: string;
			readonly target: RemoteConnectionDefinition;
			readonly resources: DisposableStore;
			readonly controller: AbortController;
			readonly ready: Promise<IRendererAgentHost>;
			lease?: LocalAgentHostServiceClient;
			host?: IRendererAgentHost;
			initialization?: Promise<void>;
			initializing?: boolean;
			error?: unknown;
		}
		const hostChanges = resources.add(new Emitter<void>());
		const hostScopes = new Map<string, HostScope>();
		const hostState = (scope: HostScope): import('../../platform/agentHost/common/appServerApi.js').AppServerConnectionState => {
			if (scope.resources.isDisposed) return 'stopped';
			const state = scope.lease?.client.state ?? 'starting';
			if (state !== 'ready') return state;
			return scope.error ? 'crashed' : scope.initializing ? 'initializing' : state;
		};
		const releaseScope = (scope: HostScope): void => {
			const key = agentHostConnectionAddress(scope.target);
			if (hostScopes.get(key) !== scope) return;
			hostScopes.delete(key);
			resources.delete(scope.resources);
			scope.resources.dispose();
			hostChanges.fire();
		};
		resources.add(toDisposable(() => { for (const scope of [...hostScopes.values()]) releaseScope(scope); }));
		const openHostScope = async (scope: HostScope): Promise<IRendererAgentHost> => {
			const { id, target, resources: hostResources, controller } = scope;
			const signal = controller.signal;
			const release = (): void => releaseScope(scope);
			try {
				throwIfCancelled(signal);
				await raceCancellationError(invoke(REMOTE_AGENT_HOST_OPEN_CHANNEL, { id, connection: target }), signal);
				throwIfCancelled(signal);
				if (hostResources.isDisposed) { throw new CancellationError(); }
				const lease = hostResources.add(connectionServices.createInstance(LocalAgentHostServiceClient, {
					clientName: 'ash-desktop-agents', connection: { id }, initializeTimeoutMs: SSH_REMOTE_INITIALIZE_TIMEOUT_MS,
					capabilities: { agentInteractions: { version: 1, kinds: ['approval', 'permissions', 'userInput'] }, directoryGrantsHost: { version: 1 } },
				}));
				scope.lease = lease;
				hostResources.add(lease.client.onStateChange(state => {
					// Protocol readiness precedes restoring this scope's directory environment.
					if (state !== 'ready') scope.initializing = true;
					hostChanges.fire();
				}));
				// Each scope observes device power, but keeps its own retry and protocol generation.
				const suspend = nativeHost.onDidSuspendOS(() => lease.recovery.suspend());
				const resume = nativeHost.onDidResumeOS(() => lease.recovery.resume());
				hostResources.add(toDisposable(() => { suspend.dispose(); resume.dispose(); }));
				const enabled = await lease.connect();
				throwIfCancelled(signal);
				if (!enabled) { throw new Error(localize({ bundle: 'ash.workbench', key: 'agentHosts.unavailable' }, 'Agent host connections are unavailable in this window.')); }
				if (hostResources.isDisposed) { throw new CancellationError(); }
				let api = createRendererHost(lease.client, {
					externalOpener: { openExternal: value => invoke<boolean>('ash:host:openExternal', value) },
					callbackHost: { listen: options => invoke('ash:oauth-callback:listen', options), wait: id => invoke('ash:oauth-callback:wait', { id }), close: id => invoke('ash:oauth-callback:close', { id }) },
					clipboardService: new ElectronRendererClipboardService(),
				}, [], target.host, lease.recovery);
				hostResources.add(api.mcpServerManagement);
				if (api.contextResourceHost) { hostResources.add(api.contextResourceHost); }
				if (lease.client.capabilities?.contracts.automation?.version === 1) {
					api = { ...api, automation: hostResources.add(new AppServerAutomationService(lease.client)) };
				}
				const connectionApi = api.appServer;
				hostResources.add(lease.recovery.onDidChange(() => hostChanges.fire()));
				const reconnect = async (): Promise<void> => {
					throwIfCancelled(signal);
					await lease.recovery.reconnect();
					await scope.initialization;
					throwIfCancelled(signal);
				};
				api = {
					...api, appServer: {
						get connectionGeneration() { return connectionApi.connectionGeneration; },
						get operatingSystem() { return connectionApi.operatingSystem; },
						get userHome() { return connectionApi.userHome; },
						recovery: {
							get status() {
								const status = lease.recovery.status;
								return status === 'unavailable' || status === 'suspended' ? status : scope.error ? 'failed' : scope.initializing && status === 'idle' ? 'recovering' : status;
							},
							get error() { return lease.recovery.status === 'unavailable' ? lease.recovery.error : scope.error instanceof Error ? scope.error.message : lease.recovery.error; },
							onDidChange: hostChanges.event,
							reconnect,
						},
						getConnectionState: async () => hostState(scope),
						getSlashCommands: () => connectionApi.getSlashCommands(),
						onConnectionState: listener => {
							let previous = hostState(scope);
							return hostChanges.event(() => { const state = hostState(scope); if (state !== previous) { previous = state; listener(state); } });
						},
					}
				};
				const initialize = (): Promise<void> => initializeWorkspaceDirectories(lease.client, workspaceTrust, api.workspaceTrust, [
					{ id: `agent-host:${id}`, path: target.workspace, label: createSshRemoteWorkspaceUri(target.host, target.workspace).toString() },
				]);
				const restoreDirectories = (): Promise<void> => {
					const task = scope.initialization = initialize();
					scope.initializing = true;
					scope.error = undefined;
					hostChanges.fire();
					void task.then(() => {
						if (scope.initialization !== task || hostResources.isDisposed) return;
						scope.initializing = false;
						hostChanges.fire();
					}, error => {
						if (scope.initialization !== task || hostResources.isDisposed) return;
						scope.initializing = false;
						scope.error = error;
						hostChanges.fire();
						if (!isCancellationError(error)) connectionLogger.error('app-server', 'Agent host directory recovery failed', error);
					});
					return task;
				};
				await restoreDirectories();
				throwIfCancelled(signal);
				if (hostResources.isDisposed) { throw new CancellationError(); }
				hostResources.add(lease.onDidReconnect(() => { void restoreDirectories().catch(() => { }); }));
				scope.host = { id, connection: target, api, dispose: release, [Symbol.dispose]: release };
				hostChanges.fire();
				throwIfCancelled(signal);
				return scope.host;
			} catch (error) {
				release();
				throw error;
			}
		};
		const agentHosts: IRendererHost['agentHosts'] = hostCapabilities.agentHosts ? {
			get connections() {
				return [...hostScopes.values()].map(scope => ({ id: scope.id, connection: scope.target, state: hostState(scope), host: scope.host }));
			},
			onDidChangeConnections: hostChanges.event,
			connect: (target, signal) => {
				throwIfCancelled(signal);
				if (resources.isDisposed) throw new CancellationError();
				const key = agentHostConnectionAddress(target);
				const existing = hostScopes.get(key);
				if (existing) return raceCancellationError(existing.ready, signal);
				const controller = new AbortController();
				const hostResources = new DisposableStore();
				const ready = new DeferredPromise<IRendererAgentHost>();
				const scope: HostScope = { id: generateUuid(), target, controller, resources: hostResources, ready: ready.p };
				hostScopes.set(key, scope);
				hostResources.add(toDisposable(() => controller.abort()));
				hostResources.add(toDisposable(() => { void invoke(REMOTE_AGENT_HOST_CLOSE_CHANNEL, { id: scope.id }).catch(error => { if (!resources.isDisposed) connectionLogger.error('app-server', 'Agent host release failed', error); }); }));
				const cancel = (): void => releaseScope(scope);
				signal.addEventListener('abort', cancel, { once: true });
				hostResources.add(toDisposable(() => signal.removeEventListener('abort', cancel)));
				resources.add(hostResources);
				hostChanges.fire();
				void openHostScope(scope).then(host => { signal.removeEventListener('abort', cancel); void ready.complete(host); }, error => { void ready.error(error); });
				return ready.p;
			},
			disconnect: id => { const scope = [...hostScopes.values()].find(scope => scope.id === id); if (scope) releaseScope(scope); },
			reconnect: async id => {
				const scope = [...hostScopes.values()].find(scope => scope.id === id);
				if (!scope) throw new CancellationError();
				await scope.ready;
				if (scope.resources.isDisposed) throw new CancellationError();
				await scope.host!.api.appServer.recovery!.reconnect();
			},
		} : undefined;

		return {
			...backend,
			// Desktop supports the server-backed feature set even when its UI development host starts disconnected.
			hasAppServer: true,
			dispose: () => resources.dispose(),
			[Symbol.dispose]: () => resources.dispose(),
			environment: {
				runtime: "electron",
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
			workspaceConfigurationFiles: workspaceApi.configurationFiles,
		};
	} catch (error) { resources.dispose(); throw error; }
}
