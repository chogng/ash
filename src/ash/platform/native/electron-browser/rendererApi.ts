import type { IExtensionHostApi } from '../../extensionHost/common/extensionHostApi.js';
import { createAppServerExtensionHostApi } from '../../extensionHost/browser/extensionHostApi.js';
import type { IAddress } from '../../remote/common/remoteAgentConnection.js';
import { AppServerSocketTransport } from '../../agentHost/browser/appServerSocketTransport.js';
import { IRemoteSocketFactoryService, RemoteSocketFactoryService } from '../../remote/common/remoteSocketFactoryService.js';
import { ManagedRemoteConnection, RemoteConnectionType } from '../../remote/common/remoteAuthorityResolver.js';
import { AppServerSymphonyService } from '../../symphony/browser/appServerSymphonyService.js';
import { EDIT_USER_HOOKS_CONFIGURATION_CHANNEL } from '../../hooks/common/hooksIpc.js';
import { AppServerBackupService } from '../../backup/browser/appServerBackupService.js';
import { AppServerCallService } from '../../call/browser/appServerCallService.js';
import { AppServerDictationService } from '../../dictation/browser/appServerDictationService.js';
import { AppServerMemoriesService } from '../../memories/browser/appServerMemoriesService.js';
import { AppServerMemoryDiagnosticsService } from '../../memory/browser/appServerMemoryDiagnosticsService.js';
import type { MemoryObservation } from '../../memory/common/memoryDiagnosticsService.js';
import { AppServerProtocolIncompatibleError } from '../../agentHost/common/appServerProtocolCompatibility.js';
import { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { AppServerMessagePortTransport } from '../../agentHost/electron-browser/appServerMessagePortTransport.js';
import { createRendererHost, type RendererCapabilityContribution } from '../../agentHost/browser/webRendererApi.js';
import { ElectronRendererClipboardService } from '../../clipboard/electron-browser/electronRendererClipboardService.js';
import { createDisconnectedRendererApi } from '../../agentHost/browser/rendererApi.js';
import { AppServerAutomationService } from '../../automation/browser/appServerAutomationService.js';
import { registerAppServerBrowserHost } from '../../agentHost/electron-browser/appServerBrowserHost.js';
import { registerAppServerWorkspaceHost, initializeWorkspace } from '../../workspaces/electron-browser/appServerWorkspaceHost.js';
import { DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { IRendererHost } from '../../renderer/common/rendererHost.js';
import { invoke } from '../../ipc/electron-browser/rendererIpc.js';
import { subscribe } from '../../ipc/electron-browser/rendererIpc.js';
import { ReconnectableTerminalProcessService } from '../../terminal/browser/reconnectableTerminalProcessService.js';
import { operatingSystemFromNodePlatform } from "../../../base/common/environment.js";
import { sandboxProcess } from "../../../base/parts/sandbox/electron-browser/globals.js";
import { createBrowserViewService } from "../../browserView/electron-browser/browserViewService.js";
import { createConfigurationApi } from "../../configuration/electron-browser/configurationApi.js";
import { popup as popupContextMenu, close as closeContextMenu } from '../../../base/parts/contextmenu/electron-browser/contextmenu.js';
import { createNativeKeyboardLayoutApi } from "../../keyboardLayout/electron-browser/nativeKeyboardLayoutApi.js";
import { createUserKeyboardLayoutApi } from "../../keyboardLayout/electron-browser/userKeyboardLayoutApi.js";
import { createNativeMenubarApi } from "../../menubar/electron-browser/nativeMenubarApi.js";
import { DiskFileSystemProviderClient, LOCAL_FILE_SYSTEM_CHANNEL_NAME } from "../../files/common/diskFileSystemProviderClient.js";
import { URI } from "../../../base/common/uri.js";
import { createWorkspaceContextApi } from "../../workspace/electron-browser/workspaceContextApi.js";
import type { AshElectronRendererApi } from "../common/rendererApi.js";
import { createNativeHostApi } from "./nativeHostApi.js";
import type { IMainProcessService } from '../../ipc/common/mainProcessService.js';
import type { IAppServerApi } from "../../agentHost/common/appServerApi.js";
import type { RendererHostCapabilities } from "../../renderer/common/rendererHost.js";
import { createRemoteAgentApi } from "../../remote/electron-browser/remoteAgentApi.js";
import { createRemoteConnectionApi } from "../../remote/electron-browser/remoteConnectionApi.js";
import type { IWorkspaceTrustRequestService } from '../../workspace/common/workspaceTrust.js';
import { ILocalTranscriptionService } from '../../localTranscription/common/localTranscription.js';
import { InstantiationService } from '../../instantiation/common/instantiationService.js';

export type ElectronRendererCapabilityContribution = RendererCapabilityContribution;

/** Composes Electron renderer capabilities from domain-owned IPC adapters. */
export async function createElectronRendererApi(contributions: readonly ElectronRendererCapabilityContribution[], hostCapabilities: { readonly browser: boolean; readonly textDocuments?: boolean; readonly appTools?: boolean; }, workspaceTrust: IWorkspaceTrustRequestService, mainProcessService: IMainProcessService, resolveRemoteAuthority?: (api: IExtensionHostApi, factories: IRemoteSocketFactoryService, authority: string, attempt: number) => Promise<IAddress>, initializeRemoteExtensions?: (api: IExtensionHostApi, authority: string) => Promise<IExtensionHostApi>): Promise<AshElectronRendererApi & IDisposable> {
	performance.mark('ash.rendererApi.start');
	const resources = new DisposableStore();
	const remoteConnection = await createRemoteAgentApi().getConnection();
	let connecting: Promise<void> = Promise.resolve();
	const carrier = resources.add(new AppServerMessagePortTransport(() => {
		connecting = reconnect();
		void connecting.catch(error => console.error('App Server reconnect failed', error));
	}));
	const connectionServices = resources.add(new InstantiationService());
	connectionServices.registerSingleton(IRemoteSocketFactoryService, () => connectionServices.createInstance(RemoteSocketFactoryService));
	const factories = connectionServices.get(IRemoteSocketFactoryService);
	const factoryRegistration = resources.add(new MutableDisposable<IDisposable>());
	let connectionId = 0;
	const acquire = async (): Promise<boolean> => {
		factoryRegistration.clear();
		const enabled = await carrier.acquire();
		if (enabled) {
			const id = ++connectionId;
			const socket = carrier.socket;
			let leased = false;
			factoryRegistration.value = factories.register(RemoteConnectionType.Managed, {
				supports: connection => connection.id === id,
				connect: async (_connection, path, query) => {
					if (leased || path || query || carrier.socket !== socket) { throw new Error('App Server connection endpoint was superseded'); }
					// One acquired port backs one protocol client; another lease needs a new acquisition.
					leased = true;
					return socket;
				},
			});
		}
		return enabled;
	};
	const transport = resources.add(connectionServices.createInstance(AppServerSocketTransport, {
		getAddress: async () => ({ connectTo: new ManagedRemoteConnection(connectionId), connectionToken: undefined }), getMetadata: () => carrier.connectionMetadata,
	}));
	// Initialization includes the local daemon's cold start, which can take 15 seconds.
	const localClient = new AppServerProtocolClient(transport, { clientName: 'ash-desktop', initializeTimeoutMs: 30_000, capabilities: { ...(hostCapabilities.browser ? { browser: { version: 3, observe: true, input: true } } : {}), ...(hostCapabilities.textDocuments ? { textDocuments: { version: 2 } } : {}), ...(hostCapabilities.appTools ? { appTools: { version: 1, agents: true, desktop: true } } : {}), dirPermissionsHost: { version: 1 } } });
	resources.add(toDisposable(() => localClient.dispose()));
	let client = localClient;
	let localExtensions: IExtensionHostApi | undefined;
	let windowExtensions: IExtensionHostApi | undefined;
	const initialize = async (): Promise<void> => {
		try { await localClient.connect(); }
		catch (error) {
			if (!(error instanceof AppServerProtocolIncompatibleError) || await invoke('ash:app-server:recover-runtime', error.incompatibility) !== true) { throw error; }
			await acquire();
			await localClient.connect();
		}
		await carrier.initialized();
	};
	let reconnectTask: Promise<void> | undefined;
	let attempts = 0;
	let recovering = false;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let started = false;
	resources.add(toDisposable(() => { started = false; if (retryTimer !== undefined) { clearTimeout(retryTimer); } }));
	const reconnect = (): Promise<void> => {
		if (reconnectTask) { return reconnectTask; }
		if (retryTimer !== undefined) { clearTimeout(retryTimer); retryTimer = undefined; }
		const operation = (async () => {
			client.disconnect();
			if (client === localClient || localClient.state !== 'ready') {
				localClient.disconnect();
				await acquire();
				await initialize();
			}
			if (client !== localClient) {
				await client.connect();
				if (remoteConnection.kind === 'remote') { windowExtensions = await initializeRemoteExtensions!(createAppServerExtensionHostApi(client), remoteConnection.authority); }
			}
		})();
		reconnectTask = operation.finally(() => { reconnectTask = undefined; });
		return reconnectTask;
	};
	const scheduleRecovery = (): void => {
		if (!started || recovering || retryTimer !== undefined || attempts >= 3) { return; }
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			recovering = true;
			attempts++;
			connecting = reconnect();
			void connecting.then(() => { attempts = 0; }, error => console.error('App Server connection recovery failed', error)).finally(() => {
				recovering = false;
				if (client.state === 'crashed') { scheduleRecovery(); }
			});
		}, [100, 500, 2000][attempts]);
	};

	try {
		performance.mark('ash.rendererApi.acquire-start');
		const enabled = await acquire();
		performance.mark('ash.rendererApi.acquired');
		let backend: IRendererHost;
		if (enabled) {
			await initialize();
			performance.mark('ash.rendererApi.initialized');
			if (remoteConnection.kind === 'remote') {
				if (!resolveRemoteAuthority || !initializeRemoteExtensions) { throw new Error('This window does not provide a local Remote resolver'); }
				localExtensions = createAppServerExtensionHostApi(localClient);
				let attempt = 0;
				const remoteTransport = resources.add(connectionServices.createInstance(AppServerSocketTransport, {
					getAddress: () => resolveRemoteAuthority(localExtensions!, factories, remoteConnection.authority, ++attempt),
					getMetadata: () => carrier.connectionMetadata,
				}));
				// An extension endpoint does not inherit the local stdio host's directory-grant authority.
				client = new AppServerProtocolClient(remoteTransport, { clientName: 'ash-desktop-remote', initializeTimeoutMs: 30_000, capabilities: { ...(hostCapabilities.browser ? { browser: { version: 3, observe: true, input: true } } : {}), ...(hostCapabilities.textDocuments ? { textDocuments: { version: 2 } } : {}) } });
				resources.add(toDisposable(() => client.dispose()));
				await client.connect();
				windowExtensions = await initializeRemoteExtensions(createAppServerExtensionHostApi(client), remoteConnection.authority);
			}
			resources.add(client.onStateChange(state => { if (state === 'crashed') { scheduleRecovery(); } }));
			if (hostCapabilities.browser) { resources.add(registerAppServerBrowserHost(client)); }
			resources.add(registerAppServerWorkspaceHost(client, () => connecting, workspaceTrust));
			backend = createRendererHost(client, {
				externalOpener: { openExternal: target => invoke<boolean>('ash:host:openExternal', target) },
				callbackHost: {
					listen: () => invoke('ash:oauth-callback:listen'),
					wait: id => invoke('ash:oauth-callback:wait', { id }),
					close: id => invoke('ash:oauth-callback:close', { id }),
				},
				clipboardService: new ElectronRendererClipboardService(),
			}, contributions);
			backend = { ...backend, backup: new AppServerBackupService(localExtensions ? localClient : client, 'ash-editor'), ...(windowExtensions ? { extensionHost: windowExtensions } : {}) };
			if (client.capabilities?.memories) { backend = { ...backend, memories: resources.add(new AppServerMemoriesService(client)) }; }
			if (client.capabilities?.contracts.memoryDiagnostics?.version === 1) { backend = { ...backend, memoryDiagnostics: resources.add(new AppServerMemoryDiagnosticsService(client, 'electron', () => invoke<MemoryObservation[]>('ash:memory:collect'))) }; }
			if (client.capabilities?.contracts.calls?.version === 1) { backend = { ...backend, calls: resources.add(new AppServerCallService(client)) }; }
			if (remoteConnection.kind === 'local') {
				const services = resources.add(new InstantiationService());
				if (!backend.localTranscription) { throw new Error('Local transcription service was not contributed by the renderer entry'); }
				services.registerInstance(ILocalTranscriptionService, backend.localTranscription);
				backend = { ...backend, dictation: resources.add(services.createInstance(AppServerDictationService, client, createConfigurationApi(mainProcessService))) };
			} else {
				backend = { ...backend, localTranscription: undefined };
			}
			if (client.capabilities?.contracts.symphony?.version === 1) { backend = { ...backend, symphony: resources.add(new AppServerSymphonyService(client)) }; }
			if (client.capabilities?.contracts.automation?.version === 1) { backend = { ...backend, automation: resources.add(new AppServerAutomationService(client)) }; }
			if (remoteConnection.kind === 'ssh') {
				const terminals = resources.add(new ReconnectableTerminalProcessService(client));
				backend = { ...backend, terminal: terminals };
				const replacement = subscribe('ash:terminal:prepareReplacement', () => terminals.prepareForServerReplacement());
				resources.add(toDisposable(() => replacement.dispose()));
			}
			await initializeWorkspace(client, workspaceTrust);
			performance.mark('ash.rendererApi.workspace-initialized');
			started = true;
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
			browserView: createBrowserViewService(client),
			configuration: createConfigurationApi(mainProcessService),
			keyboardLayout: createNativeKeyboardLayoutApi(mainProcessService),
			userKeyboardLayout: createUserKeyboardLayoutApi(mainProcessService),
			nativeContextMenu: { popup: popupContextMenu, close: closeContextMenu },
			nativeHost: createNativeHostApi(mainProcessService),
			nativeMenubar: createNativeMenubarApi(),
			hooks: { ...backend.hooks, userConfigurationEditor: () => invoke<void>(EDIT_USER_HOOKS_CONFIGURATION_CHANNEL) },
			localFiles: resources.add(new DiskFileSystemProviderClient(mainProcessService.getChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME))),
			userDataHome: URI.parse(await mainProcessService.getChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME).call<string>('userDataHome')),
			localUserHome: URI.parse(await mainProcessService.getChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME).call<string>('userHome')),
			workspace: createWorkspaceContextApi(),
		};
	} catch (error) { resources.dispose(); throw error; }
}
