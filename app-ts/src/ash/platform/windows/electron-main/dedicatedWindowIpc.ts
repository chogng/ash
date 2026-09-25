import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import { OPEN_DEDICATED_WINDOW_CHANNEL, RETURN_TO_PARENT_WINDOW_CHANNEL, validateDedicatedWindowCommand } from '../common/dedicatedWindow.js';

/** Registers only the parent renderer's ability to open its dedicated window. */
export function openDedicatedWindowIpcRoute(open: () => void | Promise<void>): IpcRoute<unknown, unknown> {
	return {
		channel: OPEN_DEDICATED_WINDOW_CHANNEL,
		validate: validateDedicatedWindowCommand,
		invoke: open,
	};
}

/** Registers only the dedicated renderer's ability to return to its parent. */
export function returnToParentWindowIpcRoute(returnToParent: () => void | Promise<void>): IpcRoute<unknown, unknown> {
	return {
		channel: RETURN_TO_PARENT_WINDOW_CHANNEL,
		validate: validateDedicatedWindowCommand,
		invoke: returnToParent,
	};
}
