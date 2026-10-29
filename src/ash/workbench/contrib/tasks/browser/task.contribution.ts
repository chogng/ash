import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { RunAutomaticTasks, ManageAutomaticTaskRunning } from './runAutomaticTasks.js';
import './taskService.js';
import './abstractTaskService.js';

registerWorkbenchContribution('workbench.contrib.runAutomaticTasks', WorkbenchPhase.AfterRestored, accessor =>
	accessor.get(IInstantiationService).createInstance(RunAutomaticTasks),
);
registerAction2(ManageAutomaticTaskRunning);
