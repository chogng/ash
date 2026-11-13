import { AppWindowScreenshotContribution } from './actions/chatAppWindowScreenshotActions.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { AppWindowScreenshotService, IAppWindowScreenshotService } from '../../screenshotTool/electron-browser/appWindowScreenshot.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';

registerSingleton(IAppWindowScreenshotService, AppWindowScreenshotService, InstantiationType.Delayed);

registerWorkbenchContribution('workbench.contrib.chatScreenshot', WorkbenchPhase.BlockRestore, accessor => {
	const instantiation = accessor.get(IInstantiationService);
	const log = accessor.get(ILogService);
	const lifetime = new DisposableStore();
	// Install gesture listeners before restored inputs can receive their first paste or drop.
	lifetime.add(instantiation.createInstance(AppWindowScreenshotContribution));
	void import('./chatScreenshot.js').then(({ ChatScreenshotContribution }) => {
		if (!lifetime.isDisposed) lifetime.add(instantiation.createInstance(ChatScreenshotContribution));
	}).catch(error => {
		if (!lifetime.isDisposed) log.error('screenshot', 'Could not start the global screenshot shortcut', error);
	});
	return lifetime;
});
