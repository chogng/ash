import { OAuthCallbackHost } from "../../platform/connectors/electron-main/oauthCallbackHost.js";
import { RendererWorkspaceHost } from "../../platform/workspaces/electron-main/rendererWorkspaceHost.js";
import { BrowserAutomationHost } from "../../platform/browser/electron-main/browserAutomationHostRoutes.js";
import { rendererSystemHostRoutes } from "../../platform/native/electron-main/rendererSystemHostRoutes.js";
import { nativeImage, nativeTheme, shell } from "electron";
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen, Tray, type Event as ElectronEvent } from "electron/main";
import type { DirGrant } from "../../platform/dirPermissions/common/dirPermissionsService.js";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { constants, readFileSync, watch } from "node:fs";
import { pathToFileURL } from "node:url";
import { isCancellationError } from "../../base/common/errors.js";
import { createUuid } from '../../base/common/uuid.js';
import { Disposable, DisposableMap, DisposableStore, DisposableTracker, MutableDisposable, installDisposableTracker, type IDisposable, toDisposable } from "../../base/common/lifecycle.js";
import { assertDefined } from "../../base/common/types.js";
import { AshApplicationName } from '../common/application.js';
import { WorkbenchModeConfigurationKey, WorkbenchModeRegistry, WorkbenchRendererEntry, withWorkbenchModeId, type WorkbenchModeId } from "../../workbench/common/workbenchMode.js";
import { ElectronContextMenu } from "../../base/parts/contextmenu/electron-main/contextmenu.js";
import { AppServerConnectionRelay } from "../../platform/app-server/electron-main/appServerConnectionRelay.js";
import { DevelopmentAppServerReloader } from "../../platform/app-server-daemon/electron-main/developmentAppServerReloader.js";
import { AppServerDaemonLauncher, createAppServerDaemonLauncher } from "../../platform/app-server-daemon/electron-main/appServerDaemonLauncher.js";
import { remoteExecutablePath } from "../../platform/remote/node/remotePackage.js";
import type { IAppServerProcessLauncher } from '../../platform/app-server/electron-main/appServerProcessLauncher.js';
import { normalizeEntryUrl, TrustedIpcRouter, type IpcRoute } from "../../platform/ipc/electron-main/trustedIpcRouter.js";
import { BROWSER_VIEW_EVENT_CHANNEL } from "../../platform/browser/common/browserView.js";
import { browserViewIpcRoutes } from "../../platform/browser/electron-main/browserViewIpc.js";
import { BrowserViewMainService } from "../../platform/browser/electron-main/browserViewMainService.js";
import { BrowserAutomationMainService } from "../../platform/browser/electron-main/browserAutomationMainService.js";
import { BrowserTargetRegistry } from "../../platform/browser/electron-main/browserTargetRegistry.js";
import { configurationValues } from '../../platform/configuration/common/configurationIpc.js';
import { formatNlsMessage } from '../../nls.js';
import { editJsonObjectProperty } from '../../base/common/json.js';
import { ConfigurationMainService } from "../../platform/configuration/electron-main/configurationMainService.js";
import { nativeContextMenuIpcRoutes } from "../../platform/contextview/electron-main/contextMenuIpc.js";
import { developmentArtifactsPath } from "../../platform/environment/node/developmentArtifacts.js";
import { ElectronOpenerService } from "../../platform/opener/electron-main/electronOpenerService.js";
import { KeybindingsResourceMainService } from "../../platform/keybinding/electron-main/keybindingsResourceMainService.js";
import { NativeKeyboardLayoutMainService } from "../../platform/keyboardLayout/electron-main/nativeKeyboardLayoutMainService.js";
import { UserKeyboardLayoutMainService } from "../../platform/keyboardLayout/electron-main/userKeyboardLayoutMainService.js";
import { NativeMenubarMainService, nativeMenubarIpcRoutes } from "../../platform/menubar/electron-main/menubarMainService.js";
import { clearElectronApplicationMenu, createElectronMenubarHost } from "../../platform/menubar/electron-main/menubar.js";
import { nativeHostIpcRoutes, windowAppearanceIpcRoutes } from "../../platform/native/electron-main/nativeHostIpc.js";
import { UpdateMainService, updateIpcRoutes } from '../../platform/update/electron-main/updateMainService.js';
import { NATIVE_HOST_ACCESSIBILITY_SUPPORT_CHANGED_CHANNEL, type IOpenAgentsWindowOptions } from "../../platform/native/common/nativeHost.js";
import { DialogMainService } from '../../platform/dialogs/electron-main/dialogMainService.js';
import type { DialogRequest } from '../../platform/dialogs/common/dialogs.js';
import { AGENTS_WINDOW_HANDOFF_AVAILABLE_CHANNEL, AGENTS_WINDOW_HANDOFF_COMPLETE_CHANNEL, AGENTS_WINDOW_HANDOFF_TAKE_CHANNEL, RETURN_TO_WORKBENCH_CHANNEL, validateAgentsWindowHandoffComplete, validateAgentsWindowHandoffTake, validateReturnToWorkbench, type IAgentsWindowHandoffResult } from '../../sessions/common/windowNavigation.js';
import { GlobalKeybindingsMainService } from '../../platform/globalKeybindings/electron-main/globalKeybindingsMainService.js';
import { OPEN_AGENTS_WINDOW_COMMAND_ID } from '../../workbench/contrib/chat/common/constants.js';
import { StateService } from "../../platform/state/node/stateService.js";
import { resolveHome } from "../../platform/home/node/home.js";
import { diskFileSystemProviderRoutes } from "../../platform/files/electron-main/diskFileSystemProviderServer.js";
import { URI } from "../../base/common/uri.js";
import { DiskFileSystemProvider } from "../../platform/files/node/diskFileSystemProvider.js";
import { LOCAL_FILE_SYSTEM_CHANGED_CHANNEL } from "../../platform/files/common/diskFileSystemProviderClient.js";
import { WindowControlsOverlay } from "../../platform/windows/electron-main/windows.js";
import { RESTORE_WINDOWS_SETTING, TitleBarSetting, parseTitleBarStyle, type TitleBarStyleConfiguration } from "../../platform/window/common/window.js";
import { WindowsStateHandler, WindowSessionStateHandler, type IWindowSessionEntry, type IWindowSessionWindow } from "../../platform/windows/electron-main/windowsStateHandler.js";
import { WindowsMainService, trackWindowResourceChanges, windowOperationIpcRoute, windowResourceIpcRoutes, workspaceContextIpcRoutes } from "../../platform/windows/electron-main/windowsMainService.js";
import { LifecycleMainService, windowCloseResponseIpcRoute } from '../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { focusWindow, WindowMode, WorkspaceContextMainService, type IWindowState } from "../../platform/window/electron-main/window.js";
import { type IAnyWorkspaceIdentifier, type IWorkspace, getWorkspaceRemoteAuthority, isRemoteWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier, serializeWorkspace, UNKNOWN_EMPTY_WINDOW_WORKSPACE } from "../../platform/workspace/common/workspace.js";
import { createEmptyWorkspaceIdentifier } from "../../platform/workspaces/node/workspaces.js";
import { packagedRemoteRuntimeCatalogSource } from "../../platform/remote/electron-main/packagedRemoteRuntimeCatalog.js";
import { RemoteRuntimeInstaller, remoteRuntimeArtifactFromEnvironment } from "../../platform/remote/electron-main/remoteRuntimeInstaller.js";
import { RemoteRuntimeProvisioner } from "../../platform/remote/electron-main/remoteRuntimeProvisioner.js";
import { RemoteConnectionProfiles } from "../../platform/remote/electron-main/remoteConnectionProfiles.js";
import { RemoteConnections } from "../../platform/remote/electron-main/remoteConnections.js";
import { UnavailableRemoteConnectionService, type IRemoteConnectionService } from "../../platform/remote/common/remoteConnectionService.js";
import type { RemoteConnectionDefinition } from "../../platform/remote/common/remoteConnectionService.js";
import { createSshRemoteAuthority, getRemoteAuthority, isRemoteResource } from "../../platform/remote/common/remote.js";
import { RemoteBrowserViewNavigationResolver } from "../../platform/remote/electron-main/remoteBrowserViewNavigationResolver.js";
import { SshRemoteTunnelService } from "../../platform/remote/electron-main/sshRemoteTunnelService.js";
import { createRemoteRuntimeInstallProgressLogger } from "../../platform/remote/electron-main/remoteRuntimeBootstrapMainService.js";
import { RemoteRuntimeBootstrapMainService } from "../../platform/remote/electron-main/remoteRuntimeBootstrapMainService.js";
import { SshAppServerProcessLauncher } from "../../platform/remote/electron-main/sshAppServerProcessLauncher.js";
import { ElectronRemoteRuntimeInstallWindow } from "../../platform/remote/electron-main/electronRemoteRuntimeInstallWindow.js";
import { electronRemoteWindowMainHost } from "../../platform/remote/electron-main/electronRemoteWindowMainHost.js";
import { RemoteWindowMainContext } from "../../platform/remote/electron-main/remoteWindowMainContext.js";
import { WORKSPACE_CONTEXT_CHANGED_CHANNEL } from "../../platform/workspace/common/workspaceIpc.js";
import { createAppServerWorkspaceTransitionAdapter } from "../../platform/workspaces/electron-main/appServerWorkspaceTransition.js";
import { DEVELOPMENT_DIR_PERMISSIONS, READ_DIR_PERMISSIONS } from '../../platform/workspace/common/workspaceTrust.js';
import { type IWorkspaceTransitionFailure, type WorkspaceTransitionMainServiceOptions, WorkspaceTransitionFailureKind, WorkspaceTransitionMainService, WorkspaceTransitionStatus } from "../../platform/workspaces/electron-main/workspaceTransitionMainService.js";
import { WorkspacesManagementMainService } from '../../platform/workspaces/electron-main/workspacesManagementMainService.js';
import { WorkspaceOpenTargetKind } from '../../platform/environment/common/argv.js';
import { parseWorkspaceLaunchArguments } from '../../platform/environment/node/argvHelper.js';
import type { IWorkbenchWindowRecord } from "./workbenchWindowRegistry.js";
import { WorkbenchWindowRegistry } from "./workbenchWindowRegistry.js";
import { LocalizationConfiguration } from '../../workbench/services/localization/common/locale.js';
import { builtinLanguagePackCatalogs } from '../../workbench/services/localization/common/localizationCatalogs.js';
import { electronWorkspaceLaunchArguments } from "./electronWindowLaunch.js";
import { workbenchModeIpcRoutes } from "../../workbench/services/workbenchMode/electron-main/workbenchModeIpc.js";
export type AppServerStartupMode = "required" | "disabled";

export interface AshApplicationOptions {
	readonly initialModeId: WorkbenchModeId;
	readonly rendererRoot: string;
	/** Selects whether this Electron process starts the App Server before opening its window. */
	readonly appServerStartupMode: AppServerStartupMode;
	/** Host-selected IPC capabilities installed for every Workbench window. */
}

interface PersistentServices {
	readonly state: StateService;
	readonly configuration: ConfigurationMainService;
	readonly keybindings: KeybindingsResourceMainService;
	readonly userKeyboardLayout: UserKeyboardLayoutMainService;
}

interface RendererEntry {
	readonly file: string;
	readonly url: string;
	readonly useDevelopmentUrl: boolean;
}

interface WorkbenchWindowRecord extends IWorkbenchWindowRecord {
	readonly window: BrowserWindow;
	readonly workspaceContext: WorkspaceContextMainService;
	readonly supervisor: AppServerConnectionRelay;
	readonly resources: DisposableStore;
	readonly remoteConnections: IRemoteConnectionService;
	modeId: WorkbenchModeId;
	windowsStateHandler: WindowsStateHandler;
	windowStateTracking: IDisposable;
	openWorkspace?: (root: string) => Promise<void>;
}

class SessionsWindowRecord extends Disposable {
	readonly workspaceContext: WorkspaceContextMainService;
	readonly remoteConnections: IRemoteConnectionService;
	readonly modeId: WorkbenchModeId;
	readonly runtimeResources = this._register(new MutableDisposable<DisposableStore>());
	supervisor: AppServerConnectionRelay | undefined;
	private readonly handoffs = new Map<string, { readonly options: IOpenAgentsWindowOptions; readonly resolve: () => void; readonly reject: (error: Error) => void }>();
	private readonly handoffQueue: string[] = [];

	constructor(workspaceContext: WorkspaceContextMainService, remoteConnections: IRemoteConnectionService, modeId: WorkbenchModeId) {
		super();
		this.workspaceContext = this._register(workspaceContext);
		this.remoteConnections = remoteConnections;
		this.modeId = modeId;
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

interface PendingWindowLaunch {
	readonly arguments: readonly string[];
	readonly cwd: string;
}

type WindowSessionEntry =
	| { readonly kind: 'workbench'; readonly workspace: IAnyWorkspaceIdentifier }
	| { readonly kind: 'sessions'; readonly workspace: IAnyWorkspaceIdentifier; readonly modeId: WorkbenchModeId };

const AGENTS_WINDOW_KEY = 'agents';

async function watchProfileThemeFiles(profileRoot: string, window: BrowserWindow, resources: DisposableStore): Promise<void> {
	const directory = join(profileRoot, 'themes');
	await mkdir(directory, { recursive: true });
	const watcher = watch(directory, { persistent: false, recursive: true }, () => {
		window.webContents.send(LOCAL_FILE_SYSTEM_CHANGED_CHANNEL);
	});
	watcher.on('error', error => console.error('Failed to watch user themes', error));
	resources.add(toDisposable(() => watcher.close()));
}

/** Owns the Electron application's persistent services, Workbench windows, IPC, and shutdown. */
export class AshApplication extends Disposable {
	private defaultModeId: WorkbenchModeId;
	private readonly rendererRoot: string;
	private readonly appServerStartupMode: AppServerStartupMode;
	private readonly disposableTracker: DisposableTracker | undefined;
	private readonly tracking: globalThis.Disposable | undefined;
	private readonly trustedIpcRouter: TrustedIpcRouter;
	private readonly updateMainService: UpdateMainService;
	private readonly nativeKeyboardLayout: NativeKeyboardLayoutMainService;
	private readonly globalKeybindings: GlobalKeybindingsMainService;
	private readonly nativeMenubar: NativeMenubarMainService | undefined;
	private readonly profileRoot: string;
	private readonly developmentAppServerReloader = this._register(new MutableDisposable<DevelopmentAppServerReloader>());
	private readonly windowIconPath: string | undefined;

	private readonly workbenchWindows = new WorkbenchWindowRegistry<WorkbenchWindowRecord>();
	private readonly sessionsWindow = this._register(new MutableDisposable<SessionsWindowRecord>());
	private sessionsWindowOpenQueue: Promise<void> = Promise.resolve();
	private readonly windowsMainService = this._register(new WindowsMainService(
		() => this.workbenchWindows.values().map(record => record.window),
		async () => {
			const workspaces = this.workspaces;
			if (!workspaces) throw new Error('Workspace service is not initialized');
			return (await this.openWorkspace(createEmptyWorkspaceIdentifier(), workspaces))?.window;
		},
		process.platform,
	));
	private readonly dialogs = this._register(new DialogMainService({
		showMessageBox: (options, window) => window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options),
		showOpenDialog: (options, window) => window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options),
		showSaveDialog: (options, window) => window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options),
	}));
	private lifecycleMainService!: LifecycleMainService<BrowserWindow>;
	private windowSessionStateHandler!: WindowSessionStateHandler<WindowSessionEntry>;
	private readonly pendingWindowLaunches: PendingWindowLaunch[] = [];
	private workspaces: WorkspacesManagementMainService | undefined;
	private persistentServices: PersistentServices | undefined;
	private closePersistentServicesPromise: Promise<void> | undefined;
	private quitRequested = false;
	private quitAfterStateSaved = false;
	private quitSaveStarted = false;

	private constructor(
		options: AshApplicationOptions,
		disposableTracker: DisposableTracker | undefined,
		tracking: globalThis.Disposable | undefined,
	) {
		super();
		this.defaultModeId = options.initialModeId;
		this.rendererRoot = options.rendererRoot;
		this.appServerStartupMode = options.appServerStartupMode;
		this.disposableTracker = disposableTracker;
		this.tracking = tracking;
		this.trustedIpcRouter = this._register(new TrustedIpcRouter(ipcMain));
		this.updateMainService = this._register(new UpdateMainService(version => this.lifecycleMainService.prepareUpdateRestart(version)));
		this.nativeKeyboardLayout = this._register(new NativeKeyboardLayoutMainService());
		this.globalKeybindings = this._register(new GlobalKeybindingsMainService({
			shortcuts: globalShortcut,
			activeWindowId: () => this.workbenchWindows.active()?.id,
			runCommand: (windowId, commandId) => {
				if (commandId !== OPEN_AGENTS_WINDOW_COMMAND_ID) return;
				const record = this.workbenchWindows.values().find(candidate => candidate.id === windowId);
				if (record) return this.openSessionsWindow(record.workspaceContext.getWorkspace(), record.workspaceContext.getResolvedWorkspace(), record.modeId);
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

		app.on("before-quit", this.onBeforeQuit);
		app.on("will-quit", this.onWillQuit);
		app.on("accessibility-support-changed", this.onAccessibilitySupportChanged);
		this._register(toDisposable(() => {
			app.removeListener("before-quit", this.onBeforeQuit);
			app.removeListener("will-quit", this.onWillQuit);
			app.removeListener("accessibility-support-changed", this.onAccessibilitySupportChanged);
		}));
	}

	static create(options: AshApplicationOptions): AshApplication {
		const disposableTracker = app.isPackaged
			? undefined
			: new DisposableTracker();
		const tracking = disposableTracker
			? installDisposableTracker(disposableTracker)
			: undefined;
		return new AshApplication(options, disposableTracker, tracking);
	}

	async startupAfterReady(): Promise<void> {
		if (!app.isReady()) {
			throw new Error("Ash application startup requires Electron to be ready");
		}
		if (process.platform === "darwin") {
			assertDefined(app.dock, 'macOS Dock API is unavailable');
			if (!app.isPackaged) {
				app.dock.setIcon(join(app.getAppPath(), '..', 'resources', 'darwin', 'ash.png'));
			}
			await app.dock.show();
		} else {
			clearElectronApplicationMenu();
		}

		await this.createPersistentServices();
		this.lifecycleMainService = this._register(new LifecycleMainService<BrowserWindow>(async (window, message) => {
			this.windowsMainService.failManagedWindowClose(window, message);
			await this.dialogs.showMessageBox({ type: 'error', message }, window);
		}, window => this.windowsMainService.failManagedWindowClose(window, 'Window close was vetoed'), this.services.state, app.getVersion()));
		this.windowSessionStateHandler = new WindowSessionStateHandler(this.services.state, () => this.getOpenWindowSessions(), isWindowSessionEntry);
		const wasUpdated = this.lifecycleMainService.wasRestarted;
		const workspaces = new WorkspacesManagementMainService();
		this.workspaces = workspaces;
		{
			using restoration = this.windowSessionStateHandler.beginRestoration();
			await this.openStartupWindows(workspaces, wasUpdated);
		}
		if (this.workbenchWindows.size === 0 && this.windowsMainService.managedWindowValues().length === 0) {
			if (!this.quitRequested) app.quit();
			return;
		}
		await this.windowSessionStateHandler.saveSession();
		this.createTray();
		await this.drainPendingWindowLaunches();
	}

	private async openStartupWindows(workspaces: WorkspacesManagementMainService, wasUpdated: boolean): Promise<void> {
		const launch = await this.resolveWorkspace();
		if (!app.isPackaged && process.env.ASH_DEV_AGENTS_WINDOW === '1') {
			await this.openSessionsWindow(launch.workspace, await workspaces.resolveWorkspace(launch.workspace), this.defaultModeId);
			return;
		}
		await this.restoreWindowSession(workspaces, launch.explicit, wasUpdated);
		if (launch.explicit) {
			await this.openWorkspace(launch.workspace, workspaces);
		} else if (this.workbenchWindows.size === 0 && this.windowsMainService.managedWindowValues().length === 0) {
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
					await this.openSessionsWindow(entry.workspace, await workspaces.resolveWorkspace(entry.workspace), entry.modeId);
				}
			} catch (error) {
				console.error('Failed to restore window', error);
			}
		}
		const active = selection.active;
		if (active) {
			if (active.kind === 'workbench') this.workbenchWindows.findWorkspace(active.workspace)?.focus();
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
		tray.setToolTip(AshApplicationName);
		tray.on('click', () => this.handleActivate());
		this._register(toDisposable(() => tray.destroy()));
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

	/** Opens a second-instance Workspace in its own window, or focuses the active window when no target was supplied. */
	handleSecondInstance(arguments_: readonly string[], cwd: string): void {
		const launch = { arguments: arguments_, cwd };
		if (!this.persistentServices || !this.workspaces) {
			this.pendingWindowLaunches.push(launch);
			return;
		}
		void this.openWindowLaunch(launch).catch(error => this.reportWindowOpenFailure(error));
	}

	/** Focuses a live window, or recreates an empty Workbench when none remains. */
	handleActivate(): void {
		if (this.workbenchWindows.focusActive()) return;
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

	private async createPersistentServices(): Promise<void> {
		const state = await StateService.create(
			join(app.getPath("userData"), "state.json"),
		);
		let configuration: ConfigurationMainService | undefined;
		let keybindings: KeybindingsResourceMainService | undefined;
		let userKeyboardLayout: UserKeyboardLayoutMainService | undefined;
		try {
			configuration = await ConfigurationMainService.create({
				filePath: join(this.profileRoot, "settings.json"),
				onError: (error) => {
					console.error("Failed to process configuration", error);
				},
			});
			keybindings = await KeybindingsResourceMainService.create({
				filePath: join(this.profileRoot, "keybindings.json"),
				onError: (error) => {
					console.error("Failed to process keybindings resource", error);
				},
			});
			userKeyboardLayout = await UserKeyboardLayoutMainService.create({
				filePath: join(this.profileRoot, "keyboard-layout.json"),
				openResource: (filePath) => shell.openPath(filePath),
				onError: (error) => {
					console.error("Failed to process user keyboard layout", error);
				},
			});
			this.persistentServices = { state, configuration, keybindings, userKeyboardLayout };
		} catch (error) {
			await Promise.all([
				state.close(),
				configuration?.close(),
				keybindings?.close(),
				userKeyboardLayout?.close(),
			]);
			throw error;
		}
	}

	private async resolveWorkspace(): Promise<{ readonly workspace: IAnyWorkspaceIdentifier; readonly explicit: boolean }> {
		try {
			const target = parseWorkspaceLaunchArguments(this.workspaceLaunchArguments(process.argv));
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
		return electronWorkspaceLaunchArguments({
			arguments: arguments_,
			packaging: app.isPackaged ? "packaged" : "development",
			appPath: app.getAppPath(),
		});
	}

	private async openWindowLaunch(launch: PendingWindowLaunch): Promise<void> {
		const workspaces = this.workspaces;
		if (!workspaces) throw new Error("Workspace service is not initialized");
		const arguments_ = this.workspaceLaunchArguments(launch.arguments);
		const target = parseWorkspaceLaunchArguments(arguments_);
		if (!target) {
			this.handleActivate();
			return;
		}
		const workspace = await this.windowsMainService.resolveWorkspaceOpenTarget(target, launch.cwd);
		await this.openWorkspace(workspace, workspaces);
	}

	private async drainPendingWindowLaunches(): Promise<void> {
		while (this.pendingWindowLaunches.length > 0 && !this.quitRequested) {
			const launch = this.pendingWindowLaunches.shift()!;
			try {
				await this.openWindowLaunch(launch);
			} catch (error) {
				await this.reportWindowOpenFailure(error);
			}
		}
	}

	private openWorkspace(workspace: IAnyWorkspaceIdentifier, workspaces: WorkspacesManagementMainService): Promise<WorkbenchWindowRecord | undefined> {
		return this.workbenchWindows.openWorkspace(workspace, () => this.performOpenWorkspace(workspace, workspaces));
	}

	private async performOpenWorkspace(workspace: IAnyWorkspaceIdentifier, workspaces: WorkspacesManagementMainService): Promise<WorkbenchWindowRecord | undefined> {
		const existing = this.workbenchWindows.findWorkspace(workspace);
		if (existing) {
			existing.focus();
			return existing;
		}
		const resources = new DisposableStore();
		try {
			const resolvedWorkspace = await workspaces.resolveWorkspace(workspace);
			const workspaceContext = resources.add(new WorkspaceContextMainService(workspace, resolvedWorkspace));
			const supervisor = resources.add(this.createAppServerConnectionRelay(workspace, resources));
			const browserAutomation = new BrowserAutomationMainService();
			resources.add(supervisor.onStateChange(state => {
				if (state === "crashed" || state === "restarting" || state === "stopping" || state === "stopped") browserAutomation.reset();
			}));
			if (this.appServerStartupMode === "required" && !await this.startAppServerWithRecovery(supervisor)) {
				resources.dispose();
				return undefined;
			}
			return await this.openWorkbenchWindow(workspaceContext, workspaces, supervisor, browserAutomation, resources);
		} catch (error) {
			resources.dispose();
			throw error;
		}
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
		let processLauncher: IAppServerProcessLauncher;
		let generationFile: string | undefined;
		if (role === 'workbench' && getWorkspaceRemoteAuthority(workspace) !== undefined) {
			processLauncher = this.createSshAppServerProcessLauncher(workspace, resources);
		} else {
			const connection = createAppServerDaemonLauncher({
				packageLocation: { appPath: app.getAppPath(), expectedVersion: app.getVersion(), isPackaged: app.isPackaged, platform: process.platform, resourcesPath: process.resourcesPath },
				sourceEnvironment: process.env,
				profileRoot: this.profileRoot,
				electronExecutable: process.execPath,
				workspaceRoot: role === 'workbench' && isSingleFolderWorkspaceIdentifier(workspace) ? workspace.uri.fsPath : undefined,
				role,
			});
			processLauncher = connection.launcher;
			generationFile = connection.generationFile;
		}
		const supervisor = existing ?? new AppServerConnectionRelay({
			enabled: true,
			processLauncher,
		});
		if (existing) existing.replaceProcessLauncher(processLauncher);
		if (generationFile && processLauncher instanceof AppServerDaemonLauncher) {
			if (!this.developmentAppServerReloader.value) this.developmentAppServerReloader.value = new DevelopmentAppServerReloader({ generationFile });
			resources.add(this.developmentAppServerReloader.value.registerConnection(processLauncher, supervisor));
		}
		return supervisor;
	}

	private createSshAppServerProcessLauncher(workspace: IAnyWorkspaceIdentifier, resources: DisposableStore) {
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
			runtimeInstaller,
			connectionProfiles,
			logProgress: createRemoteRuntimeInstallProgressLogger(),
		}));
		resources.add(new ElectronRemoteRuntimeInstallWindow({
			productName: WorkbenchModeRegistry.get(this.defaultModeId).title,
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
					title: `${WorkbenchModeRegistry.get(this.defaultModeId).title} startup failed`,
					message: "The App Server could not be validated.",
					detail,
					buttons: ["Retry", this.workbenchWindows.size === 0 ? "Quit" : "Cancel"],
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
		browserAutomationMainService: BrowserAutomationMainService,
		resources: DisposableStore,
	): Promise<WorkbenchWindowRecord> {
		const windowsStateHandler = this.createWindowsStateHandler(workspaceContext.getWorkspace());
		const windowState = windowsStateHandler.restoreWindowState();
		const titleBarStyle = this.titleBarStyle;
		const windowHost = this.windowsMainService.createWindow(options => new BrowserWindow(options), {
			state: windowState,
			titleBarStyle,
			webPreferences: this.createSandboxWebPreferences(),
			title: WorkbenchModeRegistry.get(this.defaultModeId).title,
			tabbingIdentifier: process.platform === 'darwin' ? 'ash-workbench' : undefined,
			icon: this.windowIconPath,
		}, resources);
		const window = windowHost.win;
		const remoteConnections = this.createRemoteConnections(workspaces);
		const windowStateTracking = windowsStateHandler.trackWindow(window);
		const record: WorkbenchWindowRecord = {
			id: window.id,
			openedWorkspace: workspaceContext.getWorkspace(),
			window,
			workspaceContext,
			supervisor,
			resources,
			remoteConnections,
			modeId: this.defaultModeId,
			windowsStateHandler,
			windowStateTracking,
			isDestroyed: () => window.isDestroyed(),
			focus: () => focusWindow(window),
		};
		this.workbenchWindows.add(record);
		resources.add(toDisposable(() => this.globalKeybindings.removeWindow(record.id)));
		const onFocus = (): void => {
			if (!window.isDestroyed()) {
				this.workbenchWindows.activate(record.id);
				this.windowSessionStateHandler.windowFocused(record.id);
			}
		};
		window.on("focus", onFocus);
		resources.add(toDisposable(() => window.removeListener("focus", onFocus)));
		window.once("closed", () => {
			this.workbenchWindows.remove(record.id);
			this.windowSessionStateHandler.windowClosed({ kind: 'workbench', workspace: record.openedWorkspace });
		});
		this.windowSessionStateHandler.windowOpened();

		const rendererEntry = this.resolveRendererEntry("workbench");

		const windowDisposables = resources;
		const auxiliaryWindows = windowDisposables.add(new DisposableMap<number, IDisposable>());
		// Apply restored popup bounds before creation; Chromium ignores its position features here.
		window.webContents.setWindowOpenHandler(details => {
			if (details.url !== 'about:blank') return { action: 'allow' };
			const features = new URLSearchParams(details.features.replaceAll(',', '&'));
			const x = Number(features.get('x'));
			const y = Number(features.get('y'));
			const width = Number(features.get('width'));
			const height = Number(features.get('height'));
			if (!features.has('x') || !features.has('y') || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return { action: 'allow' };
			return { action: 'allow', overrideBrowserWindowOptions: { x, y, width, height } };
		});
		const onDidCreateWindow = (child: BrowserWindow, details: { readonly url: string }): void => {
			if (details.url !== 'about:blank') return;
			auxiliaryWindows.set(child.id, this.windowsMainService.registerAuxiliaryWindow(child));
			child.once('closed', () => auxiliaryWindows.deleteAndDispose(child.id));
		};
		window.webContents.on('did-create-window', onDidCreateWindow);
		windowDisposables.add(toDisposable(() => window.webContents.off('did-create-window', onDidCreateWindow)));
		const workspaceHost = windowDisposables.add(new RendererWorkspaceHost(window.webContents));
		windowDisposables.add(record.windowStateTracking);
		const remoteTunnelService = new SshRemoteTunnelService({
			getWorkspace: () => workspaceContext.getWorkspace(),
			sshExecutable: process.env.ASH_SSH_PATH ?? "ssh",
			localEnvironment: process.env,
		});
		const browserTargetRegistry = new BrowserTargetRegistry();
		const browserViewMainService = windowDisposables.add(
			new BrowserViewMainService({
				window,
				registry: browserTargetRegistry,
				emitEvent: (event) => {
					if (!window.isDestroyed()) {
						window.webContents.send(BROWSER_VIEW_EVENT_CHANNEL, event);
					}
				},
				navigationResolver: new RemoteBrowserViewNavigationResolver({
					getWorkspace: () => workspaceContext.getWorkspace(),
					tunnels: remoteTunnelService,
					reportError: (message, error) => console.error(message, error),
				}),
			}),
		);
		windowDisposables.add(browserAutomationMainService.bind(browserViewMainService, browserTargetRegistry));
		windowDisposables.add(workspaceContext.onDidChangeWorkspace(({ workspace: nextWorkspace }) => {
			if (window.isDestroyed()) return;
			record.windowStateTracking.dispose();
			const nextWindowsStateHandler = this.createWindowsStateHandler(nextWorkspace);
			record.windowsStateHandler = nextWindowsStateHandler;
			record.windowStateTracking = windowDisposables.add(nextWindowsStateHandler.trackWindow(window));
			this.workbenchWindows.updateWorkspace(record.id, nextWorkspace);
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
			keybindings: this.services.keybindings,
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

		windowDisposables.add(toDisposable(() => this.dialogs.cancelWindow(window)));
		const windowControlsOverlay = new WindowControlsOverlay(colors => {
			if (titleBarStyle === 'custom' && (process.platform === 'win32' || process.platform === 'linux')) window.setTitleBarOverlay(colors);
		});
		const ipcRoutes = [
			...workspaceHost.routes(),
			...supervisor.routes(window.webContents, () => ({ workspaceId: workspaceContext.getWorkspace().id, workspaceRoot: workspaceContext.getResolvedWorkspace().folders[0]?.uri.fsPath ?? this.profileRoot })),
			...windowDisposables.add(new BrowserAutomationHost(browserAutomationMainService)).routes(),
			...windowDisposables.add(new OAuthCallbackHost()).routes(),
			...rendererSystemHostRoutes(window, path => this.directoryPermissionPrompt(path)),
			...remoteWindowContext.ipcRoutes,
			...browserViewIpcRoutes(browserViewMainService),
			...windowResourceIpcRoutes(windowResources),
			windowOperationIpcRoute(this.windowsMainService, window),
			windowCloseResponseIpcRoute(this.lifecycleMainService, window),
			...nativeHostIpcRoutes({
				openWindow: async options => {
					const workspace = { ...createEmptyWorkspaceIdentifier(), ...(options.remoteAuthority ? { remoteAuthority: options.remoteAuthority } : {}) };
					if (!options.forceReuseWindow) {
						await this.openWorkspace(workspace, workspaces);
						return;
					}
					if (options.remoteAuthority !== getWorkspaceRemoteAuthority(workspaceContext.getWorkspace())) throw new Error('Reusing a window must preserve its Remote authority');
					let rendererLoad: Promise<void> | undefined;
					const operation = workspaceOpenQueue.then(async () => {
						if (!await this.lifecycleMainService.unload(window)) return;
						try {
							await record.windowsStateHandler.saveWindowState(window);
							window.webContents.send('ash:terminal:prepareReplacement');
							if (this.appServerStartupMode !== 'disabled') {
								const launcher = supervisor.options.enabled ? supervisor.options.processLauncher : undefined;
								if (!(launcher instanceof AppServerDaemonLauncher) && !(launcher instanceof SshAppServerProcessLauncher)) throw new Error('Workspace connection has no directory launcher');
								await this.reconnectAppServerWorkspace(supervisor, launcher, undefined, { type: 'config' }, workspace.id, workspaceContext.getWorkspace().id, workspaceHost);
							}
							loadingWorkspace = true;
							workspaceContext.updateWorkspace(workspace);
						} finally {
							// Reply to the caller before replacing the renderer that owns the IPC request.
							rendererLoad = new Promise<void>(resolve => {
								setImmediate(() => {
									void this.loadRendererEntry(window, this.resolveRendererEntry('workbench', record.modeId))
										.catch(error => this.reportWindowOpenFailure(error)).finally(() => { loadingWorkspace = false; resolve(); });
								});
							});
						}
					});
					workspaceOpenQueue = operation.then(async () => { await rendererLoad; }, async () => { await rendererLoad; });
					await operation;
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
				openWorkspace: (root) => transitionToFolder(root, true),
				openAgentsWindow: options => this.openSessionsWindow(record.workspaceContext.getWorkspace(), record.workspaceContext.getResolvedWorkspace(), record.modeId, options),
				revealFile: path => {
					if (!isAbsolute(path)) throw new TypeError('File path to reveal must be absolute');
					shell.showItemInFolder(path);
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
				isAccessibilitySupportEnabled: () => app.isAccessibilitySupportEnabled(),
				setWindowTheme: theme => windowControlsOverlay.setTheme(theme),
				setWindowDimmed: dimmed => windowControlsOverlay.setDimmed(dimmed),
				toggleDeveloperTools: () => window.webContents.toggleDevTools(),
				syncSystemWideKeybindings: bindings => this.globalKeybindings.updateKeybindings(
					record.id,
					bindings.filter(binding => binding.commandId === OPEN_AGENTS_WINDOW_COMMAND_ID),
				),
			}),
			...workbenchModeIpcRoutes(modeId => this.scheduleWorkbenchModeSwitch(record, modeId)),
			...diskFileSystemProviderRoutes(windowDisposables.add(new DiskFileSystemProvider([URI.file(this.profileRoot)])), URI.file(this.profileRoot)),
			...workspaceContextIpcRoutes(workspaceContext),
			...updateIpcRoutes(this.updateMainService),
		];
		await watchProfileThemeFiles(this.profileRoot, window, windowDisposables);
		const systemContextMenu = windowDisposables.add(new ElectronContextMenu(window));
		ipcRoutes.push(...nativeContextMenuIpcRoutes(systemContextMenu));
		if (this.nativeMenubar) {
			windowDisposables.add(this.nativeMenubar.registerWindow(window));
			ipcRoutes.push(...nativeMenubarIpcRoutes(this.nativeMenubar, window));
		}
		windowDisposables.add(this.trustedIpcRouter.register(
			{
				webContents: window.webContents,
				allowedEntryUrls: new Set(WorkbenchModeRegistry.modeIds.map(modeId => normalizeEntryUrl(this.resolveRendererEntry("workbench", modeId).url))),
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

	private openSessionsWindow(workspace: IAnyWorkspaceIdentifier, resolvedWorkspace: IWorkspace, modeId: WorkbenchModeId, handoff?: IOpenAgentsWindowOptions): Promise<void> {
		const opening = this.sessionsWindowOpenQueue.then(() => this.performOpenSessionsWindow(workspace, resolvedWorkspace, modeId, handoff));
		this.sessionsWindowOpenQueue = opening.then(() => undefined, () => undefined);
		return opening;
	}

	/** Opens the one Agents window and selects the requesting Workspace before a handoff. */
	private async performOpenSessionsWindow(workspace: IAnyWorkspaceIdentifier, resolvedWorkspace: IWorkspace, modeId: WorkbenchModeId, handoff?: IOpenAgentsWindowOptions): Promise<void> {
		const mode = WorkbenchModeRegistry.get(modeId);
		if (!mode.dedicatedSessions) {
			throw new Error(`${mode.title} does not provide a dedicated Sessions window`);
		}
		const workspaces = this.workspaces;
		if (!workspaces) throw new Error('Workspace service is not initialized');
		let sessions = this.sessionsWindow.value;
		if (!sessions) {
			const remoteConnections = this.createRemoteConnections(workspaces);
			const workspaceContext = new WorkspaceContextMainService(workspace, resolvedWorkspace);
			sessions = new SessionsWindowRecord(workspaceContext, remoteConnections, modeId);
			this.sessionsWindow.value = sessions;
		}
		const session = sessions;
		const sessionsEntry = this.resolveRendererEntry("sessions", session.modeId);
		const sessionsWindowState = this.createWindowsStateHandler(UNKNOWN_EMPTY_WINDOW_WORKSPACE, {
			storageKey: 'sessionsWindowState',
			defaultState: { mode: WindowMode.Normal, width: 1_180, height: 780 },
		});
		const titleBarStyle = this.titleBarStyle;
		const wasOpen = this.windowsMainService.managedWindow(AGENTS_WINDOW_KEY) !== undefined;
		await this.windowsMainService.openManagedWindow(
			AGENTS_WINDOW_KEY,
			options => new BrowserWindow(options),
			{
				title: `${WorkbenchModeRegistry.get(session.modeId).title} Sessions`,
				titleBarStyle,
				icon: this.windowIconPath,
				state: sessionsWindowState.restoreWindowState(),
				webPreferences: this.createSandboxWebPreferences(),
				initialize: async (window, windowDisposables) => {
					windowDisposables.add(sessionsWindowState.trackWindow(window));
					const onFocus = (): void => {
						this.windowSessionStateHandler.windowFocused(window.id);
					};
					window.on('focus', onFocus);
					windowDisposables.add(toDisposable(() => window.removeListener('focus', onFocus)));
					// A renderer reload cannot acknowledge a draft already handed to the previous renderer.
					const rejectInterruptedHandoffs = (): void => session.rejectHandoffs(new Error('Agents Window reloaded before the handoff completed'));
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
						// Start before routes bind the renderer so daemon selection overlaps page loading.
						if (this.appServerStartupMode === 'required') await sessionsRelay.start();
					} catch (error) {
						runtimeResources.dispose();
						throw error;
					}
					session.supervisor = sessionsRelay;
					session.runtimeResources.value = runtimeResources;
					const remoteWindowContext = windowDisposables.add(new RemoteWindowMainContext({
						supervisor: sessionsRelay,
						workspaceContext: session.workspaceContext,
						connections: session.remoteConnections,
						tunnels: new SshRemoteTunnelService({
							getWorkspace: () => session.workspaceContext.getWorkspace(),
							sshExecutable: process.env.ASH_SSH_PATH ?? "ssh",
							localEnvironment: process.env,
						}),
						host: electronRemoteWindowMainHost(window, this.dialogs),
						prepareForRuntimeReplacement: () => window.webContents.send("ash:terminal:prepareReplacement"),
					}));
					const windowResources = {
						configuration: this.services.configuration,
						keybindings: this.services.keybindings,
						nativeKeyboardLayout: this.nativeKeyboardLayout,
						userKeyboardLayout: this.services.userKeyboardLayout,
					};
					const ipcRoutes = [
						...sessionsRelay.routes(window.webContents, () => ({ workspaceId: AGENTS_WINDOW_KEY, workspaceRoot: this.profileRoot })),
						...rendererSystemHostRoutes(window, path => this.directoryPermissionPrompt(path)),
						...remoteWindowContext.ipcRoutes,
						...windowResourceIpcRoutes(windowResources),
						...windowAppearanceIpcRoutes({
							setWindowTheme: theme => windowControlsOverlay.setTheme(theme),
							setWindowDimmed: dimmed => windowControlsOverlay.setDimmed(dimmed),
						}),
						windowOperationIpcRoute(this.windowsMainService, window),
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
								opened?.focus();
							},
						},
						windowCloseResponseIpcRoute(this.lifecycleMainService, window),
					];
					await watchProfileThemeFiles(this.profileRoot, window, windowDisposables);
					const systemContextMenu = windowDisposables.add(new ElectronContextMenu(window));
					ipcRoutes.push(...nativeContextMenuIpcRoutes(systemContextMenu));
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
				this.windowSessionStateHandler.windowClosed({ kind: 'sessions', workspace: closedWorkspace, modeId: session.modeId });
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

	private scheduleWorkbenchModeSwitch(record: WorkbenchWindowRecord, modeId: WorkbenchModeId): void {
		if (record.modeId === modeId) return;
		setImmediate(() => {
			void this.switchWorkbenchMode(record, modeId).catch(error => this.reportWorkbenchModeSwitchFailure(record, error));
		});
	}

	private async switchWorkbenchMode(record: WorkbenchWindowRecord, modeId: WorkbenchModeId): Promise<void> {
		if (record.window.isDestroyed() || record.modeId === modeId) return;
		const previousModeId = record.modeId;
		const previousDefaultModeId = this.defaultModeId;
		this.globalKeybindings.removeWindow(record.id);
		record.modeId = modeId;
		this.defaultModeId = modeId;
		try {
			await this.loadRendererEntry(record.window, this.resolveRendererEntry("workbench", modeId));
		} catch (error) {
			record.modeId = previousModeId;
			this.defaultModeId = previousDefaultModeId;
			let persistenceError: unknown;
			try {
				await this.persistWorkbenchModeId(previousDefaultModeId);
			} catch (candidate) {
				persistenceError = candidate;
			}
			try {
				await this.loadRendererEntry(record.window, this.resolveRendererEntry("workbench", previousModeId));
			} catch (rollbackError) {
				throw new AggregateError([error, persistenceError, rollbackError].filter(candidate => candidate !== undefined), "Workbench mode switch and rollback both failed");
			}
			if (persistenceError !== undefined) throw new AggregateError([error, persistenceError], "Workbench mode switch failed and its persisted preference could not be restored");
			throw error;
		}
	}

	private async persistWorkbenchModeId(modeId: WorkbenchModeId): Promise<void> {
		const configuration = this.services.configuration;
		const snapshot = configuration.read();
		if (configurationValues(snapshot.document)[WorkbenchModeConfigurationKey] === modeId) return;
		await configuration.update({
			expectedRevision: snapshot.revision,
			document: {
				version: 1,
				source: editJsonObjectProperty(snapshot.document.source, WorkbenchModeConfigurationKey, modeId),
			},
		});
	}

	private async reportWorkbenchModeSwitchFailure(record: WorkbenchWindowRecord, error: unknown): Promise<void> {
		console.error("Failed to switch Workbench mode", error);
		if (record.window.isDestroyed()) return;
		const detail = error instanceof Error ? error.message : "The requested mode could not be loaded";
		await this.dialogs.showMessageBox({
			type: "error",
			title: `${AshApplicationName} mode switch failed`,
			message: "The requested Workbench mode could not be loaded.",
			detail: detail.slice(0, 8_000),
			buttons: ["OK"],
			defaultId: 0,
			cancelId: 0,
			noLink: true,
		}, record.window);
	}

	private resolveRendererEntry(kind: "workbench" | "sessions" | "remoteRuntimeInstall", modeId: WorkbenchModeId = this.defaultModeId): RendererEntry {
		const mode = WorkbenchModeRegistry.get(modeId);
		const entry = kind === "workbench"
			? WorkbenchRendererEntry
			: kind === "sessions"
				? mode.dedicatedSessions?.rendererEntry
				: "remoteRuntimeInstall";
		if (!entry) {
			throw new Error(`${mode.title} does not provide a Sessions renderer entry`);
		}
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
			url: kind === "workbench" ? withWorkbenchModeId(baseUrl, modeId) : baseUrl,
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
		if (!(launcher instanceof AppServerDaemonLauncher) && !(launcher instanceof SshAppServerProcessLauncher)) {
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
		launcher: AppServerDaemonLauncher | SshAppServerProcessLauncher,
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
				title: `${WorkbenchModeRegistry.get(this.defaultModeId).title} window failed`,
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
		if (this.persistentServices) this.windowSessionStateHandler.stopAutomaticSaves();
		const records = this.workbenchWindows.values();
		for (const record of records) record.supervisor.dispose();
		if (this.quitAfterStateSaved || !this.persistentServices) {
			return;
		}
		event.preventDefault();
		if (this.quitSaveStarted) {
			return;
		}

		this.quitSaveStarted = true;
		for (const record of records) record.windowStateTracking.dispose();
		void (async () => {
			try {
				await this.windowSessionStateHandler.saveSession();
				for (const record of records) {
					if (!record.window.isDestroyed()) await record.windowsStateHandler.saveWindowState(record.window);
				}
				await this.closePersistentServices();
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
		for (const record of this.workbenchWindows.values()) {
			record.window.webContents.send(NATIVE_HOST_ACCESSIBILITY_SUPPORT_CHANGED_CHANNEL, enabled);
		}
		for (const window of this.windowsMainService.managedWindowValues()) {
			window.webContents.send(NATIVE_HOST_ACCESSIBILITY_SUPPORT_CHANGED_CHANNEL, enabled);
		}
	};

	private readonly onWillQuit = (): void => {
		this.dispose();
		this.releaseDisposableTracker();
	};

	private closePersistentServices(): Promise<void> {
		const services = this.persistentServices;
		this.closePersistentServicesPromise ??= services
			? Promise.all([
					services.state.close(),
					services.configuration.close(),
					services.keybindings.close(),
					services.userKeyboardLayout.close(),
				]).then(() => undefined)
			: Promise.resolve();
		return this.closePersistentServicesPromise;
	}

	private getOpenWindowSessions(): readonly IWindowSessionWindow<WindowSessionEntry>[] {
		const focusedWindowId = BrowserWindow.getFocusedWindow()?.id;
		const session = this.sessionsWindow.value;
		const sessionsWindow = session && this.windowsMainService.managedWindow(AGENTS_WINDOW_KEY);
		return [
			...this.workbenchWindows.values().map(record => ({
				id: record.id,
				entry: { kind: 'workbench' as const, workspace: record.openedWorkspace },
				focused: record.id === focusedWindowId,
			})),
			...(sessionsWindow && session ? [{ id: sessionsWindow.id, entry: { kind: 'sessions' as const, workspace: session.workspaceContext.getWorkspace(), modeId: session.modeId }, focused: sessionsWindow.id === focusedWindowId }] : []),
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
		const configuredLocale = configurationValues(this.services.configuration.read().document)[LocalizationConfiguration.locale];
		const locale = typeof configuredLocale === 'string' ? configuredLocale : 'en';
		const catalog = builtinLanguagePackCatalogs.find(candidate => candidate.locale === locale)
			?? builtinLanguagePackCatalogs.find(candidate => candidate.locale === 'en')!;
		const translate = (key: string, english: string): string => catalog.bundles.ash?.[key] ?? english;
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
				getAllDisplays: () => screen.getAllDisplays(),
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
	return (entry.kind === 'workbench' && entry.modeId === undefined)
		|| (entry.kind === 'sessions' && WorkbenchModeRegistry.isModeId(entry.modeId));
}

function workspaceTransitionError(
	failure: IWorkspaceTransitionFailure | undefined,
): Error {
	if (!failure) return new Error("Workspace transition failed without a classified failure");
	if (failure.error instanceof Error) return failure.error;
	return new Error(`Workspace transition failed during ${failure.stage}`);
}
