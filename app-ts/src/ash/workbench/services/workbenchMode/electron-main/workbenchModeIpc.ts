import type { WorkbenchModeId } from '../../../common/workbenchMode.js';
import type { IpcRoute } from '../../../../platform/ipc/electron-main/trustedIpcRouter.js';
import { validateWorkbenchModeId, WORKBENCH_MODE_SWITCH_CHANNEL } from '../common/workbenchModeService.js';

/** Exposes the validated Workbench mode switch request to one trusted renderer. */
export function workbenchModeIpcRoutes(switchMode: (modeId: WorkbenchModeId) => void): readonly IpcRoute<unknown, unknown>[] {
	return [{
		channel: WORKBENCH_MODE_SWITCH_CHANNEL,
		validate: validateWorkbenchModeId,
		invoke: modeId => switchMode(modeId as WorkbenchModeId),
	}];
}
