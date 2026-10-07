import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationTokenSource, type CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IAccountService } from '../../../../platform/accounts/common/accountService.js';
import { GitHubIssueState, IGitHubService as IGitHubApi, type GitHubRepository, type GitHubPullRequest, type GitHubPullRequestReference, type GitHubAccount } from '../../../../platform/github/common/githubService.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createSshRemoteWorkspaceUri } from '../../../../platform/remote/common/remote.js';
import { computePullRequestIcon, type IPullRequestIconStatus } from '../../../../workbench/common/chatPullRequest.js';
import { IGitService, type GitRepositoryIdentity, type GitStatus } from '../../../../workbench/contrib/git/common/gitService.js';
import { getPullRequestChecksStatus, getPullRequestResourceStatus } from '../../../../workbench/contrib/github/browser/githubResourceHover.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import type { ISession, SessionId } from '../../../services/sessions/common/session.js';
import type { IResolvedSessionPullRequest } from '../common/types.js';

export interface IGitHubService {
	readonly onDidChange: Event<void>;
	getSessionPullRequests(sessionId: SessionId): readonly IResolvedSessionPullRequest[];
	initialize(): void;
	attachPullRequest(sessionId: SessionId, url: string): Promise<void>;
	detachPullRequest(sessionId: SessionId, reference: GitHubPullRequestReference): Promise<void>;
}

export const IGitHubService = createServiceIdentifier<IGitHubService>('sessionsGitHubService');

/** Resolves live PR state from durable references and execution-directory branches without changing canonical Session data. */
export class GitHubService extends Disposable implements IGitHubService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly requests = new Map<SessionId, { readonly directory: string; readonly values: readonly IResolvedSessionPullRequest[]; }>();
	private readonly branches = new Map<SessionId, ReadonlyMap<string, string>>();
	private readonly operation = new MutableDisposable<CancellationTokenSource>();
	private readonly refresh = this._register(new RunOnceScheduler(() => { void this.resolveSelection(); }, 60_000));
	private selectionKey: string | undefined;

	constructor(
		@ISessionsService private readonly sessions: ISessionsService,
		@ISessionsManagementService private readonly management: ISessionsManagementService,
		@IGitService private readonly git: IGitService,
		@IGitHubApi private readonly github: IGitHubApi,
		@IAccountService accounts: IAccountService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this._register(this.operation);
		// Disposal runs in reverse order: notify pending readers before releasing their token source.
		this._register(toDisposable(() => this.operation.value?.cancel()));
		this._register(sessions.onDidChange(() => this.updateSelection()));
		this._register(github.onDidChangeSessionPullRequests(sessionId => {
			if (this.sessions.activeSelection?.kind === 'session' && this.sessions.activeSelection.active.session.sessionId === sessionId) {
				this.operation.value?.cancel();
				this.refresh.schedule(0);
			}
		}));
		this._register(git.onDidChangeRepositories(() => this.invalidateSelection()));
		this._register(git.onDidChangeRepositoryStatus(status => this.handleStatus(status)));
		this._register(accounts.onDidChangeAccounts(() => {
			this.operation.value?.cancel();
			this.requests.clear();
			this.branches.clear();
			this.changed.fire();
			this.refresh.schedule(0);
		}));
	}

	public initialize(): void {
		this.updateSelection();
	}

	public async attachPullRequest(sessionId: SessionId, url: string): Promise<void> {
		const reference = parsePullRequestReference(url);
		const accounts = await this.github.listAccounts();
		const account = accounts.find(account => account.status === 'ready' && account.host.toLowerCase() === reference.repository.host);
		if (!account) { throw new Error(localize('sessions.github.connectHost', 'Connect a GitHub account for {0} before attaching this pull request.', reference.repository.host)); }
		await this.github.readPullRequest({ ...reference.repository, accountId: account.id }, reference.number);
		await this.github.attachSessionPullRequest(sessionId, reference);
		if (!this.isDisposed) { this.operation.value?.cancel(); this.refresh.schedule(0); }
	}

	public async detachPullRequest(sessionId: SessionId, reference: GitHubPullRequestReference): Promise<void> {
		await this.github.detachSessionPullRequest(sessionId, reference);
		if (!this.isDisposed) { this.operation.value?.cancel(); this.refresh.schedule(0); }
	}

	public getSessionPullRequests(sessionId: SessionId): readonly IResolvedSessionPullRequest[] {
		return this.requests.get(sessionId)?.values ?? [];
	}

	private updateSelection(): void {
		for (const [sessionId, entry] of this.requests) {
			const session = this.management.sessions.find(candidate => candidate.sessionId === sessionId);
			if (!session || directoryKey(session) !== entry.directory) {
				this.requests.delete(sessionId);
				this.branches.delete(sessionId);
				this.changed.fire();
			}
		}
		const selected = this.sessions.activeSelection;
		const key = selected?.kind === 'session' ? `${selected.active.session.sessionId}:${directoryKey(selected.active.session)}` : undefined;
		if (key === this.selectionKey) {
			return;
		}
		this.selectionKey = key;
		this.operation.value?.cancel();
		this.refresh.cancel();
		if (key !== undefined) {
			this.refresh.schedule(0);
		}
	}

	private handleStatus(status: GitStatus): void {
		const selected = this.sessions.activeSelection;
		if (selected?.kind !== 'session') {
			return;
		}
		const branch = status.head.type === 'branch' ? status.head.name : undefined;
		const previous = this.branches.get(selected.active.session.sessionId)?.get(status.repositoryId);
		if (previous !== branch) {
			this.invalidateSelection();
			return;
		}
		this.operation.value?.cancel();
		this.refresh.schedule(100);
	}

	private invalidateSelection(): void {
		this.operation.value?.cancel();
		const selected = this.sessions.activeSelection;
		if (selected?.kind !== 'session') {
			return;
		}
		// A branch change must remove the old PR before the new branch lookup finishes.
		const entry = this.requests.get(selected.active.session.sessionId);
		if (entry) {
			this.requests.set(selected.active.session.sessionId, { ...entry, values: entry.values.filter(request => request.recordedReference !== undefined) });
			this.changed.fire();
		}
		this.refresh.schedule(100);
	}

	private async resolveSelection(): Promise<void> {
		const selected = this.sessions.activeSelection;
		if (selected?.kind !== 'session') {
			return;
		}
		const session = selected.active.session;
		const workspace = session.workspace;
		const root = workspace ? (workspace.authorityId === 'local' ? URI.file(workspace.root) : createSshRemoteWorkspaceUri(workspace.authorityId, workspace.root)) : undefined;
		const cancellation = new CancellationTokenSource();
		this.operation.value?.cancel();
		this.operation.value = cancellation;
		const token = cancellation.token;
		try {
			const branches = new Map<string, string>();
			const [accounts, references] = await Promise.all([this.github.listAccounts(token), this.github.listSessionPullRequests(session.sessionId)]);
			const hosts = new Set(accounts.filter(account => account.status === 'ready').map(account => account.host.toLowerCase()));
			const repositories = root ? this.git.repositories.filter(repository => extUriBiasedIgnorePathCase.isEqualOrParent(repository.root, root) || extUriBiasedIgnorePathCase.isEqualOrParent(root, repository.root)) : [];
			const recorded = await Promise.all(references.map(reference => this.resolveReference(reference, accounts, token)));
			const results = await Promise.all(repositories.map(async repository => {
				const [status, graph] = await Promise.all([this.git.status(repository.id), this.git.graph({ limit: 1 }, repository.id)]);
				if (token.isCancellationRequested || status.head.type !== 'branch') {
					return [];
				}
				// Enterprise remotes can be classified as "other" by Git; a GitHub grant identifies their host.
				const identities = graph.remotes.flatMap(remote => remote.identity && hosts.has(remote.identity.host.toLowerCase()) ? [remote.identity] : []);
				const branch = status.head.name;
				branches.set(repository.id, branch);
				const unique = new Map(identities.map(identity => [`${identity.host}/${identity.owner}/${identity.repository}`.toLowerCase(), identity]));
				return Promise.all([...unique.values()].flatMap(identity => {
					const account = accounts.find(account => account.host.toLowerCase() === identity.host.toLowerCase() && account.status === 'ready');
					return account ? [this.resolveRepository(identity, branch, identities, account.id, token, references)] : [];
				}));
			}));
			if (token.isCancellationRequested || this.isDisposed) {
				return;
			}
			const values = new Map(results.flat().filter(value => value !== undefined).map(value => [value.uri.toString().toLowerCase(), value]));
			for (const request of recorded) {
				if (request) { values.set(request.uri.toString().toLowerCase(), request); }
			}
			this.requests.set(session.sessionId, { directory: directoryKey(session), values: [...values.values()] });
			this.branches.set(session.sessionId, branches);
			this.changed.fire();
		} catch (error) {
			if (!token.isCancellationRequested && !isCancellationError(error)) {
				this.log.error('sessions.github', 'Unable to resolve session pull requests', error);
			}
		} finally {
			if (this.operation.value === cancellation && !this.isDisposed && !token.isCancellationRequested) {
				this.refresh.schedule();
			}
		}
	}

	private async resolveRepository(identity: GitRepositoryIdentity, branch: string, heads: readonly GitRepositoryIdentity[], accountId: string, token: CancellationToken, recorded: readonly GitHubPullRequestReference[]): Promise<IResolvedSessionPullRequest | undefined> {
		const repository: GitHubRepository = { accountId, host: identity.host, owner: identity.owner, name: identity.repository };
		let match: GitHubPullRequest | undefined;
		const hostHeads = heads.filter(head => head.host.toLowerCase() === identity.host.toLowerCase());
		const owners = new Set(hostHeads.map(head => head.owner));
		const headRepositories = new Set(hostHeads.map(head => `${head.owner}/${head.repository}`.toLowerCase()));
		for (const state of [GitHubIssueState.Open, GitHubIssueState.Closed]) {
			for (const owner of owners) {
				let page: number | null = 1;
				while (page !== null && !token.isCancellationRequested) {
					const result = await this.github.listPullRequests(repository, state, page, token, { head: `${owner}:${branch}` });
					match = result.items.find(request => request.headBranch === branch && request.headRepository !== null && headRepositories.has(request.headRepository.toLowerCase()));
					if (match) {
						break;
					}
					page = result.nextPage;
				}
				if (match || token.isCancellationRequested) {
					break;
				}
			}
			if (match || token.isCancellationRequested) {
				break;
			}
		}
		if (!match || token.isCancellationRequested) {
			return undefined;
		}
		// A recorded association owns its status read, including a visible unavailable state.
		if (recorded.some(reference => reference.number === match!.number && reference.repository.host.toLowerCase() === repository.host.toLowerCase() && reference.repository.owner.toLowerCase() === repository.owner.toLowerCase() && reference.repository.name.toLowerCase() === repository.name.toLowerCase())) {
			return undefined;
		}
		return this.readPullRequest(repository, match.number, token);
	}

	private async resolveReference(reference: GitHubPullRequestReference, accounts: readonly GitHubAccount[], token: CancellationToken): Promise<IResolvedSessionPullRequest | undefined> {
		const account = accounts.find(account => account.host.toLowerCase() === reference.repository.host.toLowerCase() && account.status === 'ready');
		if (!account || token.isCancellationRequested) { return undefined; }
		try {
			const request = await this.readPullRequest({ ...reference.repository, accountId: account.id }, reference.number, token);
			return request ? { ...request, recordedReference: reference } : undefined;
		} catch (error) {
			if (token.isCancellationRequested || isCancellationError(error)) { return undefined; }
			this.log.error('sessions.github', 'Unable to read an attached pull request', error);
			return {
				uri: URI.from({ scheme: 'https', authority: reference.repository.host, path: `/${reference.repository.owner}/${reference.repository.name}/pull/${reference.number}` }),
				owner: reference.repository.owner, repo: reference.repository.name, number: reference.number,
				title: '', state: 'unavailable', status: {}, icon: { id: 'link', color: { id: 'descriptionForeground' } }, recordedReference: reference,
			};
		}
	}

	private async readPullRequest(repository: GitHubRepository, number: number, token: CancellationToken): Promise<IResolvedSessionPullRequest | undefined> {
		const pullRequest = await this.github.readPullRequest(repository, number, token);
		if (token.isCancellationRequested) {
			return undefined;
		}
		const state = getPullRequestResourceStatus(pullRequest).kind;
		let status: IPullRequestIconStatus = {};
		if (state === 'open') {
			const [hasFailingChecks, hasUnresolvedComments] = await Promise.all([
				this.readFailingChecks(repository, pullRequest.headCommit, token),
				this.readUnresolvedComments(repository, pullRequest.number, token),
			]);
			status = { hasMergeConflicts: pullRequest.mergeable === false, hasFailingChecks, hasUnresolvedComments };
		}
		return {
			uri: URI.parse(pullRequest.url),
			owner: repository.owner,
			repo: repository.name,
			number: pullRequest.number,
			title: pullRequest.title,
			state,
			status,
			icon: computePullRequestIcon(state, status),
		};
	}

	private async readFailingChecks(repository: GitHubRepository, commit: string, token: CancellationToken): Promise<boolean> {
		let page: number | null = 1;
		while (page !== null && !token.isCancellationRequested) {
			const result = await this.github.readChecks(repository, commit, page, token);
			if (getPullRequestChecksStatus(result) === 'failure') {
				return true;
			}
			page = result.nextPage;
		}
		return false;
	}

	private async readUnresolvedComments(repository: GitHubRepository, number: number, token: CancellationToken): Promise<boolean> {
		let cursor: string | null = null;
		do {
			const result = await this.github.listReviewThreads(repository, number, cursor, token);
			if (result.threads.some(thread => !thread.resolved)) {
				return true;
			}
			cursor = result.nextCursor;
		} while (cursor !== null && !token.isCancellationRequested);
		return false;
	}
}

function directoryKey(session: ISession): string {
	return session.workspace ? `${session.workspace.authorityId}:${session.workspace.root}` : '';
}

function parsePullRequestReference(value: string): GitHubPullRequestReference {
	let url: URL;
	try { url = new URL(value.trim()); } catch { throw new Error(localize('sessions.github.invalidUrl', 'Enter an HTTPS pull request URL, such as https://github.com/owner/repo/pull/123.')); }
	const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
	if (url.protocol !== 'https:' || url.username || url.password || url.port || !match || !Number.isSafeInteger(Number(match[3]))) {
		throw new Error(localize('sessions.github.invalidUrl', 'Enter an HTTPS pull request URL, such as https://github.com/owner/repo/pull/123.'));
	}
	return { repository: { host: url.hostname.toLowerCase(), owner: match[1].toLowerCase(), name: match[2].toLowerCase() }, number: Number(match[3]) };
}
