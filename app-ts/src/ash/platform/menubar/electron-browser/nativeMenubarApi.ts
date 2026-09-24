import { NATIVE_MENUBAR_SELECT_CHANNEL, NATIVE_MENUBAR_UPDATE_CHANNEL, type INativeMenubarApi, type INativeMenubarSelection } from "../common/nativeMenubar.js";
import { invoke, subscribe } from "../../ipc/electron-browser/rendererIpc.js";

export function createNativeMenubarApi(): INativeMenubarApi {
	return {
		update: (data) => invoke<void>(NATIVE_MENUBAR_UPDATE_CHANNEL, data),
		onDidSelect: (listener) => subscribe<INativeMenubarSelection>(NATIVE_MENUBAR_SELECT_CHANNEL, listener),
	};
}
