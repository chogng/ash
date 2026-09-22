import { type WebWorkerClientPort } from '../../../../base/common/worker/webWorker.js';
import { WorkerDiffComputationService } from '../../../../editor/browser/services/workerDiffComputationService.js';
import { type IDiffService } from '../common/diffService.js';

/** Creates frontend computations for editor comparisons and dirty-buffer Quick Diff. */
export class DiffService implements IDiffService {
	constructor(private readonly createPort?: () => WebWorkerClientPort) {}

	public createComputationService(): WorkerDiffComputationService {
		return new WorkerDiffComputationService(this.createPort);
	}
}
