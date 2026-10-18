import { WebWorkerClient, type IWebWorkerClient, type WebWorkerChannel } from '../../../base/common/worker/webWorker.js';
import { BrowserWorkerClientPort } from './browserWorkerClientPort.js';
import { WebWorkerDescriptor } from './webWorkerDescriptor.js';
import type { IWebWorkerService } from './webWorkerService.js';

export class WebWorkerService implements IWebWorkerService {
	declare readonly _serviceBrand: undefined;

	createWorkerClient<T extends object>(descriptor: WebWorkerDescriptor | Worker | Promise<Worker>, channel?: WebWorkerChannel): IWebWorkerClient<T> {
		const worker = descriptor instanceof WebWorkerDescriptor ? this._createWorker(descriptor) : descriptor;
		return new WebWorkerClient<T>(new BrowserWorkerClientPort(worker), channel ?? (descriptor instanceof WebWorkerDescriptor ? descriptor.channel : undefined));
	}

	protected _createWorker(descriptor: WebWorkerDescriptor): Promise<Worker> {
		return Promise.resolve(descriptor.createWorker ? descriptor.createWorker()
			: new Worker(this.getWorkerUrl(descriptor), { type: 'module', name: descriptor.label }));
	}

	getWorkerUrl(descriptor: WebWorkerDescriptor): string {
		const location = descriptor.esmModuleLocation ?? descriptor.esmModuleLocationBundler;
		if (!location) throw new Error(`Missing Worker module location for '${descriptor.label}'`);
		return (typeof location === 'function' ? location() : location).toString(true);
	}
}
