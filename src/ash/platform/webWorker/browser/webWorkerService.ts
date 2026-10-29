import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { IWebWorkerClient, WebWorkerChannel } from '../../../base/common/worker/webWorker.js';
import type { WebWorkerDescriptor } from './webWorkerDescriptor.js';

export const IWebWorkerService = createDecorator<IWebWorkerService>('IWebWorkerService');

/** The caller owns each returned client; a window service owns no domain state. */
export interface IWebWorkerService {
	readonly _serviceBrand: undefined;
	createWorkerClient<T extends object>(
		workerDescriptor: WebWorkerDescriptor | Worker | Promise<Worker>,
		channel?: WebWorkerChannel,
	): IWebWorkerClient<T>;
	getWorkerUrl(descriptor: WebWorkerDescriptor): string;
}
