import { Disposable, Emitter, DisposableMap, DisposableStore, RunOnceScheduler, CancellationTokenSource, CancellationError, toDisposable, URI, extUriBiasedIgnorePathCase, type CancellationToken, type IDecorationData, type IDecorationsProvider } from '../../../sdk/browser/index.js';
import type { IGitService } from './types.js';
import { localize } from './support.js';
interface IgnoreQuery { readonly resource: URI; readonly token: CancellationToken; resolve(data: IDecorationData | undefined): void; reject(error: unknown): void; }
export class GitIgnoreDecorationProvider extends Disposable implements IDecorationsProvider {
	public readonly label = 'Git Ignore';
	private readonly changed = this._register(new Emitter<readonly URI[]>());
	public readonly onDidChange = this.changed.event;
	private readonly pending = new Map<symbol, IgnoreQuery>();
	private readonly requests = this._register(new DisposableMap<symbol, DisposableStore>());
	private readonly scheduler = this._register(new RunOnceScheduler(() => { void this.flush(); }, 0));

	constructor(
		private readonly gitService: IGitService,
	) {
		super();
		this._register(gitService.onDidChangeRepositories(() => this.changed.fire([])));
		this._register(gitService.onDidChangeIgnore(resources => this.changed.fire(resources)));
	}

	public provideDecorations(resource: URI, token: CancellationToken): Promise<IDecorationData | undefined> | undefined {
		if (token.isCancellationRequested) {
			return Promise.reject(new CancellationError());
		}
		const repository = this.gitService.repositoryForResource(resource);
		if (!repository || extUriBiasedIgnorePathCase.isEqual(resource, repository.root)) {
			return undefined;
		}
		const id = Symbol();
		const lifetime = this.requests.set(id, new DisposableStore());
		const result = new Promise<IDecorationData | undefined>((resolve, reject) => {
			this.pending.set(id, { resource, token, resolve, reject });
			lifetime.add(toDisposable(() => {
				this.pending.delete(id);
				reject(new CancellationError());
			}));
			lifetime.add(token.onCancellationRequested(() => this.requests.deleteAndDispose(id)));
			this.scheduler.schedule();
		});
		return result.finally(() => this.requests.deleteAndDispose(id));
	}

	private async flush(): Promise<void> {
		const queries = [...this.pending.values()];
		this.pending.clear();
		if (!queries.length) {
			return;
		}
		using lifetime = new DisposableStore();
		const cancellation = lifetime.add(new CancellationTokenSource());
		// Resource queries share this request; cancel it only after all of them have been cancelled.
		for (const query of queries) {
			lifetime.add(query.token.onCancellationRequested(() => {
				if (queries.every(candidate => candidate.token.isCancellationRequested)) {
					cancellation.cancel();
				}
			}));
		}
		try {
			const ignored = await this.gitService.checkIgnore(queries.map(query => query.resource), cancellation.token);
			const keys = new Set(ignored.map(resource => extUriBiasedIgnorePathCase.getComparisonKey(resource)));
			for (const query of queries) {
				query.resolve(keys.has(extUriBiasedIgnorePathCase.getComparisonKey(query.resource))
					? { color: 'gitDecoration.ignoredResourceForeground', tooltip: localize('git.ignored', 'Ignored by Git') }
					: undefined);
			}
		} catch (error) {
			for (const query of queries) {
				query.reject(error);
			}
		}
	}
}
