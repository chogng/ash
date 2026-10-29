import { getMonacoEnvironment, type IMonacoEnvironment } from '../../../../base/browser/browser.js';
import { WebWorkerDescriptor } from '../../../../platform/webWorker/browser/webWorkerDescriptor.js';
import { WebWorkerService } from '../../../../platform/webWorker/browser/webWorkerServiceImpl.js';

/** Standalone embedding controls how default Workers are resolved and created. */
export class StandaloneWebWorkerService extends WebWorkerService {
	constructor(private readonly environment: () => IMonacoEnvironment | undefined = getMonacoEnvironment) {
		super();
	}

	protected override _createWorker(descriptor: WebWorkerDescriptor): Promise<Worker> {
		const environment = this.environment();
		const supplied = environment?.getWorker?.('workerMain.js', descriptor.label);
		if (supplied !== undefined) return Promise.resolve(supplied);
		if (environment?.getWorkerUrl) {
			return Promise.resolve(new Worker(this.getWorkerUrl(descriptor), { type: 'module', name: descriptor.label }));
		}
		return super._createWorker(descriptor);
	}

	override getWorkerUrl(descriptor: WebWorkerDescriptor): string {
		const supplied = this.environment()?.getWorkerUrl?.('workerMain.js', descriptor.label);
		if (supplied !== undefined) return new URL(supplied, globalThis.document?.baseURI).href;
		return super.getWorkerUrl(descriptor);
	}
}
