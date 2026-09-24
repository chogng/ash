import { installBaseUiStyles } from "../../base/browser/ui/styles.js";
import { addDisposableListener } from "../../base/browser/dom.js";
import { DisposableStore, type IDisposable } from "../../base/common/lifecycle.js";
import type { WorkbenchModeId } from "../../workbench/common/workbenchMode.js";
import { createElectronRendererApi } from "../../platform/native/electron-browser/rendererApi.js";
import { createElectronWorkbenchContextMenuService } from "../../workbench/services/contextmenu/electron-browser/contextMenuService.js";
import type { SessionsProfile } from "../common/sessionsProfile.js";
import { startSessionsWorkbench } from "../browser/sessionsWorkbench.js";
import { createSessionsWindowApi } from "./sessionsWindowApi.js";
import { showStartupError } from "../../workbench/browser/startupError.js";

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
	sessions.add(startSessionsWorkbench({
		modeId,
		profile,
		api,
		sessionsWindowApi: createSessionsWindowApi(),
		configurationApi: api.configuration,
		keybindingsResourceApi: api.keybindings,
		createContextMenuService: options => createElectronWorkbenchContextMenuService(options, api.nativeContextMenu),
		container,
	}));
	sessions.add(addDisposableListener(window, "pagehide", () => sessions.dispose(), { once: true }));
	return sessions;
}
