import { withWorkbenchModeId, type WorkbenchModeId } from '../../../common/workbenchMode.js';

/** Replaces the current browser page with the selected Workbench mode. */
export async function switchBrowserWorkbenchMode(ownerWindow: Window, modeId: WorkbenchModeId): Promise<void> {
	ownerWindow.location.replace(withWorkbenchModeId(ownerWindow.location.href, modeId));
}
