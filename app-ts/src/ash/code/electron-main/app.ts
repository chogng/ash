import { AshWorkbenchName, AshSessionsRendererEntry } from '../common/application.js';
import { randomUUID } from 'node:crypto';
import { isAdmin } from '../../platform/native/electron-main/nativeHostMainService.js';
import { ChecksumService, checksumChannel } from '../../platform/checksum/node/checksumService.js';
import { URLHandlerChannel, URLHandlerChannelClient } from '../../platform/url/common/urlIpc.js';
import type { IOpenURLOptions } from '../../platform/url/common/url.js';
import { hooksConfigurationIpcRoute, openHooksTextFile } from '../../platform/hooks/electron-main/hooksConfigurationIpc.js';
import { ThemeMainService } from '../../platform/theme/electron-main/themeMainServiceImpl.js';
import { Server as MainProcessIPCServer } from '../../base/parts/ipc/electron-main/ipc.electron.js';
import { isRecord } from '../../base/common/types.js';
import { isUuid } from '../../base/common/uuid.js';
import { OAuthCallbackHost } from "../../platform/connectors/electron-main/oauthCallbackHost.js";
import { RendererWorkspaceHost } from "../../platform/workspaces/electron-main/rendererWorkspaceHost.js";
import { AppServerBrowserHost } from "../../platform/app-server/electron-main/appServerBrowserHost.js";
import { rendererSystemHostRoutes } from "../../platform/native/electron-main/rendererSystemHostRoutes.js";
import { nativeImage, nativeTheme, shell } from "electron";
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen, Menu, Tray, type Event as ElectronEvent, type MenuItemConstructorOptions } from "electron/main";
import type { DirGrant } from "../../platform/dirPermissions/common/dirPermissionsService.js";
import { basename, delimiter, dirname, isAbsolute, join, parse } from "node:path";
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { constants, readFileSync, watch } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { throwIfCancelled, type CancellationToken } from "../../base/common/cancellation.js";
import { isCancellationError } from "../../base/common/errors.js";
import { createUuid } from '../../base/common/uuid.js';
import { Disposable, DisposableMap, DisposableStore, DisposableTracker, MutableDisposable, installDisposableTracker, type IDisposable, toDisposable } from "../../base/common/lifecycle.js";
import { assertDefined } from "../../base/common/types.js";
import { AshApplicationId, AshApplicationName } from '../common/application.js';
import { ElectronContextMenu } from "../../base/parts/contextmenu/electron-main/contextmenu.js";
import { AppServerConnectionRelay } from "../../platform/app-server/electron-main/appServerConnectionRelay.js";
import { DevelopmentAppServerReloader } from "../../platform/app-server-daemon/electron-main/developmentAppServerReloader.js";
import { AppServerDaemonLauncher, createAppServerDaemonLauncher } from "../../platform/app-server-daemon/electron-main/appServerDaemonLauncher.js";
import { remoteExecutablePath } from "../../platform/remote/node/remotePackage.js";
import { normalizeEntryUrl, TrustedIpcRouter, type IpcRoute } from "../../platform/ipc/electron-main/trustedIpcRouter.js";
import { BROWSER_VIEW_EVENT_CHANNEL } from "../../platform/browserView/common/browserView.js";
import { browserViewIpcRoutes } from "../../platform/browserView/electron-main/browserViewIpc.js";
import { BrowserViewMainService, IBrowserViewMainService } from "../../platform/browserView/electron-main/browserViewMainService.js";
import { Client as MessagePortClient } from '../../base/parts/ipc/common/ipc.mp.js';
import { ProxyChannel } from '../../base/parts/ipc/common/ipc.js';
import { UtilityProcess } from '../../platform/utilityProcess/electron-main/utilityProcess.js';
import { BrowserViewGroupMainService } from '../../platform/browserView/electron-main/browserViewGroupMainService.js';
import { IPlaywrightService } from '../../platform/browserView/common/playwrightService.js';
import { WebContentsView, session as electronSession } from 'electron/main';
import { configurationValues } from '../../platform/configuration/common/configurationIpc.js';
import { formatNlsMessage } from '../../nls.js';
import { ConfigurationMainService } from "../../platform/configuration/electron-main/configurationMainService.js";
import { nativeContextMenuIpcRoutes } from "../../platform/contextview/electron-main/contextMenuIpc.js";
import { developmentArtifactsPath } from "../../platform/environment/node/developmentArtifacts.js";
import { normalizeExternalUrl } from '../../platform/opener/common/opener.js';
import { NativeKeyboardLayoutMainService } from "../../platform/keyboardLayout/electron-main/nativeKeyboardLayoutMainService.js";
import { UserKeyboardLayoutMainService } from "../../platform/keyboardLayout/electron-main/userKeyboardLayoutMainService.js";
import { NativeMenubarMainService, nativeMenubarIpcRoutes } from "../../platform/menubar/electron-main/menubarMainService.js";
import { clearElectronApplicationMenu, createElectronMenubarHost } from "../../platform/menubar/electron-main/menubar.js";
import { colorSchemeChannel, fileDialogIpcRoutes, nativeHostIpcRoutes, windowAppearanceIpcRoutes, type INativeHostMainService } from "../../platform/native/electron-main/nativeHostIpc.js";
import { UpdateMainService, updateIpcRoutes } from '../../platform/update/electron-main/updateMainService.js';
import { NATIVE_HOST_ACCESSIBILITY_SUPPORT_CHANGED_CHANNEL, NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL, NATIVE_HOST_SYNC_SYSTEM_WIDE_KEYBINDINGS_CHANNEL, validateOpenAgentsWindow, validateSystemWideKeybindings, type INativeSystemWideKeybinding, type IOpenAgentsWindowOptions } from "../../platform/native/common/nativeHost.js";
import { DialogMainService } from '../../platform/dialogs/electron-main/dialogMainService.js';
import type { DialogRequest } from '../../platform/dialogs/common/dialogs.js';
import { AGENTS_WINDOW_HANDOFF_AVAILABLE_CHANNEL, AGENTS_WINDOW_HANDOFF_COMPLETE_CHANNEL, AGENTS_WINDOW_HANDOFF_TAKE_CHANNEL, RETURN_TO_WORKBENCH_CHANNEL, validateAgentsWindowHandoffComplete, validateAgentsWindowHandoffTake, validateReturnToWorkbench, type IAgentsWindowHandoffResult } from '../../sessions/common/windowNavigation.js';
import { GlobalKeybindingsMainService } from '../../platform/globalKeybindings/electron-main/globalKeybindingsMainService.js';
import { OPEN_AGENTS_WINDOW_COMMAND_ID } from '../../workbench/contrib/chat/common/constants.js';
import { StateService } from "../../platform/state/node/stateService.js";
import { IStateService } from '../../platform/state/node/state.js';
import { WorkspacesHistoryMainService } from '../../platform/workspaces/electron-main/workspacesHistoryMainService.js';
import { recentWorkspaceUri, restoreRecentlyOpened, toStoreData, RECENTLY_OPENED_CHANGED_CHANNEL, type IRecent } from '../../platform/workspaces/common/workspaces.js';
import { Schemas } from '../../base/common/network.js';
import { resolveHome } from "../../platform/home/node/home.js";
import { diskFileSystemProviderRoutes } from "../../platform/files/electron-main/diskFileSystemProviderServer.js";
import { URI } from "../../base/common/uri.js";
import { extUriBiasedIgnorePathCase } from '../../base/common/resources.js';
import { DiskFileSystemProvider } from "../../platform/files/node/diskFileSystemProvider.js";
import { LOCAL_FILE_SYSTEM_CHANGED_CHANNEL } from "../../platform/files/common/diskFileSystemProviderClient.js";
import { IWindowsMainService, WindowControlsOverlay, type IOpenConfiguration } from "../../platform/windows/electron-main/windows.js";
import { RESTORE_WINDOWS_SETTING, TitleBarSetting, parseTitleBarStyle, type TitleBarStyleConfiguration } from "../../platform/window/common/window.js";
import { WindowsStateHandler, WindowSessionStateHandler, type IWindowSessionEntry, type IWindowSessionWindow } from "../../platform/windows/electron-main/windowsStateHandler.js";
import { WindowsMainService, trackWindowResourceChanges, windowOperationIpcRoute, windowResourceIpcRoutes, workspaceContextIpcRoutes, workspaceRecoveryIpcRoute } from "../../platform/windows/electron-main/windowsMainService.js";
import { LifecycleMainService, windowCloseResponseIpcRoute } from '../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { defaultWindowState, focusWindow, WorkspaceContextMainService, type IWindowState } from "../../platform/window/electron-main/window.js";
import { type IAnyWorkspaceIdentifier, type IWorkspace, getWorkspaceRemoteAuthority, isRemoteWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier, serializeWorkspace, UNKNOWN_EMPTY_WINDOW_WORKSPACE, WorkbenchState } from "../../platform/workspace/common/workspace.js";
import { createEmptyWorkspaceIdentifier } from "../../platform/workspaces/node/workspaces.js";
import { packagedRemoteRuntimeCatalogSource } from "../../platform/remote/electron-main/packagedRemoteRuntimeCatalog.js";
import { RemoteRuntimeInstaller, remoteRuntimeArtifactFromEnvironment } from "../../platform/remote/electron-main/remoteRuntimeInstaller.js";
import { RemoteRuntimeProvisioner } from "../../platform/remote/electron-main/remoteRuntimeProvisioner.js";
import { RemoteConnectionProfiles } from "../../platform/remote/electron-main/remoteConnectionProfiles.js";
import { RemoteConnections } from "../../platform/remote/electron-main/remoteConnections.js";
import { UnavailableRemoteConnectionService, type IRemoteConnectionService } from "../../platform/remote/common/remoteConnectionService.js";
import type { RemoteConnectionDefinition } from "../../platform/remote/common/remoteConnectionService.js";
import { createSshRemoteAuthority, getRemoteAuthority, isRemoteResource } from "../../platform/remote/common/remote.js";
import { SshRemoteTunnelService } from "../../platform/remote/electron-main/sshRemoteTunnelService.js";
import { createRemoteRuntimeInstallProgressLogger } from "../../platform/remote/electron-main/remoteRuntimeBootstrapMainService.js";
import { RemoteRuntimeBootstrapMainService } from "../../platform/remote/electron-main/remoteRuntimeBootstrapMainService.js";
import { RemoteAppServerProcessLauncher } from "../../platform/remote/electron-main/remoteAppServerProcessLauncher.js";
import { ElectronRemoteRuntimeInstallWindow } from "../../platform/remote/electron-main/electronRemoteRuntimeInstallWindow.js";
import { electronRemoteWindowMainHost } from "../../platform/remote/electron-main/electronRemoteWindowMainHost.js";
import { RemoteWindowMainContext } from "../../platform/remote/electron-main/remoteWindowMainContext.js";
import { WORKSPACE_CONTEXT_CHANGED_CHANNEL } from "../../platform/workspace/common/workspaceIpc.js";
import { createAppServerWorkspaceTransitionAdapter } from "../../platform/workspaces/electron-main/appServerWorkspaceTransition.js";
import { DEVELOPMENT_DIR_PERMISSIONS, READ_DIR_PERMISSIONS } from '../../platform/workspace/common/workspaceTrust.js';
import { type IWorkspaceTransitionFailure, type WorkspaceTransitionMainServiceOptions, WorkspaceTransitionFailureKind, WorkspaceTransitionMainService, WorkspaceTransitionStatus } from "../../platform/workspaces/electron-main/workspaceTransitionMainService.js";
import { WorkspacesManagementMainService } from '../../platform/workspaces/electron-main/workspacesManagementMainService.js';
import { StorageMainService } from '../../platform/storage/electron-main/storageMainService.js';
import { StorageDatabaseChannel } from '../../platform/storage/electron-main/storageIpc.js';
import { LoggerService } from '../../platform/log/node/loggerService.js';
import { LoggerChannel } from '../../platform/log/electron-main/logIpc.js';
import { disposableTimeout } from '../../base/common/async.js';
import { WorkspaceOpenTargetKind } from '../../platform/environment/common/argv.js';
import { parseLaunchArguments, parseMainProcessArgv, windowsCommandLine } from '../../platform/environment/node/argvHelper.js';
import { LaunchMainService, parseWindowLaunch, type IStartArguments } from '../../platform/launch/electron-main/launchMainService.js';
import { InstantiationService } from '../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import { IAuxiliaryWindowsMainService } from '../../platform/auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { AuxiliaryWindowsMainService } from '../../platform/auxiliaryWindow/electron-main/auxiliaryWindowsMainService.js';
import { nodeWorkspacePathService } from '../../platform/workspaces/node/workspaces.js';
import { LocalizationConfiguration } from '../../workbench/services/localization/common/locale.js';
import { builtinLanguagePackCatalogs } from '../../workbench/services/localization/common/localizationCatalogs.js';
import { normalizeLocale } from '../../platform/languagePacks/common/languagePackCatalog.js';
import { parseLanguagePackCatalog } from '../../platform/languagePacks/common/languagePackCatalog.js';
import type { LanguagePackCatalog } from '../../platform/languagePacks/common/languagePacksService.js';
import { LanguagePackStore } from '../../platform/languagePacks/node/languagePackStore.js';
import { LANGUAGE_PACK_READ_CHANNEL, LANGUAGE_PACK_WRITE_CHANNEL, NLS_CONFIGURATION_CHANNEL } from '../../platform/languagePacks/common/languagePackStore.js';
import { HOST_RESTART_CHANNEL, WINDOW_OPEN_EXTERNAL_URI_CHANNEL } from '../../platform/window/common/window.js';
export type AppServerStartupMode = "required" | "disabled";

export interface AshApplicationOptions {
	readonly rendererRoot: string;
	/** Selects whether this Electron process starts the App Server before opening its window. */
	readonly appServerStartupMode: AppServerStartupMode;
	/** Host-selected IPC capabilities installed for every Workbench window. */
}

interface PersistentServices {
	readonly state: StateService;
	readonly configuration: ConfigurationMainService;
	readonly userKeyboardLayout: UserKeyboardLayoutMainService;
}

interface RendererEntry {
	readonly file: string;
	readonly url: string;
	readonly useDevelopmentUrl: boolean;
}

interface WorkbenchWindowRecord {
	readonly id: number;
	readonly window: BrowserWindow;
	readonly workspaceContext: WorkspaceContextMainService;
	readonly supervisor: AppServerConnectionRelay;
	readonly resources: DisposableStore;
	readonly remoteConnections: IRemoteConnectionService;
	windowsStateHandler: WindowsStateHandler;
	windowStateTracking: IDisposable;
	openWorkspace?: (root: string) => Promise<void>;
	replaceWorkspace?: (workspace: IAnyWorkspaceIdentifier) => Promise<boolean>;
}

class SessionsWindowRecord extends Disposable {
	readonly workspaceContext: WorkspaceContextMainService;
	readonly remoteConnections: IRemoteConnectionService;
	readonly runtimeResources = this._register(new MutableDisposable<DisposableStore>());
	supervisor: AppServerConnectionRelay | undefined;
	windowState: { readonly window: BrowserWindow; readonly handler: WindowsStateHandler; readonly tracking: IDisposable } | undefined;
	private readonly handoffs = new Map<string, { readonly options: IOpenAgentsWindowOptions; readonly resolve: () => void; readonly reject: (error: Error) => void }>();
	private readonly handoffQueue: string[] = [];

	constructor(workspaceContext: WorkspaceContextMainService, remoteConnections: IRemoteConnectionService) {
		super();
		this.workspaceContext = this._register(workspaceContext);
		this.remoteConnections = remoteConnections;
		this._register(toDisposable(() => this.rejectHandoffs(new Error('Agents Window closed before the handoff completed'))));
	}

	get workspaceId(): string { return this.workspaceContext.getWorkspace().id; }

	enqueueHandoff(options: IOpenAgentsWindowOptions): Promise<void> {
		const id = createUuid();
		return new Promise<void>((resolve, reject) => {
			this.handoffs.set(id, { options, resolve, reject });
			this.handoffQueue.push(id);
		});
	}

	takeHandoff(): { readonly id: string; readonly options: IOpenAgentsWindowOptions } | undefined {
		const id = this.handoffQueue.shift();
		const handoff = id ? this.handoffs.get(id) : undefined;
		return handoff && id ? { id, options: handoff.options } : undefined;
	}

	completeHandoff(result: IAgentsWindowHandoffResult): void {
		const handoff = this.handoffs.get(result.id);
		if (!handoff) throw new Error('Agents Window handoff is not pending');
		this.handoffs.delete(result.id);
		if (result.error) handoff.reject(new Error(result.error));
		else handoff.resolve();
	}

	rejectHandoffs(error: Error): void {
		for (const handoff of this.handoffs.values()) handoff.reject(error);
		this.handoffs.clear();
		this.handoffQueue.length = 0;
	}
}

type WindowSessionEntry =
	| { readonly kind: 'workbench'; readonly workspace: IAnyWorkspaceIdentifier }
	| { readonly kind: 'sessions'; readonly workspace: IAnyWorkspaceIdentifier };

const AGENTS_WINDOW_KEY = 'agents';

async function watchProfileFiles(profileRoot: string, window: BrowserWindow, resources: DisposableStore): Promise<void> {
	await mkdir(join(profileRoot, 'themes'), { recursive: true });
	const watcher = watch(profileRoot, { persistent: false, recursive: true }, (_event, filename) => {
		const resources = filename === null ? undefined : [URI.file(join(profileRoot, filename.toString())).toString()];
		window.webContents.send(LOCAL_FILE_SYSTEM_CHANGED_CHANNEL, resources);
	});
	watcher.on('error', error => console.error('Failed to watch user profile files', error));
	resources.add(toDisposable(() => watcher.close()));
}

/** Owns the Electron application's persistent services, Workbench windows, IPC, and shutdown. */
export class AshApplication extends Disposable {
	private readonly rendererRoot: string;
	private readonly appServerStartupMode: AppServerStartupMode;
	private readonly disposableTracker: DisposableTracker | undefined;
	private readonly tracking: globalThis.Disposable | undefined;
	private readonly trustedIpcRouter: TrustedIpcRouter;
	private readonly mainProcessIpcServer = this._register(new MainProcessIPCServer());
	private readonly sharedProcess = this._register(new UtilityProcess({
		name: 'Ash Browser Automation',
		entryPoint: fileURLToPath(new URL('../electron-utility/sharedProcess/sharedProcessMain.js', import.meta.url)),
	}));
	private readonly updateMainService: UpdateMainService;
	private readonly nativeKeyboardLayout: NativeKeyboardLayoutMainService;
	private readonly globalKeybindings: GlobalKeybindingsMainService;
	private readonly nativeMenubar: NativeMenubarMainService | undefined;
	private readonly profileRoot: string;
	private activeLanguagePack: LanguagePackCatalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'en')!;
	private restartRequested = false;
	private readonly developmentAppServerReloader = this._register(new MutableDisposable<DevelopmentAppServerReloader>());
	private readonly windowIconPath: string | undefined;

	// Product resources follow platform-owned windows; this map does not select or reuse windows.
	private readonly workbenchWindowData = new Map<number, WorkbenchWindowRecord>();
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
				await this.windowsMainService.whenReady(record.window);
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
	private readonly loggerService = this._register(new LoggerService({ logsHome: app.getPath('logs') }));
	private readonly logService = this._register(this.loggerService.createLogger('main'));
	private readonly maintenance = this._register(new MutableDisposable<IDisposable>());
	private closePersistentServicesPromise: Promise<void> | undefined;
	private quitRequested = false;
	private quitAfterServicesClosed = false;
	private quitAfterStateSaved = false;
	private quitSaveStarted = false;

	private constructor(
		options: AshApplicationOptions,
		private readonly stateService: StateService,
		disposableTracker: DisposableTracker | undefined,
		tracking: globalThis.Disposable | undefined,
	) {
		super();
		this.rendererRoot = options.rendererRoot;
		this.appServerStartupMode = options.appServerStartupMode;
		this.disposableTracker = disposableTracker;
		this.tracking = tracking;
		this.trustedIpcRouter = this._register(new TrustedIpcRouter(ipcMain));
		this.updateMainService = this._register(new UpdateMainService(version => this.lifecycleMainService.prepareUpdateRestart(version)));
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
			onError: error => console.error('Failed to open Agents Window from a system-wide shortcut', error),
		}));
		this.nativeMenubar = process.platform === "darwin"
			? this._register(new NativeMenubarMainService(createElectronMenubarHost()))
			: undefined;
		this.profileRoot = resolveHome();
		// Development uses the stock Electron executable; a Windows package must embed this icon in its executable.
		this.windowIconPath = process.platform === 'win32' && !app.isPackaged
			? join(app.getAppPath(), '..', 'resources', 'win32', 'ash.ico')
			: undefined;

		this.lifecycleMainService = this._register(new LifecycleMainService<BrowserWindow>(async (window, message) => {
			this.cancelQuit();
			this.windowsMainService.failManagedWindowClose(window, message);
			await this.dialogs.showMessageBox({ type: 'error', message }, window);
		}, window => {
			this.cancelQuit();
			this.windowsMainService.failManagedWindowClose(window, 'Window close was vetoed');
		}, this.stateService, app.getVersion()));
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

	static async create(options: AshApplicationOptions): Promise<AshApplication> {
		const state = await StateService.create(join(app.getPath("userData"), "state.json"));
		const disposableTracker = app.isPackaged
			? undefined
			: new DisposableTracker();
		const tracking = disposableTracker
			? installDisposableTracker(disposableTracker)
			: undefined;
		try { return new AshApplication(options, state, disposableTracker, tracking); }
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
		if (process.platform === "darwin") {
			assertDefined(app.dock, 'macOS Dock API is unavailable');
			// Dock customization must not gate creation of the first Workbench window.
			if (!app.isPackaged) {
				app.dock.setIcon(join(app.getAppPath(), '..', 'resources', 'darwin', 'ash.png'));
			}
		} else {
			clearElectronApplicationMenu();
		}

		await this.loggerService.initialize();
		throwIfCancelled(token);
		this.mainProcessIpcServer.registerChannel('logger', new LoggerChannel(this.loggerService));
		this.logService.info('lifecycle', 'Desktop startup', { appServer: this.appServerStartupMode });
		await this.createPersistentServices(token);
		throwIfCancelled(token);
		const localeValue = configurationValues(this.services.configuration.read().document)[LocalizationConfiguration.locale];
		const locale = typeof localeValue === 'string' ? normalizeLocale(localeValue) : 'en';
		const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale.toLowerCase() === locale.toLowerCase()) ?? await new LanguagePackStore(this.profileRoot).read(locale);
		throwIfCancelled(token);
		if (!catalog) { throw new Error(`Display language '${locale}' is not installed locally`); }
		this.activeLanguagePack = catalog;
		const storage = this.storageMainService = this._register(new StorageMainService(join(app.getPath('userData'), 'workbench-state.json')));
		await storage.initialize();
		throwIfCancelled(token);
		this.mainProcessIpcServer.registerChannel('storage', new StorageDatabaseChannel(storage));
		const launchServices = this._register(new InstantiationService());
		launchServices.registerInstance(IStateService, this.services.state);
		this.workspacesHistory = this._register(launchServices.createInstance(WorkspacesHistoryMainService));
		this._register(this.workspacesHistory.onDidChangeRecentlyOpened(() => {
			for (const window of BrowserWindow.getAllWindows()) {
				window.webContents.send(RECENTLY_OPENED_CHANGED_CHANNEL);
			}
		}));
		if (process.platform === 'win32') {
			this.configureWindowsTaskbar();
		}
		this.themeMainService = this._register(new ThemeMainService(nativeTheme, this.services.state));
		this.mainProcessIpcServer.registerChannel('colorScheme', colorSchemeChannel(this.themeMainService));
		this.mainProcessIpcServer.registerChannel('checksum', checksumChannel(app.getAppPath(), app.isPackaged, new ChecksumService()));
		const wasUpdated = this.lifecycleMainService.wasRestarted;
		const workspaces = new WorkspacesManagementMainService();
		this.workspaces = workspaces;
		launchServices.registerInstance(IWindowsMainService, this.windowsMainService);
		this.launchMainService = this._register(launchServices.createInstance(LaunchMainService));
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
			this._register(this.services.configuration.onDidChange(update));
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
		await this.restoreWindowSession(workspaces, launch.explicit, wasUpdated);
		if (launch.explicit) {
			await this.openWorkspace(launch.workspace, workspaces);
		} else if (this.windowsMainService.getWindowCount() === 0 && this.windowsMainService.managedWindowValues().length === 0) {
			await this.openWorkspace(launch.workspace, workspaces);
		}
	}

	private async restoreWindowSession(workspaces: WorkspacesManagementMainService, hasExplicitTarget: boolean, wasUpdated: boolean): Promise<void> {
		const session = this.windowSessionStateHandler.readSession();
		const configuredSetting = configurationValues(this.services.configuration.read().document)[RESTORE_WINDOWS_SETTING];
		const selection = this.windowsMainService.selectWindowsToRestore(session, configuredSetting, hasExplicitTarget, wasUpdated);
		for (const entry of selection.windows) {
			try {
				if (entry.kind === 'workbench') {
					await this.openWorkspace(entry.workspace, workspaces);
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
				const window = this.windowsMainService.findWorkspace(active.workspace);
				if (window) focusWindow(window);
			}
			else {
				const window = this.windowsMainService.managedWindow(AGENTS_WINDOW_KEY);
				if (window) focusWindow(window);
			}
		}
	}

	private createTray(): void {
		if (process.platform !== 'win32' && process.platform !== 'darwin') return;
		const iconDirectory = app.isPackaged
			? join(app.getAppPath(), 'resources', 'tray')
			: join(app.getAppPath(), '..', 'resources', 'tray');
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
		this._register(this.services.configuration.onDidChange(updateMenu));
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
		const activeWindow = this.windowsMainService.getLastActiveWindow();
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
				focusWindow(window);
				arguments_.push('--reuse-window');
			}
			url.searchParams.delete('windowId');
			arguments_.push(`--open-url=${url.toString()}`);
			await this.launchMainService.start({ args: parseLaunchArguments(arguments_), cwd: process.cwd() });
			return true;
		}
		if (windowId === '_blank' || (!windowId && !this.windowsMainService.getLastActiveWindow())) {
			await this.launchMainService.start({ args: parseLaunchArguments(['--new-window']), cwd: process.cwd() });
		}
		const window = windowId && windowId !== '_blank'
			? this.windowsMainService.getWindows().find(window => String(window.id) === windowId)
			: this.windowsMainService.getLastActiveWindow();
		if (!window) {
			return false;
		}
		// Renderer readiness guarantees that its URL handler channel has been registered.
		await this.windowsMainService.whenReady(window);
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
		return { ...builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'en')!.bundles.ash, ...this.activeLanguagePack.bundles.ash };
	}

	/** Focuses a live window, or recreates an empty Workbench when none remains. */
	handleActivate(): void {
		const active = this.windowsMainService.getLastActiveWindow();
		if (active) {
			focusWindow(active);
			return;
		}
		const sessionsWindow = this.windowsMainService.managedWindowValues()[0];
		if (sessionsWindow) {
			focusWindow(sessionsWindow);
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
		let configuration: ConfigurationMainService | undefined;
		let userKeyboardLayout: UserKeyboardLayoutMainService | undefined;
		try {
			configuration = await ConfigurationMainService.create({
				filePath: join(this.profileRoot, "settings.json"),
				onError: (error) => {
					console.error("Failed to process configuration", error);
				},
			});
			throwIfCancelled(token);
			userKeyboardLayout = await UserKeyboardLayoutMainService.create({
				filePath: join(this.profileRoot, "keyboard-layout.json"),
				openResource: (filePath) => shell.openPath(filePath),
				onError: (error) => {
					console.error("Failed to process user keyboard layout", error);
				},
			});
			throwIfCancelled(token);
			this.persistentServices = { state: this.stateService, configuration, userKeyboardLayout };
		} catch (error) {
			await Promise.all([
				configuration?.close(),
				userKeyboardLayout?.close(),
			]);
			throw error;
		}
	}

	private async resolveWorkspace(): Promise<{ readonly workspace: IAnyWorkspaceIdentifier; readonly explicit: boolean }> {
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

	private async openWorkspace(workspace: IAnyWorkspaceIdentifier, workspaces: WorkspacesManagementMainService, forceNewWindow = false): Promise<WorkbenchWindowRecord | undefined> {
		if (forceNewWindow) {
			return this.performOpenWorkspace(workspace, workspaces, true);
		}
		const window = await this.windowsMainService.openWorkspace(workspace, async () => (await this.performOpenWorkspace(workspace, workspaces))?.window);
		return window ? this.workbenchWindowData.get(window.id) : undefined;
	}

	private async performOpenWorkspace(workspace: IAnyWorkspaceIdentifier, workspaces: WorkspacesManagementMainService, forceNewWindow = false): Promise<WorkbenchWindowRecord | undefined> {
		const existingWindow = this.windowsMainService.findWorkspace(workspace);
		const existing = existingWindow ? this.workbenchWindowData.get(existingWindow.id) : undefined;
		if (existing && !forceNewWindow) {
			focusWindow(existing.window);
			return existing;
		}
		const resources = new DisposableStore();
		try {
			const resolvedWorkspace = await workspaces.resolveWorkspace(workspace);
			const workspaceContext = resources.add(new WorkspaceContextMainService(workspace, resolvedWorkspace));
			const supervisor = resources.add(this.createAppServerConnectionRelay(workspace, resources));

			if (this.appServerStartupMode === "required" && !await this.startAppServerWithRecovery(supervisor)) {
				resources.dispose();
				return undefined;
			}
			return await this.openWorkbenchWindow(workspaceContext, workspaces, supervisor, resources);
		} catch (error) {
			resources.dispose();
			throw error;
		}
	}

	private mainProcessIpcRoutes(window: BrowserWindow): readonly IpcRoute<unknown, unknown>[] {
		return [
			{
				channel: NLS_CONFIGURATION_CHANNEL,
				validate: value => { if (value !== undefined) { throw new TypeError('Startup language takes no arguments'); } return undefined; },
				invoke: () => this.activeLanguagePack,
			},
			{
				channel: LANGUAGE_PACK_READ_CHANNEL,
				validate: value => { if (typeof value !== 'string' || !value || normalizeLocale(value) !== value) { throw new TypeError('Invalid display language ID'); } return value; },
				invoke: locale => new LanguagePackStore(this.profileRoot).read(locale as string),
			},
			{
				channel: LANGUAGE_PACK_WRITE_CHANNEL,
				validate: value => { const catalog = parseLanguagePackCatalog(value); if (!catalog) { throw new TypeError('Invalid display language resource'); } return catalog; },
				invoke: catalog => new LanguagePackStore(this.profileRoot).write(catalog as LanguagePackCatalog),
			},
			{
				channel: HOST_RESTART_CHANNEL,
				validate: value => { if (value !== undefined) { throw new TypeError('Restart takes no arguments'); } return undefined; },
				invoke: () => { this.restartRequested = true; app.quit(); },
			},
			{
				channel: 'ash:workspaces:recent:read',
				validate: value => {
					if (value !== undefined) {
						throw new TypeError('Recent projects read takes no arguments');
					}
					return undefined;
				},
				invoke: async () => toStoreData(await this.workspacesHistory.getRecentlyOpened()),
			},
			{
				channel: 'ash:workspaces:recent:add',
				validate: value => restoreRecentlyOpened(value).workspaces,
				invoke: value => this.workspacesHistory.addRecentlyOpened(value as readonly IRecent[]),
			},
			{
				channel: 'ash:workspaces:recent:remove',
				validate: value => {
					if (!Array.isArray(value)) {
						throw new TypeError('Recent project removal requires URI paths');
					}
					return restoreRecentlyOpened({ workspaces: value.map(folderUri => ({ folderUri })) }).workspaces.map(recentWorkspaceUri);
				},
				invoke: value => this.workspacesHistory.removeRecentlyOpened(value as readonly URI[]),
			},
			{
				channel: 'ash:workspaces:recent:clear',
				validate: value => {
					if (value !== undefined) {
						throw new TypeError('Recent projects clear takes no arguments');
					}
					return undefined;
				},
				invoke: () => this.workspacesHistory.clearRecentlyOpened(),
			},
			{
				channel: 'ash:ipc:window-id',
				validate: value => { if (value !== undefined) { throw new TypeError('Window ID read takes no arguments'); } return undefined; },
				invoke: () => window.id,
			},
			{
				channel: 'ash:ipc:connect',
				validate: value => {
					if (!isRecord(value) || Object.keys(value).length !== 1 || !isUuid(value.nonce)) { throw new TypeError('Invalid Main IPC acquisition'); }
					return { nonce: value.nonce };
				},
				// The trusted route owns the window identity; the renderer supplies only a reply nonce.
				invoke: value => this.mainProcessIpcServer.connect(window.webContents, `window:${window.id}`, (value as { nonce: string }).nonce),
			},
		];
	}

	private createAppServerConnectionRelay(
		workspace: IAnyWorkspaceIdentifier,
		resources: DisposableStore,
		existing?: AppServerConnectionRelay,
		role: 'workbench' | 'agents' = 'workbench',
	): AppServerConnectionRelay {
		if (this.appServerStartupMode === "disabled") {
			return existing ?? new AppServerConnectionRelay({ enabled: false });
		}
		const remote = role === 'workbench' && getWorkspaceRemoteAuthority(workspace) !== undefined;
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
		});
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
		const artifact = remoteRuntimeArtifactFromEnvironment(process.env);
		const runtimeInstaller = artifact === undefined
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
			runtimeInstaller,
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
	): Promise<WorkbenchWindowRecord> {
		const windowsStateHandler = this.createWindowsStateHandler(workspaceContext.getWorkspace());
		const lastActiveWindow = BrowserWindow.getFocusedWindow() ?? this.windowsMainService.getLastActiveWindow() ?? this.windowsMainService.managedWindow(AGENTS_WINDOW_KEY);
		const windowState = windowsStateHandler.restoreWindowState(lastActiveWindow?.getBounds());
		const titleBarStyle = this.titleBarStyle;
		const windowHost = this.windowsMainService.createWindow(options => new BrowserWindow(options), {
			workspace: workspaceContext.getWorkspace(),
			state: windowState,
			backgroundColor: this.themeMainService.getBackgroundColor(),
			titleBarStyle,
			webPreferences: this.createSandboxWebPreferences(),
			title: AshWorkbenchName,
			tabbingIdentifier: process.platform === 'darwin' ? 'ash-workbench' : undefined,
			icon: this.windowIconPath,
		}, resources);
		const window = windowHost.win;
		this.trackAppServerConnection(window, supervisor, resources);
		const remoteConnections = this.createRemoteConnections(workspaces);
		const windowStateTracking = windowsStateHandler.trackWindow(window);
		const record: WorkbenchWindowRecord = {
			id: window.id,
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
			this.windowSessionStateHandler.windowClosed({ kind: 'workbench', workspace: record.workspaceContext.getWorkspace() });
		});
		this.windowSessionStateHandler.windowOpened();

		const rendererEntry = this.resolveRendererEntry("workbench");

		const windowDisposables = resources;
		this.configureWindowNavigation(window, windowDisposables);
		const workspaceHost = windowDisposables.add(new RendererWorkspaceHost(window.webContents));
		windowDisposables.add(record.windowStateTracking);
		const remoteTunnelService = new SshRemoteTunnelService({
			getWorkspace: () => workspaceContext.getWorkspace(),
			sshExecutable: process.env.ASH_SSH_PATH ?? "ssh",
			localEnvironment: process.env,
		});
		const browserServices = this.createBrowserServices(window, workspaceContext, remoteTunnelService, windowDisposables);
		const browserViewMainService = browserServices.get(IBrowserViewMainService);
		const browserGroups = windowDisposables.add(browserServices.createInstance(BrowserViewGroupMainService));
		const browserPort = this.sharedProcess.connect(`window:${window.id}`);
		const browserClient = windowDisposables.add(new MessagePortClient({
			postMessage: data => browserPort.postMessage(data), start: () => browserPort.start(), close: () => browserPort.close(),
			addEventListener: (type, listener) => type === 'message' ? browserPort.on('message', listener) : browserPort.on('close', listener as () => void), removeEventListener: (type, listener) => type === 'message' ? browserPort.off('message', listener) : browserPort.off('close', listener as () => void),
		}, `window:${window.id}`));
		browserClient.registerChannel('browserViewGroup', ProxyChannel.fromService(browserGroups, windowDisposables));
		browserServices.registerInstance(IPlaywrightService, ProxyChannel.toService<IPlaywrightService>(browserClient.getChannel('playwright')));
		// A worker crash retires its debugger leases, while the user's live pages remain in Main.
		browserPort.once('close', () => browserGroups.dispose());
		const appServerBrowserHost = windowDisposables.add(browserServices.createInstance(AppServerBrowserHost));
		windowDisposables.add(supervisor.onStateChange(state => {
			if (state === 'crashed' || state === 'restarting' || state === 'stopping' || state === 'stopped') appServerBrowserHost.reset();
		}));
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
				window.webContents.send(WORKSPACE_CONTEXT_CHANGED_CHANNEL, serializeWorkspace(resolvedWorkspace));
			}
		}));
		const windowResources = {
			configuration: this.services.configuration,
			nativeKeyboardLayout: this.nativeKeyboardLayout,
			userKeyboardLayout: this.services.userKeyboardLayout,
		};
		const workspaceTransitions = windowDisposables.add(new WorkspaceTransitionMainService({
			workspaces,
			context: workspaceContext,
			...this.createWorkspaceTransitionRuntime(supervisor, workspaceHost),
		}));
		const remoteWindowContext = windowDisposables.add(new RemoteWindowMainContext({
			supervisor,
			workspaceContext,
			connections: record.remoteConnections,
			tunnels: remoteTunnelService,
			host: electronRemoteWindowMainHost(window, this.dialogs),
			prepareForRuntimeReplacement: () => window.webContents.send("ash:terminal:prepareReplacement"),
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
			window.webContents.send("ash:terminal:prepareReplacement");
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
				const root = isSingleFolderWorkspaceIdentifier(workspace) ? workspace.uri.fsPath : undefined;
				const grant = root ? await this.resolveDirGrant(workspaceHost, root) : { type: 'config' as const };
				if (!grant || !await this.lifecycleMainService.unload(window)) {
					return;
				}
				const load = async (): Promise<void> => {
					try {
						await this.loadRendererEntry(window, this.resolveRendererEntry('workbench'));
						await this.windowsMainService.whenReady(window);
					} finally {
						loadingWorkspace = false;
					}
				};
				try {
					await record.windowsStateHandler.saveWindowState(window);
					window.webContents.send('ash:terminal:prepareReplacement');
					if (this.appServerStartupMode !== 'disabled') {
						const launcher = supervisor.options.enabled ? supervisor.options.processLauncher : undefined;
						if (!(launcher instanceof AppServerDaemonLauncher) && !(launcher instanceof RemoteAppServerProcessLauncher)) {
							throw new Error('Workspace connection has no directory launcher');
						}
						await this.reconnectAppServerWorkspace(supervisor, launcher, root, grant, workspace.id, workspaceContext.getWorkspace().id, workspaceHost);
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

		windowDisposables.add(toDisposable(() => this.dialogs.cancelWindow(window)));
		const windowControlsOverlay = new WindowControlsOverlay(colors => {
			if (titleBarStyle === 'custom' && (process.platform === 'win32' || process.platform === 'linux')) window.setTitleBarOverlay(colors);
		});
		const ipcRoutes = [
			...this.mainProcessIpcRoutes(window),
			...workspaceHost.routes(),
			...supervisor.routes(window.webContents, () => ({ workspaceId: workspaceContext.getWorkspace().id, workspaceRoot: workspaceContext.getResolvedWorkspace().folders[0]?.uri.fsPath ?? this.profileRoot })),
			...appServerBrowserHost.routes(),
			...windowDisposables.add(new OAuthCallbackHost()).routes(),
			...rendererSystemHostRoutes(window, path => this.directoryPermissionPrompt(path)),
			hooksConfigurationIpcRoute(this.profileRoot, () => !getWorkspaceRemoteAuthority(workspaceContext.getWorkspace()), openHooksTextFile),
			...remoteWindowContext.ipcRoutes,
			...browserViewIpcRoutes(browserViewMainService),
			...windowResourceIpcRoutes(windowResources),
			windowOperationIpcRoute(this.windowsMainService, window),
			windowCloseResponseIpcRoute(this.lifecycleMainService, window),
			this.windowsMainService.fileOpenResponseIpcRoute(window),
			...nativeHostIpcRoutes({
				isAdmin,
				openWindow: async options => {
					const workspace = { ...createEmptyWorkspaceIdentifier(), ...(options.remoteAuthority ? { remoteAuthority: options.remoteAuthority } : {}) };
					if (!options.forceReuseWindow) {
						await this.openWorkspace(workspace, workspaces);
						return;
					}
					if (options.remoteAuthority !== getWorkspaceRemoteAuthority(workspaceContext.getWorkspace())) throw new Error('Reusing a window must preserve its Remote authority');
					await replaceWorkspace(workspace, true);
				},
				performDialogOperation: operation => this.dialogs.perform(window, operation),
				performShellCommand: operation => this.performShellCommand(operation),
				pickFolder: async () => {
					const result = await this.dialogs.showOpenDialog({
						title: "Add Directory",
						properties: ["openDirectory"],
					}, window);
					return result.canceled || !result.filePaths[0] ? undefined : result.filePaths[0];
				},
				...this.windowFileDialogs(window),
				openWorkspace: (root) => transitionToFolder(root, true),
				openAgentsWindow: options => this.openSessionsWindow(record.workspaceContext.getWorkspace(), record.workspaceContext.getResolvedWorkspace(), options),
				revealFile: path => {
					if (!isAbsolute(path)) throw new TypeError('File path to reveal must be absolute');
					shell.showItemInFolder(path);
				},
				isAccessibilitySupportEnabled: () => app.isAccessibilitySupportEnabled(),
				setWindowTheme: theme => {
					windowControlsOverlay.setTheme(theme);
					window.setBackgroundColor(theme.backgroundColor);
					void this.themeMainService.saveWindowTheme(theme).catch(error => console.error('Failed to save window theme', error));
				},
				setWindowDimmed: dimmed => windowControlsOverlay.setDimmed(dimmed),
				toggleDeveloperTools: () => window.webContents.toggleDevTools(),
				syncSystemWideKeybindings: bindings => this.globalKeybindings.updateKeybindings(
					record.id,
					bindings.filter(binding => binding.commandId === OPEN_AGENTS_WINDOW_COMMAND_ID),
				),
			}),
			...diskFileSystemProviderRoutes(windowDisposables.add(new DiskFileSystemProvider([URI.file(this.profileRoot)])), URI.file(this.profileRoot)),
			...workspaceContextIpcRoutes(workspaceContext),
			workspaceRecoveryIpcRoute(identifiers => this.windowsMainService.restoreWorkspaces(identifiers, async identifier => (await this.openWorkspace(identifier, workspaces))?.window)),
			...updateIpcRoutes(this.updateMainService),
		];
		await watchProfileFiles(this.profileRoot, window, windowDisposables);
		const systemContextMenu = windowDisposables.add(new ElectronContextMenu(window));
		ipcRoutes.push(...nativeContextMenuIpcRoutes(systemContextMenu));
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
		windowDisposables.add(this.windowsMainService.trackZoomLevel(window));
		windowDisposables.add(this.lifecycleMainService.registerWindow(window));
		windowDisposables.add(trackWindowResourceChanges(window, windowResources));
		try {
			await this.loadRendererEntry(window, rendererEntry);
			return record;
		} catch (error) {
			windowHost.dispose();
			throw error;
		}
	}

	private createRemoteConnections(workspaces: WorkspacesManagementMainService): IRemoteConnectionService {
		return this.appServerStartupMode === "disabled"
			? UnavailableRemoteConnectionService
			: new RemoteConnections({
				remoteExecutable: remoteExecutablePath({ appPath: app.getAppPath(), isPackaged: app.isPackaged, platform: process.platform, resourcesPath: process.resourcesPath }),
				environment: { ...process.env, ASH_HOME: this.profileRoot },
				scheduleConnect: connection => this.openRemoteConnection(connection, workspaces),
			});
	}

	private windowFileDialogs(window: BrowserWindow): Pick<INativeHostMainService, 'pickFile' | 'saveFile'> {
		return {
			pickFile: async (options) => {
				const result = await this.dialogs.showOpenDialog({
					title: options.title ?? 'Open File',
					...(options.defaultPath ? { defaultPath: options.defaultPath } : {}),
					...(options.buttonLabel ? { buttonLabel: options.buttonLabel } : {}),
					...(options.filters ? { filters: options.filters.map(filter => ({ name: filter.name, extensions: [...filter.extensions] })) } : {}),
					properties: [
						...(options.canSelectFiles ? ['openFile' as const] : []),
						...(options.canSelectFolders ? ['openDirectory' as const] : []),
						...(options.canSelectMany ? ['multiSelections' as const] : []),
					],
				}, window);
				return result.canceled || result.filePaths.length === 0 ? undefined : result.filePaths;
			},
			saveFile: async (options) => {
				const result = await this.dialogs.showSaveDialog({
					title: options.title ?? "Save File",
					...(options.defaultPath || options.defaultName ? { defaultPath: options.defaultPath ?? options.defaultName } : {}),
					...(options.buttonLabel ? { buttonLabel: options.buttonLabel } : {}),
					...(options.filters ? { filters: options.filters.map(filter => ({ name: filter.name, extensions: [...filter.extensions] })) } : {}),
				}, window);
				return result.canceled || !result.filePath ? undefined : result.filePath;
			},
		};
	}

	private configureWindowNavigation(window: BrowserWindow, windowDisposables: DisposableStore, openerWindow: BrowserWindow = window): void {
		const auxiliaryWindows = windowDisposables.add(new DisposableMap<number, IDisposable>());
		// Apply restored popup bounds before creation; Chromium ignores its position features here.
		window.webContents.setWindowOpenHandler(details => {
			if (details.url !== 'about:blank') {
				// The owning workbench selects URL rules; auxiliary windows share that owner.
				try { openerWindow.webContents.send(WINDOW_OPEN_EXTERNAL_URI_CHANNEL, normalizeExternalUrl(details.url)); }
				catch (error) { console.error('Could not request external link opening', error); }
				return { action: 'deny' };
			}
			return { action: 'allow', overrideBrowserWindowOptions: this.auxiliaryWindowsMainService.createWindow(details) };
		});
		const onDidCreateWindow = (child: BrowserWindow, details: { readonly url: string }): void => {
			if (details.url !== 'about:blank') return;
			const childResources = new DisposableStore();
			childResources.add(this.auxiliaryWindowsMainService.registerWindow(child.webContents, window.id));
			auxiliaryWindows.set(child.id, childResources);
			this.configureWindowNavigation(child, childResources, openerWindow);
			child.once('closed', () => auxiliaryWindows.deleteAndDispose(child.id));
		};
		// BrowserWindow releases its webContents getter on close; cleanup owns the original emitter.
		const webContents = window.webContents;
		// Product pages never navigate to link destinations; Browser views own separate webContents.
		const preventNavigation = (event: ElectronEvent): void => event.preventDefault();
		webContents.on('will-navigate', preventNavigation);
		windowDisposables.add(toDisposable(() => webContents.off('will-navigate', preventNavigation)));
		webContents.on('did-create-window', onDidCreateWindow);
		windowDisposables.add(toDisposable(() => webContents.off('did-create-window', onDidCreateWindow)));
	}

	private createBrowserServices(window: BrowserWindow, workspaceContext: WorkspaceContextMainService, remoteTunnelService: SshRemoteTunnelService, windowDisposables: DisposableStore): InstantiationService {
		const browserServices = windowDisposables.add(this.windowServices.createChild(new ServiceCollection()));
		const browserViewMainService = windowDisposables.add(browserServices.createInstance(BrowserViewMainService, {
			window,
			getWorkspaceId: () => workspaceContext.getWorkspace().id,
			getRemoteNetwork: () => {
				const authority = getWorkspaceRemoteAuthority(workspaceContext.getWorkspace());
				return authority ? { authority, tunnels: remoteTunnelService } : undefined;
			},
			createSession: (partition: string) => electronSession.fromPartition(partition),
			createView: (session: Electron.Session) => new WebContentsView({
				webPreferences: {
					contextIsolation: true,
					nodeIntegration: false,
					sandbox: true,
					webviewTag: false,
					session,
				},
			}),
		}));
		windowDisposables.add(browserViewMainService.onDidEvent(event => {
			if (!window.isDestroyed()) window.webContents.send(BROWSER_VIEW_EVENT_CHANNEL, event);
		}));
		browserServices.registerInstance(IBrowserViewMainService, browserViewMainService);
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
			// Agents uses workspace window dimensions even before a project is selected.
			defaultState: defaultWindowState(WorkbenchState.WORKSPACE),
		});
		const titleBarStyle = this.titleBarStyle;
		const wasOpen = this.windowsMainService.managedWindow(AGENTS_WINDOW_KEY) !== undefined;
		const lastActiveWindow = BrowserWindow.getFocusedWindow() ?? this.windowsMainService.getLastActiveWindow() ?? this.windowsMainService.managedWindow(AGENTS_WINDOW_KEY);
		await this.windowsMainService.openManagedWindow(
			AGENTS_WINDOW_KEY,
			options => new BrowserWindow(options),
			{
				title: `${AshWorkbenchName} Sessions`,
				titleBarStyle,
				icon: this.windowIconPath,
				state: sessionsWindowState.restoreWindowState(lastActiveWindow?.getBounds()),
				webPreferences: this.createSandboxWebPreferences(),
				initialize: async (window, windowDisposables) => {
					this.configureWindowNavigation(window, windowDisposables);
					const tracking = windowDisposables.add(sessionsWindowState.trackWindow(window));
					session.windowState = { window, handler: sessionsWindowState, tracking };
					windowDisposables.add(toDisposable(() => this.globalKeybindings.removeWindow(window.id)));
					windowDisposables.add(toDisposable(() => this.dialogs.cancelWindow(window)));
					const onFocus = (): void => {
						this.windowSessionStateHandler.windowFocused(window.id);
					};
					window.on('focus', onFocus);
					windowDisposables.add(toDisposable(() => window.removeListener('focus', onFocus)));
					// A renderer reload cannot acknowledge a draft already handed to the previous renderer.
					const rejectInterruptedHandoffs = (): void => {
						this.globalKeybindings.removeWindow(window.id);
						session.rejectHandoffs(new Error('Agents Window reloaded before the handoff completed'));
					};
					const onNavigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean): void => {
						if (mainFrame && !inPlace) rejectInterruptedHandoffs();
					};
					window.webContents.on('did-start-navigation', onNavigation);
					window.webContents.on('render-process-gone', rejectInterruptedHandoffs);
					windowDisposables.add(toDisposable(() => {
						if (window.isDestroyed()) return;
						window.webContents.removeListener('did-start-navigation', onNavigation);
						window.webContents.removeListener('render-process-gone', rejectInterruptedHandoffs);
					}));
					const windowControlsOverlay = new WindowControlsOverlay(colors => {
						if (titleBarStyle === 'custom' && (process.platform === 'win32' || process.platform === 'linux')) window.setTitleBarOverlay(colors);
					});
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
					const remoteTunnelService = new SshRemoteTunnelService({
						getWorkspace: () => session.workspaceContext.getWorkspace(),
						sshExecutable: process.env.ASH_SSH_PATH ?? "ssh",
						localEnvironment: process.env,
					});
					const browserServices = this.createBrowserServices(window, session.workspaceContext, remoteTunnelService, windowDisposables);
					const remoteWindowContext = windowDisposables.add(new RemoteWindowMainContext({
						supervisor: sessionsRelay,
						workspaceContext: session.workspaceContext,
						connections: session.remoteConnections,
						tunnels: remoteTunnelService,
						host: electronRemoteWindowMainHost(window, this.dialogs),
						prepareForRuntimeReplacement: () => window.webContents.send("ash:terminal:prepareReplacement"),
					}));
					const windowResources = {
						configuration: this.services.configuration,
						nativeKeyboardLayout: this.nativeKeyboardLayout,
						userKeyboardLayout: this.services.userKeyboardLayout,
					};
					const ipcRoutes = [
						...this.mainProcessIpcRoutes(window),
						...sessionsRelay.routes(window.webContents, () => ({ workspaceId: AGENTS_WINDOW_KEY, workspaceRoot: this.profileRoot })),
						...rendererSystemHostRoutes(window, path => this.directoryPermissionPrompt(path)),
						hooksConfigurationIpcRoute(this.profileRoot, () => !getWorkspaceRemoteAuthority(session.workspaceContext.getWorkspace()), openHooksTextFile),
						...browserViewIpcRoutes(browserServices.get(IBrowserViewMainService)),
						...remoteWindowContext.ipcRoutes,
						...windowResourceIpcRoutes(windowResources),
						...fileDialogIpcRoutes(this.windowFileDialogs(window)),
						...windowAppearanceIpcRoutes({
							setWindowTheme: theme => {
								windowControlsOverlay.setTheme(theme);
								window.setBackgroundColor(theme.backgroundColor);
								void this.themeMainService.saveWindowTheme(theme).catch(error => console.error('Failed to save window theme', error));
							},
							setWindowDimmed: dimmed => windowControlsOverlay.setDimmed(dimmed),
						}),
						windowOperationIpcRoute(this.windowsMainService, window),
						{
							channel: NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL,
							validate: validateOpenAgentsWindow,
							invoke: (options: unknown) => this.openSessionsWindow(session.workspaceContext.getWorkspace(), session.workspaceContext.getResolvedWorkspace(), options as IOpenAgentsWindowOptions | undefined),
						},
						{
							channel: NATIVE_HOST_SYNC_SYSTEM_WIDE_KEYBINDINGS_CHANNEL,
							validate: validateSystemWideKeybindings,
							invoke: (bindings: unknown) => this.globalKeybindings.updateKeybindings(window.id, (bindings as readonly INativeSystemWideKeybinding[]).filter(binding => binding.commandId === OPEN_AGENTS_WINDOW_COMMAND_ID)),
						},
						...diskFileSystemProviderRoutes(windowDisposables.add(new DiskFileSystemProvider([URI.file(this.profileRoot)])), URI.file(this.profileRoot)),
						...workspaceContextIpcRoutes(session.workspaceContext),
						{
							channel: AGENTS_WINDOW_HANDOFF_TAKE_CHANNEL,
							validate: validateAgentsWindowHandoffTake,
							invoke: () => session.takeHandoff(),
						},
						{
							channel: AGENTS_WINDOW_HANDOFF_COMPLETE_CHANNEL,
							validate: validateAgentsWindowHandoffComplete,
							invoke: (result: unknown) => session.completeHandoff(result as IAgentsWindowHandoffResult),
						},
						{
							channel: RETURN_TO_WORKBENCH_CHANNEL,
							validate: validateReturnToWorkbench,
							invoke: async () => {
								// Keep one window alive when Agents is the only restored window.
								const opened = await this.openWorkspace(session.workspaceContext.getWorkspace(), workspaces);
								await this.windowsMainService.closeManagedWindow(AGENTS_WINDOW_KEY);
								if (opened) focusWindow(opened.window);
							},
						},
						windowCloseResponseIpcRoute(this.lifecycleMainService, window),
					];
					await watchProfileFiles(this.profileRoot, window, windowDisposables);
					const systemContextMenu = windowDisposables.add(new ElectronContextMenu(window));
					ipcRoutes.push(...nativeContextMenuIpcRoutes(systemContextMenu));
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
					windowDisposables.add(this.windowsMainService.trackZoomLevel(window));
					windowDisposables.add(this.windowsMainService.trackFullscreen(window));
					windowDisposables.add(this.lifecycleMainService.registerWindow(window));
					windowDisposables.add(trackWindowResourceChanges(window, windowResources));
					windowDisposables.add(session.workspaceContext.onDidChangeWorkspace(({ resolvedWorkspace }) => {
						if (!window.isDestroyed()) {
							window.webContents.send(WORKSPACE_CONTEXT_CHANGED_CHANNEL, serializeWorkspace(resolvedWorkspace));
						}
					}));
					await this.loadRendererEntry(window, sessionsEntry);
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
			const completed = session.enqueueHandoff(handoff);
			const window = this.windowsMainService.managedWindow(AGENTS_WINDOW_KEY);
			if (!window) throw new Error('Agents Window is unavailable for handoff');
			window.webContents.send(AGENTS_WINDOW_HANDOFF_AVAILABLE_CHANNEL);
			await completed;
		}
	}

	private async selectSessionsWorkspace(session: SessionsWindowRecord, workspace: IAnyWorkspaceIdentifier, resolvedWorkspace: IWorkspace): Promise<void> {
		if (session.workspaceContext.getWorkspace().id !== workspace.id) {
			session.workspaceContext.updateWorkspace(workspace, resolvedWorkspace);
		}
	}

	private async performShellCommand(operation: 'install' | 'uninstall'): Promise<string> {
		if (process.platform !== 'darwin') throw new Error('Shell command installation requires macOS');
		if (!app.isPackaged) throw new Error('Shell command installation requires a packaged Ash application');
		const appBundle = dirname(dirname(dirname(process.execPath)));
		if (!basename(appBundle).endsWith('.app')) throw new Error('The Ash application bundle is unavailable');
		const launcher = `#!/bin/sh\n# Ash desktop launcher\nexec /usr/bin/open -n -a '${appBundle.replaceAll("'", "'\\''")}' --args "$@"\n`;
		const { stdout: shellPath } = await promisify(execFile)(process.env.SHELL ?? '/bin/zsh', ['-lc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5_000 });
		const eligible = new Set(['/usr/local/bin', '/opt/homebrew/bin', join(homedir(), '.local', 'bin'), join(homedir(), 'bin')]);
		const directories = [...new Set(shellPath.split(delimiter).filter(path => eligible.has(path)))];
		if (directories.length === 0) throw new Error('Add a writable bin directory to PATH before installing the ash command');
		for (const directory of directories) {
			const commandPath = join(directory, 'ash');
			let existing: Awaited<ReturnType<typeof lstat>> | undefined;
			try { existing = await lstat(commandPath); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
			if (existing) {
				if (!existing.isFile() || !(await readFile(commandPath, 'utf8')).startsWith('#!/bin/sh\n# Ash desktop launcher\n')) {
					throw new Error(`${commandPath} belongs to another installation`);
				}
				if (operation === 'uninstall') await unlink(commandPath);
				else {
					await writeFile(commandPath, launcher);
					await chmod(commandPath, 0o755);
				}
				return commandPath;
			}
			if (operation === 'install') {
				try { await access(directory, constants.W_OK); } catch { continue; }
				await writeFile(commandPath, launcher, { flag: 'wx', mode: 0o755 });
				return commandPath;
			}
		}
		throw new Error(operation === 'install' ? 'No writable bin directory is available in PATH' : 'The ash command is not installed in PATH');
	}

	private resolveRendererEntry(kind: "workbench" | "sessions" | "remoteRuntimeInstall"): RendererEntry {
		const entry = kind === "workbench"
			? "workbench"
			: kind === "sessions"
				? AshSessionsRendererEntry
				: "remoteRuntimeInstall";
		const directory = kind === "remoteRuntimeInstall" ? "remote-runtime-install" : kind;
		const file = join(
			this.rendererRoot,
			"electron-browser",
			directory,
			`${entry}.html`,
		);
		const rendererUrl = process.env.ASH_RENDERER_URL;
		const useDevelopmentUrl = !app.isPackaged && rendererUrl !== undefined;
		const baseUrl = useDevelopmentUrl
			? new URL(`/electron-browser/${directory}/${entry}.html`, rendererUrl).href
			: pathToFileURL(file).href;
		return {
			file,
			url: baseUrl,
			useDevelopmentUrl,
		};
	}

	private async loadRendererEntry(window: BrowserWindow, entry: RendererEntry): Promise<void> {
		if (entry.useDevelopmentUrl || new URL(entry.url).search.length > 0) {
			await window.loadURL(entry.url);
			return;
		}
		await window.loadFile(entry.file);
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
		const launcher = supervisor.options.enabled ? supervisor.options.processLauncher : undefined;
		if (!(launcher instanceof AppServerDaemonLauncher) && !(launcher instanceof RemoteAppServerProcessLauncher)) {
			throw new Error("Workspace connection has no directory launcher");
		}
		const appServerWorkspace = createAppServerWorkspaceTransitionAdapter(supervisor,
			(root, grant, workspaceId, previousWorkspaceId) => this.reconnectAppServerWorkspace(supervisor, launcher, root, grant, workspaceId, previousWorkspaceId, workspaceHost));
		return {
			runtime: appServerWorkspace,
			classifyRuntimeError: (error) => appServerWorkspace.classifyRuntimeError(error),
			recovery: appServerWorkspace,
		};
	}

	private async reconnectAppServerWorkspace(
		supervisor: AppServerConnectionRelay,
		launcher: AppServerDaemonLauncher | RemoteAppServerProcessLauncher,
		root: string | undefined,
		grant: DirGrant,
		workspaceId: string,
		previousWorkspaceId: string,
		workspaceHost: RendererWorkspaceHost,
	): Promise<void> {
		const previous = launcher instanceof AppServerDaemonLauncher
			? { kind: "local" as const, launcher, environment: launcher.environment, root: launcher.environment.ASH_WORKSPACE_ROOT }
			: { kind: "remote" as const, launcher, root: launcher.workspaceRoot };
		if (root !== undefined) await workspaceHost.persistDirectoryGrant(root, grant);
		await supervisor.stop();
		if (previous.kind === "local") {
			const environment = { ...previous.environment };
			if (root === undefined) {
				delete environment.ASH_WORKSPACE_ROOT;
				delete environment.ASH_DIR_GRANT_SOURCE;
			} else {
				environment.ASH_WORKSPACE_ROOT = root;
				environment.ASH_DIR_GRANT_SOURCE = 'userConfig';
			}
			previous.launcher.replaceEnvironment(environment);
		} else {
			previous.launcher.replaceWorkspaceRoot(root);
		}
		try {
			await supervisor.start();
			await workspaceHost.setFolders(root === undefined ? [] : [{ id: workspaceId, path: root, grant: { type: "config" } }]);
		} catch (error) {
			await supervisor.stop();
			if (previous.kind === "local") {
				previous.launcher.replaceEnvironment(previous.environment);
			} else {
				previous.launcher.replaceWorkspaceRoot(previous.root);
			}
			try {
				await supervisor.start();
				await workspaceHost.setFolders(previous.root
					? [{ id: previousWorkspaceId, path: previous.root, grant: { type: "config" } }]
					: []);
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], "Workspace authority switch and rollback both failed");
			}
			throw error;
		}
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
		void (async () => {
			try {
				await this.windowSessionStateHandler.saveSession();
				for (const record of records) {
					if (!record.window.isDestroyed()) await record.windowsStateHandler.saveWindowState(record.window);
				}
				// Capture the session before Electron starts closing its windows.
				if (sessionsState && !sessionsState.window.isDestroyed()) {
					await sessionsState.handler.saveWindowState(sessionsState.window);
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
			record.window.webContents.send(NATIVE_HOST_ACCESSIBILITY_SUPPORT_CHANGED_CHANNEL, enabled);
		}
		for (const window of this.windowsMainService.managedWindowValues()) {
			window.webContents.send(NATIVE_HOST_ACCESSIBILITY_SUPPORT_CHANGED_CHANNEL, enabled);
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
	}

	private readonly onWillQuit = (event: ElectronEvent): void => {
		if (this.quitAfterServicesClosed) {
			// Schedule the new process only after every window accepted shutdown and state was saved.
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
			this.storageMainService?.close(),
			this.stateService.close(),
			...(services ? [
				services.configuration.close(),
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
				entry: { kind: 'workbench' as const, workspace: this.workbenchWindowData.get(window.id)!.workspaceContext.getWorkspace() },
				focused: window.id === focusedWindowId,
			})),
			...(sessionsWindow && session ? [{ id: sessionsWindow.id, entry: { kind: 'sessions' as const, workspace: session.workspaceContext.getWorkspace() }, focused: sessionsWindow.id === focusedWindowId }] : []),
		];
	}

	private async resolveDirGrant(workspaceHost: RendererWorkspaceHost, path: string): Promise<DirGrant | undefined> {
		if (this.appServerStartupMode === "disabled") return { type: "config" };
		const persisted = await workspaceHost.readPermissions(path);
		if (persisted !== undefined) return { type: "config" };
		const choice = await workspaceHost.selectPermissions(path);
		if (choice === 'cancel') return undefined;
		if (choice !== 'development' && choice !== 'readOnly') throw new Error('Invalid directory permission selection');
		return workspaceHost.createGrant(path, choice === 'development' ? DEVELOPMENT_DIR_PERMISSIONS : READ_DIR_PERMISSIONS);
	}

	private directoryPermissionPrompt(path: string): DialogRequest {
		const messages = this.mainLocalizationMessages();
		const translate = (key: string, english: string): string => messages[key] ?? english;
		return {
			kind: 'prompt',
			title: AshApplicationName,
			primaryButton: translate('workspaceTrust.readOnly', 'Open Read Only'),
			secondaryButton: translate('workspaceTrust.trust', 'Trust Folder & Enable Features'),
			cancelButton: translate('dialog.cancel', 'Cancel'),
			message: translate('workspaceTrust.question', 'Do you trust the files in this folder?'),
			detail: formatNlsMessage(
				translate('workspaceTrust.detail', 'Folder: {0}\n\nTrusting this folder allows Ash to edit files, run commands, change the repository, and load project instructions and configuration. Read Only allows browsing, searching, and repository inspection.'),
				{ '0': path },
			),
		};
	}

	private createWindowsStateHandler(
		workspace: IAnyWorkspaceIdentifier,
		options?: { readonly storageKey: string; readonly defaultState: IWindowState },
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
		const value = configurationValues(this.services.configuration.read().document)[TitleBarSetting.TitleBarStyle];
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
