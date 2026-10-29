import { TerminalWindowLifetimeHost } from '../../platform/terminal/electron-main/terminalWindowLifetimeHost.js';
import { parseJsonc } from '../../base/common/jsonc.js';
import { parseDefaultLogLevels } from '../../workbench/services/log/common/defaultLogLevels.js';
import { LogLevelToString } from '../../platform/log/common/log.js';
import type { AppServerConnectionTarget } from '../../platform/agentHost/common/appServerTransport.js';
import { RemoteAgentHostConnectionPool } from '../../platform/remote/electron-main/remoteConnectionIpc.js';
import { ImageViewMainService } from '../../platform/imageView/electron-main/imageViewMainService.js';
import { AshWorkbenchName } from '../common/application.js';
import '../../platform/update/common/update.config.contribution.js';
import { SystemPolicyService } from '../../platform/policy/node/systemPolicyService.js';
import { FilePolicyService } from '../../platform/policy/common/filePolicyService.js';
import { PolicyChannel } from '../../platform/policy/common/policyIpc.js';
import { randomUUID } from 'node:crypto';
import { WebviewProtocolProvider } from '../../platform/webview/electron-main/webviewProtocolProvider.js';
import { isAdmin, TerminalWindowTransferHost } from '../../platform/native/electron-main/nativeHostMainService.js';
import { ChecksumService, checksumChannel } from '../../platform/checksum/node/checksumService.js';
import { ProcessMainService } from '../../platform/process/electron-main/processMainService.js';
import { IGPUProcessMainService } from '../../platform/gpu/electron-main/gpuProcessMainService.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { URLHandlerChannel, URLHandlerChannelClient } from '../../platform/url/common/urlIpc.js';
import type { IOpenURLOptions } from '../../platform/url/common/url.js';
import { userConfigurationIpcRoute, openUserConfigurationTextFile } from '../../platform/configuration/electron-main/userConfigurationIpc.js';
import { IThemeMainService } from '../../platform/theme/electron-main/themeMainService.js';
import { ThemeMainService } from '../../platform/theme/electron-main/themeMainServiceImpl.js';
import { Server as MainProcessIPCServer } from '../../base/parts/ipc/electron-main/ipc.electron.js';
import { isRecord } from '../../base/common/types.js';
import { Emitter, Event } from '../../base/common/event.js';
import { BaseSecretStorageService } from '../../platform/secrets/common/secrets.js';
import { TERMINAL_REVIVE_STATE_KEY } from '../../platform/terminal/common/terminal.js';
import { OAuthCallbackHost } from "../../platform/connectors/electron-main/oauthCallbackHost.js";
import { RendererWorkspaceHost } from "../../platform/workspaces/electron-main/rendererWorkspaceHost.js";
import { AppServerBrowserHost } from "../../platform/agentHost/electron-main/appServerBrowserHost.js";
import { rendererSystemHostRoutes } from "../../platform/native/electron-main/rendererSystemHostRoutes.js";
import { nativeImage, nativeTheme, shell } from "electron";
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen, Menu, Tray, powerMonitor, safeStorage, type BrowserWindowConstructorOptions, type Event as ElectronEvent, type MenuItemConstructorOptions } from "electron/main";
import { IEncryptionMainService } from '../../platform/encryption/common/encryptionService.js';
import { IBrowserPasswordMainService, BrowserPasswordMainService, browserPasswordChannel } from '../../platform/browserView/electron-main/browserPasswordMainService.js';
import { EncryptionMainService } from '../../platform/encryption/electron-main/encryptionMainService.js';

import { basename, dirname, isAbsolute, join, parse } from "node:path";
import { homedir } from 'node:os';
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { throwIfCancelled, type CancellationToken } from "../../base/common/cancellation.js";
import { isCancellationError } from "../../base/common/errors.js";
import { Disposable, DisposableMap, DisposableStore, DisposableTracker, MutableDisposable, installDisposableTracker, type IDisposable, toDisposable } from "../../base/common/lifecycle.js";
import { Lazy } from '../../base/common/lazy.js';
import { assertDefined } from "../../base/common/types.js";
import { AshApplicationId, AshApplicationName } from '../common/application.js';
import { ElectronContextMenu } from "../../base/parts/contextmenu/electron-main/contextmenu.js";
import { ElectronMainClipboardService } from '../../platform/clipboard/electron-main/electronMainClipboardService.js';
import { IClipboardService } from '../../platform/clipboard/common/clipboardService.js';
import { AppServerConnectionRelay } from "../../platform/agentHost/electron-main/appServerConnectionRelay.js";
import { DevelopmentAppServerReloader } from "../../platform/app-server-daemon/electron-main/developmentAppServerReloader.js";
import { AppServerDaemonLauncher, createAppServerDaemonLauncher } from "../../platform/app-server-daemon/electron-main/appServerDaemonLauncher.js";
import { remoteExecutablePath } from "../../platform/remote/node/remotePackage.js";
import { normalizeEntryUrl, TrustedIpcRouter, type IpcRoute } from "../../platform/ipc/electron-main/trustedIpcRouter.js";
import { ipcBrowserViewChannelName } from "../../platform/browserView/common/browserView.js";
import { browserViewChannel } from "../../platform/browserView/electron-main/browserViewIpc.js";
import { BrowserViewMainService, IBrowserViewMainService } from "../../platform/browserView/electron-main/browserViewMainService.js";
import { ChatGPTTransport } from '../../sessions/contrib/chatgptweb/electron-main/chatGPTTransport.js';
import { ChatGPTVerificationRuntime } from '../../sessions/contrib/chatgptweb/electron-main/chatGPTVerificationRuntime.js';
import { chatGPTTransportChannel } from '../../sessions/contrib/chatgptweb/common/chatGPTTransport.js';
import { readFile } from 'node:fs/promises';
import { Client as MessagePortClient } from '../../base/parts/ipc/common/ipc.mp.js';
import { ProxyChannel, type IServerChannel } from '../../base/parts/ipc/common/ipc.js';
import { UtilityProcess } from '../../platform/utilityProcess/electron-main/utilityProcess.js';
import { BrowserViewGroupMainService } from '../../platform/browserView/electron-main/browserViewGroupMainService.js';
import { IPlaywrightService } from '../../platform/browserView/common/playwrightService.js';
import { WebContentsView, session as electronSession } from 'electron/main';
import { formatNlsMessage, localize, localize2, setNlsMessages } from '../../nls.js';
import { ConfigurationService } from '../../platform/configuration/common/configurationService.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { IPolicyService } from '../../platform/policy/common/policy.js';
import { FileService } from '../../platform/files/common/fileService.js';
import { IFileService } from '../../platform/files/common/files.js';
import { IMeteredConnectionService } from '../../platform/meteredConnection/common/meteredConnection.js';
import { METERED_CONNECTION_CHANNEL } from '../../platform/meteredConnection/common/meteredConnectionIpc.js';
import { MeteredConnectionMainService } from '../../platform/meteredConnection/electron-main/meteredConnectionMainService.js';
import { MeteredConnectionChannel } from '../../platform/meteredConnection/electron-main/meteredConnectionChannel.js';
import { NATIVE_CONTEXT_MENU_CLOSE_CHANNEL, NATIVE_CONTEXT_MENU_POPUP_CHANNEL, validateNativeContextMenuClose, validateNativeContextMenuRequest, type INativeContextMenuRequest } from '../../base/parts/contextmenu/common/contextmenu.js';
import { developmentArtifactsPath } from "../../platform/environment/node/developmentArtifacts.js";
import { normalizeExternalUrl } from '../../platform/opener/common/opener.js';
import { NativeKeyboardLayoutMainService, keyboardLayoutChannel } from "../../platform/keyboardLayout/electron-main/nativeKeyboardLayoutMainService.js";
import { UserKeyboardLayoutMainService, userKeyboardLayoutChannel } from "../../platform/keyboardLayout/electron-main/userKeyboardLayoutMainService.js";
import { NativeMenubarMainService, nativeMenubarIpcRoutes } from "../../platform/menubar/electron-main/menubarMainService.js";
import { clearElectronApplicationMenu, createElectronMenubarHost, Menubar } from "../../platform/menubar/electron-main/menubar.js";
import { powerMonitorChannel, colorSchemeChannel, windowSplashIpcRoutes, nativeHostIpcRoutes, type INativeHostMainService } from "../../platform/native/electron-main/nativeHostIpc.js";
import { UpdateMainService } from '../../platform/update/electron-main/updateMainService.js';
import { UpdateChannel } from '../../platform/update/common/updateIpc.js';
import { NATIVE_HOST_ACCESSIBILITY_SUPPORT_CHANGED_CHANNEL, NATIVE_HOST_TERMINAL_REQUEST_CHANNEL, validateOpenAgentsWindow, type INativeSystemWideKeybinding, type IOpenAgentsWindowOptions } from "../../platform/native/common/nativeHost.js";
import { DialogMainService, IDialogMainService } from '../../platform/dialogs/electron-main/dialogMainService.js';
import type { DialogRequest } from '../../platform/dialogs/common/dialogs.js';
import { RETURN_TO_WORKBENCH_CHANNEL, validateReturnToWorkbench } from '../../sessions/common/windowNavigation.js';
import { AGENTS_WINDOW_HANDOFF_AVAILABLE_CHANNEL, AGENTS_WINDOW_HANDOFF_COMPLETE_CHANNEL, AGENTS_WINDOW_HANDOFF_TAKE_CHANNEL, validateAgentsWindowHandoffComplete, validateAgentsWindowHandoffTake, type IAgentsWindowHandoffResult } from '../../platform/window/common/window.js';
import { GlobalKeybindingsMainService } from '../../platform/globalKeybindings/electron-main/globalKeybindingsMainService.js';
import { OPEN_AGENTS_WINDOW_COMMAND_ID } from '../../workbench/contrib/chat/common/constants.js';
import { StateService } from "../../platform/state/node/stateService.js";
import { IStateService } from '../../platform/state/node/state.js';
import { WorkspacesHistoryMainService, workspacesHistoryChannel } from '../../platform/workspaces/electron-main/workspacesHistoryMainService.js';
import { recentWorkspaceUri, type IRecent } from '../../platform/workspaces/common/workspaces.js';
import { Schemas } from '../../base/common/network.js';
import { resolveHome } from "../../platform/home/node/home.js";
import { DiskFileSystemProviderChannel } from "../../platform/files/electron-main/diskFileSystemProviderServer.js";
import { URI } from "../../base/common/uri.js";
import { extUriBiasedIgnorePathCase } from '../../base/common/resources.js';
import { DiskFileSystemProvider } from "../../platform/files/node/diskFileSystemProvider.js";
import { DiskFileSystemProviderClient, LOCAL_FILE_SYSTEM_CHANNEL_NAME } from "../../platform/files/common/diskFileSystemProviderClient.js";
import { IWindowsMainService, type IOpenConfiguration } from "../../platform/windows/electron-main/windows.js";
import {
	DEFAULT_STARTUP_WINDOW, RESTORE_WINDOWS_SETTING, STARTUP_WINDOW_SETTING, TitleBarSetting,
	parseStartupWindow, parseTitleBarStyle, type StartupWindow, type TitleBarStyleConfiguration,
} from "../../platform/window/common/window.js";
import { WindowsStateHandler, WindowSessionStateHandler, type IWindowSessionEntry, type IWindowSessionWindow } from "../../platform/windows/electron-main/windowsStateHandler.js";
import { WindowsMainService, windowOperationIpcRoute, workspaceContextIpcRoutes, workspaceRecoveryIpcRoute } from "../../platform/windows/electron-main/windowsMainService.js";
import { LifecycleMainService, ILifecycleMainService, windowCloseResponseIpcRoute } from '../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { defaultWindowState, WorkspaceContextMainService, type IWindowState } from "../../platform/window/electron-main/window.js";
import { type IAnyWorkspaceIdentifier, type IWorkspace, getWorkspaceRemoteAuthority, hasWorkspaceFileExtension, isRemoteWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier, serializeWorkspace, UNKNOWN_EMPTY_WINDOW_WORKSPACE, WorkbenchState } from "../../platform/workspace/common/workspace.js";
import { createEmptyWorkspaceIdentifier } from "../../platform/workspaces/node/workspaces.js";
import { packagedRemoteRuntimeCatalogSource } from "../../platform/remote/electron-main/packagedRemoteRuntimeCatalog.js";
import { RemoteRuntimeInstaller, remoteRuntimeArtifactFromEnvironment } from "../../platform/remote/electron-main/remoteRuntimeInstaller.js";
import { RemoteRuntimeProvisioner } from "../../platform/remote/electron-main/remoteRuntimeProvisioner.js";
import { RemoteConnectionProfiles } from "../../platform/remote/electron-main/remoteConnectionProfiles.js";
import { RemoteConnections } from "../../platform/remote/electron-main/remoteConnections.js";
import { UnavailableRemoteConnectionApi, type IRemoteConnectionApi } from "../../platform/remote/common/remoteConnectionService.js";
import type { RemoteConnectionDefinition } from "../../platform/remote/common/remoteConnectionService.js";
import { createSshRemoteAuthority, createSshRemoteWorkspaceUri, getRemoteAuthority, isRemoteResource } from "../../platform/remote/common/remote.js";
import { remotePortForwardingChannel } from '../../platform/remote/electron-main/remotePortForwardingIpc.js';
import { SshPortForwardingService } from "../../platform/remote/electron-main/sshPortForwardingService.js";
import { createRemoteRuntimeInstallProgressLogger } from "../../platform/remote/electron-main/remoteRuntimeBootstrapMainService.js";
import { RemoteRuntimeBootstrapMainService } from "../../platform/remote/electron-main/remoteRuntimeBootstrapMainService.js";
import { RemoteAppServerProcessLauncher } from "../../platform/remote/electron-main/remoteAppServerProcessLauncher.js";
import { ElectronRemoteRuntimeInstallWindow } from "../../platform/remote/electron-main/electronRemoteRuntimeInstallWindow.js";
import { electronRemoteWindowMainHost } from "../../platform/remote/electron-main/electronRemoteWindowMainHost.js";
import { RemoteWindowMainContext } from "../../platform/remote/electron-main/remoteWindowMainContext.js";
import { WORKSPACE_CONTEXT_CHANGED_CHANNEL } from "../../platform/workspace/common/workspaceIpc.js";
import { createAppServerWorkspaceTransitionAdapter, reconnectAppServerWorkspace } from "../../platform/workspaces/electron-main/appServerWorkspaceTransition.js";
import { DEVELOPMENT_DIR_PERMISSIONS, READ_DIR_PERMISSIONS, type WorkspaceTrustGrant } from '../../platform/workspace/common/workspaceTrust.js';
import { type IWorkspaceTransitionFailure, type WorkspaceTransitionMainServiceOptions, WorkspaceTransitionFailureKind, WorkspaceTransitionMainService, WorkspaceTransitionStatus } from "../../platform/workspaces/electron-main/workspaceTransitionMainService.js";
import { WorkspaceEditingMainService, WorkspacesManagementMainService } from '../../platform/workspaces/electron-main/workspacesManagementMainService.js';
import { WORKSPACE_EDIT_CHANNEL, WORKSPACE_EDIT_ERROR_CHANNEL, validateWorkspaceEdit, WORKSPACE_CONFIGURATION_CHANNEL, WORKSPACE_CONFIGURATION_CHANGED_CHANNEL, validateWorkspaceConfigurationRequest } from '../../platform/workspace/common/workspaceIpc.js';
import { StorageMainService, IApplicationStorageMainService } from '../../platform/storage/electron-main/storageMainService.js';
import { StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { AgentsWindowInvitationState, EDITOR_AGENT_HOST_SESSIONS_STORAGE_KEY, AGENTS_WINDOW_TOTAL_SESSIONS_STORAGE_KEY, AGENTS_WINDOW_LAST_SESSION_CREATED_STORAGE_KEY, AGENTS_WINDOW_INVITATION_IMPRESSION_STORAGE_KEY, type IAgentHostEditorState } from '../../platform/chat/common/agentsWindowInvitation.js';
import { AGENT_HOST_EDITOR_STATE_CHANGED_CHANNEL, validateAgentHostEditorState } from '../../platform/native/common/nativeHost.js';
import { StorageDatabaseChannel } from '../../platform/storage/electron-main/storageIpc.js';
import { LoggerService } from '../../platform/log/node/loggerService.js';
import { LoggerChannel } from '../../platform/log/electron-main/logIpc.js';
import { disposableTimeout } from '../../base/common/async.js';
import { WorkspaceOpenTargetKind } from '../../platform/environment/common/argv.js';
import { parseLaunchArguments, parseMainProcessArgv, windowsCommandLine } from '../../platform/environment/node/argvHelper.js';
import { LaunchMainService, parseWindowLaunch, type IStartArguments } from '../../platform/launch/electron-main/launchMainService.js';
import { RemoteTunnelService } from '../../platform/remoteTunnel/node/remoteTunnelService.js';
import { ITunnelProcessCoordinator, TunnelProcessCoordinator } from '../../platform/remoteTunnel/node/tunnelProcessCoordinator.js';
import { ILogService } from '../../platform/log/common/log.js';
import { InstantiationService } from '../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import { IAuxiliaryWindowsMainService } from '../../platform/auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { AuxiliaryWindowsMainService } from '../../platform/auxiliaryWindow/electron-main/auxiliaryWindowsMainService.js';
import { nodeWorkspacePathService } from '../../platform/workspaces/node/workspaces.js';
import { LocalizationConfiguration } from '../../workbench/services/localization/common/locale.js';
import { fallbackLanguagePackCatalog, loadProductLanguagePackCatalog } from '../../../../.build/desktop/localization/localizationCatalogLoader.js';
import { parseLanguagePackCatalog } from '../../platform/languagePacks/common/languagePackCatalog.js';
import type { LanguagePackCatalog } from '../../platform/languagePacks/common/languagePackContract.js';
import { NLS_CONFIGURATION_CHANNEL, NLS_ACTIVATE_CHANNEL } from '../../platform/languagePacks/common/languagePackStore.js';
import { HOST_RESTART_CHANNEL, WINDOW_OPEN_EXTERNAL_URI_CHANNEL, WINDOW_TERMINAL_TRANSFER_STARTUP_CHANNEL } from '../../platform/window/common/window.js';
export type AppServerStartupMode = "required" | "disabled";

export interface AshApplicationOptions {
	readonly rendererRoot: string;
	/** Selects whether this Electron process starts the App Server before opening its window. */
	readonly appServerStartupMode: AppServerStartupMode;
	/** The development supervisor owns replacement processes through its IPC lifetime. */
	readonly developmentLauncher: boolean;
}

interface PersistentServices {
	readonly state: StateService;
	readonly configuration: ConfigurationService;
	readonly userKeyboardLayout: UserKeyboardLayoutMainService;
}

interface RendererEntry {
	readonly file: string;
	readonly url: string;
	readonly useDevelopmentUrl: boolean;
}

interface WorkbenchWindowRecord {
	readonly id: number;
	readonly windowSessionId: string;
	terminalTransferStartup: boolean;
	readonly window: BrowserWindow;
	readonly workspaceContext: WorkspaceContextMainService;
	readonly supervisor: AppServerConnectionRelay;
	readonly resources: DisposableStore;
	readonly remoteConnections: IRemoteConnectionApi;
	windowsStateHandler: WindowsStateHandler;
	windowStateTracking: IDisposable;
	openWorkspace?: (root: string) => Promise<void>;
	replaceWorkspace?: (workspace: IAnyWorkspaceIdentifier) => Promise<boolean>;
}

class SessionsWindowRecord extends Disposable {
	readonly workspaceContext: WorkspaceContextMainService;
	readonly remoteConnections: IRemoteConnectionApi;
	readonly runtimeResources = this._register(new MutableDisposable<DisposableStore>());
	supervisor: AppServerConnectionRelay | undefined;
	windowState: { readonly window: BrowserWindow; readonly handler: WindowsStateHandler; readonly tracking: IDisposable; } | undefined;

	constructor(workspaceContext: WorkspaceContextMainService, remoteConnections: IRemoteConnectionApi) {
		super();
		this.workspaceContext = this._register(workspaceContext);
		this.remoteConnections = remoteConnections;
	}

	get workspaceId(): string { return this.workspaceContext.getWorkspace().id; }

}

type WindowSessionEntry =
	| { readonly kind: 'workbench'; readonly workspace: IAnyWorkspaceIdentifier; readonly windowSessionId?: string; }
	| { readonly kind: 'sessions'; readonly workspace: IAnyWorkspaceIdentifier; };

const AGENTS_WINDOW_KEY = 'agents';

/** Owns the Electron application's persistent services, Workbench windows, IPC, and shutdown. */
export class AshApplication extends Disposable {
	private readonly rendererRoot: string;
	private readonly chatGPTChannels = new Map<string, IServerChannel<string>>();
	private readonly appServerStartupMode: AppServerStartupMode;
	private readonly developmentLauncher: boolean;
	private readonly disposableTracker: DisposableTracker | undefined;
	private readonly tracking: globalThis.Disposable | undefined;
	private readonly trustedIpcRouter: TrustedIpcRouter;
	private readonly mainProcessIpcServer = this._register(new MainProcessIPCServer());
	private readonly remoteTunnel = this._register(new MutableDisposable<RemoteTunnelService>());
	private readonly windowPortForwarding = new Map<string, SshPortForwardingService>();
	private readonly browserChannels = new Map<string, { readonly view: IServerChannel<string>; readonly host: IServerChannel<string>; }>();
	private readonly secretChannels = new Map<string, IServerChannel<string>>();
	private readonly sharedProcess = this._register(new UtilityProcess({
		name: 'Ash Browser Automation',
		entryPoint: fileURLToPath(new URL('../electron-utility/sharedProcess/sharedProcessMain.js', import.meta.url)),
	}));
	private updateMainService!: UpdateMainService;
	private readonly nativeKeyboardLayout: NativeKeyboardLayoutMainService;
	private readonly globalKeybindings: GlobalKeybindingsMainService;
	private readonly nativeMenubar: NativeMenubarMainService | undefined;
	private readonly profileRoot: string;
	private profileFileSystem!: DiskFileSystemProvider;
	private readonly localizationChanged = this._register(new Emitter<void>());
	private activeLanguagePack: LanguagePackCatalog = fallbackLanguagePackCatalog;
	private restartRequested = false;
	private readonly developmentAppServerReloader = this._register(new MutableDisposable<DevelopmentAppServerReloader>());
	private readonly windowIconPath: string | undefined;

	// Product resources follow platform-owned windows; this map does not select or reuse windows.
	private readonly workbenchWindowData = new Map<number, WorkbenchWindowRecord>();
	private readonly openingWindowSessionIds = new Set<string>();
	private readonly terminalWindowTransfers = this._register(new TerminalWindowTransferHost({
		getWindow: windowId => {
			const record = this.workbenchWindowData.get(windowId);
			if (!record || record.window.isDestroyed() || record.window.webContents.isDestroyed()) return undefined;
			const workspace = record.workspaceContext.getWorkspace();
			return {
				workspaceId: workspace.id, remoteAuthority: getWorkspaceRemoteAuthority(workspace),
				requestTransfer: () => this.windowsMainService.getWindowById(windowId)?.send(NATIVE_HOST_TERMINAL_REQUEST_CHANNEL),
			};
		},
		openWindow: async sourceWindowId => {
			const source = this.workbenchWindowData.get(sourceWindowId);
			if (!source || !this.workspaces) throw new Error('Terminal source window is unavailable');
			const target = await this.openWorkspace(source.workspaceContext.getWorkspace(), this.workspaces, true, randomUUID(), true);
			if (!target) throw new Error('Terminal target window could not be opened');
			return target.id;
		},
	}));
	private readonly sessionsWindow = this._register(new MutableDisposable<SessionsWindowRecord>());
	private sessionsWindowOpenQueue: Promise<void> = Promise.resolve();
	private readonly windowServices = this._register(new InstantiationService(new ServiceCollection([
		IAuxiliaryWindowsMainService,
		new SyncDescriptor(AuxiliaryWindowsMainService, [(contents: Electron.WebContents) => BrowserWindow.fromWebContents(contents)]),
	])));
	private readonly auxiliaryWindowsMainService = this.windowServices.get(IAuxiliaryWindowsMainService);
	private readonly windowsMainService: WindowsMainService<BrowserWindow> = this._register(this.windowServices.createInstance(WindowsMainService<BrowserWindow>,
		async (configuration: IOpenConfiguration | undefined, reuseWindow: BrowserWindow | undefined): Promise<BrowserWindow | undefined> => {
			const workspaces = this.workspaces;
			if (!workspaces) {
				throw new Error('Workspace service is not initialized');
			}
			const record = reuseWindow ? this.workbenchWindowData.get(reuseWindow.id) : undefined;
			if (record) {
				await this.windowsMainService.getWindowById(record.window.id)!.ready();
			}
			let workspace: IAnyWorkspaceIdentifier;
			if (!configuration?.workspace && configuration && configuration.files.length > 0) {
				const files = configuration.files.map(file => URI.parse(file.uri));
				const folders = record?.workspaceContext.getResolvedWorkspace().folders;
				if (folders && files.every(file => folders.some(folder => extUriBiasedIgnorePathCase.isEqualOrParent(file, folder.uri)))) {
					return reuseWindow;
				}
				// Rust file access belongs to a workspace. File-only launches establish that scope before opening editors.
				const root = parse(files[0]!.fsPath).root;
				if (files.some(file => !extUriBiasedIgnorePathCase.isEqual(URI.file(parse(file.fsPath).root), URI.file(root)))) {
					throw new Error('Files on separate drives require an explicit multi-root workspace');
				}
				let folder = extUriBiasedIgnorePathCase.dirname(files[0]!);
				while (!files.every(file => extUriBiasedIgnorePathCase.isEqualOrParent(file, folder))) {
					folder = extUriBiasedIgnorePathCase.dirname(folder);
				}
				workspace = await workspaces.resolveFolder(folder.fsPath);
			} else {
				workspace = await this.windowsMainService.resolveWorkspaceOpenTarget(configuration?.workspace, configuration?.cwd ?? process.cwd());
			}
			if (reuseWindow) {
				if (configuration?.workspace || configuration?.files.length) {
					if (!await record!.replaceWorkspace!(workspace)) {
						return undefined;
					}
				}
				return reuseWindow;
			}
			return (await this.openWorkspace(workspace, workspaces, configuration?.forceNewWindow))?.window;
		},
		process.platform,
		nodeWorkspacePathService,
	));
	private readonly dialogs = this._register(new DialogMainService({
		showMessageBox: (options, window) => window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options),
		showOpenDialog: (options, window) => window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options),
		showSaveDialog: (options, window) => window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options),
	}));
	private themeMainService!: ThemeMainService;
	private readonly lifecycleMainService: LifecycleMainService<BrowserWindow>;
	private startupWindowOpeningStarted = false;
	private readonly windowSessionStateHandler: WindowSessionStateHandler<WindowSessionEntry>;
	private readonly pendingWindowLaunches: IStartArguments[] = [];
	private launchMainService!: LaunchMainService;
	private workspacesHistory!: WorkspacesHistoryMainService;
	private jumpListUpdates: Promise<void> = Promise.resolve();
	private workspaces: WorkspacesManagementMainService | undefined;
	private persistentServices: PersistentServices | undefined;
	private storageMainService: StorageMainService | undefined;
	private agentsWindowInvitations!: AgentsWindowInvitationState;
	private invitationPersistence: Promise<void> = Promise.resolve();
	private readonly loggerService = this._register(new LoggerService({
		logsHome: app.getPath('logs'),
		appServerLog: async () => {
			if (this.appServerStartupMode === 'disabled') return undefined;
			const connection = createAppServerDaemonLauncher({
				packageLocation: { appPath: app.getAppPath(), expectedVersion: app.getVersion(), isPackaged: app.isPackaged, platform: process.platform, resourcesPath: process.resourcesPath },
				sourceEnvironment: process.env, profileRoot: this.profileRoot, electronExecutable: process.execPath, role: 'workbench',
			});
			try { return await connection.launcher.getLogPath(); }
			catch (error) {
				this.logService.warn('logs', 'Could not resolve the Local App Server diagnostic log', error);
				return undefined;
			} finally { connection.launcher.dispose(); }
		},
	}));
	private readonly logService = this._register(this.loggerService.createLogger('main'));
	private readonly maintenance = this._register(new MutableDisposable<IDisposable>());
	private closePersistentServicesPromise: Promise<void> | undefined;
	private quitRequested = false;
	private quitAfterServicesClosed = false;
	private quitAfterStateSaved = false;
	private quitSaveStarted = false;

	constructor(
		options: AshApplicationOptions,
		private readonly stateService: StateService,
		disposableTracker: DisposableTracker | undefined,
		tracking: globalThis.Disposable | undefined,
		@IGPUProcessMainService gpuProcessMainService: IGPUProcessMainService,
		@IInstantiationService mainServices: IInstantiationService,
	) {
		super();
		this._register(mainServices);
		this.windowServices.registerInstance(IGPUProcessMainService, gpuProcessMainService);
		this._register(gpuProcessMainService.onDidUpdateFeatureStatus(status => {
			this.logService.info('gpu', 'GPU feature status changed', { status: status ?? null });
		}));
		this._register(gpuProcessMainService.onDidExitProcess(({ reason }) => {
			this.logService.warn('gpu', 'GPU process exited', { reason });
		}));
		this.rendererRoot = options.rendererRoot;
		this.appServerStartupMode = options.appServerStartupMode;
		this.developmentLauncher = options.developmentLauncher;
		this.disposableTracker = disposableTracker;
		this.tracking = tracking;
		this.trustedIpcRouter = this._register(new TrustedIpcRouter(ipcMain));
		this.nativeKeyboardLayout = this._register(new NativeKeyboardLayoutMainService());
		this.globalKeybindings = this._register(new GlobalKeybindingsMainService({
			shortcuts: globalShortcut,
			activeWindowId: () => BrowserWindow.getFocusedWindow()?.id,
			runCommand: (windowId, commandId, args) => {
				if (commandId !== OPEN_AGENTS_WINDOW_COMMAND_ID) return;
				const options = validateOpenAgentsWindow(args);
				const focused = BrowserWindow.fromId(windowId);
				const parentId = focused ? this.auxiliaryWindowsMainService.getWindowByWebContents(focused.webContents)?.parentId : undefined;
				const record = this.workbenchWindowData.get(parentId ?? windowId);
				if (record) return this.openSessionsWindow(record.workspaceContext.getWorkspace(), record.workspaceContext.getResolvedWorkspace(), options);
				const session = this.sessionsWindow.value;
				if (session && this.windowsMainService.managedWindow(AGENTS_WINDOW_KEY)?.id === (parentId ?? windowId)) {
					return this.openSessionsWindow(session.workspaceContext.getWorkspace(), session.workspaceContext.getResolvedWorkspace(), options);
				}
			},
			onError: error => console.error('Failed to handle a system-wide shortcut', error),
		}));
		this.nativeMenubar = process.platform === "darwin"
			? this._register(new NativeMenubarMainService(createElectronMenubarHost()))
			: undefined;
		this.profileRoot = resolveHome();
		// Development uses the stock Electron executable; a Windows package must embed this icon in its executable.
		this.windowIconPath = process.platform === 'win32' && !app.isPackaged
			? join(app.getAppPath(), 'resources', 'win32', 'ash.ico')
			: undefined;

		this.lifecycleMainService = this._register(new LifecycleMainService<BrowserWindow>(async (window, failure) => {
			if (failure.kind === 'unresponsive') {
				this.logService.warn('lifecycle', 'Renderer window shutdown response timed out', {
					windowId: window.id, token: failure.token, reason: failure.reason, elapsedMs: failure.elapsedMs,
				});
				this.cancelQuit();
				await this.windowsMainService.getWindowById(window.id)?.reportWindowError(false, failure.signal);
				return;
			}
			this.cancelQuit();
			this.windowsMainService.failManagedWindowClose(window, failure.message);
			await this.dialogs.showMessageBox({ type: 'error', message: failure.message }, window);
		}, window => {
			this.cancelQuit();
			this.windowsMainService.failManagedWindowClose(window, 'Window close was vetoed');
		}, this.stateService, app.getVersion(), () => this.quitRequested ? 'quit' : 'windowClose'));
		this.windowServices.registerInstance(IDialogMainService, this.dialogs);
		this.windowServices.registerInstance(ILifecycleMainService, this.lifecycleMainService);
		this.windowSessionStateHandler = new WindowSessionStateHandler(this.stateService, () => this.getOpenWindowSessions(), isWindowSessionEntry);

		app.on('second-instance', this.onSecondInstance);
		app.on('open-file', this.onOpenFile);
		app.on('open-url', this.onOpenUrl);
		app.on('activate', this.onActivate);
		app.on('window-all-closed', this.onWindowAllClosed);
		this._register(toDisposable(() => {
			app.removeListener('second-instance', this.onSecondInstance);
			app.removeListener('open-file', this.onOpenFile);
			app.removeListener('open-url', this.onOpenUrl);
			app.removeListener('activate', this.onActivate);
			app.removeListener('window-all-closed', this.onWindowAllClosed);
		}));
		app.on("before-quit", this.onBeforeQuit);
		app.on("will-quit", this.onWillQuit);
		app.on("accessibility-support-changed", this.onAccessibilitySupportChanged);
		this._register(toDisposable(() => {
			app.removeListener("before-quit", this.onBeforeQuit);
			app.removeListener("will-quit", this.onWillQuit);
			app.removeListener("accessibility-support-changed", this.onAccessibilitySupportChanged);
		}));
	}

	static async create(options: AshApplicationOptions, mainServices: IInstantiationService): Promise<AshApplication> {
		const state = await StateService.create(join(app.getPath("userData"), "state.json"));
		const disposableTracker = app.isPackaged
			? undefined
			: new DisposableTracker();
		const tracking = disposableTracker
			? installDisposableTracker(disposableTracker)
			: undefined;
		try { return mainServices.createInstance(AshApplication, options, state, disposableTracker, tracking); }
		catch (error) {
			await state.close();
			tracking?.[Symbol.dispose]();
			throw error;
		}
	}

	startup(): Promise<void> {
		return this.lifecycleMainService.startup(app.whenReady(), token => this.startupAfterReady(token));
	}

	private async startupAfterReady(token: CancellationToken): Promise<void> {
		if (!app.isReady()) {
			throw new Error("Ash application startup requires Electron to be ready");
		}
		this._register(new WebviewProtocolProvider(this.rendererRoot, process.env.ASH_RENDERER_URL));
		if (process.platform === "darwin") {
			assertDefined(app.dock, 'macOS Dock API is unavailable');
			// Dock customization must not gate creation of the first Workbench window.
			if (!app.isPackaged) {
				app.dock.setIcon(join(app.getAppPath(), 'resources', 'darwin', 'ash.png'));
			}
		} else {
			clearElectronApplicationMenu();
		}

		await this.loggerService.initialize();
		throwIfCancelled(token);
		let savedLevels: unknown;
		try {
			const document = parseJsonc(await readFile(join(this.profileRoot, 'argv.json'), 'utf8'), 'argv.json');
			if (!isRecord(document)) throw new TypeError(localize('logs.invalidArgv', 'The startup configuration must be a JSON object.'));
			savedLevels = document['log-level'];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.logService.error('logs', localize('logs.readFailed', 'Could not read startup log levels.'), error);
		}
		const launch = parseLaunchArguments(this.workspaceLaunchArguments(process.argv));
		// The managed backend inherits this choice before its profile runtime opens.
		if (launch.useInMemorySecretStorage) process.env.ASH_USE_INMEMORY_SECRETSTORAGE = '1';
		let defaults = parseDefaultLogLevels(undefined);
		try { defaults = parseDefaultLogLevels(savedLevels); }
		catch (error) { this.logService.error('logs', localize('logs.parseFailed', 'Could not parse startup log levels.'), error); }
		const startupOverrides = [...(launch.verbose ? ['trace'] : []), ...(launch.log ?? [])];
		const commandLevels = parseDefaultLogLevels(startupOverrides);
		defaults = parseDefaultLogLevels(startupOverrides, defaults);
		this.logService.setLevel(defaults.default);
		this.mainProcessIpcServer.registerChannel('logger', new LoggerChannel(this.loggerService, {
			logLevel: startupOverrides.some(value => !value.includes('=')) ? LogLevelToString(commandLevels.default) : undefined,
			initialLogLevel: defaults.default,
			extensionLogLevel: commandLevels.extensions.map(([id, level]) => [id, LogLevelToString(level)]),
		}));
		this.mainProcessIpcServer.registerChannel('secretStorage', {
			call: <T>(context: string, command: string, arg: unknown) => {
				const channel = this.secretChannels.get(context);
				if (!channel) throw new Error('Window secret storage is unavailable');
				return channel.call<T>(context, command, arg);
			},
			listen: <T>(context: string, event: string, arg: unknown) => {
				const channel = this.secretChannels.get(context);
				if (!channel) throw new Error('Window secret storage is unavailable');
				return channel.listen<T>(context, event, arg);
			},
		});
		this.mainProcessIpcServer.registerChannel(chatGPTTransportChannel, {
			call: <T>(context: string, command: string, arg: unknown) => {
				const channel = this.chatGPTChannels.get(context);
				if (!channel) { throw new Error('ChatGPT is unavailable in this window'); }
				return channel.call<T>(context, command, arg);
			},
			listen: () => { throw new Error('ChatGPT transport has no events'); },
		});
		this.mainProcessIpcServer.registerChannel('browserHost', {
			call: <T>(context: string, command: string, arg: unknown) => this.getBrowserHostChannel(context).call<T>(context, command, arg),
			listen: <T>(context: string, event: string, arg: unknown) => this.getBrowserHostChannel(context).listen<T>(context, event, arg),
		});
		this.mainProcessIpcServer.registerChannel(ipcBrowserViewChannelName, {
			call: <T>(context: string, command: string, arg: unknown) => {
				const channel = this.browserChannels.get(context)?.view;
				if (!channel) { throw new Error('BrowserCapabilityUnavailable'); }
				return channel.call<T>(context, command, arg);
			},
			listen: <T>(context: string, event: string, arg: unknown) => {
				const channel = this.browserChannels.get(context)?.view;
				if (!channel) { throw new Error('BrowserCapabilityUnavailable'); }
				return channel.listen<T>(context, event, arg);
			},
		});
		this.logService.info('lifecycle', 'Desktop startup', { appServer: this.appServerStartupMode });
		await this.createPersistentServices(token);
		throwIfCancelled(token);
		this.windowServices.registerInstance(IConfigurationService, this.services.configuration);
		const meteredConnection = this._register(this.windowServices.createInstance(MeteredConnectionMainService));
		this.windowServices.registerInstance(IMeteredConnectionService, meteredConnection);
		this.mainProcessIpcServer.registerChannel(METERED_CONNECTION_CHANNEL, new MeteredConnectionChannel(meteredConnection));
		this.updateMainService = this._register(this.windowServices.createInstance(UpdateMainService,
			(version: string) => this.lifecycleMainService.prepareUpdateRestart(version), app));
		this.mainProcessIpcServer.registerChannel('remotePortForwarding', remotePortForwardingChannel(context => {
			const service = this.windowPortForwarding.get(context);
			if (!service || service.isDisposed) {
				throw new Error('Remote port-forwarding window is unavailable');
			}
			return service;
		}));
		const remoteExecutable = remoteExecutablePath({ appPath: app.getAppPath(), isPackaged: app.isPackaged, platform: process.platform, resourcesPath: process.resourcesPath });
		const tunnelServices = this._register(this.windowServices.createChild(new ServiceCollection([ILogService, this.logService])));
		const coordinator = this._register(tunnelServices.createInstance(TunnelProcessCoordinator, {
			executable: join(dirname(remoteExecutable), process.platform === 'win32' ? 'ash-remote-host.exe' : 'ash-remote-host'),
			backendExecutable: join(dirname(remoteExecutable), process.platform === 'win32' ? 'ash-app-server.exe' : 'ash-app-server'),
			sshExecutable: process.env.ASH_SSH_PATH ?? 'ssh',
			assets: this.rendererRoot,
			environment: { ...process.env, ASH_HOME: this.profileRoot },
		}));
		tunnelServices.registerInstance(ITunnelProcessCoordinator, coordinator);
		const remoteTunnel = tunnelServices.createInstance(RemoteTunnelService);
		this.remoteTunnel.value = remoteTunnel;
		this.mainProcessIpcServer.registerChannel('remoteTunnel', remoteTunnel.createChannel(context => {
			const record = [...this.workbenchWindowData.values()].find(candidate => `window:${candidate.id}` === context);
			if (!record || record.window.isDestroyed()) { throw new Error('Remote tunnel window is unavailable'); }
			const workspace = record.workspaceContext.getResolvedWorkspace();
			if (this.appServerStartupMode === 'disabled' || getWorkspaceRemoteAuthority(record.workspaceContext.getWorkspace()) || workspace.folders.length !== 1 || workspace.folders[0].uri.scheme !== 'file') { return undefined; }
			return workspace.folders[0].uri.fsPath;
		}));
		await mkdir(join(this.profileRoot, 'themes'), { recursive: true });
		throwIfCancelled(token);
		const profileFiles = this.profileFileSystem;
		this._register(profileFiles.onDidWatchError(error => this.logService.error('files', 'Failed to watch user profile files', error)));
		this._register(profileFiles.watch(URI.file(this.profileRoot), { recursive: true, excludes: ['**/*.tmp'] }));
		this.mainProcessIpcServer.registerChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME, this._register(new DiskFileSystemProviderChannel(profileFiles, URI.file(this.profileRoot), URI.file(app.getPath('home')))));
		this.mainProcessIpcServer.registerChannel('keyboardLayout', keyboardLayoutChannel(this.nativeKeyboardLayout));
		this.mainProcessIpcServer.registerChannel('userKeyboardLayout', userKeyboardLayoutChannel(this.services.userKeyboardLayout));
		this.mainProcessIpcServer.registerChannel('update', new UpdateChannel(this.updateMainService));
		this.mainProcessIpcServer.registerChannel('process', ProxyChannel.fromService(this.windowServices.createInstance(ProcessMainService), this._store));
		const localeValue = this.services.configuration.getValue(LocalizationConfiguration.locale);
		const catalog = await loadProductLanguagePackCatalog(localeValue);
		throwIfCancelled(token);
		this.activeLanguagePack = catalog;
		setNlsMessages(catalog.locale, catalog.bundles);
		const storage = this.storageMainService = this._register(new StorageMainService(join(app.getPath('userData'), 'workbench-state.json')));
		await storage.initialize();
		const invitationStorage = { scope: StorageScope.APPLICATION, id: 'application' };
		const invitationItems = (await storage.getItems(invitationStorage)).entries;
		let invitationHistory: Pick<IAgentHostEditorState, 'editorSessionCount' | 'lastShown' | 'agentsWindowSessionCount' | 'lastAgentsWindowSessionCreated'> = {
			editorSessionCount: 0, lastShown: undefined, agentsWindowSessionCount: 0, lastAgentsWindowSessionCreated: undefined,
		};
		try {
			const number = (key: string): number | undefined => invitationItems[key] ? JSON.parse(invitationItems[key]!.value) as number : undefined;
			const restored = validateAgentHostEditorState({
				...invitationHistory, revision: 0, sessions: [], invitation: undefined,
				editorSessionCount: number(EDITOR_AGENT_HOST_SESSIONS_STORAGE_KEY) ?? 0,
				agentsWindowSessionCount: number(AGENTS_WINDOW_TOTAL_SESSIONS_STORAGE_KEY) ?? 0,
				lastAgentsWindowSessionCreated: number(AGENTS_WINDOW_LAST_SESSION_CREATED_STORAGE_KEY),
				lastShown: invitationItems[AGENTS_WINDOW_INVITATION_IMPRESSION_STORAGE_KEY] ? JSON.parse(invitationItems[AGENTS_WINDOW_INVITATION_IMPRESSION_STORAGE_KEY]!.value) : undefined,
			});
			invitationHistory = { editorSessionCount: restored.editorSessionCount, lastShown: restored.lastShown, agentsWindowSessionCount: restored.agentsWindowSessionCount, lastAgentsWindowSessionCreated: restored.lastAgentsWindowSessionCreated };
		} catch (error) { this.logService.error('windowInvitation', 'Ignoring invalid invitation history', error); }
		this.agentsWindowInvitations = this._register(new AgentsWindowInvitationState(Date.now, invitationHistory));
		this._register(this.agentsWindowInvitations.onDidChange(state => {
			const history = { editorSessionCount: state.editorSessionCount, lastShown: state.lastShown, agentsWindowSessionCount: state.agentsWindowSessionCount, lastAgentsWindowSessionCreated: state.lastAgentsWindowSessionCreated };
			if (JSON.stringify(history) === JSON.stringify(invitationHistory)) return;
			const previousHistory = invitationHistory;
			invitationHistory = history;
			this.invitationPersistence = this.invitationPersistence.catch(() => { }).then(async () => {
				for (const [key, value] of [
					[EDITOR_AGENT_HOST_SESSIONS_STORAGE_KEY, history.editorSessionCount],
					[AGENTS_WINDOW_TOTAL_SESSIONS_STORAGE_KEY, history.agentsWindowSessionCount],
					[AGENTS_WINDOW_LAST_SESSION_CREATED_STORAGE_KEY, history.lastAgentsWindowSessionCreated],
					[AGENTS_WINDOW_INVITATION_IMPRESSION_STORAGE_KEY, history.lastShown],
				] as const) {
					await storage.updateItems(invitationStorage, key, value === undefined ? null : { value: JSON.stringify(value), target: StorageTarget.MACHINE });
				}
			});
			void this.invitationPersistence.catch(error => {
				if (invitationHistory === history) invitationHistory = previousHistory;
				this.logService.error('windowInvitation', 'Could not persist invitation history', error);
			});
		}));
		throwIfCancelled(token);
		this.windowServices.registerInstance(IApplicationStorageMainService, storage);
		this.windowServices.registerInstance(IEncryptionMainService, new EncryptionMainService(safeStorage));
		const browserPasswords = this._register(this.windowServices.createInstance(BrowserPasswordMainService, !!launch.useInMemorySecretStorage));
		this.windowServices.registerInstance(IBrowserPasswordMainService, browserPasswords);
		this.mainProcessIpcServer.registerChannel('browserPasswords', browserPasswordChannel(browserPasswords));
		this.windowServices.registerInstance(ILogService, this.logService);
		this.mainProcessIpcServer.registerChannel('storage', new StorageDatabaseChannel(storage));
		const launchServices = this._register(new InstantiationService());
		launchServices.registerInstance(IStateService, this.services.state);
		this.workspacesHistory = this._register(launchServices.createInstance(WorkspacesHistoryMainService));
		this.mainProcessIpcServer.registerChannel('workspaces', workspacesHistoryChannel(this.workspacesHistory));
		if (process.platform === 'win32') {
			this.configureWindowsTaskbar();
		}
		this.themeMainService = this._register(new ThemeMainService(nativeTheme, this.services.state));
		this.windowServices.registerInstance(IThemeMainService, this.themeMainService);
		this.mainProcessIpcServer.registerChannel('colorScheme', colorSchemeChannel(this.themeMainService));
		this.mainProcessIpcServer.registerChannel('powerMonitor', powerMonitorChannel(powerMonitor));
		this.mainProcessIpcServer.registerChannel('checksum', checksumChannel(app.getAppPath(), app.isPackaged, new ChecksumService()));
		const wasUpdated = this.lifecycleMainService.wasRestarted;
		const workspaces = new WorkspacesManagementMainService();
		this.workspaces = workspaces;
		launchServices.registerInstance(IWindowsMainService, this.windowsMainService);
		launchServices.registerInstance(ILogService, this.logService);
		this.launchMainService = this._register(launchServices.createInstance(LaunchMainService));
		if (process.platform === 'darwin') {
			this._register(launchServices.createInstance(Menubar, () => this.mainLocalizationMessages()['taskbar.newWindow']!, this.localizationChanged.event));
			const updateRecentDocuments = (): void => {
				void this.workspacesHistory.updateMacOSRecentDocuments().catch(error => this.logService.error('workspaces', 'Failed to update Dock recent projects', error));
			};
			this._register(this.workspacesHistory.onDidChangeRecentlyOpened(updateRecentDocuments));
			updateRecentDocuments();
		}
		this.mainProcessIpcServer.registerChannel('url', new URLHandlerChannel({ handleURL: (uri, options) => this.handleProtocolUrl(uri, options) }));
		// Once windows can accept user input, finish their setup before requesting normal, vetoable shutdown.
		this.startupWindowOpeningStarted = true;
		{
			using restoration = this.windowSessionStateHandler.beginRestoration();
			await this.openStartupWindows(workspaces, wasUpdated);
		}
		if (this.windowsMainService.getWindowCount() === 0 && this.windowsMainService.managedWindowValues().length === 0) {
			if (!this.quitRequested) app.quit();
			return;
		}
		await this.windowSessionStateHandler.saveSession();
		this.maintenance.value = disposableTimeout(() => {
			const protectedIds = new Set(this.getOpenWindowSessions().map(window => window.entry.workspace.id));
			for (const entry of this.windowSessionStateHandler.readSession()?.windows ?? []) { protectedIds.add(entry.workspace.id); }
			void storage.cleanUpStorage(protectedIds).catch(error => this.logService.error('storage', 'Failed to clean up Desktop storage', error));
			void this.loggerService.cleanUpLogs().catch(error => this.logService.error('logs', 'Failed to clean up Desktop logs', error));
		}, 30_000);
		this.createTray();
		await this.drainPendingWindowLaunches();
		if (process.platform === 'win32') {
			const update = (): void => {
				this.jumpListUpdates = this.jumpListUpdates.then(() => this.updateWindowsJumpList()).catch(error => console.error('Failed to update Windows Jump List', error));
			};
			this._register(this.workspacesHistory.onDidChangeRecentlyOpened(update));
			this._register(this.services.configuration.onDidChangeConfiguration(update));
			update();
		}
	}

	private async openStartupWindows(workspaces: WorkspacesManagementMainService, wasUpdated: boolean): Promise<void> {
		const launchRequest = parseWindowLaunch(this.workspaceLaunchArguments(process.argv), process.cwd(), this.mainLocalizationMessages()['taskbar.invalidAgentsArguments']!);
		if (launchRequest.agentsWindow) {
			await this.startWindowLaunch(launchRequest);
			return;
		}
		const args = launchRequest.args;
		if (args.urls.length > 0) {
			this.pendingWindowLaunches.push({
				args: {
					...args,
					paths: [],
					workspace: undefined,
					newWindow: false,
					reuseWindow: false,
					wait: false,
					waitMarkerFilePath: undefined,
				},
				cwd: process.cwd(),
			});
		}
		if (args.paths.length > 0 || args.newWindow || args.reuseWindow || args.wait || args.workspace) {
			if (app.isPackaged || process.env.ASH_DEV_AGENTS_WINDOW !== '1') {
				await this.restoreWindowSession(workspaces, true, wasUpdated);
				await this.launchMainService.start({ args, cwd: process.cwd() });
				return;
			}
		}
		const launch = await this.resolveWorkspace();
		if (!app.isPackaged && process.env.ASH_DEV_AGENTS_WINDOW === '1') {
			await this.openSessionsWindow(launch.workspace, await workspaces.resolveWorkspace(launch.workspace));
			return;
		}
		// Explicit launch targets and app restarts retain their own window intent.
		const startupWindow = launch.explicit || wasUpdated ? DEFAULT_STARTUP_WINDOW
			: parseStartupWindow(this.services.configuration.getValue(STARTUP_WINDOW_SETTING) ?? DEFAULT_STARTUP_WINDOW);
		await this.restoreWindowSession(workspaces, launch.explicit, wasUpdated, startupWindow);
		if (launch.explicit) {
			await this.openWorkspace(launch.workspace, workspaces);
		} else if (this.windowsMainService.getWindowCount() === 0 && this.windowsMainService.managedWindowValues().length === 0) {
			if (startupWindow === 'agents') {
				await this.openSessionsWindow(launch.workspace, await workspaces.resolveWorkspace(launch.workspace));
			} else {
				await this.openWorkspace(launch.workspace, workspaces);
			}
		}
	}

	private async restoreWindowSession(workspaces: WorkspacesManagementMainService, hasExplicitTarget: boolean, wasUpdated: boolean, startupWindow: StartupWindow = DEFAULT_STARTUP_WINDOW): Promise<void> {
		let session = this.windowSessionStateHandler.readSession();
		if (session && startupWindow !== 'default') {
			// Filter before applying restore policy so "last active" can still restore
			// the selected window type when the other type was focused at shutdown.
			const active = session.windows[session.active];
			const kind = startupWindow === 'ide' ? 'workbench' : 'sessions';
			const windows = session.windows.filter(entry => entry.kind === kind);
			const activeIndex = active ? windows.indexOf(active) : -1;
			session = { windows, active: activeIndex >= 0 ? activeIndex : windows.length - 1 };
		}
		const configuredSetting = this.services.configuration.getValue(RESTORE_WINDOWS_SETTING);
		const selection = this.windowsMainService.selectWindowsToRestore(session, configuredSetting, hasExplicitTarget, wasUpdated);
		using restoration = this.windowSessionStateHandler.beginRestoration();
		for (const entry of selection.windows) {
			try {
				if (entry.kind === 'workbench') {
					await this.openWorkspace(entry.workspace, workspaces, true, entry.windowSessionId);
				} else {
					await this.openSessionsWindow(entry.workspace, await workspaces.resolveWorkspace(entry.workspace));
				}
			} catch (error) {
				console.error('Failed to restore window', error);
			}
		}
		const active = selection.active;
		if (active) {
			if (active.kind === 'workbench') {
				const window = active.windowSessionId
					? [...this.workbenchWindowData.values()].find(record => record.windowSessionId === active.windowSessionId)?.window
					: this.windowsMainService.findWorkspace(active.workspace);
				if (window) this.windowsMainService.getWindowById(window.id)?.focus();
			}
			else {
				const window = this.windowsMainService.managedWindow(AGENTS_WINDOW_KEY);
				if (window) this.windowsMainService.getWindowById(window.id)?.focus();
			}
		}
	}

	private createTray(): void {
		if (process.platform !== 'win32' && process.platform !== 'darwin') return;
		const iconDirectory = join(app.getAppPath(), 'resources', 'tray');
		const iconSize = process.platform === 'darwin' ? 18 : 16;
		const loadIcon = (color: 'black' | 'white') => {
			const icon = nativeImage.createFromPath(join(iconDirectory, `ash-${color}-${iconSize}.png`));
			icon.addRepresentation({ scaleFactor: 1.5, buffer: readFileSync(join(iconDirectory, `ash-${color}-${iconSize * 1.5}.png`)) });
			icon.addRepresentation({ scaleFactor: 2, buffer: readFileSync(join(iconDirectory, `ash-${color}-${iconSize * 2}.png`)) });
			return icon;
		};
		const blackIcon = loadIcon('black');
		if (process.platform === 'darwin') blackIcon.setTemplateImage(true);
		const whiteIcon = process.platform === 'win32' ? loadIcon('white') : undefined;
		const tray = new Tray(whiteIcon && nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? whiteIcon : blackIcon);
		this._register(toDisposable(() => tray.destroy()));
		tray.setToolTip(AshApplicationName);
		const activate = (): void => this.handleActivate();
		tray.on('click', activate);
		tray.on('double-click', activate);
		this._register(toDisposable(() => {
			tray.removeListener('click', activate);
			tray.removeListener('double-click', activate);
		}));
		let menuUpdates: Promise<void> = Promise.resolve();
		const updateMenu = (): void => {
			menuUpdates = menuUpdates.then(async () => {
				const recents = await this.workspacesHistory.getRecentlyOpened();
				if (this.isDisposed) {
					return;
				}
				const messages = this.mainLocalizationMessages();
				const recentItems: MenuItemConstructorOptions[] = recents.workspaces.map(recent => ({
					label: this.recentProjectLabel(recent),
					click: () => this.handleLaunchArguments(this.workspacesHistory.getWorkspaceLaunchArguments(recent), process.cwd()),
				}));
				if (recentItems.length === 0) {
					recentItems.push({ label: messages['shell.noRecentProjects']!, enabled: false });
				}
				recentItems.push({ type: 'separator' }, {
					label: messages['shell.clearRecentProjects']!,
					enabled: recents.workspaces.length > 0,
					click: () => { void this.workspacesHistory.clearRecentlyOpened().catch(error => console.error('Failed to clear recent projects', error)); },
				});
				const items: MenuItemConstructorOptions[] = [
					{ label: messages['tray.showWindow']!, click: () => this.handleActivate() },
					{ label: messages['taskbar.newWindow']!, click: () => this.handleLaunchArguments(['--new-window'], process.cwd()) },
				];
				items.push({ label: messages['taskbar.agentsWindow']!, click: () => this.handleLaunchArguments(['--agents-window'], process.cwd()) });
				items.push(
					{ type: 'separator' },
					{ label: messages['shell.recentProjects']!, submenu: recentItems },
					{ type: 'separator' },
					{ label: messages['tray.quit']!, click: () => app.quit() },
				);
				tray.setContextMenu(Menu.buildFromTemplate(items));
			}).catch(error => console.error('Failed to update tray menu', error));
		};
		this._register(this.workspacesHistory.onDidChangeRecentlyOpened(updateMenu));
		this._register(this.services.configuration.onDidChangeConfiguration(updateMenu));
		this._register(this.localizationChanged.event(updateMenu));
		updateMenu();
		if (whiteIcon) {
			const updateIcon = (): void => tray.setImage(nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? whiteIcon : blackIcon);
			nativeTheme.on('updated', updateIcon);
			this._register(toDisposable(() => nativeTheme.removeListener('updated', updateIcon)));
		}
	}

	async disposeAfterStartupFailure(): Promise<void> {
		this.windowsMainService.dispose();
		this.sessionsWindow.dispose();
		try {
			await this.closePersistentServices();
		} finally {
			this.dispose();
			this.releaseDisposableTracker();
		}
	}

	private readonly onSecondInstance = (_event: ElectronEvent, arguments_: string[], cwd: string, data: unknown): void => {
		// A supervised replacement retries the lock until this instance exits;
		// forwarding each attempt would repeatedly open its files and windows here.
		if (!app.isPackaged && isRecord(data) && data.developmentLauncher === true) return;
		if (data && typeof data === 'object' && 'launchArguments' in data) {
			if (!Array.isArray(data.launchArguments) || !data.launchArguments.every((argument: unknown) => typeof argument === 'string')) {
				throw new TypeError('Invalid launch arguments from another process');
			}
			this.handleLaunchArguments(data.launchArguments, cwd);
			return;
		}
		this.handleSecondInstance(arguments_, cwd);
	};
	private readonly onOpenFile = (event: ElectronEvent, file: string): void => {
		event.preventDefault();
		this.handleLaunchArguments([`--file-uri=${pathToFileURL(file)}`], process.cwd());
	};
	private readonly onOpenUrl = (event: ElectronEvent, url: string): void => {
		event.preventDefault();
		this.handleLaunchArguments([`--open-url=${url}`], process.cwd());
	};
	private readonly onActivate = (): void => { this.handleActivate(); };
	private readonly onWindowAllClosed = (): void => { this.handleWindowAllClosed(); };

	/** Electron argv includes its executable and, in development, the app entry. */
	handleSecondInstance(arguments_: readonly string[], cwd: string): void {
		this.handleLaunchArguments(this.workspaceLaunchArguments(arguments_), cwd);
	}

	handleLaunchArguments(arguments_: readonly string[], cwd: string): void {
		let launch: IStartArguments;
		try {
			launch = parseWindowLaunch(arguments_, cwd, this.mainLocalizationMessages()['taskbar.invalidAgentsArguments']!);
		} catch (error) {
			void this.reportWindowOpenFailure(error);
			return;
		}
		if (!this.persistentServices || !this.workspaces) {
			this.pendingWindowLaunches.push(launch);
			return;
		}
		void this.startWindowLaunch(launch).catch(error => this.reportWindowOpenFailure(error));
	}

	private async startWindowLaunch(launch: IStartArguments): Promise<void> {
		if (!launch.agentsWindow) {
			const args = launch.args;
			if (args.urls.length === 0 || args.paths.length > 0 || args.workspace || args.newWindow || args.reuseWindow || args.wait) {
				await this.launchMainService.start(launch);
			}
			for (const originalUrl of args.urls) {
				await this.handleProtocolUrl(URI.parse(originalUrl), { originalUrl });
			}
			return;
		}
		const workspaces = this.workspaces;
		assertDefined(workspaces, 'Workspace service is not initialized');
		const activeWindow = this.windowsMainService.getLastActiveWindow('workbench');
		const active = activeWindow ? this.workbenchWindowData.get(activeWindow.id) : undefined;
		const workspace = launch.args.workspace
			? await this.windowsMainService.resolveWorkspaceOpenTarget(launch.args.workspace, launch.cwd)
			: active?.workspaceContext.getWorkspace() ?? createEmptyWorkspaceIdentifier();
		await this.openSessionsWindow(workspace, await workspaces.resolveWorkspace(workspace));
	}

	private async handleProtocolUrl(uri: URI, options?: IOpenURLOptions): Promise<boolean> {
		if (uri.scheme !== 'ash') {
			return false;
		}
		const url = new URL(uri.toString());
		const windowId = url.searchParams.get('windowId');
		if (uri.authority === 'file') {
			const arguments_: string[] = [];
			if (windowId === '_blank') {
				arguments_.push('--new-window');
			} else if (windowId) {
				const window = this.windowsMainService.getWindows().find(window => String(window.id) === windowId);
				if (!window) {
					return false;
				}
				this.windowsMainService.getWindowById(window.id)?.focus();
				arguments_.push('--reuse-window');
			}
			url.searchParams.delete('windowId');
			arguments_.push(`--open-url=${url.toString()}`);
			await this.launchMainService.start({ args: parseLaunchArguments(arguments_), cwd: process.cwd() });
			return true;
		}
		if (windowId === '_blank' || (!windowId && !this.windowsMainService.getLastActiveWindow('workbench'))) {
			await this.launchMainService.start({ args: parseLaunchArguments(['--new-window']), cwd: process.cwd() });
		}
		const window = windowId && windowId !== '_blank'
			? this.windowsMainService.getWindows().find(window => String(window.id) === windowId)
			: this.windowsMainService.getLastActiveWindow('workbench');
		if (!window) {
			return false;
		}
		// Renderer readiness guarantees that its URL handler channel has been registered.
		await this.windowsMainService.getWindowById(window.id)!.ready();
		const handler = new URLHandlerChannelClient(this.mainProcessIpcServer.getChannel('urlHandler', client => client.ctx === `window:${window.id}`));
		return handler.handleURL(uri, options);
	}

	private configureWindowsTaskbar(): void {
		const iconPath = this.windowIconPath ?? process.execPath;
		// Shell shortcuts run outside the dev launcher: retain the entry and Electron data directory.
		const launchArguments = this.shellLaunchArguments();
		const configureWindow = (_event: ElectronEvent, window: BrowserWindow): void => {
			window.setAppDetails({
				appId: AshApplicationId,
				appIconPath: iconPath,
				appIconIndex: 0,
				relaunchDisplayName: AshApplicationName,
				relaunchCommand: windowsCommandLine([process.execPath, ...launchArguments, '--new-window']),
			});
		};
		app.on('browser-window-created', configureWindow);
		this._register(toDisposable(() => app.removeListener('browser-window-created', configureWindow)));
	}

	private shellLaunchArguments(): string[] {
		const arguments_ = app.isPackaged ? [] : [app.getAppPath()];
		arguments_.push(`--user-data-dir=${app.getPath('userData')}`);
		return arguments_;
	}


	private recentProjectLabel(recent: IRecent): string {
		return recent.label ?? basename(recentWorkspaceUri(recent).fsPath);
	}

	private async updateWindowsJumpList(): Promise<void> {
		if (this.isDisposed) {
			return;
		}
		const messages = this.mainLocalizationMessages();
		const iconPath = this.windowIconPath ?? process.execPath;
		const launchArguments = this.shellLaunchArguments();
		const actions = [
			{ title: messages['taskbar.newWindow']!, description: messages['taskbar.newWindowDescription']!, argument: '--new-window' },
		];
		actions.push({ title: messages['taskbar.agentsWindow']!, description: messages['taskbar.agentsWindowDescription']!, argument: '--agents-window' });
		await this.workspacesHistory.updateWindowsJumpList({
			executable: process.execPath,
			launchArguments,
			iconPath,
			recentProjectsTitle: messages['shell.recentProjects']!,
			tasks: actions,
		});
	}

	private recordRecentWorkspace(workspace: IWorkspace): void {
		let recent: IRecent;
		if (workspace.configuration?.scheme === Schemas.file) {
			recent = { workspace: { id: workspace.id, configPath: workspace.configuration }, label: workspace.name ?? basename(workspace.configuration.fsPath) };
		} else {
			const folder = workspace.folders.length === 1 ? workspace.folders[0] : undefined;
			if (folder?.uri.scheme !== Schemas.file) {
				return;
			}
			recent = { folderUri: folder.uri, label: folder.name };
		}
		void this.workspacesHistory.addRecentlyOpened([recent]).catch(error => console.error('Failed to record recent project', error));
	}

	private mainLocalizationMessages(): Readonly<Record<string, string>> {
		// Main owns these system labels; use their English originals before applying
		// the active window's catalog, independently of the renderer's NLS resolver.
		const messages: Record<string, string> = {
			'taskbar.newWindow': localize2('taskbar.newWindow', "New Window").original,
			'shell.recentProjects': localize2('shell.recentProjects', "Recent Folders & Workspaces").original,
			'shell.noRecentProjects': localize2('shell.noRecentProjects', "No Recent Projects").original,
			'shell.clearRecentProjects': localize2('shell.clearRecentProjects', "Clear Recently Opened").original,
			'tray.showWindow': localize2('tray.showWindow', "Show Ash").original,
			'tray.quit': localize2('tray.quit', "Quit Ash").original,
			'taskbar.newWindowDescription': localize2('taskbar.newWindowDescription', "Open a new Ash window").original,
			'taskbar.agentsWindow': localize2('taskbar.agentsWindow', "Open Agents Window").original,
			'taskbar.agentsWindowDescription': localize2('taskbar.agentsWindowDescription', "Open the Ash Agents window").original,
			'taskbar.invalidAgentsArguments': localize2('taskbar.invalidAgentsArguments', "Open the Agents window with --agents-window and an optional --folder or --workspace target. File, window, and wait options cannot be combined with it.").original,
		};
		// System menus consume only these labels; copying the entire product catalog
		// on every recent-project or taskbar update creates thousands of unused entries.
		const translations = this.activeLanguagePack.bundles.ash;
		for (const key of Object.keys(messages)) messages[key] = translations?.[key] ?? messages[key]!;
		return messages;
	}

	/** Focuses a live window, or recreates an empty Workbench when none remains. */
	handleActivate(): void {
		const active = this.windowsMainService.getLastActiveWindow();
		if (active) {
			this.windowsMainService.getWindowById(active.id)?.focus();
			return;
		}
		const workspaces = this.workspaces;
		if (!workspaces || !this.persistentServices) return;
		void this.openWorkspace(createEmptyWorkspaceIdentifier(), workspaces).catch(error => this.reportWindowOpenFailure(error));
	}

	/** Electron does not finish a macOS quit after the state-save retry closes the last window. */
	handleWindowAllClosed(): void {
		if (this.quitRequested || process.platform !== 'darwin') app.quit();
	}

	private async createPersistentServices(token: CancellationToken): Promise<void> {
		let configuration: ConfigurationService | undefined;
		let userKeyboardLayout: UserKeyboardLayoutMainService | undefined;
		try {
			let watcher: DiskFileSystemProviderClient | undefined;
			// Windows directory watches use asynchronous I/O and can share Main's
			// provider. Avoid an otherwise idle Electron process for profile notifications.
			// FSEvents registration/close can block synchronously on macOS; preserve
			// the isolated watcher on non-Windows hosts.
			if (process.platform !== 'win32') {
				const watcherProcess = this._register(new UtilityProcess({
					name: 'Ash File Watcher',
					entryPoint: fileURLToPath(new URL('../electron-utility/fileWatcher/fileWatcherMain.js', import.meta.url)),
					args: [this.profileRoot],
				}));
				const watcherPort = watcherProcess.connect('profile');
				const watcherClient = this._register(new MessagePortClient({
					postMessage: data => watcherPort.postMessage(data), start: () => watcherPort.start(), close: () => watcherPort.close(),
					addEventListener: (type, listener) => type === 'message' ? watcherPort.on('message', listener) : watcherPort.on('close', listener as () => void),
					removeEventListener: (type, listener) => type === 'message' ? watcherPort.off('message', listener) : watcherPort.off('close', listener as () => void),
				}, 'profile'));
				const watcherChannel = watcherClient.getChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME);
				this._register(watcherChannel.listen<unknown>('watchError')(error => {
					if (typeof error !== 'string') throw new TypeError('Invalid file watcher error');
					this.logService.error('files', 'Failed to watch user profile files', error);
				}));
				watcher = this._register(new DiskFileSystemProviderClient(watcherChannel));
			}
			this.profileFileSystem = this._register(new DiskFileSystemProvider([URI.file(this.profileRoot)], watcher));
			this._register(this.profileFileSystem.onDidWatchError(error => this.logService.error('files', 'Failed to watch user profile files', error)));
			const files = this._register(new FileService());
			this._register(files.registerProvider(Schemas.file, this.profileFileSystem));
			let policies: IPolicyService;
			if (process.platform === 'linux') {
				const systemFiles = this._register(new FileService());
				const systemProvider = this._register(new DiskFileSystemProvider([URI.file('/etc')]));
				this._register(systemFiles.registerProvider(Schemas.file, systemProvider));
				policies = this._register(new FilePolicyService(URI.file('/etc/ash/policies.json'), systemFiles, this.logService));
			} else {
				policies = this._register(new SystemPolicyService(this.logService));
			}
			this.mainProcessIpcServer.registerChannel('policy', this._register(new PolicyChannel(policies)));
			this.windowServices.registerInstance(IPolicyService, policies);
			const scope = this._register(this.windowServices.createChild(new ServiceCollection([IFileService, files], [IPolicyService, policies], [ILogService, this.logService])));
			configuration = scope.createInstance(ConfigurationService, URI.file(join(this.profileRoot, 'settings.json')));
			await configuration.initialize();
			throwIfCancelled(token);
			userKeyboardLayout = await UserKeyboardLayoutMainService.create({
				filePath: join(this.profileRoot, "keyboard-layout.json"),
				watchFile: (filePath, onChange) => {
					const resource = URI.file(filePath);
					const subscriptions = new DisposableStore();
					subscriptions.add(files.onDidChangeFiles(event => {
						if (!event.resources || event.resources.some(changed => extUriBiasedIgnorePathCase.isEqualOrParent(resource, changed))) onChange();
					}));
					try { subscriptions.add(files.watch(resource)); }
					catch (error) { subscriptions.dispose(); throw error; }
					return subscriptions;
				},
				openResource: (filePath) => shell.openPath(filePath),
				onError: (error) => {
					console.error("Failed to process user keyboard layout", error);
				},
			});
			throwIfCancelled(token);
			this.persistentServices = { state: this.stateService, configuration, userKeyboardLayout };
		} catch (error) {
			await Promise.all([
				configuration?.dispose(),
				userKeyboardLayout?.close(),
			]);
			throw error;
		}
	}

	private windowConfigurationValues(): Readonly<Record<string, unknown>> {
		const configuration = this.services.configuration;
		return Object.fromEntries(configuration.keys().user.map(key => [key, configuration.getValue(key)]));
	}

	private async resolveWorkspace(): Promise<{ readonly workspace: IAnyWorkspaceIdentifier; readonly explicit: boolean; }> {
		try {
			const target = parseLaunchArguments(this.workspaceLaunchArguments(process.argv)).workspace;
			return {
				workspace: await this.windowsMainService.resolveWorkspaceOpenTarget(target, process.cwd()),
				explicit: target !== undefined,
			};
		} catch (error) {
			console.error("Failed to resolve startup workspace", error);
			return { workspace: createEmptyWorkspaceIdentifier(), explicit: true };
		}
	}

	private workspaceLaunchArguments(arguments_: readonly string[]): string[] {
		return parseMainProcessArgv({
			arguments: arguments_,
			packaging: app.isPackaged ? "packaged" : "development",
			appPath: app.getAppPath(),
		});
	}

	private async drainPendingWindowLaunches(): Promise<void> {
		while (this.pendingWindowLaunches.length > 0 && !this.quitRequested) {
			const launch = this.pendingWindowLaunches.shift()!;
			try {
				await this.startWindowLaunch(launch);
			} catch (error) {
				await this.reportWindowOpenFailure(error);
			}
		}
	}

	private async openWorkspace(workspace: IAnyWorkspaceIdentifier, workspaces: WorkspacesManagementMainService, forceNewWindow = false, windowSessionId?: string, terminalTransferStartup = false): Promise<WorkbenchWindowRecord | undefined> {
		if (forceNewWindow) {
			return this.performOpenWorkspace(workspace, workspaces, true, windowSessionId, terminalTransferStartup);
		}
		const window = await this.windowsMainService.openWorkspace(workspace, async () => (await this.performOpenWorkspace(workspace, workspaces))?.window);
		return window ? this.workbenchWindowData.get(window.id) : undefined;
	}

	private async performOpenWorkspace(workspace: IAnyWorkspaceIdentifier, workspaces: WorkspacesManagementMainService, forceNewWindow = false, windowSessionId?: string, terminalTransferStartup = false): Promise<WorkbenchWindowRecord | undefined> {
		const existingWindow = this.windowsMainService.findWorkspace(workspace);
		const existing = existingWindow ? this.workbenchWindowData.get(existingWindow.id) : undefined;
		if (existing && !forceNewWindow) {
			this.windowsMainService.getWindowById(existing.window.id)?.focus();
			return existing;
		}
		const resources = new DisposableStore();
		let reservedWindowSessionId: string | undefined;
		try {
			const resolvedWorkspace = await workspaces.resolveWorkspace(workspace);
			if ('configPath' in workspace) workspace = { ...workspace, ...(getWorkspaceRemoteAuthority(resolvedWorkspace) ? { remoteAuthority: getWorkspaceRemoteAuthority(resolvedWorkspace) } : {}) };
			// A closed window's checkpoint can outlive the open-window session list.
			// Claim an unoccupied identity before opening yields to another launch.
			const occupied = (id: string): boolean => this.openingWindowSessionIds.has(id) || [...this.workbenchWindowData.values()].some(record => record.windowSessionId === id);
			if (!windowSessionId) {
				const saved = this.windowSessionStateHandler.readSession()?.windows.find(entry => entry.kind === 'workbench' && entry.workspace.id === workspace.id && entry.windowSessionId && !occupied(entry.windowSessionId));
				windowSessionId = saved?.kind === 'workbench' ? saved.windowSessionId : undefined;
				if (!windowSessionId && this.storageMainService) {
					const snapshot = await this.storageMainService.getItemsIfExists({ scope: StorageScope.WORKSPACE, id: workspace.id });
					const key = Object.keys(snapshot?.entries ?? {}).find(key => /^terminal\.revive\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(key) && !occupied(key.slice('terminal.revive.'.length)));
					windowSessionId = key?.slice('terminal.revive.'.length);
				}
			}
			windowSessionId ??= randomUUID();
			if (occupied(windowSessionId)) throw new Error('Window session is already open');
			this.openingWindowSessionIds.add(windowSessionId);
			reservedWindowSessionId = windowSessionId;
			const workspaceContext = resources.add(new WorkspaceContextMainService(workspace, resolvedWorkspace));
			const supervisor = resources.add(this.createAppServerConnectionRelay(workspace, resources));

			if (this.appServerStartupMode === "required" && !await this.startAppServerWithRecovery(supervisor)) {
				resources.dispose();
				return undefined;
			}
			return await this.openWorkbenchWindow(workspaceContext, workspaces, supervisor, resources, windowSessionId, terminalTransferStartup);
		} catch (error) {
			resources.dispose();
			throw error;
		} finally {
			if (reservedWindowSessionId) this.openingWindowSessionIds.delete(reservedWindowSessionId);
		}
	}

	private contextMenuIpcRoutes(contextMenu: ElectronContextMenu): readonly IpcRoute<unknown, unknown>[] {
		// Sender trust and window-scoped registration belong to the desktop host.
		return [
			{
				channel: NATIVE_CONTEXT_MENU_POPUP_CHANNEL,
				validate: validateNativeContextMenuRequest,
				invoke: request => contextMenu.popup(request as INativeContextMenuRequest),
			},
			{
				channel: NATIVE_CONTEXT_MENU_CLOSE_CHANNEL,
				validate: validateNativeContextMenuClose,
				invoke: () => contextMenu.close(),
			},
		];
	}

	private mainProcessIpcRoutes(window: BrowserWindow): readonly IpcRoute<unknown, unknown>[] {
		return [
			{
				channel: NLS_CONFIGURATION_CHANNEL,
				validate: value => { if (value !== undefined) { throw new TypeError('Startup language takes no arguments'); } return undefined; },
				invoke: () => this.services.configuration.getValue(LocalizationConfiguration.locale) ?? 'en',
			},
			{
				channel: NLS_ACTIVATE_CHANNEL,
				validate: value => { const catalog = parseLanguagePackCatalog(value); if (!catalog) { throw new TypeError('Invalid display language resource'); } return catalog; },
				invoke: catalog => {
					this.activeLanguagePack = catalog as LanguagePackCatalog;
					setNlsMessages(this.activeLanguagePack.locale, this.activeLanguagePack.bundles);
					this.localizationChanged.fire();
					if (process.platform === 'win32') { this.configureWindowsTaskbar(); }
				},
			},
			{
				channel: HOST_RESTART_CHANNEL,
				validate: value => { if (value !== undefined) { throw new TypeError('Restart takes no arguments'); } return undefined; },
				invoke: () => { this.restartRequested = true; app.quit(); },
			},
			{
				channel: 'ash:ipc:window-id',
				validate: value => { if (value !== undefined) { throw new TypeError('Window ID read takes no arguments'); } return undefined; },
				invoke: () => window.id,
			},
			{
				channel: WINDOW_TERMINAL_TRANSFER_STARTUP_CHANNEL,
				validate: value => { if (value !== undefined) throw new TypeError('Terminal startup intent takes no arguments'); return undefined; },
				invoke: () => {
					const record = this.workbenchWindowData.get(window.id);
					const expected = record?.terminalTransferStartup ?? false;
					if (record) record.terminalTransferStartup = false;
					return expected;
				},
			},
		];
	}

	private terminalLifetimeRoutes(resources: DisposableStore): IpcRoute<unknown, string>[] {
		if (this.appServerStartupMode === 'disabled') return [];
		const connection = createAppServerDaemonLauncher({
			packageLocation: { appPath: app.getAppPath(), expectedVersion: app.getVersion(), isPackaged: app.isPackaged, platform: process.platform, resourcesPath: process.resourcesPath },
			sourceEnvironment: process.env, profileRoot: this.profileRoot, electronExecutable: process.execPath, role: 'agents',
		});
		resources.add(connection.launcher);
		return resources.add(new TerminalWindowLifetimeHost(async () => {
			await connection.launcher.validate();
			return { executable: connection.launcher.environment.ASH_APP_SERVER_PATH!, profile: this.profileRoot, environment: connection.launcher.environment };
		})).routes();
	}

	private createAppServerConnectionRelay(
		workspace: IAnyWorkspaceIdentifier,
		resources: DisposableStore,
		existing?: AppServerConnectionRelay,
		role: 'workbench' | 'agents' = 'workbench',
		connectionKind: AppServerConnectionTarget = 'workspace',
	): AppServerConnectionRelay {
		if (this.appServerStartupMode === "disabled") {
			return existing ?? new AppServerConnectionRelay({ enabled: false }, connectionKind);
		}
		const remote = (role === 'workbench' || typeof connectionKind === 'object') && getWorkspaceRemoteAuthority(workspace)?.startsWith('ssh+') === true;
		const connection = createAppServerDaemonLauncher({
			packageLocation: { appPath: app.getAppPath(), expectedVersion: app.getVersion(), isPackaged: app.isPackaged, platform: process.platform, resourcesPath: process.resourcesPath },
			sourceEnvironment: process.env,
			profileRoot: this.profileRoot,
			electronExecutable: process.execPath,
			workspaceRoot: !remote && role === 'workbench' && isSingleFolderWorkspaceIdentifier(workspace) ? workspace.uri.fsPath : undefined,
			role,
		});
		resources.add(connection.launcher);
		const processLauncher = remote ? this.createRemoteAppServerProcessLauncher(workspace, resources, connection.launcher) : connection.launcher;
		const generationFile = connection.generationFile;
		const supervisor = existing ?? new AppServerConnectionRelay({
			enabled: true,
			processLauncher,
		}, connectionKind);
		if (existing) existing.replaceProcessLauncher(processLauncher);
		if (generationFile) {
			if (!this.developmentAppServerReloader.value) this.developmentAppServerReloader.value = new DevelopmentAppServerReloader({ generationFile });
			resources.add(this.developmentAppServerReloader.value.registerConnection(connection.launcher, supervisor));
		}
		return supervisor;
	}

	private createRemoteAppServerProcessLauncher(workspace: IAnyWorkspaceIdentifier, resources: DisposableStore, carrier: AppServerDaemonLauncher): RemoteAppServerProcessLauncher {
		const remoteAuthority = getWorkspaceRemoteAuthority(workspace);
		if (!remoteAuthority) throw new Error("SSH App Server launcher requires a Remote window");
		const remoteWorkspace = isSingleFolderWorkspaceIdentifier(workspace) ? workspace.uri : createSshRemoteAuthority(remoteAuthority.slice(4));
		const sshExecutable = process.env.ASH_SSH_PATH ?? "ssh";
		const remoteExecutable = remoteExecutablePath({
			appPath: app.getAppPath(),
			isPackaged: app.isPackaged,
			platform: process.platform,
			resourcesPath: process.resourcesPath,
		});
		const configuredRuntime = process.env.ASH_REMOTE_ASH_PATH;
		const connectionProfiles = configuredRuntime === undefined ? new RemoteConnectionProfiles({
			remoteExecutable,
			environment: { ...process.env, ASH_HOME: this.profileRoot },
		}) : undefined;
		const bootstrap = resources.add(new RemoteRuntimeBootstrapMainService({
			workspace: remoteWorkspace,
			sshExecutable,
			remoteExecutable: configuredRuntime ?? "ash-remote-server",
			localEnvironment: process.env,
			carrier,
			runtimeInstaller: {
				install: (host, options) => {
					// A compatible installed runtime does not need a release catalog. Resolve
					// its trust binding only when bootstrap actually requests installation.
					const artifact = remoteRuntimeArtifactFromEnvironment(process.env);
					const installer = artifact === undefined
						? new RemoteRuntimeProvisioner({
							source: packagedRemoteRuntimeCatalogSource(
								{ appPath: app.getAppPath(), isPackaged: app.isPackaged, resourcesPath: process.resourcesPath },
								join(app.getPath("userData"), "remote-runtime-downloads"),
							),
							remoteExecutable,
							sshExecutable,
							environment: process.env,
							installRoot: process.env.ASH_REMOTE_RUNTIME_INSTALL_ROOT,
						})
						: new RemoteRuntimeInstaller({
							remoteExecutable,
							sshExecutable,
							environment: process.env,
							artifact,
							installRoot: process.env.ASH_REMOTE_RUNTIME_INSTALL_ROOT,
						});
					return installer.install(host, options);
				},
			},
			connectionProfiles,
			logProgress: createRemoteRuntimeInstallProgressLogger(),
		}));
		resources.add(new ElectronRemoteRuntimeInstallWindow({
			productName: AshWorkbenchName,
			icon: this.windowIconPath,
			rendererEntry: this.resolveRendererEntry("remoteRuntimeInstall"),
			webPreferences: this.createSandboxWebPreferences(),
			trustedIpcRouter: this.trustedIpcRouter,
			progress: bootstrap.installProgress,
		}));
		return bootstrap.processLauncher;
	}

	private async startAppServerWithRecovery(
		supervisor: AppServerConnectionRelay,
	): Promise<boolean> {
		while (!this.quitRequested) {
			try {
				await supervisor.start();
				return true;
			} catch (error) {
				console.error("App Server failed the startup gate", error);
				if (this.quitRequested) {
					return false;
				}
				if (isCancellationError(error)) {
					return false;
				}

				const message = error instanceof Error
					? error.message
					: "The App Server failed to start";
				const diagnostics = supervisor.diagnostics().trim();
				const detail = diagnostics
					? `${message}\n\nDiagnostics:\n${diagnostics}`.slice(0, 8_000)
					: message;
				const result = await this.dialogs.showMessageBox({
					type: "error",
					title: `${AshWorkbenchName} startup failed`,
					message: "The App Server could not be validated.",
					detail,
					buttons: ["Retry", this.windowsMainService.getWindowCount() === 0 ? "Quit" : "Cancel"],
					defaultId: 0,
					cancelId: 1,
					noLink: true,
				});
				if (this.quitRequested || result.response !== 0) {
					return false;
				}
				await supervisor.stop();
			}
		}
		return false;
	}

	private async openWorkbenchWindow(
		workspaceContext: WorkspaceContextMainService,
		workspaces: WorkspacesManagementMainService,
		supervisor: AppServerConnectionRelay,
		resources: DisposableStore,
		windowSessionId: string,
		terminalTransferStartup = false,
	): Promise<WorkbenchWindowRecord> {
		const windowsStateHandler = this.createWindowsStateHandler(workspaceContext.getWorkspace());
		const windowState = this.windowsMainService.getNewWindowState(windowsStateHandler, this.windowConfigurationValues(), this.lifecycleMainService.wasRestarted);
		const titleBarStyle = this.titleBarStyle;
		const windowHost = this.windowsMainService.createWindow(options => new BrowserWindow(options), {
			reopen: async () => {
				const replacement = await this.openWorkspace(workspaceContext.getWorkspace(), workspaces, true);
				if (!replacement) throw new Error('Window recovery did not open a replacement');
				replacement.window.setBounds(windowHost.getBounds());
				replacement.window.focus();
			},
			workspace: workspaceContext.getWorkspace(),
			state: windowState,
			titleBarStyle,
			webPreferences: this.createSandboxWebPreferences(),
			title: AshWorkbenchName,
			tabbingIdentifier: process.platform === 'darwin' ? 'ash-workbench' : undefined,
			icon: this.windowIconPath,
		}, resources);
		const window = windowHost.win;
		this.trackAppServerConnection(window, supervisor, resources);
		// SSH keeps its existing workspace carrier. Devices use a separate connection to
		// the same local profile daemon already used by local and Agents windows.
		const localSupervisor = getWorkspaceRemoteAuthority(workspaceContext.getWorkspace())?.startsWith('ssh+')
			? resources.add(this.createAppServerConnectionRelay(workspaceContext.getWorkspace(), resources, undefined, 'agents', 'local'))
			: undefined;
		if (localSupervisor) this.trackAppServerConnection(window, localSupervisor, resources);

		const remoteConnections = this.createRemoteConnections(workspaces);
		const windowStateTracking = windowsStateHandler.trackWindow(window);
		const record: WorkbenchWindowRecord = {
			id: window.id,
			windowSessionId,
			terminalTransferStartup,
			window,
			workspaceContext,
			supervisor,
			resources,
			remoteConnections,
			windowsStateHandler,
			windowStateTracking,
		};
		this.workbenchWindowData.set(record.id, record);
		this.recordRecentWorkspace(workspaceContext.getResolvedWorkspace());
		resources.add(toDisposable(() => this.globalKeybindings.removeWindow(record.id)));
		const onFocus = (): void => {
			if (!window.isDestroyed()) {
				this.windowSessionStateHandler.windowFocused(record.id);
			}
		};
		window.on("focus", onFocus);
		resources.add(toDisposable(() => window.removeListener("focus", onFocus)));
		window.once("closed", () => {
			this.workbenchWindowData.delete(record.id);
			this.windowSessionStateHandler.windowClosed({ kind: 'workbench', workspace: record.workspaceContext.getWorkspace(), windowSessionId: record.windowSessionId });
		});
		this.windowSessionStateHandler.windowOpened();

		const rendererEntry = this.resolveRendererEntry("workbench");

		const windowDisposables = resources;
		this.configureWindowNavigation(window, windowDisposables, titleBarStyle);
		const workspaceHost = windowDisposables.add(new RendererWorkspaceHost(window.webContents));
		windowDisposables.add(record.windowStateTracking);
		const remotePortForwardingService = new SshPortForwardingService({
			getWorkspace: () => workspaceContext.getWorkspace(),
			sshExecutable: process.env.ASH_SSH_PATH ?? "ssh",
			localEnvironment: process.env,
		});
		const systemContextMenu = windowDisposables.add(new ElectronContextMenu(window));
		const browserServices = this.createBrowserServices(window, workspaceContext, remotePortForwardingService, windowDisposables, supervisor, systemContextMenu);
		windowDisposables.add(workspaceContext.onDidChangeWorkspace(({ workspace: nextWorkspace, resolvedWorkspace }) => {
			if (window.isDestroyed()) return;
			record.windowStateTracking.dispose();
			const nextWindowsStateHandler = this.createWindowsStateHandler(nextWorkspace);
			record.windowsStateHandler = nextWindowsStateHandler;
			record.windowStateTracking = windowDisposables.add(nextWindowsStateHandler.trackWindow(window));
			this.windowsMainService.updateWorkspace(record.id, nextWorkspace);
			this.recordRecentWorkspace(resolvedWorkspace);
			this.windowSessionStateHandler.windowChanged();
		}));
		let loadingWorkspace = false;
		windowDisposables.add(workspaceContext.onDidChangeWorkspace(({ resolvedWorkspace }) => {
			if (!loadingWorkspace && !window.isDestroyed()) {
				windowHost.send(WORKSPACE_CONTEXT_CHANGED_CHANNEL, serializeWorkspace(resolvedWorkspace));
			}
		}));
		const workspaceTransitions = windowDisposables.add(new WorkspaceTransitionMainService({
			workspaces,
			context: workspaceContext,
			...this.createWorkspaceTransitionRuntime(supervisor, workspaceHost),
		}));
		const remoteWindowContext = windowDisposables.add(new RemoteWindowMainContext({
			supervisor,
			workspaceContext,
			connections: record.remoteConnections,
			tunnels: remotePortForwardingService,
			host: electronRemoteWindowMainHost(window, this.dialogs),
			prepareForRuntimeReplacement: () => windowHost.send("ash:terminal:prepareReplacement"),
		}));
		const performTransitionToFolder = async (folderPath: string, selectionRequired: boolean): Promise<void> => {
			const currentWorkspace = workspaceContext.getWorkspace();
			const nextWorkspace = getWorkspaceRemoteAuthority(currentWorkspace) !== undefined
				? await this.resolveRemoteFolderWorkspace(currentWorkspace, folderPath)
				: await workspaces.resolveFolder(folderPath);
			if (nextWorkspace.id === currentWorkspace.id) return;
			const grant = await this.resolveDirGrant(workspaceHost, folderPath);
			if (grant === undefined) {
				if (selectionRequired) throw new Error(`Directory permissions were not selected for '${folderPath}'`);
				return;
			}
			await record.windowsStateHandler.saveWindowState(window);
			windowHost.send("ash:terminal:prepareReplacement");
			const transition = isRemoteWorkspaceIdentifier(nextWorkspace)
				? await workspaceTransitions.transitionToWorkspace({ workspace: nextWorkspace, root: folderPath }, grant)
				: await workspaceTransitions.transitionToFolder(folderPath, grant);
			if (transition.status === WorkspaceTransitionStatus.Blocked) {
				throw new Error("Finish the active request before opening another Workspace");
			}
			if (transition.status === WorkspaceTransitionStatus.Failed) {
				throw workspaceTransitionError(transition.failure);
			}
		};
		let workspaceOpenQueue: Promise<void> = Promise.resolve();
		const transitionToFolder = (folderPath: string, selectionRequired: boolean): Promise<void> => {
			// Permission selection must finish before another request reaches this window's Workspace host.
			const operation = workspaceOpenQueue.then(() => performTransitionToFolder(folderPath, selectionRequired));
			workspaceOpenQueue = operation.then(() => undefined, () => undefined);
			return operation;
		};
		record.openWorkspace = (root) => transitionToFolder(root, true);
		const replaceWorkspace = (workspace: IAnyWorkspaceIdentifier, replyBeforeLoad: boolean): Promise<boolean> => {
			let accepted = false;
			let rendererLoad: Promise<void> | undefined;
			const operation = workspaceOpenQueue.then(async () => {
				if (workspace.id === workspaceContext.getWorkspace().id) {
					accepted = true;
					return;
				}
				if (getWorkspaceRemoteAuthority(workspace) !== getWorkspaceRemoteAuthority(workspaceContext.getWorkspace())) {
					throw new Error('Reusing a window must preserve its Remote authority');
				}
				const resolvedWorkspace = await workspaces.resolveWorkspace(workspace);
				const root = isSingleFolderWorkspaceIdentifier(workspace) && workspace.uri.scheme === 'file' ? workspace.uri.fsPath : undefined;
				const grant = root ? await this.resolveDirGrant(workspaceHost, root) : { type: 'config' as const };
				if (!grant || !await this.lifecycleMainService.unload(window)) {
					return;
				}
				const load = async (): Promise<void> => {
					try {
						await windowHost.load(this.resolveRendererEntry('workbench'));
						await windowHost.ready();
					} finally {
						loadingWorkspace = false;
					}
				};
				try {
					await record.windowsStateHandler.saveWindowState(window);
					windowHost.send('ash:terminal:prepareReplacement');
					if (this.appServerStartupMode !== 'disabled') {
						await reconnectAppServerWorkspace(supervisor, workspaceHost, root, grant, workspace.id, workspaceContext.getWorkspace().id);
					}
					loadingWorkspace = true;
					workspaceContext.updateWorkspace(workspace, resolvedWorkspace);
					accepted = true;
				} finally {
					// Unload shuts down renderer services even if changing the backend fails; a load completes that lifecycle.
					// An IPC caller must receive its reply before its renderer is replaced.
					if (replyBeforeLoad) {
						rendererLoad = new Promise<void>((resolve, reject) => setImmediate(() => { void load().then(resolve, reject); }));
					} else {
						await load();
					}
				}
			});
			workspaceOpenQueue = operation.then(async () => { await rendererLoad; }, async () => { await rendererLoad; });
			void workspaceOpenQueue.catch(error => this.reportWindowOpenFailure(error));
			return operation.then(() => accepted);
		};
		record.replaceWorkspace = workspace => replaceWorkspace(workspace, false);
		const workspaceEditing = windowDisposables.add(new WorkspaceEditingMainService(
			workspaceContext, workspaces, join(this.profileRoot, 'workspaces'), {
			resolveGrant: path => this.resolveDirGrant(workspaceHost, path),
			persistDirectoryGrant: (path, grant) => workspaceHost.persistDirectoryGrant(path, grant),
			setFolders: folders => workspaceHost.setFolders(folders),
			validateFolders: folders => workspaceHost.validateFolders(folders),
		}, error => {
			this.logService.error('workspaces', String(error));
			if (!window.isDestroyed()) windowHost.send(WORKSPACE_EDIT_ERROR_CHANNEL, error instanceof Error ? error.message : String(error));
		}, operation => {
			const result = workspaceOpenQueue.then(operation);
			workspaceOpenQueue = result.then(() => undefined, () => undefined);
			return result;
		},
			() => { if (!window.isDestroyed()) windowHost.send(WORKSPACE_CONFIGURATION_CHANGED_CHANNEL); },
		));

		windowDisposables.add(toDisposable(() => this.dialogs.cancelWindow(window)));
		const ipcRoutes = [
			...this.mainProcessIpcRoutes(window),
			...this.terminalLifetimeRoutes(windowDisposables),
			...workspaceHost.routes(),
			...supervisor.routes(window.webContents, () => {
				const folder = workspaceContext.getResolvedWorkspace().folders[0]?.uri;
				return { workspaceId: workspaceContext.getWorkspace().id, workspaceRoot: folder ? folder.scheme === 'file' ? folder.fsPath : folder.path : this.profileRoot };
			}),
			...(localSupervisor?.routes(window.webContents, () => ({ workspaceId: 'local-profile', workspaceRoot: this.profileRoot })) ?? []),
			...windowDisposables.add(new OAuthCallbackHost()).routes(),
			...rendererSystemHostRoutes(window, path => this.directoryPermissionPrompt(path), this.auxiliaryWindowsMainService),
			...this.globalKeybindings.createWindowRoutes(window, windowDisposables),
			...windowDisposables.add(new ImageViewMainService(window, {
				entry: this.resolveRendererEntry('imageView'), webPreferences: this.createSandboxWebPreferences(),
				router: this.trustedIpcRouter, localization: () => this.activeLanguagePack,
			})).routes(),
			userConfigurationIpcRoute(this.profileRoot, () => !getWorkspaceRemoteAuthority(workspaceContext.getWorkspace()), openUserConfigurationTextFile),
			...remoteWindowContext.ipcRoutes,
			windowOperationIpcRoute(this.windowsMainService, window),
			windowCloseResponseIpcRoute(this.lifecycleMainService, window),
			this.windowsMainService.fileOpenResponseIpcRoute(window),
			...windowSplashIpcRoutes(this.themeMainService, () => `workbench:${workspaceContext.getWorkspace().id}`, color => window.setBackgroundColor(color)),
			...nativeHostIpcRoutes({
				getTitleBarStyle: () => titleBarStyle,
				...this.windowHostOperations(window, windowDisposables),
				openWindow: async options => {
					const workspace = { ...createEmptyWorkspaceIdentifier(), ...(options.remoteAuthority ? { remoteAuthority: options.remoteAuthority } : {}) };
					if (!options.forceReuseWindow) {
						await this.openWorkspace(workspace, workspaces);
						return;
					}
					if (options.remoteAuthority !== getWorkspaceRemoteAuthority(workspaceContext.getWorkspace())) throw new Error('Reusing a window must preserve its Remote authority');
					await replaceWorkspace(workspace, true);
				},
				openWorkspace: async (root, forceNewWindow) => {
					if (hasWorkspaceFileExtension(root)) {
						let workspace = await this.windowsMainService.resolveWorkspaceOpenTarget({ kind: WorkspaceOpenTargetKind.Workspace, path: root }, process.cwd());
						const resolved = await workspaces.resolveWorkspace(workspace);
						if ('configPath' in workspace && getWorkspaceRemoteAuthority(resolved)) workspace = { ...workspace, remoteAuthority: getWorkspaceRemoteAuthority(resolved) };
						if (forceNewWindow) await this.openWorkspace(workspace, workspaces, true);
						else await replaceWorkspace(workspace, true);
					} else if (forceNewWindow) await this.openWorkspace(await workspaces.resolveFolder(root), workspaces, true);
					else await transitionToFolder(root, true);
				},
				openAgentsWindow: options => this.openSessionsWindow(record.workspaceContext.getWorkspace(), record.workspaceContext.getResolvedWorkspace(), options),
				syncSystemWideKeybindings: bindings => this.globalKeybindings.updateKeybindings(
					record.id,
					bindings.filter(binding => binding.commandId === OPEN_AGENTS_WINDOW_COMMAND_ID),
				),
			}),
			...workspaceContextIpcRoutes(workspaceContext),
			{ channel: WORKSPACE_EDIT_CHANNEL, validate: validateWorkspaceEdit, invoke: (request: unknown) => workspaceEditing.edit(request as ReturnType<typeof validateWorkspaceEdit>) },
			{ channel: WORKSPACE_CONFIGURATION_CHANNEL, validate: validateWorkspaceConfigurationRequest, invoke: (request: unknown) => workspaceEditing.configuration(request as ReturnType<typeof validateWorkspaceConfigurationRequest>) },
			workspaceRecoveryIpcRoute(identifiers => this.windowsMainService.restoreWorkspaces(identifiers, async identifier => (await this.openWorkspace(identifier, workspaces))?.window)),
		];
		ipcRoutes.push(...this.contextMenuIpcRoutes(systemContextMenu));
		if (this.nativeMenubar) {
			windowDisposables.add(this.nativeMenubar.registerWindow(window));
			ipcRoutes.push(...nativeMenubarIpcRoutes(this.nativeMenubar, window));
		}
		windowDisposables.add(this.trustedIpcRouter.register(
			{
				webContents: window.webContents,
				allowedEntryUrls: new Set([normalizeEntryUrl(this.resolveRendererEntry("workbench").url)]),
			},
			ipcRoutes,
		));
		windowDisposables.add(this.mainProcessIpcServer.registerClient(window.webContents, `window:${window.id}`, new Set([normalizeEntryUrl(this.resolveRendererEntry('workbench').url)])));
		windowDisposables.add(this.lifecycleMainService.registerWindow(window));
		try {
			await windowHost.load(rendererEntry);
			return record;
		} catch (error) {
			windowHost.dispose();
			throw error;
		}
	}

	private createRemoteConnections(workspaces: WorkspacesManagementMainService): IRemoteConnectionApi {
		return this.appServerStartupMode === "disabled"
			? UnavailableRemoteConnectionApi
			: new RemoteConnections({
				remoteExecutable: remoteExecutablePath({ appPath: app.getAppPath(), isPackaged: app.isPackaged, platform: process.platform, resourcesPath: process.resourcesPath }),
				environment: { ...process.env, ASH_HOME: this.profileRoot },
				scheduleConnect: connection => this.openRemoteConnection(connection, workspaces),
			});
	}

	private windowHostOperations(window: BrowserWindow, windowDisposables: DisposableStore): Omit<INativeHostMainService, 'getTitleBarStyle' | 'openWorkspace' | 'openWindow' | 'openAgentsWindow' | 'syncSystemWideKeybindings'> {
		const invitationContents = window.webContents;
		const resetRendererState = (): void => {
			this.agentsWindowInvitations.resetWindow(window.id);
			this.terminalWindowTransfers.resetWindow(window.id);
		};
		windowDisposables.add(this.windowsMainService.getWindowById(window.id)!.onWillLoad(resetRendererState));
		invitationContents.on('render-process-gone', resetRendererState);
		windowDisposables.add(this.agentsWindowInvitations.onDidChange(state => {
			this.windowsMainService.getWindowById(window.id)?.send(AGENT_HOST_EDITOR_STATE_CHANGED_CHANNEL, state);
		}));
		windowDisposables.add(toDisposable(() => {
			invitationContents.off('render-process-gone', resetRendererState);
			resetRendererState();
		}));
		return {
			moveTerminalToWindow: (transfer, targetWindowId) => this.terminalWindowTransfers.move(window.id, transfer, targetWindowId),
			getWindowClientSize: () => this.windowsMainService.getWindowById(window.id)!.getClientSize(),
			takeTerminalTransfer: () => this.terminalWindowTransfers.take(window.id),
			completeTerminalTransfer: result => this.terminalWindowTransfers.complete(window.id, result),
			getAgentHostEditorState: () => this.agentsWindowInvitations.getState(),
			updateAgentHostEditorState: async update => {
				// The router binds this closure to the sender; renderer payloads never choose a window ID.
				if (this.workbenchWindowData.has(window.id)) this.agentsWindowInvitations.update(window.id, update);
				else if (update.kind === 'request') this.agentsWindowInvitations.update(undefined, update);
				await this.invitationPersistence;
			},
			claimAgentsWindowInvitation: resource => !window.isDestroyed() && window.isFocused() && this.workbenchWindowData.has(window.id) ? this.agentsWindowInvitations.claim(window.id, resource) : undefined,
			markAgentsWindowInvitationShown: async id => {
				if (!window.isDestroyed() && window.isFocused()) this.agentsWindowInvitations.markShown(window.id, id);
				await this.invitationPersistence;
			},
			releaseAgentsWindowInvitation: id => this.agentsWindowInvitations.release(window.id, id),
			isAdmin,
			performDialogOperation: operation => this.dialogs.perform(window, operation),
			pickFolder: async () => {
				const result = await this.dialogs.showOpenDialog({ title: 'Add Directory', properties: ['openDirectory'] }, window);
				return result.canceled ? undefined : result.filePaths[0];
			},
			showOpenDialog: options => this.dialogs.showOpenDialog(options, window),
			showSaveDialog: options => this.dialogs.showSaveDialog(options, window),
			revealFile: path => {
				if (!isAbsolute(path)) { throw new TypeError('File path to reveal must be absolute'); }
				shell.showItemInFolder(path);
			},
			isAccessibilitySupportEnabled: () => app.isAccessibilitySupportEnabled(),
			setWindowTheme: theme => this.windowsMainService.getWindowById(window.id)!.updateWindowControls({
				backgroundColor: theme.backgroundColor, foregroundColor: theme.symbolColor, backdropColor: theme.backdropColor,
			}),
			setWindowDimmed: dimmed => this.windowsMainService.getWindowById(window.id)!.updateWindowControls({ dimmed }),
			toggleDeveloperTools: () => window.webContents.toggleDevTools(),
		};
	}

	private configureWindowNavigation(window: BrowserWindow, windowDisposables: DisposableStore, titleBarStyle: TitleBarStyleConfiguration, openerWindow: BrowserWindow = window): void {
		const auxiliaryWindows = windowDisposables.add(new DisposableMap<number, IDisposable>());
		// Apply restored popup bounds before creation; Chromium ignores its position features here.
		window.webContents.setWindowOpenHandler(details => {
			if (details.url !== 'about:blank') {
				// The owning workbench selects URL rules; auxiliary windows share that owner.
				try { this.windowsMainService.getWindowById(openerWindow.id)?.send(WINDOW_OPEN_EXTERNAL_URI_CHANNEL, normalizeExternalUrl(details.url)); }
				catch (error) { console.error('Could not request external link opening', error); }
				return { action: 'deny' };
			}
			return { action: 'allow', overrideBrowserWindowOptions: this.auxiliaryWindowsMainService.createWindow(details, titleBarStyle, window.webContents.getZoomLevel()) };
		});
		const onDidCreateWindow = (child: BrowserWindow, details: { readonly url: string; readonly options: BrowserWindowConstructorOptions; }): void => {
			if (details.url !== 'about:blank') return;
			const childResources = new DisposableStore();
			childResources.add(this.auxiliaryWindowsMainService.registerWindow(child.webContents, window.id, details.options));
			auxiliaryWindows.set(child.id, childResources);
			this.configureWindowNavigation(child, childResources, titleBarStyle, openerWindow);
			child.once('closed', () => auxiliaryWindows.deleteAndDispose(child.id));
		};
		// BrowserWindow releases its webContents getter on close; cleanup owns the original emitter.
		const webContents = window.webContents;
		// Reloads replace the product document; link destinations belong to the Browser views.
		const preventNavigation = (event: ElectronEvent, url: string): void => {
			event.preventDefault();
			if (url === webContents.getURL()) {
				void this.windowsMainService.getWindowById(window.id)?.reload().catch(error => this.logService.error('window', 'Could not prepare window reload', error));
			}
		};
		webContents.on('will-navigate', preventNavigation);
		windowDisposables.add(toDisposable(() => webContents.off('will-navigate', preventNavigation)));
		webContents.on('did-create-window', onDidCreateWindow);
		windowDisposables.add(toDisposable(() => webContents.off('did-create-window', onDidCreateWindow)));

	}

	private getBrowserHostChannel(context: string): IServerChannel<string> {
		const channel = this.browserChannels.get(context)?.host;
		if (!channel) { throw new Error('BrowserCapabilityUnavailable'); }
		return channel;
	}

	private createBrowserServices(window: BrowserWindow, workspaceContext: WorkspaceContextMainService, remotePortForwardingService: SshPortForwardingService, windowDisposables: DisposableStore, supervisor: AppServerConnectionRelay, contextMenu: ElectronContextMenu): InstantiationService {
		const context = `window:${window.id}`;
		const secrets = windowDisposables.add(new BaseSecretStorageService());
		const windowSessionId = this.workbenchWindowData.get(window.id)?.windowSessionId;
		if (windowSessionId) void secrets.set(TERMINAL_REVIVE_STATE_KEY, `terminal.revive.${windowSessionId}`).catch(error => this.logService.error('terminal', error));
		this.secretChannels.set(context, ProxyChannel.fromService(secrets, windowDisposables));
		windowDisposables.add(toDisposable(() => this.secretChannels.delete(context)));
		this.windowPortForwarding.set(context, remotePortForwardingService);
		windowDisposables.add(toDisposable(() => {
			if (this.windowPortForwarding.get(context) === remotePortForwardingService) {
				this.windowPortForwarding.delete(context);
			}
		}));
		const browserServices = windowDisposables.add(this.windowServices.createChild(new ServiceCollection()));
		browserServices.registerInstance(IClipboardService, new ElectronMainClipboardService(window));
		const browserViewMainService = windowDisposables.add(browserServices.createInstance(BrowserViewMainService, {
			window,
			contextMenu,
			getNlsMessages: () => this.activeLanguagePack.bundles['ash.workbench'] ?? {},
			getWorkspaceId: () => workspaceContext.getWorkspace().id,
			getRemoteNetwork: () => {
				const authority = getWorkspaceRemoteAuthority(workspaceContext.getWorkspace());
				return authority ? { authority, tunnels: remotePortForwardingService } : undefined;
			},
			createSession: (partition: string) => {
				const session = electronSession.fromPartition(partition);
				return session;
			},
			createView: (session: Electron.Session) => new WebContentsView({
				webPreferences: {
					preload: app.isPackaged
						? join(app.getAppPath(), 'dist/preload/src/ash/platform/browserView/electron-browser/preload-browserView.js')
						: developmentArtifactsPath(app.getAppPath(), 'preload', 'src/ash/platform/browserView/electron-browser/preload-browserView.js'),
					nodeIntegrationInSubFrames: true,
					contextIsolation: true,
					nodeIntegration: false,
					sandbox: true,
					webviewTag: false,
					session,
				},
			}),
		}));
		const sharing = this.mainProcessIpcServer.getChannel('browserSharing', client => client.ctx === context);
		browserServices.registerInstance(IBrowserViewMainService, browserViewMainService);
		const browserGroups = windowDisposables.add(browserServices.createInstance(BrowserViewGroupMainService));
		const browserConnection = windowDisposables.add(new DisposableStore());
		// Window creation and manual browsing need no Playwright worker. Connect only
		// when automation first reads or acts on a page, preserving window ownership.
		const playwright = new Lazy<IPlaywrightService>(() => {
			if (windowDisposables.isDisposed) { throw new Error('BrowserCapabilityUnavailable'); }
			const browserPort = this.sharedProcess.connect(context);
			const browserClient = browserConnection.add(new MessagePortClient({
				postMessage: data => browserPort.postMessage(data), start: () => browserPort.start(), close: () => browserPort.close(),
				addEventListener: (type, listener) => type === 'message' ? browserPort.on('message', listener) : browserPort.on('close', listener as () => void), removeEventListener: (type, listener) => type === 'message' ? browserPort.off('message', listener) : browserPort.off('close', listener as () => void),
			}, context));
			browserClient.registerChannel('browserViewGroup', ProxyChannel.fromService(browserGroups, browserConnection));
			// A worker crash retires its debugger leases, while the user's live pages remain in Main.
			browserPort.once('close', () => browserGroups.dispose());
			return ProxyChannel.toService<IPlaywrightService>(browserClient.getChannel('playwright'));
		});
		browserServices.registerInstance(IPlaywrightService, {
			getObservation: async (...args) => playwright.value.getObservation(...args),
			performAction: async (...args) => playwright.value.performAction(...args),
			// Cancellation and direct-CDP cleanup must not start an unused worker.
			cancelOperation: async id => { await playwright.rawValue?.cancelOperation(id); },
			disposeSession: async sessionId => { await playwright.rawValue?.disposeSession(sessionId); },
		});
		const appServerBrowserHost = windowDisposables.add(browserServices.createInstance(AppServerBrowserHost));
		this.browserChannels.set(context, { view: browserViewChannel(browserViewMainService, sharing), host: appServerBrowserHost.getChannel() });
		windowDisposables.add(toDisposable(() => this.browserChannels.delete(context)));
		windowDisposables.add(supervisor.onStateChange(state => {
			if (state === 'crashed' || state === 'restarting' || state === 'stopping' || state === 'stopped') appServerBrowserHost.reset();
		}));
		return browserServices;
	}

	private openSessionsWindow(workspace: IAnyWorkspaceIdentifier, resolvedWorkspace: IWorkspace, handoff?: IOpenAgentsWindowOptions): Promise<void> {
		const opening = this.sessionsWindowOpenQueue.then(() => this.performOpenSessionsWindow(workspace, resolvedWorkspace, handoff));
		this.sessionsWindowOpenQueue = opening.then(() => undefined, () => undefined);
		return opening;
	}

	/** Opens the one Agents window and selects the requesting Workspace before a handoff. */
	private async performOpenSessionsWindow(workspace: IAnyWorkspaceIdentifier, resolvedWorkspace: IWorkspace, handoff?: IOpenAgentsWindowOptions): Promise<void> {
		const workspaces = this.workspaces;
		if (!workspaces) throw new Error('Workspace service is not initialized');
		let sessions = this.sessionsWindow.value;
		if (!sessions) {
			const remoteConnections = this.createRemoteConnections(workspaces);
			const workspaceContext = new WorkspaceContextMainService(workspace, resolvedWorkspace);
			sessions = new SessionsWindowRecord(workspaceContext, remoteConnections);
			this.sessionsWindow.value = sessions;
		}
		const session = sessions;
		const sessionsEntry = this.resolveRendererEntry("sessions");
		const sessionsWindowState = this.createWindowsStateHandler(UNKNOWN_EMPTY_WINDOW_WORKSPACE, {
			storageKey: 'sessionsWindowState',
			// Agents uses the user-requested 1200 × 800 workspace default even before a project is selected.
			defaultState: defaultWindowState(WorkbenchState.WORKSPACE),
		});
		const titleBarStyle = this.titleBarStyle;
		const wasOpen = this.windowsMainService.managedWindow(AGENTS_WINDOW_KEY) !== undefined;
		await this.windowsMainService.openManagedWindow(
			AGENTS_WINDOW_KEY,
			options => new BrowserWindow(options),
			{
				title: `${AshWorkbenchName} Sessions`,
				titleBarStyle,
				workspace: session.workspaceContext.getWorkspace(),
				isSessionsWindow: true,
				icon: this.windowIconPath,
				state: this.windowsMainService.getNewWindowState(sessionsWindowState, this.windowConfigurationValues(), this.lifecycleMainService.wasRestarted),
				webPreferences: this.createSandboxWebPreferences(),
				initialize: async (window, windowDisposables) => {
					this.configureWindowNavigation(window, windowDisposables, titleBarStyle);
					const tracking = windowDisposables.add(sessionsWindowState.trackWindow(window));
					session.windowState = { window, handler: sessionsWindowState, tracking };
					windowDisposables.add(toDisposable(() => this.globalKeybindings.removeWindow(window.id)));
					windowDisposables.add(toDisposable(() => this.dialogs.cancelWindow(window)));
					const onFocus = (): void => {
						this.windowSessionStateHandler.windowFocused(window.id);
					};
					window.on('focus', onFocus);
					windowDisposables.add(toDisposable(() => window.removeListener('focus', onFocus)));
					// Reloaded renderers must register their current system-wide keybindings again.
					const clearInterruptedKeybindings = (): void => {
						// Contribution leases belong to the live window and handle navigation themselves.
						this.globalKeybindings.updateKeybindings(window.id, []);
					};
					windowDisposables.add(this.windowsMainService.getWindowById(window.id)!.onWillLoad(clearInterruptedKeybindings));
					window.webContents.on('render-process-gone', clearInterruptedKeybindings);
					windowDisposables.add(toDisposable(() => {
						if (window.isDestroyed()) return;
						window.webContents.removeListener('render-process-gone', clearInterruptedKeybindings);
					}));
					const runtimeResources = new DisposableStore();
					let sessionsRelay: AppServerConnectionRelay;
					try {
						sessionsRelay = windowDisposables.add(this.createAppServerConnectionRelay(session.workspaceContext.getWorkspace(), runtimeResources, undefined, 'agents'));
						this.trackAppServerConnection(window, sessionsRelay, windowDisposables);
						// Start before routes bind the renderer so daemon selection overlaps page loading.
						if (this.appServerStartupMode === 'required') await sessionsRelay.start();
					} catch (error) {
						runtimeResources.dispose();
						throw error;
					}
					session.supervisor = sessionsRelay;
					session.runtimeResources.value = runtimeResources;
					const localSessionsRelay = getWorkspaceRemoteAuthority(session.workspaceContext.getWorkspace())?.startsWith('ssh+')
						? windowDisposables.add(this.createAppServerConnectionRelay(session.workspaceContext.getWorkspace(), runtimeResources, undefined, 'agents', 'local'))
						: undefined;
					if (localSessionsRelay) this.trackAppServerConnection(window, localSessionsRelay, windowDisposables);

					const remotePortForwardingService = new SshPortForwardingService({
						getWorkspace: () => session.workspaceContext.getWorkspace(),
						sshExecutable: process.env.ASH_SSH_PATH ?? "ssh",
						localEnvironment: process.env,
					});
					const systemContextMenu = windowDisposables.add(new ElectronContextMenu(window));
					const browserServices = this.createBrowserServices(window, session.workspaceContext, remotePortForwardingService, windowDisposables, sessionsRelay, systemContextMenu);
					const chatGPT = windowDisposables.add(new ChatGPTTransport({
						credentialFile: join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'),
						readVerificationScript: async signal => {
							const devURL = process.env.ASH_RENDERER_URL;
							if (devURL) {
								const response = await electronSession.defaultSession.fetch(new URL('browser/chatgpt/verification.js', devURL).href, { signal });
								if (!response.ok) { throw new Error('ChatGPT verification script is unavailable'); }
								return response.text();
							}
							return readFile(join(this.rendererRoot, 'browser/chatgpt/verification.js'), { encoding: 'utf8', signal });
						},
						createRuntime: authorize => new ChatGPTVerificationRuntime(authorize),
					}));
					const chatGPTContext = `window:${window.id}`;
					this.chatGPTChannels.set(chatGPTContext, chatGPT.getChannel());
					windowDisposables.add(toDisposable(() => this.chatGPTChannels.delete(chatGPTContext)));

					const remoteWindowContext = windowDisposables.add(new RemoteWindowMainContext({
						supervisor: sessionsRelay,
						workspaceContext: session.workspaceContext,
						connections: session.remoteConnections,
						tunnels: remotePortForwardingService,
						host: electronRemoteWindowMainHost(window, this.dialogs),
						prepareForRuntimeReplacement: () => this.windowsMainService.getWindowById(window.id)?.send("ash:terminal:prepareReplacement"),
					}));
					const agentHostTarget = {
						webContents: window.webContents,
						allowedEntryUrls: new Set([normalizeEntryUrl(sessionsEntry.url)]),
					};
					const agentHosts = windowDisposables.add(new RemoteAgentHostConnectionPool(session.remoteConnections, (target, id) => {
						const resources = new DisposableStore();
						try {
							const workspace = { id: `agent-host:${id}`, uri: createSshRemoteWorkspaceUri(target.host, target.workspace) };
							const relay = resources.add(this.createAppServerConnectionRelay(workspace, resources, undefined, 'agents', { id }));
							resources.add(this.trustedIpcRouter.register(agentHostTarget, relay.routes(window.webContents, () => ({ workspaceId: workspace.id, workspaceRoot: target.workspace }))));
							return resources;
						} catch (error) {
							resources.dispose();
							throw error;
						}
					}));
					const retireAgentHosts = (): void => agentHosts.reset();
					window.webContents.on('did-navigate', retireAgentHosts);
					window.webContents.on('render-process-gone', retireAgentHosts);
					windowDisposables.add(toDisposable(() => {
						window.webContents.removeListener('did-navigate', retireAgentHosts);
						window.webContents.removeListener('render-process-gone', retireAgentHosts);
					}));
					const ipcRoutes = [
						...this.mainProcessIpcRoutes(window),
						...this.terminalLifetimeRoutes(windowDisposables),
						...agentHosts.routes(),
						...sessionsRelay.routes(window.webContents, () => ({ workspaceId: AGENTS_WINDOW_KEY, workspaceRoot: this.profileRoot })),
						...(localSessionsRelay?.routes(window.webContents, () => ({ workspaceId: AGENTS_WINDOW_KEY, workspaceRoot: this.profileRoot })) ?? []),
						...rendererSystemHostRoutes(window, path => this.directoryPermissionPrompt(path), this.auxiliaryWindowsMainService),
						...this.globalKeybindings.createWindowRoutes(window, windowDisposables),
						...windowDisposables.add(new ImageViewMainService(window, {
							entry: this.resolveRendererEntry('imageView'), webPreferences: this.createSandboxWebPreferences(),
							router: this.trustedIpcRouter, localization: () => this.activeLanguagePack,
						})).routes(),
						userConfigurationIpcRoute(this.profileRoot, () => !getWorkspaceRemoteAuthority(session.workspaceContext.getWorkspace()), openUserConfigurationTextFile),
						...remoteWindowContext.ipcRoutes,
						windowOperationIpcRoute(this.windowsMainService, window),
						...windowSplashIpcRoutes(this.themeMainService, () => `sessions:${session.workspaceContext.getWorkspace().id}`, color => window.setBackgroundColor(color)),
						...nativeHostIpcRoutes({
							getTitleBarStyle: () => titleBarStyle,
							...this.windowHostOperations(window, windowDisposables),
							openWindow: async options => {
								if (options.forceReuseWindow) {
									const existing = this.windowsMainService.getLastActiveWindow('workbench');
									if (existing) {
										this.windowsMainService.getWindowById(existing.id)!.focus();
										return;
									}
								}
								const workspace = { ...createEmptyWorkspaceIdentifier(), ...(options.remoteAuthority ? { remoteAuthority: options.remoteAuthority } : {}) };
								// Reuse applies only to IDE windows; Agents keeps its own renderer and state.
								await this.openWorkspace(workspace, workspaces);
							},
							openWorkspace: async (root, forceNewWindow) => { await this.openWorkspace(await workspaces.resolveFolder(root), workspaces, forceNewWindow); },
							openAgentsWindow: options => this.openSessionsWindow(session.workspaceContext.getWorkspace(), session.workspaceContext.getResolvedWorkspace(), options),
							syncSystemWideKeybindings: bindings => this.globalKeybindings.updateKeybindings(window.id, bindings.filter(binding => binding.commandId === OPEN_AGENTS_WINDOW_COMMAND_ID)),
						}),
						...workspaceContextIpcRoutes(session.workspaceContext),
						{
							channel: AGENTS_WINDOW_HANDOFF_TAKE_CHANNEL,
							validate: validateAgentsWindowHandoffTake,
							invoke: () => this.windowsMainService.takeManagedWindowHandoff(AGENTS_WINDOW_KEY),
						},
						{
							channel: AGENTS_WINDOW_HANDOFF_COMPLETE_CHANNEL,
							validate: validateAgentsWindowHandoffComplete,
							invoke: (result: unknown) => this.windowsMainService.completeManagedWindowHandoff(AGENTS_WINDOW_KEY, result as IAgentsWindowHandoffResult),
						},
						{
							channel: RETURN_TO_WORKBENCH_CHANNEL,
							validate: validateReturnToWorkbench,
							invoke: async () => {
								// Keep one window alive when Agents is the only restored window.
								const opened = await this.openWorkspace(session.workspaceContext.getWorkspace(), workspaces);
								await this.windowsMainService.closeManagedWindow(AGENTS_WINDOW_KEY);
								if (opened) this.windowsMainService.getWindowById(opened.window.id)?.focus();
							},
						},
						windowCloseResponseIpcRoute(this.lifecycleMainService, window),
					];
					ipcRoutes.push(...this.contextMenuIpcRoutes(systemContextMenu));
					if (this.nativeMenubar) {
						windowDisposables.add(this.nativeMenubar.registerWindow(window));
						ipcRoutes.push(...nativeMenubarIpcRoutes(this.nativeMenubar, window));
					}
					windowDisposables.add(this.trustedIpcRouter.register(
						{
							webContents: window.webContents,
							allowedEntryUrls: new Set([normalizeEntryUrl(sessionsEntry.url)]),
						},
						ipcRoutes,
					));
					windowDisposables.add(this.mainProcessIpcServer.registerClient(window.webContents, `window:${window.id}`, new Set([normalizeEntryUrl(this.resolveRendererEntry('sessions').url)])));
					windowDisposables.add(this.lifecycleMainService.registerWindow(window));
					windowDisposables.add(session.workspaceContext.onDidChangeWorkspace(({ workspace, resolvedWorkspace }) => {
						if (!window.isDestroyed()) {
							this.windowsMainService.updateWorkspace(window.id, workspace);
							this.windowsMainService.getWindowById(window.id)?.send(WORKSPACE_CONTEXT_CHANGED_CHANNEL, serializeWorkspace(resolvedWorkspace));
						}
					}));
					await this.windowsMainService.getWindowById(window.id)!.load(sessionsEntry);
				},
			},
			() => {
				const closedWorkspace = session.workspaceContext.getWorkspace();
				if (this.sessionsWindow.value === session) this.sessionsWindow.clear();
				this.windowSessionStateHandler.windowClosed({ kind: 'sessions', workspace: closedWorkspace });
			},
		);
		await this.selectSessionsWorkspace(session, workspace, resolvedWorkspace);
		if (!wasOpen) this.windowSessionStateHandler.windowOpened();
		if (handoff) {
			const completed = this.windowsMainService.enqueueManagedWindowHandoff(AGENTS_WINDOW_KEY, handoff);
			const window = this.windowsMainService.managedWindow(AGENTS_WINDOW_KEY);
			if (!window) throw new Error('Agents Window is unavailable for handoff');
			this.windowsMainService.getWindowById(window.id)?.send(AGENTS_WINDOW_HANDOFF_AVAILABLE_CHANNEL);
			await completed;
		}
	}

	private async selectSessionsWorkspace(session: SessionsWindowRecord, workspace: IAnyWorkspaceIdentifier, resolvedWorkspace: IWorkspace): Promise<void> {
		if (session.workspaceContext.getWorkspace().id !== workspace.id) {
			session.workspaceContext.updateWorkspace(workspace, resolvedWorkspace);
		}
	}

	private resolveRendererEntry(kind: "workbench" | "sessions" | "remoteRuntimeInstall" | "imageView"): RendererEntry {
		const entry = kind === "imageView" ? "imageView" : kind === "workbench"
			? "workbench"
			: kind === "sessions"
				? 'sessions'
				: "remoteRuntimeInstall";
		const directory = kind === "remoteRuntimeInstall" ? "remote-runtime-install" : kind;
		const relativePath = kind === 'sessions'
			? `sessions/electron-browser/${entry}.html`
			: `electron-browser/${directory}/${entry}.html`;
		const file = join(
			this.rendererRoot,
			relativePath,
		);
		const rendererUrl = process.env.ASH_RENDERER_URL;
		const useDevelopmentUrl = !app.isPackaged && rendererUrl !== undefined;
		const baseUrl = useDevelopmentUrl
			? new URL(`/${relativePath}`, rendererUrl).href
			: pathToFileURL(file).href;
		return {
			file,
			url: baseUrl,
			useDevelopmentUrl,
		};
	}

	private createSandboxWebPreferences() {
		return {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			preload: app.isPackaged
				? join(app.getAppPath(), "dist/preload/src/ash/base/parts/sandbox/electron-browser/preload.cjs")
				: developmentArtifactsPath(app.getAppPath(), "preload", "src/ash/base/parts/sandbox/electron-browser/preload.cjs"),
			additionalArguments: [],
		};
	}

	private createWorkspaceTransitionRuntime(
		supervisor: AppServerConnectionRelay,
		workspaceHost: RendererWorkspaceHost,
	): Pick<WorkspaceTransitionMainServiceOptions, "runtime" | "classifyRuntimeError" | "recovery"> {
		if (this.appServerStartupMode === "disabled") {
			return {
				runtime: {
					async switchWorkspace() {
						// UI-only development changes the window context without touching a backend runtime.
					},
				},
				classifyRuntimeError: () => WorkspaceTransitionFailureKind.RuntimeUnavailable,
			};
		}
		const appServerWorkspace = createAppServerWorkspaceTransitionAdapter(supervisor, workspaceHost);
		return {
			runtime: appServerWorkspace,
			classifyRuntimeError: (error) => appServerWorkspace.classifyRuntimeError(error),
			recovery: appServerWorkspace,
		};
	}

	private async resolveRemoteFolderWorkspace(
		currentWorkspace: IAnyWorkspaceIdentifier,
		folderPath: string,
	) {
		const remoteAuthority = getWorkspaceRemoteAuthority(currentWorkspace);
		if (!remoteAuthority) throw new Error("Remote Workspace resolution requires a Remote window");
		const authority = createSshRemoteAuthority(remoteAuthority.slice(4));
		if (!authority || authority.type !== "ssh") throw new Error("Unsupported Remote Workspace authority");
		const workspace = await this.windowsMainService.resolveWorkspaceOpenTarget({ kind: WorkspaceOpenTargetKind.RemoteFolder, path: folderPath, sshHost: authority.host }, process.cwd());
		if (!isSingleFolderWorkspaceIdentifier(workspace) || !isRemoteWorkspaceIdentifier(workspace)) {
			throw new Error("Remote folder did not resolve to a Remote Workspace");
		}
		return workspace;
	}

	private async openRemoteConnection(connection: RemoteConnectionDefinition, workspaces: WorkspacesManagementMainService): Promise<void> {
		if (this.quitRequested) return;
		const workspace = await this.windowsMainService.resolveWorkspaceOpenTarget({ kind: WorkspaceOpenTargetKind.RemoteFolder, path: connection.workspace, sshHost: connection.host }, process.cwd());
		await this.openWorkspace(workspace, workspaces);
	}

	private async reportWindowOpenFailure(error: unknown): Promise<void> {
		console.error("Failed to open Workbench window", error);
		if (this.quitRequested) return;
		const message = error instanceof Error ? error.message : "The requested Workspace could not be opened";
		try {
			await this.dialogs.showMessageBox({
				type: "error",
				title: `${AshWorkbenchName} window failed`,
				message: "The requested Workspace could not be opened.",
				detail: message.slice(0, 8_000),
				buttons: ["OK"],
				defaultId: 0,
				cancelId: 0,
				noLink: true,
			});
		} catch (dialogError) {
			console.error("Failed to report Workbench window open failure", dialogError);
		}
	}

	private readonly onBeforeQuit = (event: ElectronEvent): void => {
		this.quitRequested = true;
		if (this.quitAfterStateSaved) { return; }
		if (this.lifecycleMainService.isStarting) {
			event.preventDefault();
			if (this.quitSaveStarted) { return; }
			this.quitSaveStarted = true;
			void this.lifecycleMainService.stopStartup().catch(error => {
				console.error('Failed to stop Desktop startup before quit', error);
			}).finally(() => {
				// Cancelling before any window opens must preserve the session awaiting restoration.
				if (!this.startupWindowOpeningStarted) { this.quitAfterStateSaved = true; }
				this.quitSaveStarted = false;
				app.quit();
			});
			return;
		}
		if (this.persistentServices) this.windowSessionStateHandler.stopAutomaticSaves();
		const records = [...this.workbenchWindowData.values()];
		if (!this.persistentServices) {
			return;
		}
		event.preventDefault();
		if (this.quitSaveStarted) {
			return;
		}

		this.quitSaveStarted = true;
		const sessionsState = this.sessionsWindow.value?.windowState;
		for (const record of records) record.windowsStateHandler.stopAutomaticSaves();
		sessionsState?.handler.stopAutomaticSaves();
		const activeWindowId = this.windowsMainService.getLastActiveWindow()?.id;
		void (async () => {
			try {
				await this.windowSessionStateHandler.saveSession();
				const placements = records.map(record => ({ window: record.window, handler: record.windowsStateHandler }));
				if (sessionsState) placements.push(sessionsState);
				// The global first-window placement follows activity, not the order that window kinds are saved.
				placements.sort((a, b) => Number(a.window.id === activeWindowId) - Number(b.window.id === activeWindowId));
				for (const placement of placements) {
					if (!placement.window.isDestroyed()) await placement.handler.saveWindowState(placement.window);
				}
			} catch (error) {
				console.error("Failed to flush application state before quit", error);
			} finally {
				this.quitAfterStateSaved = true;
				app.quit();
			}
		})();
	};

	private readonly onAccessibilitySupportChanged = (
		_event: ElectronEvent,
		enabled: boolean,
	): void => {
		for (const record of this.workbenchWindowData.values()) {
			this.windowsMainService.getWindowById(record.window.id)?.send(NATIVE_HOST_ACCESSIBILITY_SUPPORT_CHANGED_CHANNEL, enabled);
		}
		for (const window of this.windowsMainService.managedWindowValues()) {
			this.windowsMainService.getWindowById(window.id)?.send(NATIVE_HOST_ACCESSIBILITY_SUPPORT_CHANGED_CHANNEL, enabled);
		}
	};

	private cancelQuit(): void {
		if (!this.quitRequested) {
			return;
		}
		this.quitRequested = false;
		this.restartRequested = false;
		this.quitSaveStarted = false;
		this.quitAfterStateSaved = false;
		this.windowSessionStateHandler.resumeAutomaticSaves();
		for (const record of this.workbenchWindowData.values()) record.windowsStateHandler.resumeAutomaticSaves();
		this.sessionsWindow.value?.windowState?.handler.resumeAutomaticSaves();
	}

	private readonly onWillQuit = (event: ElectronEvent): void => {
		if (this.quitAfterServicesClosed) {
			// Schedule the new process only after every window accepted shutdown and state was saved.
			if (this.restartRequested && this.developmentLauncher) {
				event.preventDefault();
				this.restartRequested = false;
				// The watcher owns replacement and cleanup. Electron's detached
				// relaunch would escape it and keep the old development profile busy.
				if (process.connected && process.send) process.send('ash:dev:relaunch', () => app.quit());
				else app.quit();
				return;
			}
			if (this.restartRequested) { app.relaunch(); }
			this.dispose();
			this.releaseDisposableTracker();
			return;
		}
		// A window can still veto before this event. Keep its services alive until then.
		event.preventDefault();
		void this.closePersistentServices().catch(error => {
			console.error('Failed to close persistent services before quit', error);
		}).finally(() => {
			this.quitAfterServicesClosed = true;
			app.quit();
		});
	};

	private closePersistentServices(): Promise<void> {
		this.maintenance.clear();
		const services = this.persistentServices;
		this.closePersistentServicesPromise ??= Promise.all([
			this.remoteTunnel.value?.stopTunnel(),
			this.invitationPersistence.catch(() => { }).then(() => this.storageMainService?.close()),
			this.stateService.close(),
			...(services ? [
				services.configuration.dispose(),
				services.userKeyboardLayout.close(),
			] : []),
		]).catch(error => {
			this.logService.error('lifecycle', 'Failed to close persistent services', error);
			throw error;
		}).finally(() => this.loggerService.close()).then(() => undefined);
		return this.closePersistentServicesPromise;
	}

	private trackAppServerConnection(window: BrowserWindow, relay: AppServerConnectionRelay, resources: DisposableStore): void {
		let phaseStarted = performance.now();
		let previousState = relay.state;
		const record = (state: typeof relay.state): void => {
			const now = performance.now();
			const detail = { windowId: window.id, generation: relay.generation, previousState, state, phaseDurationMillis: Math.round(now - phaseStarted) };
			if (state === 'crashed') { this.logService.error('app-server', 'Connection phase', detail, relay.diagnostics()); }
			else { this.logService.info('app-server', 'Connection phase', detail); }
			previousState = state;
			phaseStarted = now;
		};
		// A carrier can start before its window exists. Record its current phase before tracking the handshake.
		record(relay.state);
		resources.add(relay.onStateChange(record));
	}

	private getOpenWindowSessions(): readonly IWindowSessionWindow<WindowSessionEntry>[] {
		const focusedWindowId = BrowserWindow.getFocusedWindow()?.id;
		const session = this.sessionsWindow.value;
		const sessionsWindow = session && this.windowsMainService.managedWindow(AGENTS_WINDOW_KEY);
		return [
			...this.windowsMainService.getWindows().map(window => ({
				id: window.id,
				entry: { kind: 'workbench' as const, workspace: this.workbenchWindowData.get(window.id)!.workspaceContext.getWorkspace(), windowSessionId: this.workbenchWindowData.get(window.id)!.windowSessionId },
				focused: window.id === focusedWindowId,
			})),
			...(sessionsWindow && session ? [{ id: sessionsWindow.id, entry: { kind: 'sessions' as const, workspace: session.workspaceContext.getWorkspace() }, focused: sessionsWindow.id === focusedWindowId }] : []),
		];
	}

	private async resolveDirGrant(workspaceHost: RendererWorkspaceHost, path: string): Promise<WorkspaceTrustGrant | undefined> {
		if (this.appServerStartupMode === "disabled") return { type: "config" };
		const persisted = await workspaceHost.readPermissions(path);
		if (persisted !== undefined) return { type: "config" };
		const choice = await workspaceHost.selectPermissions(path);
		if (choice === 'cancel') return undefined;
		if (choice !== 'development' && choice !== 'readOnly') throw new Error('Invalid directory permission selection');
		return workspaceHost.createGrant(path, choice === 'development' ? DEVELOPMENT_DIR_PERMISSIONS : READ_DIR_PERMISSIONS);
	}

	private directoryPermissionPrompt(path: string): DialogRequest {
		const translate = (key: string, english: string): string => this.activeLanguagePack.bundles.ash?.[key] ?? english;
		return {
			kind: 'prompt',
			title: AshApplicationName,
			primaryButton: translate('workspaceTrust.readOnly', localize2('workspaceTrust.readOnly', 'Open Read-Only').original),
			secondaryButton: translate('workspaceTrust.trust', localize2('workspaceTrust.trust', 'Trust Folder').original),
			cancelButton: translate('dialog.cancel', localize2('dialog.cancel', 'Cancel').original),
			message: translate('workspaceTrust.question', localize2('workspaceTrust.question', 'Do you trust the files in this folder?').original),
			detail: formatNlsMessage(
				translate('workspaceTrust.detail', localize2('workspaceTrust.detail', 'Folder: {0}\n\nTrusting this folder allows Ash to edit files and run commands. Open read-only to browse and search without making changes.').original),
				{ '0': path },
			),
		};
	}

	private createWindowsStateHandler(
		workspace: IAnyWorkspaceIdentifier,
		options?: { readonly storageKey: string; readonly defaultState: IWindowState; },
	): WindowsStateHandler {
		return new WindowsStateHandler({
			stateService: this.services.state,
			workspace,
			...options,
			displayService: {
				onDidChangeDisplays: listener => {
					const changed = (): void => { listener(); };
					screen.on('display-metrics-changed', changed);
					screen.on('display-added', changed);
					screen.on('display-removed', changed);
					return toDisposable(() => {
						screen.removeListener('display-metrics-changed', changed);
						screen.removeListener('display-added', changed);
						screen.removeListener('display-removed', changed);
					});
				},
				getAllDisplays: () => screen.getAllDisplays(),
				getPrimaryDisplay: () => screen.getPrimaryDisplay(),
				getDisplayMatching: (bounds) => screen.getDisplayMatching(bounds),
				getCursorDisplay: () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()),
			},
			onError: (error) => {
				console.error("Failed to save window state", error);
			},
		});
	}

	private get services(): PersistentServices {
		assertDefined(this.persistentServices, "Persistent application services are not initialized");
		return this.persistentServices;
	}

	private get titleBarStyle(): TitleBarStyleConfiguration {
		const value = this.services.configuration.getValue(TitleBarSetting.TitleBarStyle);
		return parseTitleBarStyle(value ?? 'custom');
	}

	private releaseDisposableTracker(): void {
		try {
			this.disposableTracker?.assertNoLeaks();
		} finally {
			this.tracking?.[Symbol.dispose]();
		}
	}
}

function isWindowSessionEntry(entry: IWindowSessionEntry): entry is WindowSessionEntry {
	return entry.kind === 'workbench' || entry.kind === 'sessions';
}

function workspaceTransitionError(
	failure: IWorkspaceTransitionFailure | undefined,
): Error {
	if (!failure) return new Error("Workspace transition failed without a classified failure");
	if (failure.error instanceof Error) return failure.error;
	return new Error(`Workspace transition failed during ${failure.stage}`);
}
