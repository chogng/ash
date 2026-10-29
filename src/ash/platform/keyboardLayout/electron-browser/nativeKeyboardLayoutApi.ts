import type { IMainProcessService } from '../../ipc/common/mainProcessService.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import {
	type INativeKeyboardLayoutApi,
	validateNativeKeyboardLayout,
} from '../common/nativeKeyboardLayout.js';

export function createNativeKeyboardLayoutApi(mainProcessService: IMainProcessService): INativeKeyboardLayoutApi {
	const channel = mainProcessService.getChannel('keyboardLayout');
	return {
		async readKeyboardLayout() {
			return validateNativeKeyboardLayout(await channel.call('readKeyboardLayout'));
		},
		onDidChangeKeyboardLayout(listener) {
			const subscription = channel.listen<unknown>('onDidChangeKeyboardLayout')((value) => {
				validateNativeKeyboardLayout(value);
				listener();
			});
			return toDisposable(() => subscription.dispose());
		},
	};
}
