import type { IConfigurationApi } from '../common/configurationIpc.js';
import type { IMainProcessService } from '../../ipc/common/mainProcessService.js';

export function createConfigurationApi(mainProcessService: IMainProcessService): IConfigurationApi {
	const channel = mainProcessService.getChannel('configuration');
	return {
		read: () => channel.call('read'),
		update: request => channel.call('update', request),
		onDidChange: listener => channel.listen('onDidChange')(listener),
	};
}
