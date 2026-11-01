import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { PartsSplash } from '../../../../workbench/contrib/splash/browser/partsSplash.js';

registerWorkbenchContribution(
	'sessions.contrib.splash',
	WorkbenchPhase.BlockStartup,
	accessor => accessor.get(IInstantiationService).createInstance(PartsSplash),
);
