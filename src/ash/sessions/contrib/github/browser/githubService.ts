import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationTokenSource, type CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { DisposableStore, Disposable, DisposableMap, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { observableValue, type IReader } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import {
	GitHubIssueState,
	IGitHubService as IGitHubApi,
	type GitHubRepository,
	type GitHubPullRequest,
	type GitHubPullRequestReference,
	type GitHubAccount,
	type GitHubIssueReference,
} from '../../../../platform/github/common/githubService.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import { computePullRequestIcon, type IPullRequestIconStatus } from '../../../../workbench/common/chatPullRequest.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ISCMService } from '../../../../workbench/contrib/scm/common/scm.js';
import type { GitRepositoryContext } from '../../../../platform/git/common/localGitService.js';
type RepositoryIdentity = NonNullable<GitRepositoryContext['remotes'][number]['identity']>;
import { getPullRequestChecksStatus, getPullRequestResourceStatus } from '../../../../workbench/contrib/github/browser/githubResourceHover.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import type { ISession, SessionId } from '../../../services/sessions/common/session.js';
import { ISessionProviderScopeService, type ISessionProviderScope } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { linkKey } from '../../../common/sessionLinks.js';
import { agentHostSessionWorkspaceKey } from '../../../common/agentHostSessionWorkspace.js';
import type { IResolvedSessionPullRequest, IResolvedSessionIssue } from '../common/types.js';

export interface IGitHubService {
	readonly onDidChange: Event<void>;
	getSessionPullRequests(sessionId: SessionId): readonly IResolvedSessionPullRequest[];
	getSessionIssues(sessionId: SessionId, reader?: IReader): readonly IResolvedSessionIssue[];
	attachIssue(sessionId: SessionId, url: string): Promise<void>;
	detachIssue(sessionId: SessionId, reference: GitHubIssueReference): Promise<void>;
	initialize(): void;
	attachPullRequest(sessionId: SessionId, url: string): Promise<void>;
	detachPullRequest(sessionId: SessionId, reference: GitHubPullRequestReference): Promise<void>;
}

export const IGitHubService = createServiceIdentifier<IGitHubService>('sessionsGitHubService');

/** Resolves live Issue and PR state from durable references and execution-directory branches. */
export class GitHubService extends Disposable implements IGitHubService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly requests = new Map<SessionId, { readonly directory: string; readonly values: readonly IResolvedSessionPullRequest[] }>();
	private readonly issues = observableValue<ReadonlyMap<SessionId, readonly IResolvedSessionIssue[]>>(this, new Map());
	private readonly accountGenerations = new WeakMap<ISessionProviderScope, number>();
	private readonly attachmentProviders = new WeakMap<CancellationTokenSource, ISessionProviderScope>();
	private readonly attachments = this._register(new DisposableMap<CancellationTokenSource, CancellationTokenSource>());
	private readonly branches = new Map<SessionId, ReadonlyMap<string, string>>();
	private readonly operation = new MutableDisposable<CancellationTokenSource>();
	private readonly refresh = this._register(
		new RunOnceScheduler(() => {
			void this.resolveSelection();
		}, 60_000),
	);
	private selectionKey: string | undefined;
	private resolving = false;
	private refreshQueued = false;
	private observedScopes = new Set<ISessionProviderScope>();

	constructor(
		@ISessionsService private readonly sessions: ISessionsService,
		@ISessionsManagementService private readonly management: ISessionsManagementService,
		@ISCMService scm: ISCMService,
		@ISessionProviderScopeService private readonly scopes: ISessionProviderScopeService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this._register(this.operation);
		// Disposal runs in reverse order: notify pending readers before releasing their token source.
		this._register(
			toDisposable(() => {
				this.operation.value?.cancel();
				for (const [source] of this.attachments) {
					source.cancel();
				}
			}),
		);
		this._register(sessions.onDidChange(() => this.updateSelection()));

		const providerListeners = this._register(new DisposableStore());
		const observeProviders = (): void => {
			providerListeners.clear();
			for (const repository of scm.repositories) {
				providerListeners.add(repository.provider.onDidChangeResources(() => this.invalidateSelection()));
			}
			this.invalidateSelection();
		};
		this._register(scm.onDidAddRepository(observeProviders));
		this._register(scm.onDidRemoveRepository(observeProviders));
		this._register(CommandsRegistry.onDidChangeCommands(() => this.invalidateSelection()));
		observeProviders();
		const hostListeners = this._register(new DisposableStore());
		const observeHosts = (): void => {
			hostListeners.clear();
			const current = scopes.getScopes();
			for (const previous of this.observedScopes) if (!current.includes(previous)) this.invalidateAccounts(previous);
			this.observedScopes = new Set(current);
			for (const scope of current) {
				const api = scope.services.host;
				hostListeners.add(
					Event.any(
						api.github.onDidChangeSessionPullRequests,
						api.github.onDidChangeSessionIssues,
					)(sessionId => {
						if (this.sessions.activeSelection?.kind === 'session' && this.sessions.activeSelection.active.session.sessionId === scope.identity(sessionId)) {
							this.operation.value?.cancel();
							this.refresh.schedule(0);
						}
					}),
				);
				const events = api.events.subscribe(event => {
					if (event.method === 'account/updated' || event.method === 'account/login/completed') this.invalidateAccounts(scope);
					if (event.method === 'git/statusChanged' || event.method === 'git/repositoriesChanged') this.invalidateSelection();
				});
				hostListeners.add(toDisposable(() => events.dispose()));
				const connection = api.appServer.onConnectionState(() => this.invalidateAccounts(scope));
				hostListeners.add(toDisposable(() => connection.dispose()));
			}
		};
		this._register(scopes.onDidChangeScopes(observeHosts));
		observeHosts();
	}

	private invalidateAccounts(scope?: ISessionProviderScope): void {
		const affected = (id: SessionId): boolean => {
			if (!scope) return true;
			try {
				scope.backendIdentity(id);
				return true;
			} catch {
				return false;
			}
		};
		const selected = this.sessions.activeSelection;
		if (selected?.kind === 'session' && affected(selected.active.session.sessionId)) this.operation.value?.cancel();
		if (scope) this.accountGenerations.set(scope, (this.accountGenerations.get(scope) ?? 0) + 1);
		for (const [source] of this.attachments) {
			if (!scope || this.attachmentProviders.get(source) === scope) source.cancel();
		}
		const issues = new Map(this.issues.get());
		for (const id of issues.keys()) if (affected(id)) issues.delete(id);
		this.issues.set(issues, undefined);
		for (const id of this.requests.keys())
			if (affected(id)) {
				this.requests.delete(id);
				this.branches.delete(id);
			}
		this.changed.fire();
		if (selected?.kind === 'session' && affected(selected.active.session.sessionId)) this.refresh.schedule(0);
	}

	private capture(sessionId: SessionId): SessionGitHubScope {
		const scope = this.scopes.getScope(sessionId);
		const generation = scope.services.host.appServer.connectionGeneration;
		const accounts = this.accountGenerations.get(scope) ?? 0;
		return {
			provider: scope,
			github: scope.services.host.github,
			backendSessionId: scope.backendIdentity(sessionId),
			assertCurrent: () => {
				scope.assertCurrent();
				if (this.isDisposed || generation !== scope.services.host.appServer.connectionGeneration || accounts !== (this.accountGenerations.get(scope) ?? 0)) throw new CancellationError();
			},
		};
	}

	public initialize(): void {
		this.updateSelection();
	}

	public async attachPullRequest(sessionId: SessionId, url: string): Promise<void> {
		const binding = this.capture(sessionId);
		const reference = parsePullRequestReference(url);
		const source = new CancellationTokenSource();
		this.attachments.set(source, source);
		this.attachmentProviders.set(source, binding.provider);
		try {
			const accounts = await binding.github.listAccounts(source.token);
			binding.assertCurrent();
			const account = accounts.find(account => account.status === 'ready' && account.host.toLowerCase() === reference.repository.host);
			if (!account) throw new Error(localize('sessions.github.connectHost', 'Connect a GitHub account for {0} before attaching this pull request.', reference.repository.host));
			await binding.github.readPullRequest({ ...reference.repository, accountId: account.id }, reference.number, source.token);
			binding.assertCurrent();
			if (source.token.isCancellationRequested) throw new CancellationError();
			await binding.github.attachSessionPullRequest(binding.backendSessionId, reference);
			binding.assertCurrent();
			if (!this.isDisposed) {
				this.operation.value?.cancel();
				this.refresh.schedule(0);
			}
		} finally {
			this.attachments.deleteAndDispose(source);
		}
	}

	public async detachPullRequest(sessionId: SessionId, reference: GitHubPullRequestReference): Promise<void> {
		const binding = this.capture(sessionId);
		await binding.github.detachSessionPullRequest(binding.backendSessionId, reference);
		binding.assertCurrent();
		if (!this.isDisposed) {
			this.operation.value?.cancel();
			this.refresh.schedule(0);
		}
	}

	public getSessionPullRequests(sessionId: SessionId): readonly IResolvedSessionPullRequest[] {
		return this.requests.get(sessionId)?.values ?? [];
	}

	public getSessionIssues(sessionId: SessionId, reader?: IReader): readonly IResolvedSessionIssue[] {
		return this.issues.read(reader).get(sessionId) ?? [];
	}

	public async attachIssue(sessionId: SessionId, url: string): Promise<void> {
		const binding = this.capture(sessionId);
		const reference = parseIssueReference(url);
		const source = new CancellationTokenSource();
		this.attachments.set(source, source);
		this.attachmentProviders.set(source, binding.provider);
		try {
			const accounts = await binding.github.listAccounts(source.token);
			binding.assertCurrent();
			const account = accounts.find(account => account.status === 'ready' && account.host.toLowerCase() === reference.repository.host);
			if (!account) {
				throw new Error(localize('sessions.github.connectIssueHost', 'Connect a GitHub account for {0} before attaching this issue.', reference.repository.host));
			}
			await binding.github.readIssue({ ...reference.repository, accountId: account.id }, reference.number, source.token);
			binding.assertCurrent();
			if (this.isDisposed || source.token.isCancellationRequested) {
				throw new CancellationError();
			}
			await binding.github.attachSessionIssue(binding.backendSessionId, reference);
			binding.assertCurrent();
			if (!this.isDisposed) {
				this.operation.value?.cancel();
				this.refresh.schedule(0);
			}
		} finally {
			this.attachments.deleteAndDispose(source);
		}
	}

	public async detachIssue(sessionId: SessionId, reference: GitHubIssueReference): Promise<void> {
		const binding = this.capture(sessionId);
		await binding.github.detachSessionIssue(binding.backendSessionId, reference);
		binding.assertCurrent();
		if (!this.isDisposed) {
			this.operation.value?.cancel();
			this.refresh.schedule(0);
		}
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
		const retainedIssues = new Map(this.issues.get());
		for (const sessionId of retainedIssues.keys()) {
			if (!this.management.sessions.some(session => session.sessionId === sessionId)) {
				retainedIssues.delete(sessionId);
			}
		}
		if (retainedIssues.size !== this.issues.get().size) {
			this.issues.set(retainedIssues, undefined);
			this.changed.fire();
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

	private invalidateSelection(): void {
		this.operation.value?.cancel();
		if (this.sessions.activeSelection?.kind === 'session') {
			this.refresh.schedule(100);
		}
	}

	private async resolveSelection(): Promise<void> {
		// Cancellation retires transport requests asynchronously. Session notifications
		// must coalesce until that retirement finishes, rather than opening another batch.
		if (this.resolving) {
			this.refreshQueued = true;
			return;
		}
		const selected = this.sessions.activeSelection;
		if (selected?.kind !== 'session') {
			return;
		}
		const session = selected.active.session;
		const workspace = session.workspace;
		const root = workspace ? sessionWorkspaceUri(workspace) : undefined;
		const cancellation = new CancellationTokenSource();
		this.operation.value?.cancel();
		this.operation.value = cancellation;
		const token = cancellation.token;
		this.resolving = true;
		let issueResolution: Promise<void> = Promise.resolve();
		try {
			const binding = this.capture(session.sessionId);
			const accountsPromise = binding.github.listAccounts(token);
			issueResolution = this.resolveSessionIssues(binding, session.sessionId, accountsPromise, token);
			const branches = new Map<string, string>();
			const [accounts, references] = await Promise.all([accountsPromise, binding.github.listSessionPullRequests(binding.backendSessionId)]);
			const hosts = new Set(accounts.filter(account => account.status === 'ready').map(account => account.host.toLowerCase()));
			const contexts = root
				? await binding.provider.services.host.localGit.readRepositoryContexts({ sessionId: binding.backendSessionId, path: workspace!.root }, token).catch(error => {
						// Attached references remain useful without permission to inspect a working directory.
						if (isCancellationError(error) || token.isCancellationRequested) throw error;
						this.log.error('sessions.github', 'Unable to inspect session repositories', error);
						return [];
					})
				: [];
			const repositories = root
				? contexts
						.map(repository => ({
							...repository,
							root: root.with({ path: URI.file(repository.rootPath).path }),
						}))
						.filter(repository => extUriBiasedIgnorePathCase.isEqualOrParent(repository.root, root) || extUriBiasedIgnorePathCase.isEqualOrParent(root, repository.root))
				: [];
			binding.assertCurrent();
			if (token.isCancellationRequested || this.isDisposed) {
				return;
			}
			for (const repository of repositories) {
				if (repository.head.type === 'branch') {
					branches.set(repository.id, repository.head.name);
				}
			}
			const previousBranches = this.branches.get(session.sessionId);
			if (previousBranches && (previousBranches.size !== branches.size || [...previousBranches].some(([id, branch]) => branches.get(id) !== branch))) {
				// Clear old branch associations before remote lookups, while preserving focus on ordinary status refreshes.
				const entry = this.requests.get(session.sessionId);
				if (entry) {
					this.requests.set(session.sessionId, {
						...entry,
						values: entry.values.filter(request => request.recordedReference !== undefined),
					});
					this.changed.fire();
				}
			}
			const recorded = await Promise.all(references.map(reference => this.resolveReference(binding, reference, accounts, token)));
			const results = await Promise.all(
				repositories.map(async repository => {
					if (token.isCancellationRequested || repository.head.type !== 'branch') {
						return [];
					}
					// Enterprise remotes can be classified as "other" by Git; a GitHub grant identifies their host.
					const identities = repository.remotes.flatMap(remote => (remote.identity && hosts.has(remote.identity.host.toLowerCase()) ? [remote.identity] : []));
					const branch = repository.head.name;
					const unique = new Map(identities.map(identity => [`${identity.host}/${identity.owner}/${identity.repository}`.toLowerCase(), identity]));
					return Promise.all(
						[...unique.values()].flatMap(identity => {
							const account = accounts.find(account => account.host.toLowerCase() === identity.host.toLowerCase() && account.status === 'ready');
							return account ? [this.resolveRepository(binding, identity, branch, identities, account.id, token, references)] : [];
						}),
					);
				}),
			);
			if (token.isCancellationRequested || this.isDisposed) {
				return;
			}
			binding.assertCurrent();
			const values = new Map(
				results
					.flat()
					.filter(value => value !== undefined)
					.map(value => [linkKey(value.uri.toString()), value]),
			);
			for (const request of recorded) {
				if (request) {
					values.set(linkKey(request.uri.toString()), request);
				}
			}
			this.requests.set(session.sessionId, { directory: directoryKey(session), values: [...values.values()] });
			this.branches.set(session.sessionId, branches);
			this.changed.fire();
		} catch (error) {
			if (!token.isCancellationRequested && !isCancellationError(error)) {
				this.log.error('sessions.github', 'Unable to resolve session pull requests', error);
			}
		} finally {
			try {
				await issueResolution;
			} finally {
				this.resolving = false;
				if (!this.isDisposed && this.refreshQueued) {
					this.refreshQueued = false;
					this.refresh.schedule(0);
				} else if (this.operation.value === cancellation && !this.isDisposed && !token.isCancellationRequested) {
					this.refresh.schedule();
				}
			}
		}
	}

	private async resolveRepository(
		binding: SessionGitHubScope,
		identity: RepositoryIdentity,
		branch: string,
		heads: readonly RepositoryIdentity[],
		accountId: string,
		token: CancellationToken,
		recorded: readonly GitHubPullRequestReference[],
	): Promise<IResolvedSessionPullRequest | undefined> {
		const repository: GitHubRepository = {
			accountId,
			host: identity.host,
			owner: identity.owner,
			name: identity.repository,
		};
		let match: GitHubPullRequest | undefined;
		const hostHeads = heads.filter(head => head.host.toLowerCase() === identity.host.toLowerCase());
		const owners = new Set(hostHeads.map(head => head.owner));
		const headRepositories = new Set(hostHeads.map(head => `${head.owner}/${head.repository}`.toLowerCase()));
		for (const state of [GitHubIssueState.Open, GitHubIssueState.Closed]) {
			for (const owner of owners) {
				let page: number | null = 1;
				while (page !== null && !token.isCancellationRequested) {
					const result = await binding.github.listPullRequests(repository, state, page, token, {
						head: `${owner}:${branch}`,
					});
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
		if (
			recorded.some(
				reference =>
					reference.number === match!.number &&
					reference.repository.host.toLowerCase() === repository.host.toLowerCase() &&
					reference.repository.owner.toLowerCase() === repository.owner.toLowerCase() &&
					reference.repository.name.toLowerCase() === repository.name.toLowerCase(),
			)
		) {
			return undefined;
		}
		return this.readPullRequest(binding, repository, match.number, token);
	}

	private async resolveSessionIssues(binding: SessionGitHubScope, sessionId: SessionId, accountsPromise: Promise<readonly GitHubAccount[]>, token: CancellationToken): Promise<void> {
		let values: readonly IResolvedSessionIssue[];
		try {
			const [accounts, references] = await Promise.all([accountsPromise, binding.github.listSessionIssues(binding.backendSessionId)]);
			binding.assertCurrent();
			values = await Promise.all(references.map(reference => this.resolveIssue(binding, reference, accounts, token)));
			binding.assertCurrent();
		} catch (error) {
			if (token.isCancellationRequested || isCancellationError(error)) {
				return;
			}
			this.log.error('sessions.github', 'Unable to refresh session issues', error);
			// A failed collection read must not leave an old completed status looking current.
			values = this.getSessionIssues(sessionId).map(entry => ({ ...entry, issue: undefined }));
		}
		if (token.isCancellationRequested || this.isDisposed) {
			return;
		}
		const state = new Map(this.issues.get());
		state.set(sessionId, values);
		this.issues.set(state, undefined);
	}

	private async resolveIssue(binding: SessionGitHubScope, reference: GitHubIssueReference, accounts: readonly GitHubAccount[], token: CancellationToken): Promise<IResolvedSessionIssue> {
		const uri = URI.from({
			scheme: 'https',
			authority: reference.repository.host,
			path: `/${reference.repository.owner}/${reference.repository.name}/issues/${reference.number}`,
		});
		const unresolved: IResolvedSessionIssue = { reference, uri, issue: undefined };
		const account = accounts.find(account => account.status === 'ready' && account.host.toLowerCase() === reference.repository.host.toLowerCase());
		if (!account || token.isCancellationRequested) {
			return unresolved;
		}
		try {
			const issue = await binding.github.readIssue({ ...reference.repository, accountId: account.id }, reference.number, token);
			if (token.isCancellationRequested) {
				return unresolved;
			}
			return {
				reference,
				uri,
				issue: { title: issue.title, state: issue.state, stateReason: issue.stateReason },
			};
		} catch (error) {
			if (!token.isCancellationRequested && !isCancellationError(error)) {
				this.log.error('sessions.github', 'Unable to read an attached issue', error);
			}
			return unresolved;
		}
	}

	private async resolveReference(
		binding: SessionGitHubScope,
		reference: GitHubPullRequestReference,
		accounts: readonly GitHubAccount[],
		token: CancellationToken,
	): Promise<IResolvedSessionPullRequest | undefined> {
		const account = accounts.find(account => account.host.toLowerCase() === reference.repository.host.toLowerCase() && account.status === 'ready');
		if (!account || token.isCancellationRequested) {
			return undefined;
		}
		try {
			const request = await this.readPullRequest(binding, { ...reference.repository, accountId: account.id }, reference.number, token);
			return request ? { ...request, recordedReference: reference } : undefined;
		} catch (error) {
			if (token.isCancellationRequested || isCancellationError(error)) {
				return undefined;
			}
			this.log.error('sessions.github', 'Unable to read an attached pull request', error);
			return {
				uri: URI.from({
					scheme: 'https',
					authority: reference.repository.host,
					path: `/${reference.repository.owner}/${reference.repository.name}/pull/${reference.number}`,
				}),
				owner: reference.repository.owner,
				repo: reference.repository.name,
				number: reference.number,
				title: '',
				state: 'unavailable',
				status: {},
				icon: { id: 'link', color: { id: 'descriptionForeground' } },
				recordedReference: reference,
			};
		}
	}

	private async readPullRequest(binding: SessionGitHubScope, repository: GitHubRepository, number: number, token: CancellationToken): Promise<IResolvedSessionPullRequest | undefined> {
		binding.assertCurrent();
		const pullRequest = await binding.github.readPullRequest(repository, number, token);
		binding.assertCurrent();
		if (token.isCancellationRequested) {
			return undefined;
		}
		const state = getPullRequestResourceStatus(pullRequest).kind;
		let status: IPullRequestIconStatus = {};
		if (state === 'open') {
			const [hasFailingChecks, hasUnresolvedComments] = await Promise.all([
				this.readFailingChecks(binding, repository, pullRequest.headCommit, token),
				this.readUnresolvedComments(binding, repository, pullRequest.number, token),
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

	private async readFailingChecks(binding: SessionGitHubScope, repository: GitHubRepository, commit: string, token: CancellationToken): Promise<boolean> {
		let page: number | null = 1;
		while (page !== null && !token.isCancellationRequested) {
			const result = await binding.github.readChecks(repository, commit, page, token);
			if (getPullRequestChecksStatus(result) === 'failure') {
				return true;
			}
			page = result.nextPage;
		}
		return false;
	}

	private async readUnresolvedComments(binding: SessionGitHubScope, repository: GitHubRepository, number: number, token: CancellationToken): Promise<boolean> {
		let cursor: string | null = null;
		do {
			const result = await binding.github.listReviewThreads(repository, number, cursor, token);
			if (result.threads.some(thread => !thread.resolved)) {
				return true;
			}
			cursor = result.nextCursor;
		} while (cursor !== null && !token.isCancellationRequested);
		return false;
	}
}

interface SessionGitHubScope {
	readonly provider: ISessionProviderScope;
	readonly github: IGitHubApi;
	readonly backendSessionId: string;
	assertCurrent(): void;
}

function directoryKey(session: ISession): string {
	return agentHostSessionWorkspaceKey(session.workspace) ?? '';
}

function parsePullRequestReference(value: string): GitHubPullRequestReference {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error(localize('sessions.github.invalidUrl', 'Enter an HTTPS pull request URL, such as https://github.com/owner/repo/pull/123.'));
	}
	const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
	if (url.protocol !== 'https:' || url.username || url.password || url.port || !match || !Number.isSafeInteger(Number(match[3]))) {
		throw new Error(localize('sessions.github.invalidUrl', 'Enter an HTTPS pull request URL, such as https://github.com/owner/repo/pull/123.'));
	}
	return {
		repository: { host: url.hostname.toLowerCase(), owner: match[1].toLowerCase(), name: match[2].toLowerCase() },
		number: Number(match[3]),
	};
}

function parseIssueReference(value: string): GitHubIssueReference {
	const invalid = () => new Error(localize('sessions.github.invalidIssueUrl', 'Enter an HTTPS issue URL, such as https://github.com/owner/repo/issues/123.'));
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw invalid();
	}
	const match = /^\/([\w.-]+)\/([\w.-]+)\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
	if (url.protocol !== 'https:' || url.username || url.password || url.port || !match || !Number.isSafeInteger(Number(match[3]))) {
		throw invalid();
	}
	return {
		repository: { host: url.hostname.toLowerCase(), owner: match[1].toLowerCase(), name: match[2].toLowerCase() },
		number: Number(match[3]),
	};
}
