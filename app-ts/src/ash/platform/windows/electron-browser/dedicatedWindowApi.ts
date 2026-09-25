import { invoke } from '../../ipc/electron-browser/rendererIpc.js';
import { OPEN_DEDICATED_WINDOW_CHANNEL, RETURN_TO_PARENT_WINDOW_CHANNEL, type IOpenDedicatedWindowApi, type IReturnToParentWindowApi } from '../common/dedicatedWindow.js';

export function createOpenDedicatedWindowApi(): IOpenDedicatedWindowApi {
	return {
		openDedicatedWindow: () => invoke<void>(OPEN_DEDICATED_WINDOW_CHANNEL),
	};
}

export function createReturnToParentWindowApi(): IReturnToParentWindowApi {
	return {
		returnToParentWindow: () => invoke<void>(RETURN_TO_PARENT_WINDOW_CHANNEL),
	};
}
