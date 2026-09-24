import { invoke } from '../../../../platform/ipc/electron-browser/rendererIpc.js';
import type { WorkbenchModeId } from '../../../common/workbenchMode.js';
import { WORKBENCH_MODE_SWITCH_CHANNEL } from '../common/workbenchModeService.js';

/** Requests a trusted same-window Workbench mode reload from Electron Main. */
export function switchElectronWorkbenchMode(modeId: WorkbenchModeId): Promise<void> {
	return invoke<void>(WORKBENCH_MODE_SWITCH_CHANNEL, modeId);
}
