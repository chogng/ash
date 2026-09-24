import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchModeRegistry, type WorkbenchModeId } from '../../../common/workbenchMode.js';

export const WORKBENCH_MODE_SWITCH_CHANNEL = 'ash:workbench-mode:switch';

export interface WorkbenchModeOption {
	readonly id: WorkbenchModeId;
	readonly label: string;
}

/** Window-scoped Workbench mode selection with a reload boundary. */
export interface IWorkbenchModeService {
	readonly currentModeId: WorkbenchModeId;
	readonly availableModes: readonly WorkbenchModeOption[];
	switchMode(modeId: WorkbenchModeId): Promise<void>;
	resetMode(): Promise<void>;
}

export const IWorkbenchModeService = createServiceIdentifier<IWorkbenchModeService>('workbenchModeService');

export function validateWorkbenchModeId(value: unknown): WorkbenchModeId {
	if (!WorkbenchModeRegistry.isModeId(value)) throw new Error('Workbench mode id is not registered');
	return value;
}
