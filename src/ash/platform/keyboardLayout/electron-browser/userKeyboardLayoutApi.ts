import { toDisposable } from '../../../base/common/lifecycle.js';
import type { IMainProcessService } from '../../ipc/common/mainProcessService.js';
import {
	type IUserKeyboardLayoutApi,
	validateUserKeyboardLayout,
} from '../common/userKeyboardLayout.js';

export function createUserKeyboardLayoutApi(mainProcessService: IMainProcessService): IUserKeyboardLayoutApi {
	const channel = mainProcessService.getChannel('userKeyboardLayout');
	return {
		available: true,
		async readKeyboardLayout() {
			return validateUserKeyboardLayout(await channel.call('readKeyboardLayout'));
		},
		async openResource() {
			const value = await channel.call('openResource');
			if (value !== undefined) {
				throw new TypeError('user keyboard layout open must not return a value');
			}
		},
		onDidChangeKeyboardLayout(listener) {
			const subscription = channel.listen<unknown>('onDidChangeKeyboardLayout')((value) => {
				validateUserKeyboardLayout(value);
				listener();
			});
			return toDisposable(() => subscription.dispose());
		},
	};
}
