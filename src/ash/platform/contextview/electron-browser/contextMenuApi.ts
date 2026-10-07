import { NATIVE_CONTEXT_MENU_CLOSE_CHANNEL, NATIVE_CONTEXT_MENU_POPUP_CHANNEL, type INativeContextMenuApi, type INativeContextMenuResult } from "../../../base/parts/contextmenu/common/contextmenu.js";
import { invoke } from "../../ipc/electron-browser/rendererIpc.js";

export function createNativeContextMenuApi(): INativeContextMenuApi {
	return {
		popup: (request) => invoke<INativeContextMenuResult>(NATIVE_CONTEXT_MENU_POPUP_CHANNEL, request),
		close: () => invoke<void>(NATIVE_CONTEXT_MENU_CLOSE_CHANNEL),
	};
}
