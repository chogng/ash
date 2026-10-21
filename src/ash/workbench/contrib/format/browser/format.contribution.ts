import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { DefaultFormatter } from './formatActionsMultiple.js';

registerWorkbenchContribution('workbench.contrib.defaultFormatter', WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(DefaultFormatter));
