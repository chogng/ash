import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { PartsSplash } from '../../../../workbench/contrib/splash/browser/partsSplash.js';
import { ICustomViewService } from '../../../services/customView/browser/customViewService.js';
import { captureSessionsSkeleton, watchSessionsSplashContent } from './sessionsSplashCapture.js';

registerWorkbenchContribution(
	'sessions.contrib.splash',
	WorkbenchPhase.BlockStartup,
	accessor => {
		const customViews = accessor.get(ICustomViewService);
		return accessor.get(IInstantiationService).createInstance(PartsSplash, {
			retireAfterRestore: true,
			// A transient overlay disappears on restart; keep the last restorable page.
			shouldCapture: () => customViews.activeCustomViewOpen.get()?.restorable !== false,
			captureSkeleton: captureSessionsSkeleton,
			watchContent: watchSessionsSplashContent,
		});
	},
);
