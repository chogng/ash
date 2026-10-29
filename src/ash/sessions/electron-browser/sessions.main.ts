import { ElectronAuxiliaryWindowService } from '../../workbench/services/auxiliaryWindow/electron-browser/auxiliaryWindowService.js';
import { ILoggerService } from '../../platform/log/common/log.js';
import '../../workbench/contrib/url/browser/url.contribution.js';
import { IPolicyService } from '../../platform/policy/common/policy.js';
import { PolicyChannelClient } from '../../platform/policy/common/policyIpc.js';
import { AppToolsHost } from '../contrib/appTools/browser/appToolsHost.js';
import { AppServerAppToolsHost } from '../services/appTools/browser/appServerAppToolsHost.js';
import { IUpdateService } from '../../platform/update/common/updateService.js';
import { FileUserDataProvider } from '../../platform/userData/common/fileUserDataProvider.js';
import { AppServerProtocolClient } from '../../platform/agentHost/browser/appServerProtocolClient.js';
import { AppServerTextDocumentHost } from '../../workbench/services/textfile/browser/appServerTextDocumentHost.js';
import { IChatEditingService } from '../../workbench/contrib/chat/common/editing/chatEditingService.js';
import { FileDialogService } from '../../workbench/services/dialogs/electron-browser/fileDialogService.js';
import { OpenAgentsWindowSystemWideKeybindingContribution } from '../contrib/openAgentsWindow/electron-browser/openAgentsWindow.contribution.js';
import { installBaseUiStyles } from "../../base/browser/ui/styles.js";
import { URI } from "../../base/common/uri.js";
import { IFileService } from "../../platform/files/common/files.js";
import { FileService } from '../../platform/files/common/fileService.js';
import { InstantiationService } from "../../platform/instantiation/common/instantiationService.js";
import { addDisposableListener } from "../../base/browser/dom.js";
import { DisposableStore, toDisposable, type IDisposable } from "../../base/common/lifecycle.js";
import { onUnexpectedError } from "../../base/common/errors.js";
import { createElectronRendererApi } from "../../workbench/electron-browser/rendererApi.js";
import { registerLocalTranscriptionService } from '../../workbench/services/localTranscription/electron-browser/localTranscriptionService.js';
import { DirectoryPermissionDialog } from '../../workbench/electron-browser/parts/dialogs/directoryPermissionDialog.js';
import { ElectronContextMenuService } from "../../workbench/services/contextmenu/electron-browser/contextMenuService.js";
import type { SessionsProfile } from "../common/sessionsProfile.js";
import type { Workbench } from '../browser/workbench.js';
import { createSessionsWorkbench } from '../browser/workbenchFactory.js';
import { isMacintosh } from '../../base/common/platform.js';
import { NativeMenubarControl } from '../../workbench/electron-browser/parts/titlebar/menubarControl.js';
import { Menus } from '../browser/menus.js';
import { TitlebarPart } from '../browser/parts/titlebarPart.js';
import { bindWindowControlTheme } from '../../workbench/electron-browser/parts/titlebar/titlebarPart.js';
import { RETURN_TO_WORKBENCH_CHANNEL } from '../common/windowNavigation.js';
import { AGENTS_WINDOW_HANDOFF_AVAILABLE_CHANNEL, AGENTS_WINDOW_HANDOFF_COMPLETE_CHANNEL, AGENTS_WINDOW_HANDOFF_TAKE_CHANNEL } from '../../platform/window/common/window.js';
import type { IOpenAgentsWindowOptions } from '../../platform/native/common/nativeHost.js';
import { ElectronLifecycleService } from '../../workbench/services/lifecycle/electron-browser/lifecycleService.js';
import { NativeHostColorSchemeService } from '../../workbench/services/themes/electron-browser/nativeHostColorSchemeService.js';
import { showStartupError } from "../../workbench/browser/startupError.js";
import { invoke, subscribe } from '../../platform/ipc/electron-browser/rendererIpc.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { IBrowserPasswordService } from '../../platform/browserView/common/browserPasswordService.js';
import { IBrowserViewService, ipcBrowserViewChannelName } from '../../platform/browserView/common/browserView.js';
import { IMainProcessService } from '../../platform/ipc/common/mainProcessService.js';
import { ISecretStorageService } from '../../platform/secrets/common/secrets.js';
import { SecretStorageService } from '../../workbench/services/secrets/electron-browser/secretStorageService.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { ElectronIPCMainProcessService } from '../../platform/ipc/electron-browser/mainProcessService.js';
import { WINDOW_FULLSCREEN_CHANGED_CHANNEL, WINDOW_OPERATION_CHANNEL, WINDOW_ZOOM_CHANGED_CHANNEL } from '../../platform/window/common/window.js';
import { createWorkspaceContextApi } from '../../platform/workspace/electron-browser/workspaceContextApi.js';
import { parseWorkspace } from '../../platform/workspace/common/workspace.js';
import { selectionFromWorkspace } from '../browser/workspaceSelection.js';
import { NativeWorkbenchStorageService } from '../../workbench/services/storage/electron-browser/storageService.js';
import { NativeLogService } from '../../workbench/services/log/electron-browser/logService.js';
import { IPlaywrightService } from '../../platform/browserView/common/playwrightService.js';
import { registerAppServerBrowserHost } from '../../platform/agentHost/electron-browser/appServerBrowserHost.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { getSingletonServiceDescriptors } from '../../platform/instantiation/common/extensions.js';

/** Starts the Code-specific Electron Sessions page. */
export async function main(profile: SessionsProfile): Promise<IDisposable> {
	installBaseUiStyles();
	const container = document.querySelector<HTMLElement>("#app");
	if (!container) throw new Error("Sessions renderer requires an #app container");
	const sessions = new DisposableStore();
	let workbench: Workbench | undefined;
	let drainRequested = false;
	let draining = false;
	const drainHandoffs = async (): Promise<void> => {
		if (draining || !workbench) return;
		draining = true;
		try {
			while (drainRequested) {
				drainRequested = false;
				let handoff: { readonly id: string; readonly options: IOpenAgentsWindowOptions; } | undefined;
				while ((handoff = await invoke<typeof handoff>(AGENTS_WINDOW_HANDOFF_TAKE_CHANNEL))) {
					try {
						await workbench.acceptHandoff(handoff.options);
						await invoke<void>(AGENTS_WINDOW_HANDOFF_COMPLETE_CHANNEL, { id: handoff.id });
					} catch (error) {
						await invoke<void>(AGENTS_WINDOW_HANDOFF_COMPLETE_CHANNEL, { id: handoff.id, error: String(error) });
					}
				}
			}
		} finally {
			draining = false;
			if (drainRequested) void drainHandoffs().catch(onUnexpectedError);
		}
	};
	const requestDrain = (): void => {
		drainRequested = true;
		void drainHandoffs().catch(onUnexpectedError);
	};
	const handoffSubscription = subscribe<void>(AGENTS_WINDOW_HANDOFF_AVAILABLE_CHANNEL, requestDrain);
	sessions.add(toDisposable(() => handoffSubscription.dispose()));
	const permissionDialog = sessions.add(new DirectoryPermissionDialog(container));
	const transcriptionServices = sessions.add(new InstantiationService());
	const profileServices = sessions.add(new InstantiationService(new ServiceCollection(
		...getSingletonServiceDescriptors().filter(([id]) => id === IPlaywrightService),
	)));
	const serviceCollection = new ServiceCollection([IWorkbenchEnvironmentService, new ElectronWorkbenchEnvironmentService()]);
	let logger: NativeLogService;
	let api: Awaited<ReturnType<typeof createElectronRendererApi>>;
	let documentClient: AppServerProtocolClient | undefined;
	try {
		const windowId = await invoke<unknown>('ash:ipc:window-id');
		if (!Number.isSafeInteger(windowId) || (windowId as number) <= 0) { throw new TypeError('Invalid Main IPC window ID'); }
		// Release automation dependencies before their Main IPC connection during window shutdown.
		profileServices.registerSingleton(IMainProcessService, () => profileServices.createInstance(ElectronIPCMainProcessService, windowId as number));
		const mainProcessService = profileServices.get(IMainProcessService);
		const environment = new ElectronWorkbenchEnvironmentService(await mainProcessService.getChannel('logger').call('getDefaultLogLevels'));
		profileServices.registerInstance(IWorkbenchEnvironmentService, environment);
		const playwrightService = profileServices.get(IPlaywrightService);
		serviceCollection.set(IMainProcessService, mainProcessService);
		serviceCollection.set(ISecretStorageService, sessions.add(profileServices.createInstance(SecretStorageService)));
		serviceCollection.set(IWorkbenchEnvironmentService, environment);
		serviceCollection.set(IPolicyService, sessions.add(new PolicyChannelClient(mainProcessService.getChannel('policy'))));
		serviceCollection.set(IPlaywrightService, playwrightService);
		serviceCollection.set(IBrowserPasswordService, ProxyChannel.toService<IBrowserPasswordService>(mainProcessService.getChannel('browserPasswords')));
		serviceCollection.set(IBrowserViewService, ProxyChannel.toService<IBrowserViewService>(mainProcessService.getChannel(ipcBrowserViewChannelName)));
		logger = sessions.add(profileServices.createInstance(NativeLogService, 'agents'));
		serviceCollection.set(ILoggerService, logger);
		api = await createElectronRendererApi([client => { documentClient = client; return {}; }, (_client, _appServer, localClient) => registerLocalTranscriptionService(transcriptionServices, localClient)], { browser: true, textDocuments: true, appTools: true, agentHosts: true }, permissionDialog, mainProcessService);
	}
	catch (error) { sessions.dispose(); return showStartupError(error, text => invoke<void>('ash:host:writeClipboard', text)); }
	try {
		sessions.add(api);
		const profileFiles = sessions.add(profileServices.createInstance(FileService));
		sessions.add(profileFiles.registerProvider(api.userDataHome.scheme, api.localFiles));
		profileServices.registerInstance(IFileService, profileFiles);
		const { loadUserThemes } = await import('../../workbench/services/themes/browser/workbenchThemeService.js');
		sessions.add(await loadUserThemes(profileServices, URI.parse(api.userDataHome.toString().replace(/\/$/u, '') + '/themes')));
		const setFullscreen = (fullscreen: boolean): void => { container.classList.toggle('ash-sessions-fullscreen', fullscreen); };
		setFullscreen(await invoke<boolean>(WINDOW_OPERATION_CHANNEL, { kind: 'getFullscreen' }));
		sessions.add(toDisposable(() => container.classList.remove('ash-sessions-fullscreen')));
		const fullscreenSubscription = subscribe<boolean>(WINDOW_FULLSCREEN_CHANGED_CHANNEL, setFullscreen);
		sessions.add(toDisposable(() => fullscreenSubscription.dispose()));
		const updateZoomFactor = async (): Promise<void> => {
			const factor = await invoke<number>(WINDOW_OPERATION_CHANNEL, { kind: 'getZoomFactor' });
			container.style.setProperty('--ash-sessions-inverse-zoom-factor', (1 / factor).toString());
		};
		await updateZoomFactor();
		sessions.add(toDisposable(() => container.style.removeProperty('--ash-sessions-inverse-zoom-factor')));
		const zoomSubscription = subscribe<number>(WINDOW_ZOOM_CHANGED_CHANNEL, () => { void updateZoomFactor().catch(onUnexpectedError); });
		sessions.add(toDisposable(() => zoomSubscription.dispose()));
		let lifecycleService!: ElectronLifecycleService;
		const workspaceContext = createWorkspaceContextApi();
		let workspace = parseWorkspace(await workspaceContext.getWorkspace());
		let workspaceSelection = selectionFromWorkspace(workspace);
		const workspaceSubscription = workspaceContext.onDidChange(value => {
			workspace = parseWorkspace(value);
			workspaceSelection = selectionFromWorkspace(workspace);
		});
		sessions.add(toDisposable(() => workspaceSubscription.dispose()));
		const hostColorScheme = await api.nativeHost.getOSColorScheme();
		workbench = sessions.add(await createSessionsWorkbench({
			serviceCollection,
			createAppToolsHost: documentClient ? services => new AppServerAppToolsHost(documentClient!, services.createInstance(AppToolsHost, container.ownerDocument, services.get(IUpdateService))) : undefined,
			createBrowserHost: documentClient ? services => registerAppServerBrowserHost(documentClient!, services.get(IPlaywrightService), services.get(IMainProcessService), services.get(IConfigurationService)) : undefined,
			createTextDocumentHost: documentClient ? services => {
				const editing = services.get(IChatEditingService);
				return services.createInstance(AppServerTextDocumentHost, documentClient!, { applyEdits: editing.applyEdits.bind(editing), finishTurn: editing.finishTurn.bind(editing) });
			} : undefined,
			contributionIds: [
				'workbench.contrib.limitIndicator',
				'status.languageStatus',
				'workbench.contrib.opener',
				'chatResponseResourceWorkbenchContribution',
				'terminalAutoReplies',
				'terminalTelemetry',
				'workbench.contrib.settingsChangeRelauncher',
				'workbench.contrib.partsSplash',
				'workbench.contrib.preferences',
				'workbench.contrib.extensionRecommendations',
				'workbench.contrib.snippets',
				'workbench.contrib.defaultFormatter',
				'workbench.contrib.sessionsLayout',
				'terminal.native',
				'workbench.contrib.call',
				'sessions.contrib.multiDiffSource',
				'sessions.contrib.automationsCustomView',
				'workbench.contrib.nativeWindow',
				OpenAgentsWindowSystemWideKeybindingContribution.ID,
				'workbench.contrib.chatScreenshot',
				'workbench.contrib.agentsWindowInvitation',
				'chat.edits.editorOverlay',
				'chat.promptLanguageFeatures',
				'workbench.contrib.chatEnablement',
				'workbench.contrib.dataChannels',
				'workbench.contrib.output',
				'workbench.contrib.logs',
				'workbench.contrib.appServerRecovery',
				'workbench.contrib.workspacePermissionStatus',
				'workbench.contrib.githubLinkPresentations',
				'workbench.contrib.url',
				'workbench.contrib.externalUriOpener',
				'workbench.contrib.browserView',
				'workbench.contrib.browserView.windowZoomSynchronizer',
				'workbench.contrib.browserView.autoReload',
				'workbench.contrib.sessionBrowserViewController',
				'sessions.chatgpt.web',
				'workbench.contrib.browserView.restore',
				'workbench.contrib.chatAccessibilitySignals',
				'workbench.contrib.speechAccessibilitySignal',
				'workbench.contrib.saveAccessibilitySignals',
			],
			createLogService: () => {
				// The factory owns failure cleanup and transfers the logger to the Workbench.
				sessions.delete(logger);
				return logger;
			},
			createStorageService: async options => {
				const storage = profileServices.createInstance(NativeWorkbenchStorageService, options);
				try { await storage.initialize(); return storage; }
				catch (error) { storage.dispose(); throw error; }
			},
			profile,
			api,
			workspaceSelection: () => workspaceSelection,
			workspace: () => workspace,
			createFileDialogService: services => services.createInstance(FileDialogService),
			createLifecycleService: services => {
				lifecycleService = services.createInstance(ElectronLifecycleService, { ownerWindow: window, onError: onUnexpectedError });
				sessions.add(lifecycleService.onWillShutdown(event => event.join(logger.flush().catch(error => console.error('Could not flush Agents logs during shutdown', error)), 'Agents logs flush')));
				return lifecycleService;
			},
			nativeHostApi: api.nativeHost,
			createAuxiliaryWindowService: (opener, root, services) => services.createInstance(ElectronAuxiliaryWindowService, opener, root),
			keyboardLayoutProvider: api.keyboardLayout,
			userKeyboardLayoutApi: api.userKeyboardLayout,
			returnToWorkbench: () => { void invoke<void>(RETURN_TO_WORKBENCH_CHANNEL).catch(onUnexpectedError); },
			createUserDataFileSystemProvider: async () => new FileUserDataProvider(api.localFiles, api.userDataHome),
			createContextMenuService: services => services.createInstance(ElectronContextMenuService, api.nativeContextMenu),
			createHostColorSchemeService: services => {
				const colors = services.createInstance(NativeHostColorSchemeService, hostColorScheme);
				void colors.initialize().catch(onUnexpectedError);
				return colors;
			},
			createTitlebarPart: (titlebarContainer, services) => {
				if (isMacintosh) {
					// Publish this window's menu so switching focus never dispatches Workbench-only actions here.
					sessions.add(services.createInstance(NativeMenubarControl, Menus.MenubarMainMenu));
				}
				return services.createInstance(TitlebarPart, titlebarContainer, isMacintosh ? 'actions-only' : 'application-menu');
			},
			container,
		}));
		requestDrain();
		sessions.add(bindWindowControlTheme(workbench.themeService, api.nativeHost));
		const activeWorkbench = workbench;
		sessions.add(addDisposableListener(window, "pagehide", () => {
			void activeWorkbench.shutdown("pageHide").catch(error => console.error("Failed to shut down Sessions Workbench", error)).finally(() => sessions.dispose());
		}, { once: true }));
		await lifecycleService.initialize();
		await workbench.whenRestored;
		return sessions;
	} catch (error) {
		sessions.dispose();
		throw error;
	}
}
import { IWorkbenchEnvironmentService } from '../../workbench/services/environment/common/environmentService.js';
import { ElectronWorkbenchEnvironmentService } from '../../workbench/services/environment/electron-browser/environmentService.js';
