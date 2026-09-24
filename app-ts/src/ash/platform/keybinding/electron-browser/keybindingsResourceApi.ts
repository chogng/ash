import { KEYBINDINGS_RESOURCE_CHANGED_CHANNEL, KEYBINDINGS_RESOURCE_READ_CHANNEL, KEYBINDINGS_RESOURCE_UPDATE_CHANNEL, type IKeybindingsResourceApi } from "../common/keybindingsResource.js";
import { invoke, subscribe } from "../../ipc/electron-browser/rendererIpc.js";

export function createKeybindingsResourceApi(): IKeybindingsResourceApi {
	return {
		read: () => invoke(KEYBINDINGS_RESOURCE_READ_CHANNEL),
		update: (request) => invoke(KEYBINDINGS_RESOURCE_UPDATE_CHANNEL, request),
		onDidChange: (listener) => subscribe(KEYBINDINGS_RESOURCE_CHANGED_CHANNEL, listener),
	};
}
