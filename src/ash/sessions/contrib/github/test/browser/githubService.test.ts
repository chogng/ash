import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import type { ISCMService } from '../../../../../workbench/contrib/scm/common/scm.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { mock } from 'node:test';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { IAccountService, AccountState } from '../../../../../platform/accounts/common/accountService.js';
import { GitHubIssueState, type IGitHubService, type GitHubPullRequest } from '../../../../../platform/github/common/githubService.js';
import { NullLoggerService } from '../../../../../platform/log/common/log.js';
// Fixtures expose the public repository-context command consumed by GitHub, independently of Git's runtime.
interface GitRepository {
	id: string;
	label: string;
	path: string;
	root: URI;
}
interface GitStatus {
	repositoryId: string;
	streamInstanceId: string;
	historyRevision: number;
	revision: number;
	workspacePath: string;
	head: { type: 'branch'; name: string; objectId: string; upstream: undefined };
	changes: readonly unknown[];
}
interface RepositoryCommandsFixture {
	repositories: GitRepository[];
	status(repositoryId?: string): Promise<GitStatus>;
	graph(
		query?: unknown,
		repositoryId?: string,
	): Promise<{
		remotes: readonly {
			name: string;
			identity: { provider: string; host: string; owner: string; repository: string };
		}[];
	}>;
	onDidChangeRepositories: Event<readonly GitRepository[]>;
	onDidChangeRepositoryStatus: Event<GitStatus>;
}
import type { ISessionsService, SessionsViewSelection } from '../../../../services/sessions/browser/sessionsService.js';
import type { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import type { ISession } from '../../../../services/sessions/common/session.js';
import { GitHubService } from '../../browser/githubService.js';
import { createDisconnectedRendererApi } from '../../../../../workbench/browser/rendererApi.js';
import type { IRendererHost } from '../../../../../platform/renderer/common/rendererHost.js';
import type { ISessionProviderScope, ISessionProviderScopeService, SessionProviderServices } from '../../../../browser/agentHost/sessionProviderScopeService.js';
import { parseSessionIdentity, sessionIdentity } from '../../../../services/sessions/common/sessionIdentity.js';
import { CancellationError } from '../../../../../base/common/errors.js';

const session: ISession = {
	sessionId: 'session',
	title: 'PR work',
	status: 'active',
	workspace: { authorityId: 'local', root: '/work' },
	nextApprovalMode: 'manual',
	chats: [{ threadId: 'thread', origin: { type: 'root' }, status: 'active' }],
};
const pullRequest: GitHubPullRequest = {
	number: 7,
	title: 'Branch work',
	body: '',
	url: 'https://github.com/team/repo/pull/7',
	state: 'open',
	draft: false,
	mergedAt: null,
	mergeable: null,
	headCommit: 'a'.repeat(40),
	headBranch: 'feature',
	headRepository: 'team/repo',
	baseBranch: 'main',
	autoMerge: false,
};

function fixture(overrides: Partial<IGitHubService> = {}, gitOverrides: Partial<RepositoryCommandsFixture> = {}) {
	const resources = new DisposableStore();
	const selectionChanged = resources.add(new Emitter<void>());
	const repositoriesChanged = resources.add(new Emitter<readonly GitRepository[]>());
	const statusChanged = resources.add(new Emitter<GitStatus>());
	const accountChanged = resources.add(new Emitter<AccountState>());
	let selection: SessionsViewSelection | undefined = { kind: 'session', active: { session, threadId: 'thread' } };
	const repository: GitRepository = { id: 'repo', label: 'repo', path: '', root: URI.file('/work') };
	const status: GitStatus = {
		repositoryId: 'repo',
		streamInstanceId: 'stream',
		historyRevision: 1,
		revision: 1,
		workspacePath: '/work',
		head: { type: 'branch', name: 'feature', objectId: 'a'.repeat(40), upstream: undefined },
		changes: [],
	};
	const github = {
		onDidChangeSessionPullRequests: Event.None,
		onDidChangeSessionIssues: Event.None,
		listSessionIssues: async () => [],
		listSessionPullRequests: async () => [],
		listAccounts: async () => [{ id: 'account', host: 'github.com', login: 'user', status: 'ready', credentialRevision: 1n }],
		listPullRequests: async (_repository, state) => ({
			items: state === GitHubIssueState.Open ? [pullRequest] : [],
			nextPage: null,
		}),
		readPullRequest: async () => pullRequest,
		readChecks: async () => ({ state: 'success', statuses: [], checks: [], nextPage: null }),
		listReviewThreads: async () => ({ threads: [], nextCursor: null }),
		...overrides,
	} as IGitHubService;
	const git = {
		repositories: [repository],
		onDidChangeRepositories: repositoriesChanged.event,
		onDidChangeRepositoryStatus: statusChanged.event,
		status: async () => status,
		graph: async () => ({
			commits: [],
			references: [],
			remotes: [
				{
					name: 'origin',
					identity: { provider: 'github', host: 'github.com', owner: 'team', repository: 'repo' },
				},
			],
			hasMore: false,
			nextCursor: undefined,
		}),
		...gitOverrides,
	} as RepositoryCommandsFixture;
	resources.add(statusChanged.event(value => Object.assign(status, value)));
	resources.add(CommandsRegistry.register('git.getRepositoryContexts', () => {}));
	const scm = {
		onDidAddRepository: repositoriesChanged.event,
		onDidRemoveRepository: Event.None,
		get repositories() {
			return git.repositories.map(repository => ({
				provider: { id: repository.id, onDidChangeResources: statusChanged.event },
			}));
		},
	} as unknown as ISCMService;
	const hostEvents = resources.add(new Emitter<Parameters<Parameters<IRendererHost['events']['subscribe']>[0]>[0]>());
	resources.add(accountChanged.event(() => hostEvents.fire({ method: 'account/updated', params: {} } as never)));
	const scopeChanges = resources.add(new Emitter<void>());
	const hostScopes = new Map<string, ISessionProviderScope>();
	const catalog: ISession[] = [session];
	const base = createDisconnectedRendererApi();
	const host: IRendererHost = {
		...base,
		github,
		events: { subscribe: hostEvents.event },
		localGit: {
			...base.localGit,
			readRepositoryContexts: async () =>
				Promise.all(
					git.repositories.map(async repository => ({
						id: repository.id,
						label: repository.label,
						path: repository.path,
						rootPath: repository.root.fsPath,
						head: (await git.status(repository.id)).head,
						remotes: (await git.graph({ limit: 1 }, repository.id)).remotes,
					})),
				),
		},
	};
	const addHost = (providerId: string, api: IRendererHost): ISessionProviderScope => {
		const scope: ISessionProviderScope = {
			providerId,
			services: { host: api } as SessionProviderServices,
			thread: api.thread,
			identity: value => sessionIdentity(providerId, value, 'primary'),
			backendIdentity: value => {
				const parsed = parseSessionIdentity(value, 'primary');
				if (parsed.providerId !== providerId) throw new CancellationError();
				return parsed.backendSessionId;
			},
			assertCurrent: () => {
				if (hostScopes.get(providerId) !== scope) throw new CancellationError();
			},
		};
		hostScopes.set(providerId, scope);
		scopeChanges.fire();
		return scope;
	};
	addHost('primary', host);
	const scopes = {
		onDidChangeScopes: scopeChanges.event,
		getScopes: () => [...hostScopes.values()],
		getScope: (sessionId: string) => {
			const scope = hostScopes.get(parseSessionIdentity(sessionId, 'primary').providerId);
			if (!scope) throw new CancellationError();
			return scope;
		},
	} as unknown as ISessionProviderScopeService;
	const service = resources.add(
		new GitHubService(
			{
				get activeSelection() {
					return selection;
				},
				onDidChange: selectionChanged.event,
			} as ISessionsService,
			{
				get sessions() {
					return catalog;
				},
			} as unknown as ISessionsManagementService,
			scm,
			scopes,
			new NullLoggerService(),
		),
	);
	const nextChange = (): Promise<void> =>
		new Promise(resolve => {
			const listener = resources.add(
				service.onDidChange(() => {
					listener.dispose();
					resolve();
				}),
			);
		});
	return {
		[Symbol.dispose]: () => resources.dispose(),
		service,
		status,
		host,
		catalog,
		addHost,
		removeHost: (id: string) => {
			hostScopes.delete(id);
			scopeChanges.fire();
		},
		statusChanged,
		accountChanged,
		nextChange,
		select: (value: SessionsViewSelection | undefined) => {
			selection = value;
			selectionChanged.fire();
		},
		load: async () => {
			const changed = nextChange();
			service.initialize();
			await changed;
			return service.getSessionPullRequests(session.sessionId);
		},
	};
}

suite('Session GitHub associations', () => {
	test('equal backend Session and repository IDs route through the owning host and preserve its remote workspace', async () => {
		const calls: string[] = [];
		using context = fixture({
			attachSessionPullRequest: async id => {
				calls.push(`primary:${id}`);
			},
		});
		const changed = new Emitter<string>();
		try {
			const host: IRendererHost = {
				...context.host,
				events: { subscribe: Event.None },
				github: {
					...context.host.github,
					onDidChangeSessionPullRequests: changed.event,
					listSessionPullRequests: async id => {
						calls.push(`remote:list:${id}`);
						return [];
					},
					attachSessionPullRequest: async id => {
						calls.push(`remote:attach:${id}`);
					},
					detachSessionPullRequest: async id => {
						calls.push(`remote:detach:${id}`);
					},
					readPullRequest: async () => ({ ...pullRequest, title: 'Remote branch' }),
				},
				localGit: {
					...context.host.localGit,
					readRepositoryContexts: async directory => {
						calls.push(`remote:repos:${directory.sessionId}:${directory.path}`);
						return [
							{
								id: 'repo',
								label: 'repo',
								path: '',
								rootPath: '/work',
								head: { type: 'branch', name: 'feature' },
								remotes: [
									{
										name: 'origin',
										identity: {
											provider: 'github',
											host: 'github.com',
											owner: 'team',
											repository: 'repo',
										},
									},
								],
							},
						];
					},
				},
			};
			const scope = context.addHost('remote', host);
			const remote = {
				...session,
				sessionId: scope.identity('session'),
				providerId: 'remote',
				workspace: { authorityId: 'ssh+build', root: '/work' },
			};
			context.catalog.push(remote);
			context.select({ kind: 'session', active: { session: remote, threadId: 'thread' } });
			await context.nextChange();
			assert.equal(context.service.getSessionPullRequests(remote.sessionId)[0]!.title, 'Remote branch');
			await context.service.attachPullRequest(remote.sessionId, pullRequest.url);
			await context.service.detachPullRequest(remote.sessionId, {
				repository: { host: 'github.com', owner: 'team', name: 'repo' },
				number: 7,
			});
			assert.ok(calls.includes('remote:list:session'));
			assert.ok(calls.includes('remote:repos:session:/work'));
			assert.ok(calls.includes('remote:attach:session'));
			assert.ok(calls.includes('remote:detach:session'));
			assert.equal(
				calls.some(call => call.startsWith('primary:')),
				false,
			);
		} finally {
			changed.dispose();
		}
	});

	test('retiring a captured host cancels a late attachment before its write and never falls back to the primary host', async () => {
		const started = new DeferredPromise<void>();
		const accounts = new DeferredPromise<Awaited<ReturnType<IGitHubService['listAccounts']>>>();
		const writes: string[] = [];
		using context = fixture({
			attachSessionPullRequest: async id => {
				writes.push(`primary:${id}`);
			},
		});
		const scope = context.addHost('remote', {
			...context.host,
			events: { subscribe: Event.None },
			github: {
				...context.host.github,
				listAccounts: () => {
					void started.complete();
					return accounts.p;
				},
				attachSessionPullRequest: async id => {
					writes.push(`remote:${id}`);
				},
			},
		});
		const attaching = context.service.attachPullRequest(scope.identity('session'), pullRequest.url);
		const rejected = assert.rejects(attaching, { name: 'CancellationError' });
		await started.p;
		context.removeHost('remote');
		await accounts.complete([{ id: 'account', host: 'github.com', login: 'user', status: 'ready', credentialRevision: 1n }]);
		await rejected;
		assert.deepEqual(writes, []);
		await assert.rejects(
			context.service.detachPullRequest(scope.identity('session'), {
				repository: { host: 'github.com', owner: 'team', name: 'repo' },
				number: 7,
			}),
			{ name: 'CancellationError' },
		);
	});

	test('an unrelated host account update does not cancel a captured remote attachment', async () => {
		const accounts = new DeferredPromise<Awaited<ReturnType<IGitHubService['listAccounts']>>>();
		const writes: string[] = [];
		using context = fixture();
		const scope = context.addHost('remote', {
			...context.host,
			events: { subscribe: Event.None },
			github: {
				...context.host.github,
				listAccounts: () => accounts.p,
				attachSessionPullRequest: async id => {
					writes.push(id);
				},
			},
		});
		const attaching = context.service.attachPullRequest(scope.identity('session'), pullRequest.url);
		context.accountChanged.fire({ revision: 2n, accounts: [] });
		await accounts.complete([{ id: 'account', host: 'github.com', login: 'user', status: 'ready', credentialRevision: 1n }]);
		await attaching;
		assert.deepEqual(writes, ['session']);
	});

	test('adding an unrelated provider cannot cancel an attachment already captured by another host', async () => {
		const accounts = new DeferredPromise<Awaited<ReturnType<IGitHubService['listAccounts']>>>();
		const writes: string[] = [];
		using context = fixture();
		const scope = context.addHost('remote', {
			...context.host,
			events: { subscribe: Event.None },
			github: {
				...context.host.github,
				listAccounts: () => accounts.p,
				attachSessionPullRequest: async id => {
					writes.push(id);
				},
			},
		});
		const attaching = context.service.attachPullRequest(scope.identity('session'), pullRequest.url);
		context.addHost('third', { ...context.host, events: { subscribe: Event.None } });
		await accounts.complete([{ id: 'account', host: 'github.com', login: 'user', status: 'ready', credentialRevision: 1n }]);
		await attaching;
		assert.deepEqual(writes, ['session']);
	});

	test('discovery merges equivalent PR links across remotes without rewriting the open URL', async () => {
		let reads = 0;
		const urls = ['https://github.com/TEAM/Repo/pull/7/', 'https://github.com/team/repo/pull/7'];
		using context = fixture(
			{
				readPullRequest: async () => ({ ...pullRequest, url: urls[reads++]! }),
			},
			{
				graph: async () => ({
					streamInstanceId: 'stream',
					historyRevision: 1,
					graphRevision: 1,
					commits: [],
					references: [],
					hasMore: false,
					nextCursor: undefined,
					remotes: [
						{
							name: 'origin',
							identity: { provider: 'github', host: 'github.com', owner: 'team', repository: 'repo' },
						},
						{
							name: 'upstream',
							identity: { provider: 'github', host: 'github.com', owner: 'team', repository: 'fork' },
						},
					],
				}),
			},
		);
		const requests = await context.load();
		assert.equal(reads, 2);
		assert.deepEqual(
			requests.map(request => request.uri.toString()),
			[urls[1]],
		);
	});

	test('Issue references verify access, reject other resource URLs, and normalize Enterprise identities', async () => {
		const writes: unknown[] = [];
		using context = fixture({
			listAccounts: async () => [{ id: 'enterprise', host: 'ghe.example', login: 'user', status: 'ready', credentialRevision: 1n }],
			readIssue: async (repository, number) => {
				assert.deepEqual(repository, {
					accountId: 'enterprise',
					host: 'ghe.example',
					owner: 'team',
					name: 'repo',
				});
				return { number } as never;
			},
			attachSessionIssue: async (sessionId, reference) => {
				writes.push({ sessionId, reference });
			},
		});
		for (const url of [
			'https://ghe.example/team/repo/pull/7',
			'http://ghe.example/team/repo/issues/7',
			'https://user:secret@ghe.example/team/repo/issues/7',
			'https://ghe.example/team/repo/issues/9007199254740992',
		]) {
			await assert.rejects(context.service.attachIssue('session', url));
		}
		assert.deepEqual(writes, []);
		await context.service.attachIssue('session', 'https://GHE.example/TEAM/Repo/issues/7?view=all#comment');
		assert.deepEqual(writes, [
			{
				sessionId: 'session',
				reference: { repository: { host: 'ghe.example', owner: 'team', name: 'repo' }, number: 7 },
			},
		]);
	});

	test('Issue associations remain removable without an account and never invent closed status', async () => {
		const reference = { repository: { host: 'github.com', owner: 'team', name: 'repo' }, number: 11 };
		const removals: unknown[] = [];
		using context = fixture({
			listAccounts: async () => [],
			listSessionIssues: async () => [reference],
			detachSessionIssue: async (sessionId, reference) => {
				removals.push({ sessionId, reference });
			},
		});
		await context.load();
		assert.deepEqual(
			context.service.getSessionIssues('session').map(entry => ({ reference: entry.reference, url: entry.uri.toString(), issue: entry.issue })),
			[{ reference, url: 'https://github.com/team/repo/issues/11', issue: undefined }],
		);
		await context.service.detachIssue('session', reference);
		assert.deepEqual(removals, [{ sessionId: 'session', reference }]);
	});

	test('one unavailable Issue cannot hide another Issue or an existing PR', async () => {
		const repository = { host: 'github.com', owner: 'team', name: 'repo' };
		using context = fixture({
			listSessionIssues: async () => [11, 12].map(number => ({ repository, number })),
			readIssue: async (_repository, number) => {
				if (number === 11) {
					throw new Error('Access removed');
				}
				return { title: 'Completed work', state: 'closed', stateReason: 'completed' } as never;
			},
		});
		const requests = await context.load();
		assert.equal(requests[0].number, 7);
		assert.deepEqual(
			context.service.getSessionIssues('session').map(entry => entry.issue?.state),
			[undefined, 'closed'],
		);
	});

	test('an unavailable Issue collection leaves PR discovery working', async () => {
		using context = fixture({
			listSessionIssues: async () => {
				throw new Error('Method unavailable');
			},
		});
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
			listAccounts: async () => (signedIn ? [{ id: 'account', host: 'github.com', login: 'user', status: 'ready', credentialRevision: 1n }] : []),
			readIssue: async (_repository, _number, token) => {
				await started.complete(token!);
				return pending.p;
			},
		});
		context.service.initialize();
		const token = await started.p;
		signedIn = false;
		context.accountChanged.fire({ revision: 2n, accounts: [] });
		assert.equal(token.isCancellationRequested, true);
		const refreshed = context.nextChange();
		await pending.complete({ title: 'Private title', state: 'closed' } as never);
		await refreshed;
		assert.deepEqual(
			context.service.getSessionIssues('session').map(entry => entry.issue),
			[undefined],
		);
	});

	test('a recorded PR with unavailable remote state remains removable without an invented PR state', async () => {
		const reference = { repository: { host: 'github.com', owner: 'team', name: 'repo' }, number: 7 };
		using context = fixture({
			listSessionPullRequests: async () => [reference],
			listPullRequests: async () => ({ items: [], nextPage: null }),
			readPullRequest: async () => {
				throw new Error('Access removed');
			},
		});
		const requests = await context.load();
		assert.equal(requests.length, 1);
		assert.equal(requests[0].state, 'unavailable');
		assert.deepEqual(requests[0].recordedReference, reference);
	});
	test('recorded PRs survive branch changes and duplicate discovery is merged', async () => {
		const reference = { repository: { host: 'github.com', owner: 'team', name: 'repo' }, number: 7 };
		let associated = true;
		using context = fixture({
			listSessionPullRequests: async () => [reference],
			listPullRequests: async () => ({ items: associated ? [pullRequest] : [], nextPage: null }),
		});
		const requests = await context.load();
		assert.equal(requests.length, 1);
		assert.deepEqual(requests[0].recordedReference, reference);
		associated = false;
		const changed = context.nextChange();
		context.statusChanged.fire({
			...context.status,
			head: { type: 'branch', name: 'another', objectId: 'b'.repeat(40), upstream: undefined },
		});
		await changed;
		const restored = context.nextChange();
		await restored;
		assert.deepEqual(context.service.getSessionPullRequests('session')[0].recordedReference, reference);
	});

	test('attaching verifies the PR and preserves its normalized identity without credentials', async () => {
		const writes: unknown[] = [];
		using context = fixture({
			attachSessionPullRequest: async (sessionId, reference) => {
				writes.push({ sessionId, reference });
			},
		});
		await assert.rejects(context.service.attachPullRequest('session', 'https://github.com/TEAM/Repo/pull/7/files'));
		await assert.rejects(context.service.attachPullRequest('session', 'https://user:secret@github.com/team/repo/pull/7'));
		assert.deepEqual(writes, []);
		await context.service.attachPullRequest('session', 'https://github.com/TEAM/Repo/pull/7?view=split#review');
		assert.deepEqual(writes, [
			{
				sessionId: 'session',
				reference: { repository: { host: 'github.com', owner: 'team', name: 'repo' }, number: 7 },
			},
		]);
	});
	test('an Enterprise grant resolves Git remotes classified as other', async () => {
		using context = fixture(
			{
				listAccounts: async () => [
					{
						id: 'enterprise-account',
						host: 'ghe.example',
						login: 'user',
						status: 'ready',
						credentialRevision: 1n,
					},
				],
				listPullRequests: async (repository, state, _page, _token, options) => {
					assert.deepEqual(repository, {
						accountId: 'enterprise-account',
						host: 'ghe.example',
						owner: 'team',
						name: 'repo',
					});
					assert.deepEqual(options, { head: 'team:feature' });
					return { items: state === GitHubIssueState.Open ? [pullRequest] : [], nextPage: null };
				},
				readPullRequest: async () => ({ ...pullRequest, url: 'https://ghe.example/team/repo/pull/7' }),
			},
			{
				graph: async () => ({
					streamInstanceId: 'stream',
					historyRevision: 1,
					graphRevision: 1,
					commits: [],
					references: [],
					remotes: [
						{
							name: 'origin',
							identity: { provider: 'other', host: 'ghe.example', owner: 'team', repository: 'repo' },
						},
					],
					hasMore: false,
					nextCursor: undefined,
				}),
			},
		);
		assert.deepEqual(
			(await context.load()).map(request => request.uri.toString()),
			['https://ghe.example/team/repo/pull/7'],
		);
	});
	test('reads all pages before choosing the attention icon and preserves every reason', async () => {
		const reads: string[] = [];
		using context = fixture({
			listPullRequests: async (_repository, _state, page, _token, options) => {
				assert.deepEqual(options, { head: 'team:feature' });
				reads.push(`pulls:${page}`);
				return {
					items: page === 1 ? [{ ...pullRequest, headRepository: 'other/repo' }] : [pullRequest],
					nextPage: page === 1 ? 2 : null,
				};
			},
			readPullRequest: async () => ({ ...pullRequest, mergeable: false }),
			readChecks: async (_repository, _commit, page) => {
				reads.push(`checks:${page}`);
				return {
					state: 'pending',
					statuses: [
						{
							context: 'build',
							state: page === 1 ? 'pending' : 'failure',
							description: null,
							targetUrl: null,
						},
					],
					checks: [],
					nextPage: page === 1 ? 2 : null,
				};
			},
			listReviewThreads: async (_repository, _number, cursor) => {
				reads.push(`threads:${cursor}`);
				return {
					threads:
						cursor === null
							? []
							: [
									{
										id: 'thread',
										path: 'file',
										line: 1,
										side: 'RIGHT',
										resolved: false,
										outdated: true,
										canResolve: true,
										comments: { comments: [], nextCursor: null },
									},
								],
					nextCursor: cursor === null ? 'second' : null,
				} as Awaited<ReturnType<IGitHubService['listReviewThreads']>>;
			},
		});
		const result = await context.load();
		assert.deepEqual(
			result.map(request => ({
				number: request.number,
				state: request.state,
				icon: request.icon.id,
				status: request.status,
			})),
			[
				{
					number: 7,
					state: 'open',
					icon: 'git-pull-request-error',
					status: { hasMergeConflicts: true, hasFailingChecks: true, hasUnresolvedComments: true },
				},
			],
		);
		assert.deepEqual(reads.sort(), ['checks:1', 'checks:2', 'pulls:1', 'pulls:2', 'threads:null', 'threads:second']);
	});

	test('a closed or merged branch PR is resolved when there is no open match', async () => {
		using context = fixture({
			listPullRequests: async (_repository, state) => ({
				items: state === GitHubIssueState.Closed ? [pullRequest] : [],
				nextPage: null,
			}),
			readPullRequest: async () => ({
				...pullRequest,
				state: 'closed',
				mergedAt: '2026-10-06',
				mergeable: false,
			}),
			readChecks: async () => {
				throw new Error('Terminal PRs do not need checks');
			},
			listReviewThreads: async () => {
				throw new Error('Terminal PRs do not need review threads');
			},
		});
		assert.deepEqual(
			(await context.load()).map(request => [request.state, request.icon.id, request.status]),
			[['merged', 'git-pull-request-done', {}]],
		);
	});

	test('an ordinary SCM refresh preserves branch PRs while their remote state is loading', async () => {
		const started = new DeferredPromise<void>();
		const pending = new DeferredPromise<GitHubPullRequest>();
		let reads = 0;
		using context = fixture({
			readPullRequest: async () => {
				if (++reads === 1) {
					return pullRequest;
				}
				await started.complete();
				return pending.p;
			},
		});
		await context.load();
		const before = context.service.getSessionPullRequests('session');
		context.statusChanged.fire({ ...context.status, revision: 2 });
		await started.p;
		assert.equal(context.service.getSessionPullRequests('session'), before);
		context.select(undefined);
		await pending.complete(pullRequest);
	});

	test('a branch change removes the previous PR before the new lookup completes', async () => {
		const started = new DeferredPromise<void>();
		const pending = new DeferredPromise<GitHubPullRequest>();
		let reads = 0;
		using context = fixture({
			listPullRequests: async (_repository, state, _page, _token, filter) => ({
				items: state === GitHubIssueState.Open ? [{ ...pullRequest, headBranch: filter?.head?.split(':')[1] ?? 'feature' }] : [],
				nextPage: null,
			}),
			readPullRequest: async () => {
				if (++reads === 1) {
					return pullRequest;
				}
				await started.complete();
				return pending.p;
			},
		});
		await context.load();
		const invalidated = context.nextChange();
		context.statusChanged.fire({
			...context.status,
			head: { type: 'branch', name: 'another-branch', objectId: 'b'.repeat(40), upstream: undefined },
		});
		await invalidated;
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
			listAccounts: async () => (signedIn ? [{ id: 'account', host: 'github.com', login: 'user', status: 'ready', credentialRevision: 1n }] : []),
			readPullRequest: async (_repository, _number, token) => {
				await started.complete(token!);
				return pending.p;
			},
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

	test('coalesces session refreshes until canceled GitHub requests retire', async () => {
		const referencesChanged = new Emitter<string>();
		const pending = new DeferredPromise<Awaited<ReturnType<IGitHubService['listAccounts']>>>();
		let reads = 0;
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			using context = fixture({
				onDidChangeSessionPullRequests: referencesChanged.event,
				listAccounts: async () => {
					reads++;
					return reads === 1 ? pending.p : [];
				},
			});
			context.service.initialize();
			mock.timers.tick(0);
			assert.equal(reads, 1);
			// Deliver notifications in separate scheduler turns while transport cancellation is pending.
			for (let notification = 0; notification < 150; notification++) {
				referencesChanged.fire('session');
				mock.timers.tick(0);
			}
			assert.equal(reads, 1);
			const refreshed = context.nextChange();
			await pending.complete([]);
			await yieldEventLoop();
			mock.timers.tick(0);
			await refreshed;
			assert.equal(reads, 2);
			assert.deepEqual(context.service.getSessionPullRequests('session'), []);
		} finally {
			mock.timers.reset();
			referencesChanged.dispose();
			if (!pending.isSettled) await pending.complete([]);
		}
	});

	test('disposing the owner cancels the in-flight GitHub request', async () => {
		const started = new DeferredPromise<CancellationToken>();
		const pending = new DeferredPromise<GitHubPullRequest>();
		using context = fixture({
			readPullRequest: async (_repository, _number, token) => {
				await started.complete(token!);
				return pending.p;
			},
		});
		context.service.initialize();
		const token = await started.p;
		context.service.dispose();
		assert.equal(token.isCancellationRequested, true);
		await pending.complete(pullRequest);
	});
});

suite('sessionGitHub browser component', () => {
	const browserTests = useBrowserTests();
	test('branch PRs share state across composer and sidebar, retain focus, and open with Enter', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => {
			errors.push(error.message);
			console.error(error.stack);
		});
		page.on('console', message => {
			if (message.type() === 'error') {
				console.error(message.text());
			}
		});
		await page.goto('/sessionGitHub.html');
		const pills = page.locator('.ash-session-chat-input-pr');
		const first = pills.filter({ hasText: 'one #7' });
		const sidebar = page.locator('.ash-sessions-list-item');
		await expect(pills).toHaveCount(2);
		await expect(first).toHaveAccessibleName(/Changes in one · Open/);
		await expect(sidebar.locator('[data-ash-icon-id="git-pull-request"]')).toHaveCount(1);
		await expect.poll(() => pills.locator('.ash-icon').evaluateAll(elements => elements.map(element => element.getAttribute('aria-hidden')))).toEqual(['true', 'true']);
		await first.focus();
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashSessionGitHub.opened)).toEqual(['https://github.com/team/one/pull/7']);
		await page.evaluate(() => window.ashSessionGitHub.setAttention('comments'));
		await expect(first).toHaveAccessibleName(/Unresolved review comments/);
		await expect(sidebar.locator('[data-ash-icon-id="git-pull-request-comment"]')).toHaveCount(1);
		await expect(first).toBeFocused();
		await page.evaluate(() => window.ashSessionGitHub.setAttention('checks'));
		await expect(first).toHaveAccessibleName(/Checks failed/);
		await expect(sidebar.locator('[data-ash-icon-id="git-pull-request-error"]')).toHaveCount(1);
		await expect(first).toBeFocused();
		await page.evaluate(() => window.ashSessionGitHub.setAttention('conflicts'));
		await expect(first).toHaveAccessibleName(/Merge conflicts/);
		await expect(first).toBeFocused();
		await page.evaluate(() => window.ashSessionGitHub.setState('merged'));
		await expect(first).toHaveAccessibleName(/Merged$/);
		await expect(first.locator('[data-ash-icon-id="git-pull-request-done"]')).toHaveCount(1);
		await expect(sidebar.locator('[data-ash-icon-id="git-pull-request-draft"]')).toHaveCount(1);
		await expect(first).toBeFocused();
		await page.evaluate(() => window.ashSessionGitHub.theme('light'));
		await expect(first.locator('span').first()).toHaveCSS('color', 'rgb(101, 45, 144)');
		await page.evaluate(() => window.ashSessionGitHub.theme('hc'));
		await expect(first).toHaveCSS('outline-style', 'solid');
		await expect(first).toHaveCSS('min-height', '28px');
		expect(await first.evaluate(element => element.getBoundingClientRect().right <= element.parentElement!.getBoundingClientRect().right)).toBe(true);
		await page.evaluate(() => window.ashSessionGitHub.changeBranch());
		await expect(pills).toHaveCount(0);
		await expect(sidebar.locator('.ash-sessions-list-pr')).toBeHidden();
		await page.evaluate(() => window.ashSessionGitHub.dispose());
		await expect(page.locator('.ash-session-chat-input-prs')).toHaveCount(0);
		expect(errors).toEqual([]);
	});

	test('signing out clears private PR labels in both surfaces', async function () {
		const { page } = browserTests;

		await page.goto('/sessionGitHub.html');
		await expect(page.locator('.ash-session-chat-input-pr')).toHaveCount(2);
		await page.evaluate(() => window.ashSessionGitHub.signOut());
		await expect(page.locator('.ash-session-chat-input-pr')).toHaveCount(0);
		await expect(page.locator('.ash-sessions-list-item')).not.toHaveAccessibleName(/Changes in/);
	});

	test('Chinese attention labels reach the composer and session list', async function () {
		const { page } = browserTests;

		await page.goto('/sessionGitHub.html?locale=zh-CN');
		await expect(page.getByRole('group', { name: '会话 GitHub 关联' })).toBeVisible();
		const pr = page.locator('.ash-session-chat-input-pr').filter({ hasText: 'one #7' });
		for (const [attention, label] of [
			['comments', '未解决的审查评论'],
			['checks', '检查未通过'],
			['conflicts', '合并冲突'],
		] as const) {
			await page.evaluate(attention => window.ashSessionGitHub.setAttention(attention), attention);
			await expect(pr).toHaveAccessibleName(new RegExp(label));
			await expect(page.locator('.ash-sessions-list-item')).toHaveAccessibleName(new RegExp(label));
		}
	});

	test('manual attachments deduplicate, survive reopening and branch changes, and can be removed with the keyboard', async function () {
		const { page } = browserTests;

		await page.goto('/sessionGitHub.html');
		const attach = page.getByRole('button', { name: 'Attach PR', exact: true });
		await expect(page.locator('.ash-session-chat-input-pr')).toHaveCount(2);
		await attach.focus();
		await page.keyboard.press('Enter');
		const dialog = page.getByRole('dialog', { name: 'Attach a pull request to this session' });
		await expect(dialog).toBeVisible();
		await dialog.getByRole('textbox').fill('https://github.com/TEAM/one/pull/7#discussion');
		await page.keyboard.press('Enter');
		const remove = page.getByRole('button', { name: 'Remove attached pull request team/one #7' });
		await expect(remove).toBeVisible();
		await expect(page.locator('.ash-session-chat-input-pr')).toHaveCount(2);
		await expect(attach).toBeFocused();
		await page.reload();
		await expect(remove).toBeVisible();
		await page.evaluate(() => window.ashSessionGitHub.changeBranch());
		await expect(page.locator('.ash-session-chat-input-pr')).toHaveCount(1);
		await expect(remove).toBeVisible();
		await page.goto('/sessionGitHub.html?noWorkspace');
		await expect(page.locator('.ash-session-chat-input-pr')).toHaveCount(1);
		await expect(remove).toBeVisible();
		await remove.focus();
		await page.keyboard.press('Enter');
		await expect(page.locator('.ash-session-chat-input-pr')).toHaveCount(0);
		await expect(attach).toBeFocused();
		await page.reload();
		await expect(remove).toHaveCount(0);
	});

	test('Chinese attach input supports cancellation and restores focus', async function () {
		const { page } = browserTests;

		await page.goto('/sessionGitHub.html?locale=zh-CN');
		const attach = page.getByRole('button', { name: '附加 PR', exact: true });
		await attach.focus();
		await page.keyboard.press('Enter');
		const dialog = page.getByRole('dialog', { name: '将拉取请求附加到此会话' });
		await expect(dialog).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect(attach).toBeFocused();
		expect(await page.evaluate(() => window.ashSessionGitHub.requests.filter(request => request.method === 'github/session/pullRequest/attach'))).toHaveLength(0);
	});

	test('removing a manual attachment retains its current branch association', async function () {
		const { page } = browserTests;

		await page.goto('/sessionGitHub.html');
		await expect(page.locator('.ash-session-chat-input-pr')).toHaveCount(2);
		await page.getByRole('button', { name: 'Attach PR', exact: true }).click();
		await page.getByRole('dialog').getByRole('textbox').fill('https://github.com/team/one/pull/7');
		await page.keyboard.press('Enter');
		const remove = page.getByRole('button', { name: 'Remove attached pull request team/one #7' });
		await expect(remove).toBeVisible();
		await remove.click();
		await expect(remove).toHaveCount(0);
		await expect(page.locator('.ash-session-chat-input-pr')).toHaveCount(2);
		await expect(page.locator('.ash-session-chat-input-pr').filter({ hasText: 'one #7' })).toHaveAccessibleName(/Open$/);
		await page.reload();
		await expect(remove).toHaveCount(0);
		await expect(page.locator('.ash-session-chat-input-pr')).toHaveCount(2);
	});

	test('Session PR review opens the shared editor without posting a review', async function () {
		const { page } = browserTests;

		await page.goto('/sessionGitHub.html');
		const review = page.getByRole('button', { name: 'Review pull request team/one #7 in Ash', exact: true });
		await expect(review).toBeVisible();
		await review.click();
		expect(await page.evaluate(() => window.ashSessionGitHub.opened)).toContain('ash-github://github.com/team/one/pull/7');
		expect(await page.evaluate(() => window.ashSessionGitHub.requests.some(request => request.method === 'github/comment/create'))).toBe(false);
	});

	async function attachIssue(page: import('@playwright/test').Page, number: number): Promise<void> {
		await page.getByRole('button', { name: 'Attach issue', exact: true }).click();
		await page.getByRole('dialog', { name: 'Attach an issue to this session' }).getByRole('textbox').fill(`https://github.com/TEAM/one/issues/${number}`);
		await page.keyboard.press('Enter');
		await expect(page.getByRole('dialog')).toHaveCount(0);
	}

	test('multiple issues restore, deduplicate, aggregate live states and retain keyboard focus', async function () {
		const { page } = browserTests;

		await page.goto('/sessionGitHub.html?noWorkspace');
		await attachIssue(page, 11);
		await attachIssue(page, 12);
		await attachIssue(page, 11);
		const summary = page.locator('.ash-session-chat-input-issue-summary');
		await expect(summary).toHaveAccessibleName('2 issues · 1 open · 1 closed · 0 unavailable');
		await expect(summary.locator('[data-ash-icon-id="issue-opened"]')).toHaveCount(1);
		await page.reload();
		await expect(summary).toHaveAccessibleName('2 issues · 1 open · 1 closed · 0 unavailable');
		await summary.focus();
		await page.keyboard.press('Enter');
		await expect(summary).toHaveAttribute('aria-expanded', 'true');
		const issue = page.locator('.ash-session-chat-input-issue[href$="/11"]');
		await issue.focus();
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashSessionGitHub.opened)).toContain('https://github.com/team/one/issues/11');
		await page.evaluate(() => window.ashSessionGitHub.setIssueState(11, 'closed', 'completed'));
		await expect(summary).toHaveAccessibleName('2 issues · 0 open · 2 closed · 0 unavailable');
		await expect(summary.locator('[data-ash-icon-id="issue-closed"]')).toHaveCount(1);
		await expect(issue).toBeFocused();
		await expect(issue).toHaveAccessibleName(/Completed$/);
		await page.evaluate(() => window.ashSessionGitHub.setIssueState(11, 'closed', 'not_planned'));
		await page.evaluate(() => window.ashSessionGitHub.setIssueState(12, 'closed', 'duplicate'));
		await expect(summary.locator('span').first()).toHaveCSS('color', 'rgb(184, 184, 184)');
		await page.evaluate(() => window.ashSessionGitHub.setIssueState(11, 'future'));
		await expect(summary).toHaveAccessibleName('2 issues · 0 open · 1 closed · 1 unavailable');
		await expect(issue.locator('[data-ash-icon-id="issue-opened"]')).toHaveCount(1);
		await expect(issue).toHaveAccessibleName(/Status unavailable$/);
		await page.evaluate(() => window.ashSessionGitHub.setIssueState(11, 'unavailable'));
		await expect(summary).toHaveAccessibleName('2 issues · 0 open · 1 closed · 1 unavailable');
		await expect(summary.locator('[data-ash-icon-id="issue-opened"]')).toHaveCount(1);
		await expect(issue).toHaveAccessibleName(/Status unavailable$/);
		await expect(issue).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(summary).toBeFocused();
		await expect(summary).toHaveAttribute('aria-expanded', 'false');
		await page.keyboard.press('Space');
		const remove = page.getByRole('button', { name: 'Remove attached issue github.com/team/one #11', exact: true });
		await remove.focus();
		await page.keyboard.press('Enter');
		await expect(summary).toHaveAccessibleName('1 issues · 0 open · 1 closed · 0 unavailable');
		await expect(page.getByRole('button', { name: 'Attach issue', exact: true })).toBeFocused();
		await page.reload();
		await expect(summary).toHaveAccessibleName('1 issues · 0 open · 1 closed · 0 unavailable');
		expect(await page.evaluate(() => window.ashSessionGitHub.requests.some(request => request.method === 'github/issue/update'))).toBe(false);
	});

	test('Issue labels translate and survive narrow layout, theme changes and account invalidation', async function () {
		const { page } = browserTests;

		await page.goto('/sessionGitHub.html?noWorkspace');
		await attachIssue(page, 11);
		await page.goto('/sessionGitHub.html?noWorkspace&locale=zh-CN');
		const summary = page.locator('.ash-session-chat-input-issue-summary');
		await expect(summary).toHaveAccessibleName('1 个 Issue · 1 个开放 · 0 个关闭 · 0 个状态不可用');
		await summary.click();
		const issue = page.locator('.ash-session-chat-input-issue');
		await expect(issue).toHaveAccessibleName(/打开$/);
		await page.evaluate(() => window.ashSessionGitHub.theme('light'));
		await expect(summary.locator('span').first()).toHaveCSS('color', 'rgb(16, 124, 16)');
		await page.evaluate(() => window.ashSessionGitHub.theme('hc'));
		await summary.focus();
		await page.keyboard.press('Tab');
		await expect(issue).toBeFocused();
		await expect(issue).toHaveCSS('outline-style', 'solid');
		expect(await issue.evaluate(element => element.getBoundingClientRect().right <= element.parentElement!.getBoundingClientRect().right)).toBe(true);
		await page.evaluate(() => window.ashSessionGitHub.signOut());
		await expect(issue).toHaveAccessibleName(/状态不可用$/);
		await expect(issue).not.toHaveAccessibleName(/long title/);
		const attach = page.getByRole('button', { name: '附加 Issue', exact: true });
		await attach.focus();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('dialog', { name: '将 Issue 附加到此会话' })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(attach).toBeFocused();
		await page.evaluate(() => window.ashSessionGitHub.dispose());
		await expect(page.locator('.ash-session-chat-input-issues')).toHaveCount(0);
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`PR follow-up persists its source, stops from the keyboard and opens history in ${locale}`, async function () {
			const { page } = browserTests;
			const zh = locale === 'zh-CN';
			await page.goto(`/sessionGitHub.html?checks&locale=${locale}`);
			const group = page.locator('.ash-sessions-follow-up').getByRole('group', { name: 'team/one #7', exact: true });
			const start = group.getByRole('button', { name: zh ? '跟进 PR 检查' : 'Follow PR checks', exact: true });
			await expect(start).toBeVisible();
			await start.focus();
			await start.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashSessionGitHub.requests.filter(request => request.method === 'automation/write').length)).toBe(1);
			const stopName = zh ? '停止 PR 跟进' : 'Stop PR follow-up';
			await expect(group.getByRole('button', { name: stopName, exact: true })).toHaveAttribute('aria-pressed', 'true');
			const writes = await page.evaluate(() => window.ashSessionGitHub.requests.filter(request => request.method === 'automation/write'));
			expect(writes).toHaveLength(1);
			const definition = writes[0]!.params.definition as Record<string, unknown>;
			expect(definition.session).toEqual({ type: 'continue', sessionId: 'session', threadId: 'thread' });
			expect(definition.directory).toBe('/workspace');
			expect(definition.condition).toEqual({
				type: 'gitHubChecks',
				host: 'github.com',
				owner: 'team',
				repository: 'one',
				number: 7,
				accountId: 'account',
				credentialRevision: '1',
			});
			expect(await page.evaluate(() => window.ashSessionGitHub.submissions)).toEqual([]);
			await page.reload();
			const restored = group.getByRole('button', { name: stopName, exact: true });
			await expect(restored).toBeVisible();
			await restored.focus();
			await restored.press('Enter');
			await expect(group.getByRole('button', { name: zh ? '跟进 PR 检查' : 'Follow PR checks', exact: true })).toHaveAttribute('aria-pressed', 'false');
			const stopped = await page.evaluate(() => window.ashSessionGitHub.requests.filter(request => request.method === 'automation/write'));
			expect(stopped).toHaveLength(1);
			expect(stopped[0]!.params.status).toBe('paused');
			expect(stopped[0]!.params.expectedRevision).toBe(1);
			const history = group.getByRole('button', { name: zh ? '跟进历史' : 'Follow-up history', exact: true });
			await history.focus();
			await history.press('Enter');
			await expect(page.locator('body')).toHaveAttribute('data-opened-view', 'sessions.customView.automations');
			await page.evaluate(() => window.ashSessionGitHub.dispose());
			await expect(page.locator('.ash-sessions-follow-up')).toHaveCount(0);
		});

		test(`CI actions read annotations and dispatch only explicit scoped requests in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/sessionGitHub.html?checks&locale=${locale}`);
			const zh = locale === 'zh-CN';
			await page.waitForFunction(() => Boolean(window.ashSessionGitHub));
			await page.evaluate(() => window.ashSessionGitHub.theme('highContrast'));
			const row = page.locator('.ash-sessions-checks li').filter({ hasText: 'team/one #7' }).filter({ hasText: 'build' });
			await expect(row).toHaveCount(1);
			expect(await page.evaluate(() => window.ashSessionGitHub.submissions)).toEqual([]);
			const annotations = row.getByRole('button', { name: zh ? '读取注释' : 'Read annotations', exact: true });
			await annotations.focus();
			await annotations.press('Enter');
			const output = row.getByRole('region', { name: zh ? 'build 注释' : 'build annotations', exact: true });
			await expect(output).toBeFocused();
			await expect(output).toContainText('src/main.rs:3-4');
			await expect(output).toContainText('Error page 2');
			await expect(output).toContainText('<script>untrusted output</script>');
			expect(await output.locator('script').count()).toBe(0);
			await row.getByRole('button', { name: zh ? '下载日志' : 'Download logs', exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashSessionGitHub.opened)).toContain('https://productionresults.blob.core.windows.net/logs?sig=fixture');
			await row.getByRole('button', { name: zh ? '重新运行作业' : 'Re-run job', exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashSessionGitHub.requests.filter(request => request.method === 'github/check/rerun').length)).toBe(1);
			await row.getByRole('button', { name: zh ? '请 Agent 修复 CI' : 'Ask agent to fix CI', exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashSessionGitHub.submissions.length)).toBe(1);
			const submission = await page.evaluate(() => window.ashSessionGitHub.submissions[0]!);
			expect(submission).toMatchObject({
				sessionId: 'session',
				threadId: 'thread',
				expectedSequence: 3,
				mode: 'agent',
			});
			expect(submission.text).toContain('Error page 2');
			expect(submission.text).not.toContain('sig=fixture');
			const rerun = await page.evaluate(() => window.ashSessionGitHub.requests.find(request => request.method === 'github/check/rerun')!);
			expect(rerun.params).toMatchObject({
				accountId: 'account',
				repository: { host: 'github.com', owner: 'team', name: 'one' },
				number: 7,
				commit: '7'.repeat(40),
				checkId: 2,
			});
			await page.evaluate(() => window.ashSessionGitHub.signOut());
			await expect(page.locator('.ash-sessions-check-output')).toHaveCount(0);
		});
	}
});
