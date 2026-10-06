import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableMap, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { IGitHubService, type GitHubChecks, type GitHubIssueDetails, type GitHubPullRequest } from '../../../../platform/github/common/githubService.js';

export type GitHubReferenceKind = 'pullRequest' | 'issue';

export interface IGitHubReferenceTarget {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
}

export interface IPullRequestHoverDetails {
	readonly pullRequest: GitHubPullRequest;
	readonly checks: GitHubChecks | undefined;
}

export type LazyGitHubResourceState<T> =
	| { readonly status: 'idle' | 'loading' | 'failed'; }
	| { readonly status: 'resolved'; readonly value: T; };

interface ResourceEntry<T> extends IDisposable {
	readonly cancellation: CancellationTokenSource;
	readonly state: ReturnType<typeof observableValue<LazyGitHubResourceState<T>>>;
	pending: Promise<T> | undefined;
	isComplete: boolean;
}

enum ResourceDetail { Core, Checks }

/** Core metadata appears with the link; checks are requested only on hover intent. */
export class LazyGitHubResourceResolver extends Disposable {
	private readonly issues = this._register(new DisposableMap<string, ResourceEntry<GitHubIssueDetails>>());
	private readonly pullRequests = this._register(new DisposableMap<string, ResourceEntry<IPullRequestHoverDetails>>());

	constructor(@IGitHubService private readonly github: IGitHubService) {
		super();
	}

	public getIssueState(target: IGitHubReferenceTarget): IObservable<LazyGitHubResourceState<GitHubIssueDetails>> {
		return this.entry(this.issues, target).state;
	}

	public getPullRequestState(target: IGitHubReferenceTarget): IObservable<LazyGitHubResourceState<IPullRequestHoverDetails>> {
		return this.entry(this.pullRequests, target).state;
	}

	public resolveIssue(target: IGitHubReferenceTarget): Promise<GitHubIssueDetails> {
		const entry = this.entry(this.issues, target);
		return this.load(entry, () => this.github.readIssue(repository(target), target.number, entry.cancellation.token));
	}

	public prefetchPullRequest(target: IGitHubReferenceTarget): Promise<IPullRequestHoverDetails> {
		const entry = this.entry(this.pullRequests, target);
		return this.load(entry, async () => ({
			pullRequest: await this.github.readPullRequest(repository(target), target.number, entry.cancellation.token),
			checks: undefined,
		}));
	}

	public async resolvePullRequest(target: IGitHubReferenceTarget): Promise<IPullRequestHoverDetails> {
		const entry = this.entry(this.pullRequests, target);
		const token = entry.cancellation.token;
		await this.prefetchPullRequest(target);
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}
		return this.load(entry, async () => {
			const state = entry.state.get();
			if (state.status !== 'resolved') {
				throw new Error('Pull request core metadata is not loaded');
			}
			const pullRequest = state.value.pullRequest;
			const statuses: GitHubChecks['statuses'][number][] = [];
			const checks: GitHubChecks['checks'][number][] = [];
			let page: number | null = 1;
			let result!: GitHubChecks;
			while (page !== null) {
				result = await this.github.readChecks(repository(target), pullRequest.headCommit, page, entry.cancellation.token);
				statuses.push(...result.statuses);
				checks.push(...result.checks);
				page = result.nextPage;
			}
			return { pullRequest, checks: { ...result, statuses, checks } };
		}, ResourceDetail.Checks);
	}

	public retain(references: readonly { readonly resource: URI; }[]): void {
		for (const [cache, kind] of [[this.issues, 'issue'], [this.pullRequests, 'pullRequest']] as const) {
			const retained = new Set(references.map(reference => parseGitHubReferenceTarget(reference.resource, kind)).filter(target => target !== undefined).map(referenceKey));
			for (const key of cache.keys()) {
				if (!retained.has(key)) {
					cache.deleteAndDispose(key);
				}
			}
		}
	}

	private entry<T>(cache: DisposableMap<string, ResourceEntry<T>>, target: IGitHubReferenceTarget): ResourceEntry<T> {
		this.assertNotDisposed();
		const key = referenceKey(target);
		let entry = cache.get(key);
		if (!entry) {
			const cancellation = new CancellationTokenSource();
			entry = Object.assign(toDisposable(() => cancellation.dispose(true)), {
				cancellation,
				state: observableValue<LazyGitHubResourceState<T>>(this, { status: 'idle' }),
				pending: undefined,
				isComplete: false,
			});
			cache.set(key, entry);
		}
		return entry;
	}

	private async load<T>(entry: ResourceEntry<T>, read: () => Promise<T>, detail = ResourceDetail.Core): Promise<T> {
		if (entry.pending) {
			return entry.pending;
		}
		const state = entry.state.get();
		if (state.status === 'resolved' && (detail === ResourceDetail.Core || entry.isComplete)) {
			return state.value;
		}
		if (state.status !== 'resolved') {
			entry.state.set({ status: 'loading' });
		}
		const token = entry.cancellation.token;
		entry.pending = read();
		try {
			const value = await entry.pending;
			if (!token.isCancellationRequested) {
				entry.isComplete = detail === ResourceDetail.Checks;
				entry.state.set({ status: 'resolved', value });
			}
			return value;
		} catch (error) {
			// Optional checks failure must not erase already loaded title and branches.
			if (!token.isCancellationRequested && state.status !== 'resolved') {
				entry.state.set({ status: 'failed' });
			}
			throw error;
		} finally {
			entry.pending = undefined;
		}
	}
}

export function parseGitHubReferenceTarget(resource: URI, kind: GitHubReferenceKind): IGitHubReferenceTarget | undefined {
	const match = /^\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/([1-9]\d*)$/.exec(resource.path);
	if (resource.scheme !== 'https' || resource.authority.toLowerCase() !== 'github.com' || !match || match[3] !== (kind === 'issue' ? 'issues' : 'pull')) {
		return undefined;
	}
	const number = Number(match[4]);
	return Number.isSafeInteger(number) ? { owner: match[1], repo: match[2], number } : undefined;
}

function repository(target: IGitHubReferenceTarget): { host: string; owner: string; name: string; } {
	return { host: 'github.com', owner: target.owner, name: target.repo };
}

function referenceKey(target: IGitHubReferenceTarget): string {
	return `${target.owner}/${target.repo}#${target.number}`.toLowerCase();
}
