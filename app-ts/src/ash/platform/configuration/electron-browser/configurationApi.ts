import { CONFIGURATION_CHANGED_CHANNEL, CONFIGURATION_READ_CHANNEL, CONFIGURATION_UPDATE_CHANNEL, type IConfigurationApi } from "../common/configurationIpc.js";
import { invoke, subscribe } from "../../ipc/electron-browser/rendererIpc.js";

export function createConfigurationApi(): IConfigurationApi {
	return {
		read: () => invoke(CONFIGURATION_READ_CHANNEL),
		update: (request) => invoke(CONFIGURATION_UPDATE_CHANNEL, request),
		onDidChange: (listener) => subscribe(CONFIGURATION_CHANGED_CHANNEL, listener),
	};
}
