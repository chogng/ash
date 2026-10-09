import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { IAccountService, AccountState } from '../../../../../platform/accounts/common/accountService.js';
import { GitHubIssueState, type IGitHubService, type GitHubPullRequest } from '../../../../../platform/github/common/githubService.js';
import { NullLoggerService } from '../../../../../platform/log/common/log.js';
import type { IGitService, GitRepository, GitStatus } from '../../../../../workbench/contrib/git/common/gitService.js';
import type { ISessionsService, SessionsViewSelection } from '../../../../services/sessions/browser/sessionsService.js';
import type { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import type { ISession } from '../../../../services/sessions/common/session.js';
import { GitHubService } from '../../browser/githubService.js';

const session: ISession = { sessionId: 'session', title: 'PR work', status: 'active', workspace: { authorityId: 'local', root: '/work' }, nextApprovalMode: 'manual', chats: [{ threadId: 'thread', origin: { type: 'root' }, status: 'active' }] };
const pullRequest: GitHubPullRequest = { number: 7, title: 'Branch work', body: '', url: 'https://github.com/team/repo/pull/7', state: 'open', draft: false, mergedAt: null, mergeable: null, headCommit: 'a'.repeat(40), headBranch: 'feature', headRepository: 'team/repo', baseBranch: 'main', autoMerge: false };

function fixture(overrides: Partial<IGitHubService> = {}, gitOverrides: Partial<IGitService> = {}) {
	const resources = new DisposableStore();
	const selectionChanged = resources.add(new Emitter<void>());
	const repositoriesChanged = resources.add(new Emitter<readonly GitRepository[]>());
	const statusChanged = resources.add(new Emitter<GitStatus>());
	const accountChanged = resources.add(new Emitter<AccountState>());
	let selection: SessionsViewSelection | undefined = { kind: 'session', active: { session, threadId: 'thread' } };
	const repository: GitRepository = { id: 'repo', label: 'repo', path: '', root: URI.file('/work') };
	const status: GitStatus = { repositoryId: 'repo', streamInstanceId: 'stream', revision: 1, workspacePath: '/work', head: { type: 'branch', name: 'feature', objectId: 'a'.repeat(40), upstream: undefined }, changes: [] };
	const github = {
		onDidChangeSessionPullRequests: Event.None, onDidChangeSessionIssues: Event.None, listSessionIssues: async () => [], listSessionPullRequests: async () => [],
		listAccounts: async () => [{ id: 'account', host: 'github.com', login: 'user', status: 'ready', credentialRevision: 1n }],
		listPullRequests: async (_repository, state) => ({ items: state === GitHubIssueState.Open ? [pullRequest] : [], nextPage: null }),
		readPullRequest: async () => pullRequest,
		readChecks: async () => ({ state: 'success', statuses: [], checks: [], nextPage: null }),
		listReviewThreads: async () => ({ threads: [], nextCursor: null }),
		...overrides,
	} as IGitHubService;
	const git = {
		repositories: [repository], onDidChangeRepositories: repositoriesChanged.event, onDidChangeRepositoryStatus: statusChanged.event,
		status: async () => status,
		graph: async () => ({ commits: [], references: [], remotes: [{ name: 'origin', identity: { provider: 'github', host: 'github.com', owner: 'team', repository: 'repo' } }], hasMore: false, nextCursor: undefined }),
		...gitOverrides,
	} as IGitService;
	const service = resources.add(new GitHubService(
		{ get activeSelection() { return selection; }, onDidChange: selectionChanged.event } as ISessionsService,
		{ sessions: [session] } as unknown as ISessionsManagementService,
		git, github, { onDidChangeAccounts: accountChanged.event } as IAccountService, new NullLoggerService(),
	));
	const nextChange = (): Promise<void> => new Promise(resolve => {
		const listener = resources.add(service.onDidChange(() => { listener.dispose(); resolve(); }));
	});
	return {
		[Symbol.dispose]: () => resources.dispose(), service, status, statusChanged, accountChanged, nextChange,
		select: (value: SessionsViewSelection | undefined) => { selection = value; selectionChanged.fire(); },
		load: async () => {
			const changed = nextChange();
			service.initialize();
			await changed;
			return service.getSessionPullRequests(session.sessionId);
		},
	};
}

suite('Session GitHub associations', () => {
	test('Issue references verify access, reject other resource URLs, and normalize Enterprise identities', async () => {
		const writes: unknown[] = [];
		using context = fixture({
			listAccounts: async () => [{ id: 'enterprise', host: 'ghe.example', login: 'user', status: 'ready', credentialRevision: 1n }],
			readIssue: async (repository, number) => { assert.deepEqual(repository, { accountId: 'enterprise', host: 'ghe.example', owner: 'team', name: 'repo' }); return { number } as never; },
			attachSessionIssue: async (sessionId, reference) => { writes.push({ sessionId, reference }); },
		});
		for (const url of ['https://ghe.example/team/repo/pull/7', 'http://ghe.example/team/repo/issues/7', 'https://user:secret@ghe.example/team/repo/issues/7', 'https://ghe.example/team/repo/issues/9007199254740992']) {
			await assert.rejects(context.service.attachIssue('session', url));
		}
		assert.deepEqual(writes, []);
		await context.service.attachIssue('session', 'https://GHE.example/TEAM/Repo/issues/7?view=all#comment');
		assert.deepEqual(writes, [{ sessionId: 'session', reference: { repository: { host: 'ghe.example', owner: 'team', name: 'repo' }, number: 7 } }]);
	});

	test('Issue associations remain removable without an account and never invent closed status', async () => {
		const reference = { repository: { host: 'github.com', owner: 'team', name: 'repo' }, number: 11 };
		const removals: unknown[] = [];
		using context = fixture({
			listAccounts: async () => [], listSessionIssues: async () => [reference],
			detachSessionIssue: async (sessionId, reference) => { removals.push({ sessionId, reference }); },
		});
		await context.load();
		assert.deepEqual(context.service.getSessionIssues('session').map(entry => ({ reference: entry.reference, url: entry.uri.toString(), issue: entry.issue })), [{ reference, url: 'https://github.com/team/repo/issues/11', issue: undefined }]);
		await context.service.detachIssue('session', reference);
		assert.deepEqual(removals, [{ sessionId: 'session', reference }]);
	});

	test('one unavailable Issue cannot hide another Issue or an existing PR', async () => {
		const repository = { host: 'github.com', owner: 'team', name: 'repo' };
		using context = fixture({
			listSessionIssues: async () => [11, 12].map(number => ({ repository, number })),
			readIssue: async (_repository, number) => {
				if (number === 11) { throw new Error('Access removed'); }
				return { title: 'Completed work', state: 'closed', stateReason: 'completed' } as never;
			},
		});
		const requests = await context.load();
		assert.equal(requests[0].number, 7);
		assert.deepEqual(context.service.getSessionIssues('session').map(entry => entry.issue?.state), [undefined, 'closed']);
	});

	test('an unavailable Issue collection leaves PR discovery working', async () => {
		using context = fixture({ listSessionIssues: async () => { throw new Error('Method unavailable'); } });
		const requests = await context.load();
		assert.equal(requests[0].number, 7);
		assert.deepEqual(context.service.getSessionIssues('session'), []);
	});

	test('a late Issue response cannot restore private state after an account switch', async () => {
		const reference = { repository: { host: 'github.com', owner: 'team', name: 'repo' }, number: 11 };
		const started = new DeferredPromise<CancellationToken>();
		const pending = new DeferredPromise<Awaited<ReturnType<IGitHubService['readIssue']>>>();
		let signedIn = true;
		using context = fixture({
			listSessionIssues: async () => [reference],
			listAccounts: async () => signedIn ? [{ id: 'account', host: 'github.com', login: 'user', status: 'ready', credentialRevision: 1n }] : [],
			readIssue: async (_repository, _number, token) => { await started.complete(token!); return pending.p; },
		});
		context.service.initialize();
		const token = await started.p;
		signedIn = false;
		context.accountChanged.fire({ revision: 2n, accounts: [] });
		assert.equal(token.isCancellationRequested, true);
		const refreshed = context.nextChange();
		await pending.complete({ title: 'Private title', state: 'closed' } as never);
		await refreshed;
		assert.deepEqual(context.service.getSessionIssues('session').map(entry => entry.issue), [undefined]);
	});

	test('a recorded PR with unavailable remote state remains removable without an invented PR state', async () => {
		const reference = { repository: { host: 'github.com', owner: 'team', name: 'repo' }, number: 7 };
		using context = fixture({ listSessionPullRequests: async () => [reference], listPullRequests: async () => ({ items: [], nextPage: null }), readPullRequest: async () => { throw new Error('Access removed'); } });
		const requests = await context.load();
		assert.equal(requests.length, 1);
		assert.equal(requests[0].state, 'unavailable');
		assert.deepEqual(requests[0].recordedReference, reference);
	});
	test('recorded PRs survive branch changes and duplicate discovery is merged', async () => {
		const reference = { repository: { host: 'github.com', owner: 'team', name: 'repo' }, number: 7 };
		let associated = true;
		using context = fixture({ listSessionPullRequests: async () => [reference], listPullRequests: async () => ({ items: associated ? [pullRequest] : [], nextPage: null }) });
		const requests = await context.load();
		assert.equal(requests.length, 1);
		assert.deepEqual(requests[0].recordedReference, reference);
		associated = false;
		const changed = context.nextChange();
		context.statusChanged.fire({ ...context.status, head: { type: 'branch', name: 'another', objectId: 'b'.repeat(40), upstream: undefined } });
		await changed;
		const restored = context.nextChange();
		await restored;
		assert.deepEqual(context.service.getSessionPullRequests('session')[0].recordedReference, reference);
	});

	test('attaching verifies the PR and preserves its normalized identity without credentials', async () => {
		const writes: unknown[] = [];
		using context = fixture({ attachSessionPullRequest: async (sessionId, reference) => { writes.push({ sessionId, reference }); } });
		await assert.rejects(context.service.attachPullRequest('session', 'https://github.com/TEAM/Repo/pull/7/files'));
		await assert.rejects(context.service.attachPullRequest('session', 'https://user:secret@github.com/team/repo/pull/7'));
		assert.deepEqual(writes, []);
		await context.service.attachPullRequest('session', 'https://github.com/TEAM/Repo/pull/7?view=split#review');
		assert.deepEqual(writes, [{ sessionId: 'session', reference: { repository: { host: 'github.com', owner: 'team', name: 'repo' }, number: 7 } }]);
	});
	test('an Enterprise grant resolves Git remotes classified as other', async () => {
		using context = fixture({
			listAccounts: async () => [{ id: 'enterprise-account', host: 'ghe.example', login: 'user', status: 'ready', credentialRevision: 1n }],
			listPullRequests: async (repository, state, _page, _token, options) => {
				assert.deepEqual(repository, { accountId: 'enterprise-account', host: 'ghe.example', owner: 'team', name: 'repo' });
				assert.deepEqual(options, { head: 'team:feature' });
				return { items: state === GitHubIssueState.Open ? [pullRequest] : [], nextPage: null };
			},
			readPullRequest: async () => ({ ...pullRequest, url: 'https://ghe.example/team/repo/pull/7' }),
		}, {
			graph: async () => ({ commits: [], references: [], remotes: [{ name: 'origin', identity: { provider: 'other', host: 'ghe.example', owner: 'team', repository: 'repo' } }], hasMore: false, nextCursor: undefined }),
		});
		assert.deepEqual((await context.load()).map(request => request.uri.toString()), ['https://ghe.example/team/repo/pull/7']);
	});
	test('reads all pages before choosing the attention icon and preserves every reason', async () => {
		const reads: string[] = [];
		using context = fixture({
			listPullRequests: async (_repository, _state, page, _token, options) => {
				assert.deepEqual(options, { head: 'team:feature' });
				reads.push(`pulls:${page}`);
				return { items: page === 1 ? [{ ...pullRequest, headRepository: 'other/repo' }] : [pullRequest], nextPage: page === 1 ? 2 : null };
			},
			readPullRequest: async () => ({ ...pullRequest, mergeable: false }),
			readChecks: async (_repository, _commit, page) => {
				reads.push(`checks:${page}`);
				return { state: 'pending', statuses: [{ context: 'build', state: page === 1 ? 'pending' : 'failure', description: null, targetUrl: null }], checks: [], nextPage: page === 1 ? 2 : null };
			},
			listReviewThreads: async (_repository, _number, cursor) => {
				reads.push(`threads:${cursor}`);
				return { threads: cursor === null ? [] : [{ id: 'thread', path: 'file', line: 1, side: 'RIGHT', resolved: false, outdated: true, canResolve: true, comments: { comments: [], nextCursor: null } }], nextCursor: cursor === null ? 'second' : null } as Awaited<ReturnType<IGitHubService['listReviewThreads']>>;
			},
		});
		const result = await context.load();
		assert.deepEqual(result.map(request => ({ number: request.number, state: request.state, icon: request.icon.id, status: request.status })), [{ number: 7, state: 'open', icon: 'git-pull-request-error', status: { hasMergeConflicts: true, hasFailingChecks: true, hasUnresolvedComments: true } }]);
		assert.deepEqual(reads.sort(), ['checks:1', 'checks:2', 'pulls:1', 'pulls:2', 'threads:null', 'threads:second']);
	});

	test('a closed or merged branch PR is resolved when there is no open match', async () => {
		using context = fixture({
			listPullRequests: async (_repository, state) => ({ items: state === GitHubIssueState.Closed ? [pullRequest] : [], nextPage: null }),
			readPullRequest: async () => ({ ...pullRequest, state: 'closed', mergedAt: '2026-10-06', mergeable: false }),
			readChecks: async () => { throw new Error('Terminal PRs do not need checks'); },
			listReviewThreads: async () => { throw new Error('Terminal PRs do not need review threads'); },
		});
		assert.deepEqual((await context.load()).map(request => [request.state, request.icon.id, request.status]), [['merged', 'git-pull-request-done', {}]]);
	});

	test('a branch change removes the previous PR before the new lookup completes', async () => {
		const started = new DeferredPromise<void>();
		const pending = new DeferredPromise<GitHubPullRequest>();
		let reads = 0;
		using context = fixture({
			readPullRequest: async () => {
				if (++reads === 1) { return pullRequest; }
				await started.complete();
				return pending.p;
			}
		});
		await context.load();
		context.statusChanged.fire({ ...context.status, head: { type: 'branch', name: 'another-branch', objectId: 'b'.repeat(40), upstream: undefined } });
		assert.deepEqual(context.service.getSessionPullRequests('session'), []);
		await started.p;
		context.select(undefined);
		await pending.complete(pullRequest);
		// Account invalidation is synchronous, including requests that already reached the API.
		context.accountChanged.fire({ revision: 2n, accounts: [] });
		assert.deepEqual(context.service.getSessionPullRequests('session'), []);
	});

	test('an old account response cannot republish private PR data', async () => {
		const started = new DeferredPromise<CancellationToken>();
		const pending = new DeferredPromise<GitHubPullRequest>();
		let signedIn = true;
		using context = fixture({
			listAccounts: async () => signedIn ? [{ id: 'account', host: 'github.com', login: 'user', status: 'ready', credentialRevision: 1n }] : [],
			readPullRequest: async (_repository, _number, token) => { await started.complete(token!); return pending.p; },
		});
		context.service.initialize();
		const token = await started.p;
		signedIn = false;
		context.accountChanged.fire({ revision: 2n, accounts: [] });
		assert.equal(token.isCancellationRequested, true);
		const refreshed = context.nextChange();
		await pending.complete(pullRequest);
		await refreshed;
		assert.deepEqual(context.service.getSessionPullRequests('session'), []);
	});

	test('disposing the owner cancels the in-flight GitHub request', async () => {
		const started = new DeferredPromise<CancellationToken>();
		const pending = new DeferredPromise<GitHubPullRequest>();
		using context = fixture({ readPullRequest: async (_repository, _number, token) => { await started.complete(token!); return pending.p; } });
		context.service.initialize();
		const token = await started.p;
		context.service.dispose();
		assert.equal(token.isCancellationRequested, true);
		await pending.complete(pullRequest);
	});
});
