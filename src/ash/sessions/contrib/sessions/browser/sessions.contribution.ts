import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { AutomationsCustomViewContribution } from './views/automationsView.js';
import './views/sessionsViewActions.js';

registerWorkbenchContribution(AutomationsCustomViewContribution.ID, WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(AutomationsCustomViewContribution));
