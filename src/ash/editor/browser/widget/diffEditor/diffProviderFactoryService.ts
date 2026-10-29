import { CancellationTokenSource, type CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { IWebWorkerClient } from '../../../../base/common/worker/webWorker.js';
import { IWebWorkerService } from '../../../../platform/webWorker/browser/webWorkerService.js';
import { WebWorkerDescriptor } from '../../../../platform/webWorker/browser/webWorkerDescriptor.js';
import { diffWorkerChannel } from '../../../common/diff/diffWorker.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import type { IDocumentDiff, IDocumentDiffProvider, IDocumentDiffProviderOptions } from '../../../common/diff/documentDiffProvider.js';
import type { ITextModel } from '../../../common/model.js';
import { WorkerDiffComputationService } from '../../services/workerDiffComputationService.js';

export interface IDiffProviderFactoryService {
	readonly _serviceBrand: undefined;
	/** Each caller owns its cancellation lifetime; the first provider starts the shared worker. */
	createDiffProvider(): IDocumentDiffProvider & IDisposable;
}

export const IDiffProviderFactoryService = createServiceIdentifier<IDiffProviderFactoryService>('diffProviderFactoryService');

/** Creates independently cancellable editor providers over the host's Worker transport. */
export class WorkerBasedDiffProviderFactoryService extends Disposable implements IDiffProviderFactoryService {
	declare readonly _serviceBrand: undefined;
	private readonly computation = this._register(new MutableDisposable<WorkerDiffComputationService>());
	private readonly preparedClient = this._register(new MutableDisposable<IWebWorkerClient<object>>());

	constructor(@IWebWorkerService private readonly workers: IWebWorkerService) {
		super();
	}

	private createClient(): IWebWorkerClient<object> {
		return this.workers.createWorkerClient(
			new WebWorkerDescriptor({
				label: 'ash-editor-diff',
				channel: diffWorkerChannel,
				createWorker: () =>
					new Worker(new URL('../../../common/diff/diffWorkerMain.ts', import.meta.url), {
						type: 'module',
						name: 'ash-editor-diff',
					}),
			}),
		);
	}

	private takeClient(): IWebWorkerClient<object> {
		const prepared = this.preparedClient.clearAndLeak();
		if (prepared) {
			try {
				prepared.ensureAvailable();
				return prepared;
			} catch {
				prepared.dispose();
			}
		}
		return this.createClient();
	}

	public createDiffProvider(): IDocumentDiffProvider & IDisposable {
		this.assertNotDisposed();
		if (!this.computation.value) {
			// Start loading when a comparison is requested, while its models resolve.
			// Until the first non-empty computation takes it, this factory owns the client.
			this.preparedClient.value = this.createClient();
			this.computation.value = new WorkerDiffComputationService(() => this.takeClient());
		}
		return new WorkerBasedDocumentDiffProvider(this.computation.value);
	}
}

class WorkerBasedDocumentDiffProvider extends Disposable implements IDocumentDiffProvider {
	readonly onDidChange;
	private readonly pending = new Set<CancellationTokenSource>();

	constructor(private readonly computation: WorkerDiffComputationService) {
		super();
		this.onDidChange = computation.onDidChange;
		this._register(
			toDisposable(() => {
				for (const source of this.pending) source.cancel();
				this.pending.clear();
			}),
		);
	}

	async computeDiff(original: ITextModel, modified: ITextModel, options: IDocumentDiffProviderOptions, cancellationToken: CancellationToken): Promise<IDocumentDiff> {
		this.assertNotDisposed();
		const source = new CancellationTokenSource(cancellationToken);
		this.pending.add(source);
		try {
			return await this.computation.computeDiff(original, modified, options, source.token);
		} finally {
			this.pending.delete(source);
			source.dispose();
		}
	}
}

registerSingleton(IDiffProviderFactoryService, WorkerBasedDiffProviderFactoryService, InstantiationType.Delayed);
