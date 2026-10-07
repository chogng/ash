import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableMap, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import { IGitHubService, type GitHubCommit } from '../../../../platform/github/common/githubService.js';

export interface IGitHubCommitTarget {
	readonly owner: string;
	readonly repo: string;
	readonly sha: string;
}

interface CommitEntry extends IDisposable {
	readonly value: ReturnType<typeof observableValue<GitHubCommit | undefined>>;
	readonly cancellation: CancellationTokenSource;
	pending: Promise<GitHubCommit> | undefined;
}

/** One cache per account registration; the provider retains only live Markdown links. */
export class GitHubCommitResolver extends Disposable {
	private readonly entries = this._register(new DisposableMap<string, CommitEntry>());

	constructor(@IGitHubService private readonly github: IGitHubService) {
		super();
	}

	public get(target: IGitHubCommitTarget): IObservable<GitHubCommit | undefined> {
		return this.entry(target).value;
	}

	public async resolve(target: IGitHubCommitTarget): Promise<GitHubCommit> {
		const entry = this.entry(target);
		if (entry.pending) { return entry.pending; }
		const cached = entry.value.get();
		if (cached) { return cached; }
		const token = entry.cancellation.token;
		entry.pending = this.github.readCommit({ host: 'github.com', owner: target.owner, name: target.repo }, target.sha, token);
		try {
			const commit = await entry.pending;
			if (!token.isCancellationRequested) {
				entry.value.set(commit);
			}
			return commit;
		} finally {
			entry.pending = undefined;
		}
	}

	public retain(targets: readonly IGitHubCommitTarget[]): void {
		const retained = new Set(targets.map(commitKey));
		for (const key of this.entries.keys()) {
			if (!retained.has(key)) {
				this.entries.deleteAndDispose(key);
			}
		}
	}

	private entry(target: IGitHubCommitTarget): CommitEntry {
		this.assertNotDisposed();
		const key = commitKey(target);
		const existing = this.entries.get(key);
		if (existing) {
			return existing;
		}
		const cancellation = new CancellationTokenSource();
		const value = observableValue<GitHubCommit | undefined>(this, undefined);
		const entry = Object.assign(toDisposable(() => cancellation.dispose(true)), { value, cancellation, pending: undefined });
		this.entries.set(key, entry);
		return entry;
	}
}

function commitKey(target: IGitHubCommitTarget): string {
	return `${target.owner}/${target.repo}@${target.sha}`.toLowerCase();
}
