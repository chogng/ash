import { CancellationTokenSource, type CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
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
	/** Each caller owns its cancellation lifetime. Background providers can defer Worker loading until computation. */
	createDiffProvider(options?: { readonly prewarm?: boolean; }): IDocumentDiffProvider & IDisposable;
}

export const IDiffProviderFactoryService = createServiceIdentifier<IDiffProviderFactoryService>('diffProviderFactoryService');

/** Creates independently cancellable editor providers over the host's Worker transport. */
export class WorkerBasedDiffProviderFactoryService extends Disposable implements IDiffProviderFactoryService {
	declare readonly _serviceBrand: undefined;
	private readonly computation = this._register(new WorkerDiffComputationService(() => this.createClient()));

	constructor(@IWebWorkerService private readonly workers: IWebWorkerService) {
		super();
	}

	private createClient(): IWebWorkerClient<object> {
		return this.workers.createWorkerClient(new WebWorkerDescriptor({
			label: 'ash-editor-diff', channel: diffWorkerChannel,
			createWorker: () => new Worker(new URL('../../../common/diff/diffWorkerMain.ts', import.meta.url), { type: 'module', name: 'ash-editor-diff' }),
		}));
	}

	public createDiffProvider(options?: { readonly prewarm?: boolean; }): IDocumentDiffProvider & IDisposable {
		this.assertNotDisposed();
		if (options?.prewarm !== false) this.computation.prewarm();
		return new WorkerBasedDocumentDiffProvider(this.computation);
	}
}

class WorkerBasedDocumentDiffProvider extends Disposable implements IDocumentDiffProvider {
	readonly onDidChange;
	private readonly pending = new Set<CancellationTokenSource>();

	constructor(private readonly computation: WorkerDiffComputationService) {
		super();
		this.onDidChange = computation.onDidChange;
		this._register(toDisposable(() => {
			for (const source of this.pending) source.cancel();
			this.pending.clear();
		}));
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
