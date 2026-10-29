import { IChatService } from '../../../../../workbench/services/chat/common/chatService.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAccountService, type AccountState } from '../../../../../platform/accounts/common/accountService.js';
import { IGitHubService as IGitHubApi, GitHubError, GitHubErrorCode, type GitHubChecks, type GitHubCheckDetails } from '../../../../../platform/github/common/githubService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { IGitHubService } from '../../../github/browser/githubService.js';
import { ChecksViewModel, type ChecksEntry } from '../../browser/checksViewModel.js';
import { getCheckStateLabel } from '../../browser/checksActions.js';
import { IChecksOperationService } from '../../common/checksOperationService.js';
import { ChecksOperationService } from '../../browser/checksOperationService.js';

function fixture(api: Partial<IGitHubApi> = {}, chat: Partial<IChatService> = {}, registerOperations = true) {
	const resources = new DisposableStore();
	const associations = resources.add(new Emitter<void>());
	const accounts = resources.add(new Emitter<AccountState>());
	const services = resources.add(new InstantiationService());
	if (registerOperations) services.registerSingleton(IChecksOperationService, () => services.createInstance(ChecksOperationService));
	const selected = resources.add(new Emitter<void>());
	let sessionId = 'session';
	services.registerInstance(ISessionsService, {
		onDidChange: selected.event,
		get activeSelection() {
			return { kind: 'session', active: { session: { sessionId }, threadId: 'thread' } };
		},
	} as unknown as ISessionsService);
	services.registerInstance(IGitHubService, {
		onDidChange: associations.event,
		getSessionPullRequests: () => [
			{
				uri: URI.parse('https://ghe.example/team/repo/pull/7'),
				owner: 'team',
				repo: 'repo',
				number: 7,
				state: 'open',
			},
		],
	} as unknown as IGitHubService);
	services.registerInstance(IChatService, chat as IChatService);
	services.registerInstance(IAccountService, { onDidChangeAccounts: accounts.event } as unknown as IAccountService);
	services.registerInstance(IGitHubApi, {
		listAccounts: async () => [{ id: 'enterprise', host: 'ghe.example', login: 'user', status: 'ready', credentialRevision: 1n }],
		readPullRequest: async () => ({ headCommit: 'reviewed-head' }),
		...api,
	} as IGitHubApi);
	const createModel = () => resources.add(services.createInstance(ChecksViewModel));
	let model: ChecksViewModel;
	try {
		model = createModel();
	} catch (error) {
		resources.dispose();
		throw error;
	}
	return {
		resources,
		model,
		createModel,
		accounts,
		associations,
		selectSession: (id: string) => {
			sessionId = id;
			selected.fire();
		},
	};
}

async function ready(model: ChecksViewModel): Promise<void> {
	if (!model.checksObs.get().loading) {
		return;
	}
	await new Promise<void>(resolve => {
		const listener = model.checksObs.onDidChange(state => {
			if (!state.loading) {
				listener.dispose();
				resolve();
			}
		});
	});
}

suite('Session Changes CI reads', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads every page at the current PR head and includes legacy statuses', async () => {
		const reads: unknown[] = [];
		const context = fixture({
			readChecks: async (repository, commit, page) => {
				reads.push({ repository, commit, page });
				return {
					state: 'failure',
					checks: [
						{
							id: page,
							name: page === 1 ? 'Build' : 'Tests',
							status: 'completed',
							conclusion: page === 1 ? 'success' : 'timed_out',
							detailsUrl: null,
						},
					],
					statuses: [{ context: 'legacy', state: 'error', description: null, targetUrl: null }],
					nextPage: page === 1 ? 2 : null,
				};
			},
		});
		using owner = context.resources;
		await ready(context.model);
		assert.deepEqual(
			reads,
			[1, 2].map(page => ({
				repository: { host: 'ghe.example', owner: 'team', name: 'repo', accountId: 'enterprise' },
				commit: 'reviewed-head',
				page,
			})),
		);
		assert.deepEqual(
			context.model.checksObs.get().checks.map(entry => [entry.pullRequest, entry.check.name, getCheckStateLabel(entry.check)]),
			[
				['team/repo #7', 'Build', 'Successful'],
				['team/repo #7', 'legacy', 'Failed'],
				['team/repo #7', 'Tests', 'Failed'],
			],
		);
	});

	test('account changes clear private results and cancellation rejects a late response', async () => {
		const pending = new DeferredPromise<GitHubChecks>();
		const started = new DeferredPromise<CancellationToken>();
		const context = fixture({
			readChecks: async (_repository, _commit, _page, token) => {
				await started.complete(token!);
				return pending.p;
			},
		});
		using owner = context.resources;
		const token = await started.p;
		context.accounts.fire({ revision: 2n, accounts: [] });
		assert.equal(token.isCancellationRequested, true);
		assert.deepEqual(context.model.checksObs.get().checks, []);
		// Dispose before the invalidation timer starts another read.
		context.model.dispose();
		await pending.complete({
			state: 'success',
			checks: [{ id: 1, name: 'Private check', status: 'completed', conclusion: 'success', detailsUrl: null }],
			statuses: [],
			nextPage: null,
		});
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(context.model.checksObs.get().checks, []);
		assert.equal(context.accounts.hasListeners(), false);
		assert.equal(context.associations.hasListeners(), false);
	});

	test('repeated pagination is an explicit failure instead of an unbounded read', async () => {
		let reads = 0;
		const context = fixture({
			readChecks: async () => {
				reads++;
				return { state: 'pending', checks: [], statuses: [], nextPage: 1 };
			},
		});
		using owner = context.resources;
		await ready(context.model);
		assert.equal(reads, 1);
		assert.deepEqual(context.model.checksObs.get(), {
			loading: false,
			checks: [],
			error: 'Could not read all check results.',
		});
	});
});

const details: GitHubCheckDetails = {
	title: 'Build failure',
	summary: 'Compilation failed',
	text: '<script>untrusted</script>',
	annotations: [
		{
			path: 'src/main.rs',
			startLine: 3,
			endLine: 4,
			annotationLevel: 'failure',
			title: null,
			message: 'Compiler error',
		},
	],
	nextPage: null,
	actionsJob: true,
};
const failingChecks = async (): Promise<GitHubChecks> => ({
	state: 'failure',
	statuses: [],
	nextPage: null,
	checks: [
		{
			id: 9,
			name: 'Build',
			status: 'completed',
			conclusion: 'failure',
			detailsUrl: 'https://ghe.example/team/repo/actions/runs/7/job/45',
		},
	],
});

suite('Session Changes CI actions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('construction requires the window-scoped operation owner', () => {
		assert.throws(() => fixture({}, {}, false), /checksOperationService/);
	});

	for (const running of [false, true])
		test(`a ${running ? 'queued' : 'started'} CI fix stays guarded while hidden and after a lost reply`, async () => {
			let writes = 0;
			let revision = 1n;
			const reply = new DeferredPromise<void>();
			const started = new DeferredPromise<void>();
			const submit = async () => {
				writes++;
				started.complete();
				return reply.p;
			};
			const f = fixture(
				{
					listAccounts: async () => [
						{
							id: 'enterprise',
							host: 'ghe.example',
							login: 'user',
							status: 'ready',
							credentialRevision: revision,
						},
					],
					readChecks: failingChecks,
					readCheckDetails: async () => details,
				},
				{
					readThread: async () =>
						({
							thread: { status: 'active', sequence: 1, turns: running ? [{ status: 'inProgress' }] : [] },
						}) as never,
					startTurn: submit,
					queueTurn: submit,
				},
			);
			using owner = f.resources;
			await ready(f.model);
			const pending = assert.rejects(f.model.fix(f.model.checksObs.get().checks[0]!), /could not be confirmed/);
			await started.p;
			f.model.dispose();
			const reopened = f.createModel();
			await ready(reopened);
			let entry = reopened.checksObs.get().checks[0]!;
			assert.equal(reopened.retryBlocked(entry, 'fix'), true);
			await reopened.fix(entry);
			assert.equal(writes, 1);
			await reply.error(new Error('reply lost after acceptance'));
			await pending;
			reopened.dispose();
			// Reauthentication cannot confirm or undo a request already accepted by Chat.
			revision++;
			const restored = f.createModel();
			await ready(restored);
			entry = restored.checksObs.get().checks[0]!;
			assert.equal(restored.retryBlocked(entry, 'fix'), true);
			assert.equal(restored.retryBlocked(entry, 'rerun'), false);
			await restored.fix(entry);
			assert.equal(writes, 1);
		});

	test('paginates annotation reads with the captured account, PR, head and check identity', async () => {
		const calls: unknown[] = [];
		const f = fixture({
			readChecks: failingChecks,
			readCheckDetails: async (repository, target, page) => {
				calls.push({ repository, target, page });
				return { ...details, nextPage: page === 1 ? 2 : null };
			},
		});
		using owner = f.resources;
		await ready(f.model);
		const result = await f.model.details(f.model.checksObs.get().checks[0]!);
		assert.equal(result.annotations.length, 2);
		assert.deepEqual(
			calls,
			[1, 2].map(page => ({
				repository: { host: 'ghe.example', owner: 'team', name: 'repo', accountId: 'enterprise' },
				target: { number: 7, commit: 'reviewed-head', checkId: 9 },
				page,
			})),
		);
	});

	test('a confirmed fix releases its guard even when the original panel closes', async () => {
		let writes = 0;
		const reply = new DeferredPromise<void>();
		const started = new DeferredPromise<void>();
		const f = fixture(
			{ readChecks: failingChecks, readCheckDetails: async () => details },
			{
				readThread: async () => ({ thread: { status: 'active', sequence: 1, turns: [] } }) as never,
				startTurn: async () => {
					writes++;
					started.complete();
					if (writes === 1) return reply.p;
				},
			},
		);
		using owner = f.resources;
		await ready(f.model);
		const pending = assert.rejects(f.model.fix(f.model.checksObs.get().checks[0]!));
		await started.p;
		f.model.dispose();
		const reopened = f.createModel();
		await ready(reopened);
		const entry = reopened.checksObs.get().checks[0]!;
		assert.equal(reopened.retryBlocked(entry, 'fix'), true);
		await reply.complete();
		await pending;
		assert.equal(reopened.retryBlocked(entry, 'fix'), false);
		await reopened.fix(entry);
		assert.equal(writes, 2);
	});

	test('closing a panel before submission releases the guard without blocking a later fix', async () => {
		let writes = 0;
		let reads = 0;
		const response = new DeferredPromise<GitHubCheckDetails>();
		const started = new DeferredPromise<void>();
		const f = fixture(
			{
				readChecks: failingChecks,
				readCheckDetails: async () => {
					if (++reads === 1) {
						started.complete();
						return response.p;
					}
					return details;
				},
			},
			{
				readThread: async () => ({ thread: { status: 'active', sequence: 1, turns: [] } }) as never,
				startTurn: async () => {
					writes++;
				},
			},
		);
		using owner = f.resources;
		await ready(f.model);
		const pending = assert.rejects(f.model.fix(f.model.checksObs.get().checks[0]!));
		await started.p;
		f.model.dispose();
		const reopened = f.createModel();
		await ready(reopened);
		const entry = reopened.checksObs.get().checks[0]!;
		assert.equal(reopened.retryBlocked(entry, 'fix'), true);
		await response.complete(details);
		await pending;
		assert.equal(writes, 0);
		assert.equal(reopened.retryBlocked(entry, 'fix'), false);
		await reopened.fix(entry);
		assert.equal(writes, 1);
	});

	test('account changes cancel live detail reads and discard private late results', async () => {
		const response = new DeferredPromise<GitHubCheckDetails>();
		const started = new DeferredPromise<CancellationToken>();
		const f = fixture({
			readChecks: failingChecks,
			readCheckDetails: async (_repository, _target, _page, token) => {
				started.complete(token!);
				return response.p;
			},
		});
		using owner = f.resources;
		await ready(f.model);
		const pending = assert.rejects(f.model.details(f.model.checksObs.get().checks[0]!), error => error instanceof Error && (error.name === 'Canceled' || error.name === 'CancellationError'));
		const token = await started.p;
		f.accounts.fire({ revision: 2n, accounts: [] });
		assert.equal(token.isCancellationRequested, true);
		await response.complete(details);
		await pending;
		f.model.dispose();
		assert.deepEqual(f.model.checksObs.get().checks, []);
	});

	test('uncertain reruns are not repeated and permission failures remain explicit', async () => {
		for (const code of [GitHubErrorCode.SubmissionUncertain, GitHubErrorCode.PermissionDenied]) {
			let writes = 0;
			const f = fixture({
				readChecks: failingChecks,
				rerunCheck: async () => {
					writes++;
					throw new GitHubError(code);
				},
			});
			using owner = f.resources;
			await ready(f.model);
			const entry = f.model.checksObs.get().checks[0]!;
			await assert.rejects(f.model.rerun(entry), error => error instanceof GitHubError && error.code === code);
			assert.equal(f.model.retryBlocked(entry, 'rerun'), code === GitHubErrorCode.SubmissionUncertain);
			if (code === GitHubErrorCode.SubmissionUncertain) await f.model.rerun(entry);
			assert.equal(writes, 1);
		}
	});

	for (const running of [false, true])
		test(`explicit Fix CI uses the captured Thread and normal ${running ? 'queue' : 'turn'} contract`, async () => {
			const requests: unknown[] = [];
			const f = fixture(
				{ readChecks: failingChecks, readCheckDetails: async () => details },
				{
					readThread: async () =>
						({
							thread: {
								status: 'active',
								sequence: 12,
								turns: running ? [{ status: 'inProgress' }] : [],
							},
						}) as never,
					startTurn: async options => {
						requests.push(['start', options]);
					},
					queueTurn: async options => {
						requests.push(['queue', options]);
					},
				},
			);
			using owner = f.resources;
			await ready(f.model);
			assert.deepEqual(requests, [], 'Reading checks never submits a message');
			await f.model.fix(f.model.checksObs.get().checks[0]!);
			assert.equal(requests.length, 1);
			const [kind, submission] = requests[0] as [string, { sessionId: string; threadId: string; expectedSequence: number; text: string }];
			assert.equal(kind, running ? 'queue' : 'start');
			assert.equal(submission.sessionId, 'session');
			assert.equal(submission.threadId, 'thread');
			assert.equal(submission.expectedSequence, 12);
			assert.match(submission.text, /untrusted CI output/);
			assert.match(submission.text, /src\/main.rs:3-4/);
			assert.match(submission.text, /reviewed-head/);
		});

	test('account invalidation while preparing Fix CI prevents submission', async () => {
		const read = new DeferredPromise<never>();
		const started = new DeferredPromise<void>();
		let submitted = 0;
		const f = fixture(
			{ readChecks: failingChecks, readCheckDetails: async () => details },
			{
				readThread: async () => {
					started.complete();
					return read.p;
				},
				startTurn: async () => {
					submitted++;
				},
				queueTurn: async () => {
					submitted++;
				},
			},
		);
		using owner = f.resources;
		await ready(f.model);
		const pending = assert.rejects(f.model.fix(f.model.checksObs.get().checks[0]!));
		await started.p;
		f.accounts.fire({ revision: 2n, accounts: [] });
		read.complete({ thread: { status: 'active', sequence: 1, turns: [] } } as never);
		await pending;
		f.model.dispose();
		assert.equal(submitted, 0);
	});
});

async function renamedEntry(model: ChecksViewModel, name: string): Promise<ChecksEntry> {
	return new Promise(resolve => {
		const listener = model.checksObs.onDidChange(state => {
			const entry = state.checks.find(entry => entry.check.name === name);
			if (entry) {
				listener.dispose();
				resolve(entry);
			}
		});
	});
}

suite('CI operation identity across refreshes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('an uncertain rerun stays blocked after metadata changes and a new head has a new identity', async () => {
		let name = 'Build';
		let commit = 'reviewed-head';
		let writes = 0;
		const f = fixture({
			readPullRequest: async () => ({ headCommit: commit }) as never,
			readChecks: async () => ({
				...(await failingChecks()),
				checks: [{ ...(await failingChecks()).checks[0]!, name }],
			}),
			rerunCheck: async () => {
				writes++;
				throw new GitHubError(GitHubErrorCode.SubmissionUncertain);
			},
		});
		using owner = f.resources;
		await ready(f.model);
		await assert.rejects(f.model.rerun(f.model.checksObs.get().checks[0]!));
		name = 'Renamed build';
		const changed = renamedEntry(f.model, name);
		f.associations.fire();
		const entry = await changed;
		assert.equal(f.model.retryBlocked(entry, 'rerun'), true);
		await f.model.rerun(entry);
		assert.equal(writes, 1);
		commit = 'b'.repeat(40);
		name = 'Build on new head';
		const next = renamedEntry(f.model, name);
		f.associations.fire();
		const current = await next;
		assert.equal(f.model.retryBlocked(current, 'rerun'), false);
		await assert.rejects(f.model.rerun(current));
		assert.equal(writes, 2);
	});

	test('a pending write cannot be dispatched again after a check label refresh', async () => {
		let name = 'Build';
		let writes = 0;
		const response = new DeferredPromise<void>();
		const started = new DeferredPromise<void>();
		const f = fixture({
			readChecks: async () => ({
				...(await failingChecks()),
				checks: [{ ...(await failingChecks()).checks[0]!, name }],
			}),
			rerunCheck: async () => {
				writes++;
				started.complete();
				return response.p;
			},
		});
		using owner = f.resources;
		await ready(f.model);
		const pending = assert.rejects(f.model.rerun(f.model.checksObs.get().checks[0]!));
		await started.p;
		name = 'Updated label';
		const changed = renamedEntry(f.model, name);
		f.associations.fire();
		const entry = await changed;
		assert.equal(f.model.retryBlocked(entry, 'rerun'), true);
		await f.model.rerun(entry);
		assert.equal(writes, 1);
		response.complete();
		await pending;
	});

	test('an uncertain agent submission stays blocked after same-check refresh', async () => {
		let name = 'Build';
		let writes = 0;
		const f = fixture(
			{
				readChecks: async () => ({
					...(await failingChecks()),
					checks: [{ ...(await failingChecks()).checks[0]!, name }],
				}),
				readCheckDetails: async () => details,
			},
			{
				readThread: async () => ({ thread: { status: 'active', sequence: 1, turns: [] } }) as never,
				startTurn: async () => {
					writes++;
					throw new Error('reply lost');
				},
			},
		);
		using owner = f.resources;
		await ready(f.model);
		await assert.rejects(f.model.fix(f.model.checksObs.get().checks[0]!), /could not be confirmed/);
		name = 'Updated failure';
		const changed = renamedEntry(f.model, name);
		f.associations.fire();
		const entry = await changed;
		assert.equal(f.model.retryBlocked(entry, 'fix'), true);
		assert.equal(f.model.retryBlocked(entry, 'rerun'), false);
		await f.model.fix(entry);
		assert.equal(writes, 1);
	});
});

async function selectedSessionEntry(model: ChecksViewModel, sessionId: string): Promise<ChecksEntry> {
	return new Promise(resolve => {
		const listener = model.checksObs.onDidChange(state => {
			const entry = state.checks.find(entry => entry.sessionId === sessionId);
			if (entry) {
				listener.dispose();
				resolve(entry);
			}
		});
	});
}

suite('CI uncertainty across session navigation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('A to B to A navigation cannot retry the same uncertain operation', async () => {
		let writes = 0;
		const f = fixture({
			readChecks: failingChecks,
			rerunCheck: async () => {
				writes++;
				throw new GitHubError(GitHubErrorCode.SubmissionUncertain);
			},
		});
		using owner = f.resources;
		await ready(f.model);
		await assert.rejects(f.model.rerun(f.model.checksObs.get().checks[0]!));
		const other = selectedSessionEntry(f.model, 'other');
		f.selectSession('other');
		await other;
		const back = selectedSessionEntry(f.model, 'session');
		f.selectSession('session');
		const original = await back;
		assert.equal(f.model.retryBlocked(original, 'rerun'), true);
		await f.model.rerun(original);
		assert.equal(writes, 1);
	});
});
