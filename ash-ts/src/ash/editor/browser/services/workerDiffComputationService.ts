import { Disposable } from '../../../base/common/lifecycle.js';
import { WebWorkerClient, type WebWorkerClientPort } from '../../../base/common/worker/webWorker.js';
import { BrowserWorkerClientPort } from '../../../platform/webWorker/browser/browserWorkerClientPort.js';
import { type DiffComputationRequest, type IDiffComputationService } from '../../common/diff/diffComputationService.js';
import { diffWorkerChannel, readDiffResult } from '../../common/diff/diffWorker.js';
import { type LineDiff } from '../../common/diff/lineDiff.js';

/** Owns one lazy frontend Worker and independent, cancellable snapshot requests. */
export class WorkerDiffComputationService extends Disposable implements IDiffComputationService {
	private client: WebWorkerClient | undefined;
	private requestId = 0;

	constructor(private readonly createPort: () => WebWorkerClientPort = () => new BrowserWorkerClientPort(
		new Worker(new URL('../../common/diff/diffWorkerMain.ts', import.meta.url), { type: 'module', name: 'ash-editor-diff' }),
	)) {
		super();
	}

	public async compute(request: DiffComputationRequest, signal: AbortSignal): Promise<LineDiff> {
		this.assertNotDisposed();
		signal.throwIfAborted();
		this.client ??= this._register(new WebWorkerClient(this.createPort(), diffWorkerChannel));
		const result = await this.client.request(++this.requestId, { request }, signal);
		this.assertNotDisposed();
		signal.throwIfAborted();
		return readDiffResult(result, request);
	}
}
