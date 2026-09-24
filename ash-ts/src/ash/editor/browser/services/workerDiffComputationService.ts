import { throwIfCancelled, type CancellationToken } from '../../../base/common/cancellation.js';
import { Event } from '../../../base/common/event.js';
import { CancellationError } from '../../../base/common/errors.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { WebWorkerClient, type WebWorkerClientPort } from '../../../base/common/worker/webWorker.js';
import { BrowserWorkerClientPort } from '../../../platform/webWorker/browser/browserWorkerClientPort.js';
import { type DiffComputationRequest } from '../../common/diff/diffComputationService.js';
import { nullDocumentDiff, type IDocumentDiff, type IDocumentDiffProvider, type IDocumentDiffProviderOptions } from '../../common/diff/documentDiffProvider.js';
import { diffWorkerChannel, readDiffResult } from '../../common/diff/diffWorker.js';
import { type ITextModel } from '../../common/model.js';

/** Owns one lazy frontend Worker and independent, cancellable document comparisons. */
export class WorkerDiffComputationService extends Disposable implements IDocumentDiffProvider {
	private client: WebWorkerClient | undefined;
	private requestId = 0;
	public readonly onDidChange = Event.None;

	constructor(private readonly createPort: () => WebWorkerClientPort = () => new BrowserWorkerClientPort(
		new Worker(new URL('../../common/diff/diffWorkerMain.ts', import.meta.url), { type: 'module', name: 'ash-editor-diff' }),
	)) {
		super();
	}

	public async computeDiff(original: ITextModel, modified: ITextModel, options: IDocumentDiffProviderOptions, cancellationToken: CancellationToken): Promise<IDocumentDiff> {
		this.assertNotDisposed();
		throwIfCancelled(cancellationToken);
		const controller = new AbortController();
		const cancellation = cancellationToken.onCancellationRequested(() => controller.abort(new CancellationError()));
		try {
			throwIfCancelled(cancellationToken);
			const request: DiffComputationRequest = {
				original: snapshot(original),
				modified: snapshot(modified),
				options,
			};
			if (request.original.text === request.modified.text) {
				throwIfCancelled(cancellationToken);
				return nullDocumentDiff;
			}
			this.client ??= this._register(new WebWorkerClient(this.createPort(), diffWorkerChannel));
			const result = await this.client.request(++this.requestId, { request }, controller.signal);
			this.assertNotDisposed();
			throwIfCancelled(cancellationToken);
			const diff = readDiffResult(result, request);
			return {
				identical: false,
				quitEarly: diff.hitTimeout,
				changes: diff.changes,
				moves: diff.moves,
			};
		} finally {
			cancellation.dispose();
		}
	}
}

function snapshot(model: ITextModel): DiffComputationRequest['original'] {
	const version = model.getVersionId();
	const reader = model.createSnapshot();
	const chunks: string[] = [];
	for (let chunk = reader.read(); chunk !== null; chunk = reader.read()) {
		chunks.push(chunk);
	}
	return { version, text: chunks.join('') };
}
