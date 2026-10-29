import { throwIfCancelled, type CancellationToken } from '../../../base/common/cancellation.js';
import { Event } from '../../../base/common/event.js';
import { CancellationError } from '../../../base/common/errors.js';
import { Disposable, MutableDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { WebWorkerClient, type WebWorkerClientPort, type IWebWorkerClient } from '../../../base/common/worker/webWorker.js';
import { type DiffComputationRequest } from '../../common/diff/diffComputationService.js';
import { nullDocumentDiff, type IDocumentDiff, type IDocumentDiffProvider, type IDocumentDiffProviderOptions } from '../../common/diff/documentDiffProvider.js';
import { diffWorkerChannel, readDiffResult } from '../../common/diff/diffWorker.js';
import { type ITextModel } from '../../common/model.js';

/** Owns one lazy frontend Worker and independent, cancellable document comparisons. */
export class WorkerDiffComputationService extends Disposable implements IDocumentDiffProvider {
	private readonly client = this._register(new MutableDisposable<IWebWorkerClient<object>>());
	private readonly failureListener = this._register(new MutableDisposable<IDisposable>());
	private requestId = 0;
	public readonly onDidChange = Event.None;

	constructor(private readonly createPort: () => WebWorkerClientPort | IWebWorkerClient<object>) {
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
			const client = this.client.value ?? this.createClient();
			const result = await client.request(++this.requestId, { request }, controller.signal);
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

	private createClient(): IWebWorkerClient<object> {
		const port = this.createPort();
		const client = 'request' in port ? port : new WebWorkerClient(port, diffWorkerChannel);
		this.client.value = client;
		// A failed shared transport must not poison every later comparison in the window.
		this.failureListener.value = client.onDidFail(() => {
			this.failureListener.clear();
			this.client.clear();
		});
		return client;
	}
}

function snapshot(model: ITextModel): DiffComputationRequest['original'] {
	const version = model.getVersionId();
	const reader = model.createSnapshot();
	const chunks: string[] = [];
	for (let chunk = reader.read(); chunk !== null; chunk = reader.read()) {
		chunks.push(chunk);
	}
	return { version, text: chunks.join('').replace(/\r\n|\r/g, '\n') };
}
