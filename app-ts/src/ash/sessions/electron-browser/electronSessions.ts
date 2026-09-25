import { installBaseUiStyles } from "../../base/browser/ui/styles.js";
import { addDisposableListener } from "../../base/browser/dom.js";
import { DisposableStore, type IDisposable } from "../../base/common/lifecycle.js";
import { onUnexpectedError } from "../../base/common/errors.js";
import type { WorkbenchModeId } from "../../workbench/common/workbenchMode.js";
import { createElectronRendererApi } from "../../platform/native/electron-browser/rendererApi.js";
import { createElectronWorkbenchContextMenuService } from "../../workbench/services/contextmenu/electron-browser/contextMenuService.js";
import type { SessionsProfile } from "../common/sessionsProfile.js";
import { Workbench } from "../browser/workbench.js";
import { createReturnToParentWindowApi } from "../../platform/windows/electron-browser/dedicatedWindowApi.js";
import { registerWindowCloseHandler } from '../../platform/windows/electron-browser/windowClose.js';
import { showStartupError } from "../../workbench/browser/startupError.js";
import { Keybinding, logicalKey } from '../../base/common/keybindings.js';
import { Action2, registerAction2 } from '../../platform/actions/common/actions.js';
import { localizedString } from '../../platform/action/common/action.js';
import { invoke } from '../../platform/ipc/electron-browser/rendererIpc.js';
import { WINDOW_OPERATION_CHANNEL, type IWorkbenchWindowInfo } from '../../platform/window/common/window.js';

registerAction2(class QuickSwitchWindowAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.quickSwitchWindow', title: localizedString('ash', 'workbench.quickSwitchWindow', 'Quick Switch Window'), keybinding: { primary: Keybinding.single(logicalKey('w', { primaryKey: true, altKey: true })) } });
	}

	override async run(): Promise<void> {
		const windows = await invoke<readonly IWorkbenchWindowInfo[]>(WINDOW_OPERATION_CHANNEL, { kind: 'list' });
		if (windows.length < 2) return;
		const focusedIndex = windows.findIndex(window => window.focused);
		await invoke<void>(WINDOW_OPERATION_CHANNEL, { kind: 'focus', windowId: windows[(focusedIndex + 1) % windows.length]!.id });
	}
});

/** Starts the Code-specific Electron Sessions page. */
export async function startElectronSessions(modeId: WorkbenchModeId, profile: SessionsProfile): Promise<IDisposable> {
	installBaseUiStyles();
	let api: Awaited<ReturnType<typeof createElectronRendererApi>>;
	try { api = await createElectronRendererApi([], { browser: false }); }
	catch (error) { return showStartupError(error); }
	const sessions = new DisposableStore();
	sessions.add(api);
	const container = document.querySelector<HTMLElement>("#app");
	if (!container) throw new Error("Sessions renderer requires an #app container");
	const windowApi = createReturnToParentWindowApi();
	const workbench = sessions.add(new Workbench({
		modeId,
		profile,
		api,
		returnToWorkbench: () => { void windowApi.returnToParentWindow().catch(onUnexpectedError); },
		configurationApi: api.configuration,
		keybindingsResourceApi: api.keybindings,
		createContextMenuService: options => createElectronWorkbenchContextMenuService(options, api.nativeContextMenu),
		container,
	}));
	sessions.add(addDisposableListener(window, "pagehide", () => {
		void workbench.shutdown("pageHide").catch(error => console.error("Failed to shut down Sessions Workbench", error)).finally(() => sessions.dispose());
	}, { once: true }));
	sessions.add(await registerWindowCloseHandler(() => workbench.shutdown('windowClose')));
	return sessions;
}
