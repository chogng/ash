import type { AppServerProtocolClient } from '../../platform/agentHost/browser/appServerProtocolClient.js';
import type { IExtensionHostApi } from '../../platform/agentHost/common/extensionHostApi.js';
import { createAppServerExtensionHostApi } from '../../platform/agentHost/browser/extensionHostApi.js';
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
import { RemoteAgentHostService } from '../../platform/agentHost/browser/remoteAgentHostServiceImpl.js';
import { createRendererHost, type RendererCapabilityContribution } from '../browser/webRendererApi.js';
import { ElectronRendererClipboardService } from '../../platform/clipboard/electron-browser/electronRendererClipboardService.js';
import { createDisconnectedRendererApi } from '../browser/rendererApi.js';
import { AppServerAutomationService } from '../../platform/agentHost/browser/appServerAutomationService.js';
import { registerAppServerWorkspaceHost, initializeWorkspace } from '../../platform/workspaces/electron-browser/appServerWorkspaceHost.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import type { IRendererHost } from '../../platform/renderer/common/rendererHost.js';
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
import { createNativeMenubarApi } from "../../platform/menubar/electron-browser/nativeMenubarApi.js";
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

export type ElectronRendererCapabilityContribution = (client: AppServerProtocolClient, appServer: Parameters<RendererCapabilityContribution>[1], localClient: AppServerProtocolClient) => ReturnType<RendererCapabilityContribution>;

/** Composes Electron renderer capabilities from domain-owned IPC adapters. */
export async function createElectronRendererApi(contributions: readonly ElectronRendererCapabilityContribution[], hostCapabilities: { readonly browser: boolean; readonly textDocuments?: boolean; readonly appTools?: boolean; }, workspaceTrust: IWorkspaceTrustRequestService, mainProcessService: IMainProcessService, resolveRemoteAuthority?: (api: IExtensionHostApi, factories: IRemoteSocketFactoryService, authority: string, attempt: number) => Promise<IAddress>, initializeRemoteExtensions?: (api: IExtensionHostApi, authority: string) => Promise<IExtensionHostApi>): Promise<AshElectronRendererApi & IDisposable> {
	performance.mark('ash.rendererApi.start');
	const resources = new DisposableStore();
	const workspaceApi = createWorkspaceContextApi();
	const remoteConnection = await createRemoteAgentApi().getConnection();
	const connectionServices = resources.add(new InstantiationService());
	connectionServices.registerInstance(IMainProcessService, mainProcessService);
	const connectionLogger = resources.add(connectionServices.createInstance(LoggerChannelClient)).createLogger('app-server', { hidden: true });
	connectionServices.registerInstance(ILogService, connectionLogger);
	connectionServices.registerSingleton(IRemoteSocketFactoryService, () => connectionServices.createInstance(RemoteSocketFactoryService));
	const factories = connectionServices.get(IRemoteSocketFactoryService);
	// Initialization includes the local daemon's cold start, which can take 15 seconds.
	const localConnection = resources.add(connectionServices.createInstance(LocalAgentHostServiceClient, {
		clientName: 'ash-desktop',
		connection: remoteConnection.kind === 'ssh' ? 'local' : 'workspace',
		initializeTimeoutMs: 30_000,
		capabilities: {
			agentInteractions: { version: 1, kinds: ['approval', 'permissions', 'userInput'] },
			...(hostCapabilities.browser ? { browser: { version: 4, observe: true, input: true } } : {}),
			...(hostCapabilities.textDocuments ? { textDocuments: { version: 2 } } : {}),
			...(hostCapabilities.appTools ? { appTools: { version: 1, agents: true, desktop: true } } : {}),
			directoryGrantsHost: { version: 1 },
		},
	} satisfies ConstructorParameters<typeof LocalAgentHostServiceClient>[0]));
	const localClient = localConnection.client;
	let client = localClient;
	let connection: LocalAgentHostServiceClient | RemoteAgentHostService = localConnection;
	let localExtensions: IExtensionHostApi | undefined;
	let windowExtensions: IExtensionHostApi | undefined;

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
		const enabled = await localConnection.connect();
		let backend: IRendererHost;
		if (enabled) {
			performance.mark('ash.rendererApi.initialized');
			if (remoteConnection.kind === 'ssh') {
				const workspaceConnection = resources.add(connectionServices.createInstance(LocalAgentHostServiceClient, {
					clientName: 'ash-desktop-remote', initializeTimeoutMs: SSH_REMOTE_INITIALIZE_TIMEOUT_MS,
					capabilities: {
						directoryGrantsHost: { version: 1 },
						agentInteractions: { version: 1, kinds: ['approval', 'permissions', 'userInput'] },
						...(hostCapabilities.browser ? { browser: { version: 4, observe: true, input: true } } : {}),
						...(hostCapabilities.textDocuments ? { textDocuments: { version: 2 } } : {}),
						...(hostCapabilities.appTools ? { appTools: { version: 1, agents: true, desktop: true } } : {}),
					},
				}));
				await workspaceConnection.connect();
				connection = workspaceConnection;
				client = workspaceConnection.client;
			}
			if (remoteConnection.kind === 'remote') {
				if (!resolveRemoteAuthority || !initializeRemoteExtensions) { throw new Error('This window does not provide a local Remote resolver'); }
				localExtensions = createAppServerExtensionHostApi(localClient);
				let attempt = 0;
				// An extension endpoint does not inherit the local stdio host's directory-grant authority.
				const remote = resources.add(connectionServices.createInstance(RemoteAgentHostService, {
					protocol: {
						clientName: 'ash-desktop-remote',
						initializeTimeoutMs: 30_000,
						capabilities: {
							agentInteractions: { version: 1, kinds: ['approval', 'permissions', 'userInput'] },
							...(hostCapabilities.browser ? { browser: { version: 4, observe: true, input: true } } : {}),
							...(hostCapabilities.textDocuments ? { textDocuments: { version: 2 } } : {}),
						},
					},
					getAddress: async () => {
						await localConnection.whenConnected();
						return resolveRemoteAuthority(localExtensions!, factories, remoteConnection.authority, ++attempt);
					},
					getMetadata: () => localConnection.connectionMetadata,
					onDidReconnectLocal: localConnection.onDidReconnect,
					initialize: async remoteClient => {
						windowExtensions = await initializeRemoteExtensions(createAppServerExtensionHostApi(remoteClient), remoteConnection.authority);
					},
				} satisfies ConstructorParameters<typeof RemoteAgentHostService>[0]));
				connection = remote;
				client = remote.client;
				await remote.connect();
			}
			backend = createRendererHost(client, {
				externalOpener: { openExternal: target => invoke<boolean>('ash:host:openExternal', target) },
				callbackHost: {
					listen: options => invoke('ash:oauth-callback:listen', options),
					wait: id => invoke('ash:oauth-callback:wait', { id }),
					close: id => invoke('ash:oauth-callback:close', { id }),
				},
				clipboardService: new ElectronRendererClipboardService(),
			}, contributions.map(contribution => (client, appServer) => contribution(client, appServer, localClient)));
			resources.add(backend.mcpServerManagement);
			resources.add(registerAppServerWorkspaceHost(client, () => connection.whenConnected(), workspaceTrust, backend.workspaceTrust));
			backend = { ...backend, backup: new AppServerBackupService(localExtensions ? localClient : client, 'ash-editor'), ...(windowExtensions ? { extensionHost: windowExtensions } : {}) };
			if (client.capabilities?.memories) { backend = { ...backend, memories: resources.add(new AppServerMemoriesService(client)) }; }
			if (client.capabilities?.contracts.memoryDiagnostics?.version === 1) { backend = { ...backend, memoryDiagnostics: resources.add(new AppServerMemoryDiagnosticsService(client, 'electron', () => invoke<MemoryObservation[]>('ash:memory:collect'))) }; }
			// Device ownership stays on this computer when the workspace connection is remote.
			if (localClient.capabilities?.contracts.calls?.version === 1) { backend = { ...backend, calls: resources.add(new AppServerCallService(localClient)) }; }
			if (remoteConnection.kind === 'local' && client.capabilities?.contracts.voiceConversation?.version === 1) { backend = { ...backend, agentVoice: resources.add(new AppServerAgentVoiceService(client)) }; }
			backend = { ...backend, dictation: createAppServerVoiceCodeTranscriptionBackend(localClient) };
			if (client.capabilities?.contracts.symphony?.version === 1) { backend = { ...backend, symphony: resources.add(new AppServerSymphonyService(client)) }; }
			if (client.capabilities?.contracts.automation?.version === 1) { backend = { ...backend, automation: resources.add(new AppServerAutomationService(client)) }; }
			if (remoteConnection.kind === 'ssh') {
				const terminals = resources.add(new ReconnectableTerminalProcessService(client));
				backend = { ...backend, terminal: terminals };
				const replacement = subscribe('ash:terminal:prepareReplacement', () => terminals.prepareForServerReplacement());
				resources.add(toDisposable(() => replacement.dispose()));
			}
			await initializeWorkspace(client, workspaceTrust, backend.workspaceTrust, workspaceApi);
			performance.mark('ash.rendererApi.workspace-initialized');
		} else {
			backend = createDisconnectedRendererApi();
		}

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
			keyboardLayout: createNativeKeyboardLayoutApi(mainProcessService),
			userKeyboardLayout: createUserKeyboardLayoutApi(mainProcessService),
			nativeContextMenu: { popup: popupContextMenu, close: closeContextMenu },
			nativeHost: createNativeHostApi(mainProcessService),
			nativeMenubar: createNativeMenubarApi(),
			editUserConfiguration: () => invoke<void>(EDIT_USER_CONFIGURATION_CHANNEL),
			localFiles,
			userDataHome,
			localUserHome: URI.parse(await mainProcessService.getChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME).call<string>('userHome')),
			workspace: workspaceApi,
		};
	} catch (error) { resources.dispose(); throw error; }
}
