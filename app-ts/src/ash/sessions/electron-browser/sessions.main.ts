import { installBaseUiStyles } from "../../base/browser/ui/styles.js";
import { URI } from "../../base/common/uri.js";
import { IFileService } from "../../platform/files/common/files.js";
import { validateConfigurationSnapshot } from '../../platform/configuration/common/configurationIpc.js';
import { InstantiationService } from "../../platform/instantiation/common/instantiationService.js";
import { addDisposableListener } from "../../base/browser/dom.js";
import { DisposableStore, toDisposable, type IDisposable } from "../../base/common/lifecycle.js";
import { onUnexpectedError } from "../../base/common/errors.js";
import type { WorkbenchModeId } from "../../workbench/common/workbenchMode.js";
import { createElectronRendererApi } from "../../platform/native/electron-browser/rendererApi.js";
import { registerLocalTranscriptionService } from '../../workbench/services/localTranscription/electron-browser/localTranscriptionService.js';
import { DirectoryPermissionDialog } from '../../workbench/electron-browser/parts/dialogs/directoryPermissionDialog.js';
import { createElectronWorkbenchContextMenuService } from "../../workbench/services/contextmenu/electron-browser/contextMenuService.js";
import type { SessionsProfile } from "../common/sessionsProfile.js";
import { Workbench } from "../browser/workbench.js";
import { NativeWindow } from '../../workbench/electron-browser/window.js';
import { bindWindowControlTheme } from '../../workbench/electron-browser/parts/titlebar/titlebarPart.js';
import { RETURN_TO_WORKBENCH_CHANNEL } from '../common/windowNavigation.js';
import { AGENTS_WINDOW_HANDOFF_AVAILABLE_CHANNEL, AGENTS_WINDOW_HANDOFF_COMPLETE_CHANNEL, AGENTS_WINDOW_HANDOFF_TAKE_CHANNEL } from '../common/windowNavigation.js';
import type { IOpenAgentsWindowOptions } from '../../platform/native/common/nativeHost.js';
import { ElectronLifecycleService } from '../../workbench/services/lifecycle/electron-browser/lifecycleService.js';
import { NativeHostColorSchemeService } from '../../workbench/services/themes/electron-browser/nativeHostColorSchemeService.js';
import { showStartupError } from "../../workbench/browser/startupError.js";
import { invoke, subscribe } from '../../platform/ipc/electron-browser/rendererIpc.js';
import { IMainProcessService } from '../../platform/ipc/common/mainProcessService.js';
import { ElectronIPCMainProcessService } from '../../platform/ipc/electron-browser/mainProcessService.js';
import { WINDOW_FULLSCREEN_CHANGED_CHANNEL, WINDOW_OPERATION_CHANNEL, WINDOW_ZOOM_CHANGED_CHANNEL } from '../../platform/window/common/window.js';
import { createWorkspaceContextApi } from '../../platform/workspace/electron-browser/workspaceContextApi.js';
import { parseWorkspace } from '../../platform/workspace/common/workspace.js';
import { selectionFromWorkspace } from '../browser/workspaceSelection.js';

/** Starts the Code-specific Electron Sessions page. */
export async function main(modeId: WorkbenchModeId, profile: SessionsProfile): Promise<IDisposable> {
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
				let handoff: { readonly id: string; readonly options: IOpenAgentsWindowOptions } | undefined;
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
	const profileServices = sessions.add(new InstantiationService());
	let api: Awaited<ReturnType<typeof createElectronRendererApi>>;
	try {
		const windowId = await invoke<unknown>('ash:ipc:window-id');
		if (!Number.isSafeInteger(windowId) || (windowId as number) <= 0) { throw new TypeError('Invalid Main IPC window ID'); }
		const mainProcessService = sessions.add(profileServices.createInstance(ElectronIPCMainProcessService, windowId as number));
		profileServices.registerInstance(IMainProcessService, mainProcessService);
		await mainProcessService.connect();
		api = await createElectronRendererApi([client => registerLocalTranscriptionService(transcriptionServices, client)], { browser: false }, permissionDialog, mainProcessService);
	}
	catch (error) { sessions.dispose(); return showStartupError(error, text => invoke<void>('ash:host:writeClipboard', text)); }
	sessions.add(api);
	profileServices.registerInstance(IFileService, api.localFiles);
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
	const initialConfigurationSnapshot = validateConfigurationSnapshot(await api.configuration.read());
	const workspaceContext = createWorkspaceContextApi();
	let workspace = parseWorkspace(await workspaceContext.getWorkspace());
	let workspaceSelection = selectionFromWorkspace(workspace);
	const workspaceSubscription = workspaceContext.onDidChange(value => {
		workspace = parseWorkspace(value);
		workspaceSelection = selectionFromWorkspace(workspace);
	});
	sessions.add(toDisposable(() => workspaceSubscription.dispose()));
	const hostColorScheme = await api.nativeHost.getOSColorScheme();
	workbench = sessions.add(await Workbench.create({
		modeId,
		profile,
		api,
		workspaceSelection: () => workspaceSelection,
		workspace: () => workspace,
		createLifecycleService: services => lifecycleService = services.createInstance(ElectronLifecycleService, { ownerWindow: window, onError: onUnexpectedError }),
		nativeHostApi: api.nativeHost,
		returnToWorkbench: () => { void invoke<void>(RETURN_TO_WORKBENCH_CHANNEL).catch(onUnexpectedError); },
		configurationApi: api.configuration,
		initialConfigurationSnapshot,
		keybindingsResourceApi: api.keybindings,
		createContextMenuService: options => createElectronWorkbenchContextMenuService(options, api.nativeContextMenu),
		createHostColorSchemeService: services => {
			const colors = services.createInstance(NativeHostColorSchemeService, hostColorScheme);
			void colors.initialize().catch(onUnexpectedError);
			return colors;
		},
		container,
	}));
	requestDrain();
	sessions.add(new NativeWindow(api.nativeHost, workbench.configurationService));
	sessions.add(bindWindowControlTheme(workbench.themeService, api.nativeHost));
	sessions.add(addDisposableListener(window, "pagehide", () => {
		void workbench.shutdown("pageHide").catch(error => console.error("Failed to shut down Sessions Workbench", error)).finally(() => sessions.dispose());
	}, { once: true }));
	await lifecycleService.initialize();
	return sessions;
}
