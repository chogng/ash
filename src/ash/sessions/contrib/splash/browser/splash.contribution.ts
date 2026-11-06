import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { PartsSplash } from '../../../../workbench/contrib/splash/browser/partsSplash.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';

registerWorkbenchContribution(
	'sessions.contrib.splash',
	WorkbenchPhase.BlockStartup,
	accessor => {
		const customViews = accessor.get(ICustomViewService);
		return accessor.get(IInstantiationService).createInstance(PartsSplash, {
			// A transient overlay disappears on restart. Keep the last restorable layout.
			shouldCapture: () => customViews.activeCustomViewOpen.get()?.restorable !== false,
		});
	},
);
