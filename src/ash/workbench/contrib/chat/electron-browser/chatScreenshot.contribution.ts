import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';

registerWorkbenchContribution('workbench.contrib.chatScreenshot', WorkbenchPhase.Eventually, accessor => {
	const instantiation = accessor.get(IInstantiationService);
	const log = accessor.get(ILogService);
	const lifetime = new DisposableStore();
	void import('./chatScreenshot.js').then(({ ChatScreenshotContribution }) => {
		if (!lifetime.isDisposed) lifetime.add(instantiation.createInstance(ChatScreenshotContribution));
	}).catch(error => {
		if (!lifetime.isDisposed) log.error('screenshot', 'Could not start the global screenshot shortcut', error);
	});
	return lifetime;
});
