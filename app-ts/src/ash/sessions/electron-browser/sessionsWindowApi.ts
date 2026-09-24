import { invoke } from "../../platform/ipc/electron-browser/rendererIpc.js";
import { OPEN_SESSIONS_WINDOW_CHANNEL, RETURN_TO_WORKBENCH_CHANNEL, type ISessionsWindowApi } from "../common/sessionsWindow.js";

/** Creates the Electron-only adapter for the dedicated Sessions window lifecycle. */
export function createSessionsWindowApi(): ISessionsWindowApi {
	return {
		openSessionsWindow: () => invoke<void>(OPEN_SESSIONS_WINDOW_CHANNEL),
		returnToWorkbench: () => invoke<void>(RETURN_TO_WORKBENCH_CHANNEL),
	};
}
