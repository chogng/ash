import { invoke, subscribe } from '../../ipc/electron-browser/rendererIpc.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import {
	NATIVE_KEYBOARD_LAYOUT_CHANGED_CHANNEL,
	NATIVE_KEYBOARD_LAYOUT_READ_CHANNEL,
	type INativeKeyboardLayoutApi,
	validateNativeKeyboardLayout,
} from '../common/nativeKeyboardLayout.js';

export function createNativeKeyboardLayoutApi(): INativeKeyboardLayoutApi {
	return {
		async readKeyboardLayout() {
			return validateNativeKeyboardLayout(await invoke<unknown>(NATIVE_KEYBOARD_LAYOUT_READ_CHANNEL));
		},
		onDidChangeKeyboardLayout(listener) {
			const subscription = subscribe<unknown>(NATIVE_KEYBOARD_LAYOUT_CHANGED_CHANNEL, (value) => {
				validateNativeKeyboardLayout(value);
				listener();
			});
			return toDisposable(() => subscription.dispose());
		},
	};
}
