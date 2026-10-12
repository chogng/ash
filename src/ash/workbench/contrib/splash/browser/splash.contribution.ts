import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { PartsSplash } from './partsSplash.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import type { IPartsSplash } from '../../../../platform/theme/common/themeService.js';
import { ISplashStorageService, browserSplashStorageKey } from './splash.js';

class SplashStorageService implements ISplashStorageService {
	constructor(@ILayoutService private readonly layoutService: ILayoutService) { }

	async saveWindowSplash(splash: IPartsSplash): Promise<void> {
		const ownerWindow = this.layoutService.mainContainer.ownerDocument.defaultView!;
		ownerWindow.localStorage.setItem(browserSplashStorageKey(ownerWindow), JSON.stringify(splash));
	}
}

registerSingleton(ISplashStorageService, SplashStorageService, InstantiationType.Delayed);

registerWorkbenchContribution(PartsSplash.ID, WorkbenchPhase.BlockStartup, accessor => accessor.get(IInstantiationService).createInstance(PartsSplash));
