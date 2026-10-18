import { WebWorkerClient, type IWebWorkerClient, type WebWorkerChannel, type WebWorkerClientPort } from '../../../../base/common/worker/webWorker.js';
import { WebWorkerDescriptor } from '../../browser/webWorkerDescriptor.js';
import type { IWebWorkerService } from '../../browser/webWorkerService.js';

export class TestWebWorkerService implements IWebWorkerService {
	declare readonly _serviceBrand: undefined;
	constructor(private readonly createPort: () => WebWorkerClientPort) { }
	createWorkerClient<T extends object>(descriptor: WebWorkerDescriptor | Worker | Promise<Worker>, channel?: WebWorkerChannel): IWebWorkerClient<T> {
		return new WebWorkerClient<T>(this.createPort(), channel ?? (descriptor instanceof WebWorkerDescriptor ? descriptor.channel : undefined));
	}
	getWorkerUrl(): string { throw new Error('No URL resolution expected in a memory Worker test'); }
}
