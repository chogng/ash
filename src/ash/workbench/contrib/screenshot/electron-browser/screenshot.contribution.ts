import { ScreenshotShortcutContribution } from '../browser/screenshot.contribution.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IScreenshotService } from '../common/screenshot.js';
import { DesktopScreenshotService } from './desktopScreenshotService.js';

import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';

registerSingleton(IScreenshotService, DesktopScreenshotService, InstantiationType.Delayed);

registerWorkbenchContribution('workbench.contrib.screenshotShortcut', WorkbenchPhase.AfterRestored, (accessor) =>
	accessor.get(IInstantiationService).createInstance(ScreenshotShortcutContribution)
);
