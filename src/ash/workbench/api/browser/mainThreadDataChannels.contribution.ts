import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../common/contributions.js';
import { MainThreadDataChannels } from './mainThreadDataChannels.js';

registerWorkbenchContribution('workbench.contrib.dataChannels', WorkbenchPhase.BlockStartup, accessor => {
	const channels = accessor.get(IInstantiationService).createInstance(MainThreadDataChannels, 30_000);
	const logService = accessor.get(ILogService);
	void channels.start().catch(error => logService.error('dataChannel', 'Could not start extension channel integration', error));
	return channels;
});
