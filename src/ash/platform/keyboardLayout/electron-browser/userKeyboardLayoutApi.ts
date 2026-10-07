import { toDisposable } from '../../../base/common/lifecycle.js';
import { invoke, subscribe } from '../../ipc/electron-browser/rendererIpc.js';
import {
	type IUserKeyboardLayoutApi,
	USER_KEYBOARD_LAYOUT_CHANGED_CHANNEL,
	USER_KEYBOARD_LAYOUT_OPEN_RESOURCE_CHANNEL,
	USER_KEYBOARD_LAYOUT_READ_CHANNEL,
	validateUserKeyboardLayout,
} from '../common/userKeyboardLayout.js';

export function createUserKeyboardLayoutApi(): IUserKeyboardLayoutApi {
	return {
		available: true,
		async readKeyboardLayout() {
			return validateUserKeyboardLayout(await invoke<unknown>(USER_KEYBOARD_LAYOUT_READ_CHANNEL));
		},
		async openResource() {
			const value = await invoke<unknown>(USER_KEYBOARD_LAYOUT_OPEN_RESOURCE_CHANNEL);
			if (value !== undefined) {
				throw new TypeError('user keyboard layout open must not return a value');
			}
		},
		onDidChangeKeyboardLayout(listener) {
			const subscription = subscribe<unknown>(USER_KEYBOARD_LAYOUT_CHANGED_CHANNEL, (value) => {
				validateUserKeyboardLayout(value);
				listener();
			});
			return toDisposable(() => subscription.dispose());
		},
	};
}
