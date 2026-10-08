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
import { DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
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
import { createRemoteTunnelApi } from "../../remote/electron-browser/remoteTunnelApi.js";
import type { IWorkspaceTrustRequestService } from '../../workspace/common/workspaceTrust.js';
import { ILocalTranscriptionService } from '../../localTranscription/common/localTranscription.js';
import { InstantiationService } from '../../instantiation/common/instantiationService.js';

export type ElectronRendererCapabilityContribution = RendererCapabilityContribution;

/** Composes Electron renderer capabilities from domain-owned IPC adapters. */
export async function createElectronRendererApi(contributions: readonly ElectronRendererCapabilityContribution[], hostCapabilities: { readonly browser: boolean; readonly textDocuments?: boolean; readonly appTools?: boolean; }, workspaceTrust: IWorkspaceTrustRequestService, mainProcessService: IMainProcessService): Promise<AshElectronRendererApi & IDisposable> {
	performance.mark('ash.rendererApi.start');
	const resources = new DisposableStore();
	let connecting: Promise<void> = Promise.resolve();
	const transport = resources.add(new AppServerMessagePortTransport(() => {
		connecting = reconnect();
		void connecting.catch(error => console.error('App Server reconnect failed', error));
	}));
	// Initialization includes the local daemon's cold start, which can take 15 seconds.
	const client = new AppServerProtocolClient(transport, { clientName: 'ash-desktop', initializeTimeoutMs: 30_000, capabilities: { ...(hostCapabilities.browser ? { browser: { version: 3, observe: true, input: true } } : {}), ...(hostCapabilities.textDocuments ? { textDocuments: { version: 2 } } : {}), ...(hostCapabilities.appTools ? { appTools: { version: 1, agents: true, desktop: true } } : {}), dirPermissionsHost: { version: 1 } } });
	resources.add(toDisposable(() => client.dispose()));
	if (hostCapabilities.browser) { resources.add(registerAppServerBrowserHost(client)); }
	resources.add(registerAppServerWorkspaceHost(client, () => connecting, workspaceTrust));
	const initialize = async (): Promise<void> => {
		try { await client.connect(); }
		catch (error) {
			if (!(error instanceof AppServerProtocolIncompatibleError) || await invoke('ash:app-server:recover-runtime', error.incompatibility) !== true) { throw error; }
			await transport.acquire();
			await client.connect();
		}
		await transport.initialized();
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
			await transport.acquire();
			await initialize();
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
	resources.add(client.onStateChange(state => { if (state === 'crashed') { scheduleRecovery(); } }));
	try {
		performance.mark('ash.rendererApi.acquire-start');
		const enabled = await transport.acquire();
		performance.mark('ash.rendererApi.acquired');
		let backend: IRendererHost;
		if (enabled) {
			await initialize();
			performance.mark('ash.rendererApi.initialized');
			backend = createRendererHost(client, {
				externalOpener: { openExternal: target => invoke<boolean>('ash:host:openExternal', target) },
				callbackHost: {
					listen: () => invoke('ash:oauth-callback:listen'),
					wait: id => invoke('ash:oauth-callback:wait', { id }),
					close: id => invoke('ash:oauth-callback:close', { id }),
				},
				clipboardService: new ElectronRendererClipboardService(),
			}, contributions);
			backend = { ...backend, backup: new AppServerBackupService(client, 'ash-editor') };
			if (client.capabilities?.memories) { backend = { ...backend, memories: resources.add(new AppServerMemoriesService(client)) }; }
			if (client.capabilities?.contracts.memoryDiagnostics?.version === 1) { backend = { ...backend, memoryDiagnostics: resources.add(new AppServerMemoryDiagnosticsService(client, 'electron', () => invoke<MemoryObservation[]>('ash:memory:collect'))) }; }
			if (client.capabilities?.contracts.calls?.version === 1) { backend = { ...backend, calls: resources.add(new AppServerCallService(client)) }; }
			const remoteConnection = await createRemoteAgentApi().getConnection();
			if (remoteConnection.kind !== 'ssh') {
				const services = resources.add(new InstantiationService());
				if (!backend.localTranscription) { throw new Error('Local transcription service was not contributed by the renderer entry'); }
				services.registerInstance(ILocalTranscriptionService, backend.localTranscription);
				backend = { ...backend, dictation: resources.add(services.createInstance(AppServerDictationService, client, createConfigurationApi(mainProcessService))) };
			} else {
				backend = { ...backend, localTranscription: undefined };
			}
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
			remoteTunnels: createRemoteTunnelApi(),
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
			workspace: createWorkspaceContextApi(),
		};
	} catch (error) { resources.dispose(); throw error; }
}
