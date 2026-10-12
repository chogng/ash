import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError, getErrorMessage } from '../../../../base/common/errors.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import { IAccountService } from '../../../../platform/accounts/common/accountService.js';
import { IGitHubService as IGitHubApi, GitHubError, type GitHubCheckRun } from '../../../../platform/github/common/githubService.js';
import { localize } from '../../../../nls.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { IGitHubService } from '../../github/browser/githubService.js';

interface ChecksState {
	readonly loading: boolean;
	readonly error?: string;
	readonly checks: readonly { readonly pullRequest: string; readonly check: GitHubCheckRun; }[];
}

/** Owns only the visible Changes surface's cancellable CI detail reads. */
export class ChecksViewModel extends Disposable {
	private readonly state = observableValue<ChecksState>(this, { loading: false, checks: [] });
	public readonly checksObs: IObservable<ChecksState> = this.state;
	private readonly pending = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly refresh = this._register(new RunOnceScheduler(() => { void this.load(); }, 60_000));
	private owner: string | undefined;

	constructor(
		@ISessionsService private readonly sessions: ISessionsService,
		@IGitHubService private readonly associations: IGitHubService,
		@IGitHubApi private readonly github: IGitHubApi,
		@IAccountService accounts: IAccountService,
	) {
		super();
		this._register(toDisposable(() => this.pending.value?.cancel()));
		const invalidate = (): void => {
			this.pending.value?.cancel();
			if (this.selectionKey() !== this.owner) {
				this.state.set({ loading: false, checks: [] }, undefined);
			}
			this.refresh.schedule(0);
		};
		this._register(sessions.onDidChange(invalidate));
		this._register(associations.onDidChange(invalidate));
		this._register(accounts.onDidChangeAccounts(() => {
			this.owner = undefined;
			this.state.set({ loading: false, checks: [] }, undefined);
			invalidate();
		}));
		void this.load();
	}

	private selectionKey(): string | undefined {
		const selected = this.sessions.activeSelection;
		if (selected?.kind !== 'session') { return undefined; }
		return JSON.stringify([
			selected.active.session.sessionId,
			selected.active.threadId,
			this.associations.getSessionPullRequests(selected.active.session.sessionId).map(request => [request.uri.toString(), request.state]),
		]);
	}

	private async load(): Promise<void> {
		this.pending.value?.cancel();
		const source = new CancellationTokenSource();
		this.pending.value = source;
		const token = source.token;
		this.owner = this.selectionKey();
		const selected = this.sessions.activeSelection;
		const requests = selected?.kind === 'session' ? this.associations.getSessionPullRequests(selected.active.session.sessionId).filter(request => request.state === 'open' || request.state === 'draft') : [];
		if (!requests.length) {
			this.state.set({ loading: false, checks: [] }, undefined);
			return;
		}
		this.state.set({ ...this.state.get(), loading: true, error: undefined }, undefined);
		try {
			const accounts = await this.github.listAccounts(token);
			if (token.isCancellationRequested) { return; }
			const results = await Promise.all(requests.map(async request => {
				const host = request.uri.authority.toLowerCase();
				const account = accounts.find(account => account.status === 'ready' && account.host.toLowerCase() === host);
				if (!account) { throw new Error(localize('sessions.changes.checkAccount', 'Connect a GitHub account for {0} to read checks.', host)); }
				const repository = { host, owner: request.owner, name: request.repo, accountId: account.id };
				const pullRequest = await this.github.readPullRequest(repository, request.number, token);
				const checks = new Map<string, GitHubCheckRun>();
				const pages = new Set<number>();
				let page: number | null = 1;
				while (page !== null && !token.isCancellationRequested) {
					if (pages.has(page) || pages.size >= 100) { throw new Error(localize('sessions.changes.checkPages', 'Could not read all check results.')); }
					pages.add(page);
					const result = await this.github.readChecks(repository, pullRequest.headCommit, page, token);
					for (const check of result.checks) { checks.set(`run:${check.id}`, check); }
					for (const status of result.statuses) {
						checks.set(`status:${status.context}`, {
							id: 0, name: status.context, detailsUrl: status.targetUrl,
							status: status.state === 'pending' ? 'queued' : 'completed',
							conclusion: status.state === 'success' ? 'success' : status.state === 'failure' || status.state === 'error' ? 'failure' : null,
						});
					}
					page = result.nextPage;
				}
				return [...checks.values()].map(check => ({ pullRequest: `${request.owner}/${request.repo} #${request.number}`, check }));
			}));
			if (!token.isCancellationRequested && !this.isDisposed) { this.state.set({ loading: false, checks: results.flat() }, undefined); }
		} catch (error) {
			if (!token.isCancellationRequested && !this.isDisposed && !isCancellationError(error)) {
				this.state.set({
					loading: false,
					checks: [],
					error: error instanceof GitHubError
						? localize('sessions.changes.checkGitHubError', 'GitHub checks are unavailable. Check your account and repository access; the view will retry.')
						: getErrorMessage(error),
				}, undefined);
			}
		} finally {
			if (!token.isCancellationRequested && !this.isDisposed) { this.refresh.schedule(); }
		}
	}
}
