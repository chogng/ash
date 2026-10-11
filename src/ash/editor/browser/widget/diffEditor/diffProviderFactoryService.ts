import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { WebWorkerClientPort } from '../../../../base/common/worker/webWorker.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import type { IDocumentDiffProvider } from '../../../common/diff/documentDiffProvider.js';
import { WorkerDiffComputationService } from '../../services/workerDiffComputationService.js';

export interface IDiffProviderFactoryService {
	readonly _serviceBrand: undefined;
	/** Each caller owns the returned provider and its lazy worker. */
	createDiffProvider(): IDocumentDiffProvider & IDisposable;
}

export const IDiffProviderFactoryService = createServiceIdentifier<IDiffProviderFactoryService>('diffProviderFactoryService');

/** Creates independently cancellable editor providers over the host's Worker transport. */
export class WorkerBasedDiffProviderFactoryService implements IDiffProviderFactoryService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly createPort?: () => WebWorkerClientPort) { }

	public createDiffProvider(): IDocumentDiffProvider & IDisposable {
		return new WorkerDiffComputationService(this.createPort);
	}
}

registerSingleton(IDiffProviderFactoryService, WorkerBasedDiffProviderFactoryService, InstantiationType.Delayed);
