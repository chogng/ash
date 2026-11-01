import './nativeSplashStorageService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { PartsSplash } from '../browser/partsSplash.js';

registerWorkbenchContribution(
	PartsSplash.ID,
	WorkbenchPhase.BlockStartup,
	accessor => accessor.get(IInstantiationService).createInstance(PartsSplash),
);
