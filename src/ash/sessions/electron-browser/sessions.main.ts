import { isCancellationError } from '../../base/common/errors.js';
import type { IWorkspaceTrustApi, DirectoryPermissionRequest } from '../../platform/workspace/common/workspaceTrust.js';
import { createSessionFolderTrustRequestService } from '../contrib/workspace/browser/workspace.contribution.js';
import { removePartsSplash } from '../../workbench/contrib/splash/browser/splash.js';
import { structuralEquals } from '../../base/common/equals.js';
import { registerBrowserNetworkHost } from '../../platform/browserView/electron-browser/browserNetworkHost.js';
import { IAgentHostConnectionsService } from '../../platform/agentHost/common/agentHostConnectionsService.js';
import { IWorkspaceContextService } from '../../platform/workspace/common/workspace.js';
import { IBrowserViewWorkbenchService } from '../../workbench/contrib/browserView/common/browserView.js';
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
import { OpenAgentsWindowSystemWideKeybindingTip } from '../contrib/openAgentsWindow/electron-browser/openAgentsWindowKeybindingTip.js';
import { installBaseUiStyles } from '../../base/browser/ui/styles.js';
import { URI } from '../../base/common/uri.js';
import { IFileService } from '../../platform/files/common/files.js';
import { FileService } from '../../platform/files/common/fileService.js';
import { InstantiationService } from '../../platform/instantiation/common/instantiationService.js';
import { addDisposableListener } from '../../base/browser/dom.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import { onUnexpectedError } from '../../base/common/errors.js';
import { createElectronRendererApi } from '../../workbench/electron-browser/rendererApi.js';
import { registerLocalTranscriptionService } from '../../workbench/services/localTranscription/electron-browser/localTranscriptionService.js';
import { throwIfCancelled, type CancellationToken } from '../../base/common/cancellation.js';
import { createAppServerWorkspaceTrustApi } from '../../platform/workspace/browser/workspaceTrustApi.js';
import { DEVELOPMENT_DIR_PERMISSIONS, hasDevelopmentPermissions } from '../../platform/workspace/common/workspaceTrust.js';
import { ISessionFolderAuthorizationService } from '../common/sessionWorkspace.js';
import { WorkspaceTrustPrompt } from '../../workbench/contrib/workspace/browser/workspace.contribution.js';
import { BrowserContextMenuService } from '../../platform/contextview/browser/contextMenuService.js';
import type { SessionsProfile } from '../common/sessionsProfile.js';
import type { Workbench } from '../browser/workbench.js';
import { createSessionsWorkbench } from '../browser/workbenchFactory.js';
import { getSessionsTitlebarBackground } from '../browser/parts/titlebarPart.js';
import { registerTitleService } from '../services/title/electron-browser/titleService.js';
import { bindWindowControlTheme } from '../../workbench/electron-browser/parts/titlebar/titlebarPart.js';
import { AGENTS_WINDOW_DISCARD_STARTUP_WORKSPACE_CHANNEL, AGENTS_WINDOW_READY_CHANNEL, AGENTS_WINDOW_STARTUP_INTENT_CHANNEL, AGENTS_WINDOW_WORKSPACE_CHANNEL, RETURN_TO_WORKBENCH_CHANNEL } from '../common/windowNavigation.js';
import { AGENTS_WINDOW_HANDOFF_AVAILABLE_CHANNEL, AGENTS_WINDOW_HANDOFF_COMPLETE_CHANNEL, AGENTS_WINDOW_HANDOFF_TAKE_CHANNEL } from '../../platform/window/common/window.js';
import type { IOpenAgentsWindowOptions } from '../../platform/native/common/nativeHost.js';
import { ElectronLifecycleService } from '../../workbench/services/lifecycle/electron-browser/lifecycleService.js';
import { StartupKind } from '../../workbench/services/lifecycle/common/lifecycle.js';
import { NativeHostColorSchemeService } from '../../workbench/services/themes/electron-browser/nativeHostColorSchemeService.js';
import { invoke, subscribe } from '../../platform/ipc/electron-browser/rendererIpc.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { IBrowserPasswordService } from '../../platform/browserView/common/browserPasswordService.js';
import { IBrowserViewService, ipcBrowserViewChannelName } from '../../platform/browserView/common/browserView.js';
import { IMainProcessService } from '../../platform/ipc/common/mainProcessService.js';
import { ISecretStorageService } from '../../platform/secrets/common/secrets.js';
import { SecretStorageService } from '../../workbench/services/secrets/electron-browser/secretStorageService.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { desktopStorageChannelName, IProfileStorageService } from '../../platform/storage/common/profileStorageService.js';
import { DesktopProfileStorageService } from '../../platform/storage/electron-browser/desktopProfileStorageService.js';
import { ElectronIPCMainProcessService } from '../../platform/ipc/electron-browser/mainProcessService.js';
import { WINDOW_FULLSCREEN_CHANGED_CHANNEL, WINDOW_OPERATION_CHANNEL, WINDOW_ZOOM_CHANGED_CHANNEL } from '../../platform/window/common/window.js';
import { createWorkspaceContextApi } from '../../platform/workspace/electron-browser/workspaceContextApi.js';
import { getWorkspaceRemoteAuthority, parseWorkspace } from '../../platform/workspace/common/workspace.js';
import { getRemoteWorkspacePath } from '../../platform/remote/common/remote.js';
import { selectionFromWorkspace } from '../common/agentHostSessionWorkspace.js';
import { NativeWorkbenchStorageService } from '../../workbench/services/storage/electron-browser/storageService.js';
import { NativeLogService } from '../../workbench/services/log/electron-browser/logService.js';
import { IPlaywrightService } from '../../platform/browserView/common/playwrightService.js';
import { registerAppServerBrowserHost } from '../../platform/agentHost/electron-browser/appServerBrowserHost.js';
import { IAgentHostCanvasCollection } from '../../workbench/contrib/canvases/common/agentHostCanvas.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { getSingletonServiceDescriptors } from '../../platform/instantiation/common/extensions.js';
import '../contrib/sessions/electron-browser/sessions.contribution.js';
import { SessionsApplicationBadge } from '../contrib/sessions/electron-browser/sessionsApplicationBadge.js';
import { SessionsWindowNotifier } from '../contrib/sessions/browser/sessionsWindowNotifier.js';

/** Starts the Code-specific Electron Sessions page. */
export async function main(profile: SessionsProfile): Promise<IDisposable> {
	installBaseUiStyles();
	const container = document.querySelector<HTMLElement>('#app');
	if (!container) throw new Error('Sessions renderer requires an #app container');
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
	const permissionDialog = sessions.add(new WorkspaceTrustPrompt(container));
	const workspaceTrust = createSessionFolderTrustRequestService(container, (load, handler, signal) =>
		permissionDialog.show(async () => {
			const prompt = await load();
			removePartsSplash(container.ownerDocument);
			return prompt;
		}, handler, signal));
	const transcriptionServices = sessions.add(new InstantiationService());
	const profileServices = sessions.add(new InstantiationService(new ServiceCollection(
		...getSingletonServiceDescriptors().filter(([id]) => id === IPlaywrightService),
	)));
	const serviceCollection = new ServiceCollection([IWorkbenchEnvironmentService, new ElectronWorkbenchEnvironmentService()]);
	let logger: NativeLogService;
	let api: Awaited<ReturnType<typeof createElectronRendererApi>>;
	let documentClient: AppServerProtocolClient | undefined;
	let restoreEntry: boolean;
	let promptForWorkspaceTrust: boolean;
	try {
		const windowId = await invoke<unknown>('ash:ipc:window-id');
		if (!Number.isSafeInteger(windowId) || (windowId as number) <= 0) { throw new TypeError('Invalid Main IPC window ID'); }
		const startupIntent = await invoke<{ restoreEntry?: unknown; promptForWorkspaceTrust?: unknown; } | undefined>(AGENTS_WINDOW_STARTUP_INTENT_CHANNEL);
		if (typeof startupIntent?.restoreEntry !== 'boolean' || typeof startupIntent.promptForWorkspaceTrust !== 'boolean') {
			throw new TypeError('Invalid Agents startup intent');
		}
		({ restoreEntry, promptForWorkspaceTrust } = startupIntent);
		// Release automation dependencies before their Main IPC connection during window shutdown.
		profileServices.registerSingleton(IMainProcessService, () => profileServices.createInstance(ElectronIPCMainProcessService, windowId as number));
		const mainProcessService = profileServices.get(IMainProcessService);
		const environment = new ElectronWorkbenchEnvironmentService(await mainProcessService.getChannel('logger').call('getDefaultLogLevels'), false, sandboxProcess.isBuilt);
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
		serviceCollection.set(IProfileStorageService, {
			_serviceBrand: undefined,
			readOverview: async () => { throw new Error('Local App Server is unavailable'); },
			cleanWorktree: async () => { throw new Error('Local App Server is unavailable'); },
		});
		api = await createElectronRendererApi([client => { documentClient = client; return {}; }, (_client, _appServer, localClient) => {
			serviceCollection.set(IProfileStorageService, new DesktopProfileStorageService(localClient, mainProcessService.getChannel(desktopStorageChannelName)));
			const localTrust = createAppServerWorkspaceTrustApi(localClient);
			serviceCollection.set(ISessionFolderAuthorizationService, {
				isTrusted: async path => {
					const directory = await localTrust.readDirectory(path);
					return hasDevelopmentPermissions(directory.permissions ?? directory.inheritedWorkspacePermissions);
				},
				authorize: (path, signal, host, onTrustDeclined) => authorizeSessionFolder(
					host?.api.workspaceTrust ?? localTrust,
					listener => {
						if (!host) return localClient.onStateChange(listener);
						const subscription = host.api.appServer.onConnectionState(listener);
						return toDisposable(() => subscription.dispose());
					},
					workspaceTrust.confirmFolderTrust, { path, remoteHostLabel: host?.label }, signal, { onTrustDeclined }),
			});
			return registerLocalTranscriptionService(transcriptionServices, localClient);
		}], { browser: true, textDocuments: true, appTools: true, agentHosts: true }, workspaceTrust, mainProcessService);
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
		const initialWorkspace = parseWorkspace(await workspaceContext.getWorkspace());
		const workspaceAuthority = getWorkspaceRemoteAuthority(initialWorkspace);
		mainProcessService.registerChannel(AGENTS_WINDOW_WORKSPACE_CHANNEL, {
			listen: () => { throw new Error('Agents workspace authorization has no events'); },
			call: async <T>(_context: string, command: string, value: unknown, token?: CancellationToken): Promise<T> => {
				if (command !== 'authorize') throw new TypeError('Invalid Agents workspace operation');
				const target = parseWorkspace(value);
				// The renderer's workspace connection is selected when it starts.
				if (getWorkspaceRemoteAuthority(target) !== workspaceAuthority) return false as T;
				const controller = new AbortController();
				using cancellation = token?.onCancellationRequested(() => controller.abort());
				if (token) throwIfCancelled(token);
				for (const { uri } of target.folders) {
					const accepted = await authorizeSessionFolder(
						api.workspaceTrust,
						listener => {
							const subscription = api.appServer.onConnectionState(listener);
							return toDisposable(() => subscription.dispose());
						},
						workspaceTrust.confirmFolderTrust,
						workspaceAuthority ? { path: getRemoteWorkspacePath(uri), remoteHostLabel: workspaceAuthority } : { path: uri.fsPath },
						controller.signal,
						{ explicitGrant: true },
					);
					if (!accepted) return false as T;
				}
				return true as T;
			},
		});
		let workspace: typeof initialWorkspace = { id: initialWorkspace.id, folders: [] };
		let workspaceSelection = selectionFromWorkspace(workspace);
		let workspaceGeneration = 0;
		const initialWorkspaceReady = api.workspaceDirectoriesReady.then(async () => {
			const state = await api.appServer.getConnectionState();
			if (sessions.isDisposed || workspaceGeneration !== 0 || state !== 'ready') return;
			const boundFolders = await Promise.all(initialWorkspace.folders.map(async folder =>
				hasDevelopmentPermissions(await api.workspaceTrust.readWorkspaceDirectory(folder.id))));
			if (!sessions.isDisposed && workspaceGeneration === 0 && boundFolders.every(Boolean)) {
				workspace = initialWorkspace;
				workspaceSelection = selectionFromWorkspace(workspace);
			}
		});
		// Workbench construction will take ownership of startup errors.
		void initialWorkspaceReady.catch(() => undefined);
		let workspaceChange = initialWorkspaceReady.catch(() => undefined);
		const workspaceSubscription = workspaceContext.onDidChange(value => {
			const next = parseWorkspace(value);
			const generation = ++workspaceGeneration;
			workspaceChange = workspaceChange.then(async () => {
				if (sessions.isDisposed || generation !== workspaceGeneration) return;
				await api.reloadWorkspaceDirectories();
				const state = await api.appServer.getConnectionState();
				if (sessions.isDisposed || generation !== workspaceGeneration || state !== 'ready') return;
				workspace = next;
				workspaceSelection = selectionFromWorkspace(workspace);
			}).catch(error => { if (!isCancellationError(error)) onUnexpectedError(error); });
		});
		sessions.add(toDisposable(() => workspaceSubscription.dispose()));
		const hostColorScheme = await api.nativeHost.getOSColorScheme();
		workbench = sessions.add(
			await createSessionsWorkbench({
				serviceCollection,
				createAppToolsHost: documentClient
					? services =>
						new AppServerAppToolsHost(
							documentClient!,
							services.createInstance(
								AppToolsHost,
								container.ownerDocument,
								services.get(IUpdateService),
							),
						)
					: undefined,
				createBrowserHost: documentClient
					? services => {
						const browsers = services.get(IBrowserViewWorkbenchService);
						const networkHost = registerBrowserNetworkHost(services.get(IMainProcessService), services.get(IAgentHostConnectionsService), services.get(IWorkspaceContextService), api.localTcp);
						const browserHost = registerAppServerBrowserHost(
							documentClient!,
							services.get(IPlaywrightService),
							services.get(IMainProcessService),
							services.get(IConfigurationService),
							services.get(IAgentHostCanvasCollection),
							owner => browsers.resolveNetwork(owner),
						);
						return toDisposable(() => { browserHost.dispose(); networkHost.dispose(); });
					}
					: undefined,
				createTextDocumentHost: documentClient
					? services => {
						const editing = services.get(IChatEditingService);
						return services.createInstance(AppServerTextDocumentHost, documentClient!, {
							applyEdits: editing.applyEdits.bind(editing),
							finishTurn: editing.finishTurn.bind(editing),
						});
					}
					: undefined,
				contributionIds: [
					'sessions.chat.copyActionRendering',
					'chat.queuePickerRendering',
					'workbench.contrib.btwSlashCommand',
					'workbench.contrib.chatSideChat',
					'workbench.contrib.policyTelemetry',
					'workbench.contrib.limitIndicator',
					'status.languageStatus',
					'workbench.contrib.mediaPreviewStatusBar',
					'workbench.contrib.opener',
					'chatResponseResourceWorkbenchContribution',
					'workbench.contrib.chatSpeechInstructions',
					'terminalAutoReplies',
					'terminalTelemetry',
					'workbench.contrib.settingsChangeRelauncher',
					'sessions.contrib.splash',
					'workbench.contrib.preferences',
					'workbench.contrib.extensionRecommendations',
					'workbench.contrib.snippets',
					'workbench.contrib.defaultFormatter',
					'workbench.contrib.sessionsLayout',
					'sessions.contrib.filesView',
					'terminal.native',
					'workbench.contrib.call',
					'workbench.contrib.memories',
					'sessions.contrib.multiDiffSource',
					'sessions.openSessionLinkOpener',
					'sessions.contrib.sharedChatInputComposer',
					'sessions.contrib.remoteAgentHostContribution',
					'sessions.contrib.sshAgentHostContribution',
					'sessions.contrib.wslAgentHostContribution',
					'sessions.contrib.tunnelAgentHostContribution',
					'sessions.contrib.automationsCustomView',
					'sessions.contrib.titleBarWidget',
					'sessions.contrib.inboxOne',
					'sessions.contrib.projectTitleBar',
					'workbench.contrib.sessionsMouseNavigation',
					'sessions.automationSessionsListing',
					SessionsApplicationBadge.ID,
					SessionsWindowNotifier.ID,
					'workbench.contrib.nativeWindow',
					OpenAgentsWindowSystemWideKeybindingTip.ID,
					'workbench.contrib.chatScreenshot',
					'workbench.contrib.agentsWindowInvitation',
					'chat.edits.editorOverlay',
					'chat.promptLanguageFeatures',
					'chat.newPromptFileActions',
					'chat.agentActions',
					'chat.runPromptActions',
					'chat.skillActions',
					'chat.promptActions',
					'workbench.contrib.chatSetup',
					'workbench.contrib.chatContextContribution',
					'workbench.contrib.chatReferenceAttachmentWidgetFactory',
					'chat.sessionReferenceContext',
					'workbench.contrib.dataChannels',
					'workbench.contrib.output',
					'workbench.contrib.logs',
					'workbench.contrib.workspaceTrustRequestHandler',
					'workbench.contrib.workspaceFolderManagement',
					'sessions.contrib.workspaceStatus',
					'workbench.contrib.githubLinkPresentations',
					'workbench.contrib.githubFileSystemProvider',
					'workbench.contrib.url',
					'workbench.contrib.externalUriOpener',
					'workbench.contrib.browserView',
					'workbench.contrib.canvases',
					'sessions.contrib.canvases',
					'sessions.contrib.remoteCanvases',
					'workbench.contrib.browserView.windowZoomSynchronizer',
					'workbench.contrib.browserView.autoReload',
					'workbench.contrib.sessionBrowserViewController',
					'workbench.contrib.sessionBrowserNetwork',
					'sessions.chatgpt.web',
					'sessions.chatgpt.experimental',
					'sessions.chatWorkspace',
					'workbench.contrib.browserView.restore',
					'workbench.contrib.chatAccessibilitySignals',
					'workbench.contrib.speechAccessibilitySignal',
					'workbench.contrib.dictationWarmup',
					'workbench.contrib.saveAccessibilitySignals',
				],
				createLogService: () => {
					// The factory owns failure cleanup and transfers the logger to the Workbench.
					sessions.delete(logger);
					return logger;
				},
				createStorageService: async options => {
					const storage = profileServices.createInstance(NativeWorkbenchStorageService, options);
					try {
						await storage.initialize();
						return storage;
					} catch (error) {
						storage.dispose();
						throw error;
					}
				},
				profile,
				api,
				workspaceSelection: () => workspaceSelection,
				workspace: () => workspace,
				bindLocalWorkspaceFolder: api.bindLocalWorkspaceFolder,
				initialWorkspaceReady,
				createFileDialogService: services => services.createInstance(FileDialogService),
				createLifecycleService: services => {
					lifecycleService = services.createInstance(ElectronLifecycleService, {
						ownerWindow: window,
						onError: onUnexpectedError,
						startupKind: restoreEntry ? StartupKind.ReopenedWindow : undefined,
					});
					sessions.add(
						lifecycleService.onWillShutdown(event =>
							event.join(
								logger
									.flush()
									.catch(error =>
										console.error('Could not flush Agents logs during shutdown', error),
									),
								'Agents logs flush',
							),
						),
					);
					return lifecycleService;
				},
				nativeHostApi: api.nativeHost,
				createAuxiliaryWindowService: (opener, root, services) =>
					services.createInstance(ElectronAuxiliaryWindowService, opener, root),
				keyboardLayoutProvider: api.keyboardLayout,
				userKeyboardLayoutApi: api.userKeyboardLayout,
				returnToWorkbench: () => {
					void invoke<void>(RETURN_TO_WORKBENCH_CHANNEL).catch(onUnexpectedError);
				},
				createUserDataFileSystemProvider: async () =>
					new FileUserDataProvider(api.localFiles, api.userDataHome),
				// Keep content menus in the window's themed DOM, independently of IDE menu preferences.
				createContextMenuService: services => services.createInstance(BrowserContextMenuService),
				createHostColorSchemeService: services => {
					const colors = services.createInstance(NativeHostColorSchemeService, hostColorScheme);
					void colors.initialize().catch(onUnexpectedError);
					return colors;
				},
				registerTitleService: (titlebarContainer, productName, services) =>
					registerTitleService(titlebarContainer, productName, services, sessions),
				container,
			}),
		);
		requestDrain();
		sessions.add(bindWindowControlTheme(workbench.themeService, api.nativeHost, getSessionsTitlebarBackground));
		const activeWorkbench = workbench;
		sessions.add(addDisposableListener(window, 'pagehide', () => {
			void activeWorkbench.shutdown('pageHide').catch(error => console.error('Failed to shut down Sessions Workbench', error)).finally(() => sessions.dispose());
		}, { once: true }));
		await lifecycleService.initialize();
		const discardStartupWorkspace = () => invoke<void>(AGENTS_WINDOW_DISCARD_STARTUP_WORKSPACE_CHANNEL, initialWorkspace.id);
		api.startWorkspaceDirectories(promptForWorkspaceTrust
			? { onTrustDeclined: discardStartupWorkspace }
			: { discardUntrustedWorkspace: discardStartupWorkspace });
		await workbench.whenRestored;
		await invoke<void>(AGENTS_WINDOW_READY_CHANNEL);
		return sessions;
	} catch (error) {
		sessions.dispose();
		throw error;
	}
}
import { IWorkbenchEnvironmentService } from '../../workbench/services/environment/common/environmentService.js';
import { ElectronWorkbenchEnvironmentService } from '../../workbench/services/environment/electron-browser/environmentService.js';
import { sandboxProcess } from '../../base/parts/sandbox/electron-browser/globals.js';

async function authorizeSessionFolder(
	trust: IWorkspaceTrustApi,
	onConnectionState: (listener: (state: string) => void) => IDisposable,
	confirmFolderTrust: (request: DirectoryPermissionRequest, signal: AbortSignal) => Promise<boolean>,
	request: DirectoryPermissionRequest,
	signal: AbortSignal,
	options?: { readonly onTrustDeclined?: () => void; readonly explicitGrant?: boolean; },
): Promise<boolean> {
	const { path } = request;
	const controller = new AbortController();
	using selection = addDisposableListener(signal, 'abort', () => controller.abort(), { once: true });
	using connection = onConnectionState(state => {
		if (state !== 'ready') { controller.abort(); }
	});
	throwIfCancelled(signal);
	const existing = await trust.readDirectory(path);
	throwIfCancelled(controller.signal);
	const permissions = existing.permissions ?? (options?.explicitGrant ? undefined : existing.inheritedWorkspacePermissions);
	if (hasDevelopmentPermissions(permissions)) { return true; }

	const confirmed = await confirmFolderTrust(request, controller.signal);
	throwIfCancelled(controller.signal);
	if (!confirmed) {
		options?.onTrustDeclined?.();
		return false;
	}
	const grant = await trust.createGrant(path, DEVELOPMENT_DIR_PERMISSIONS);
	// A concurrent grant wins, and an alias must still identify the folder that was approved.
	const current = await trust.readDirectory(path);
	throwIfCancelled(controller.signal);
	if (current.dir !== existing.dir) { return false; }
	const currentPermissions = current.permissions ?? (options?.explicitGrant ? undefined : current.inheritedWorkspacePermissions);
	if (hasDevelopmentPermissions(currentPermissions)) { return true; }
	if (!structuralEquals(currentPermissions, permissions)) { return false; }
	await trust.persistGrant(path, grant);
	throwIfCancelled(controller.signal);
	return true;
}
