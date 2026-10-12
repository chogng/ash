import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAccountService, type AccountState } from '../../../../../platform/accounts/common/accountService.js';
import { IGitHubService as IGitHubApi, type GitHubChecks } from '../../../../../platform/github/common/githubService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { IGitHubService } from '../../../github/browser/githubService.js';
import { ChecksViewModel } from '../../browser/checksViewModel.js';
import { getCheckStateLabel } from '../../browser/checksActions.js';

function fixture(api: Partial<IGitHubApi> = {}) {
	const resources = new DisposableStore();
	const associations = resources.add(new Emitter<void>());
	const accounts = resources.add(new Emitter<AccountState>());
	const services = resources.add(new InstantiationService());
	services.registerInstance(ISessionsService, { onDidChange: Event.None, activeSelection: { kind: 'session', active: { session: { sessionId: 'session' }, threadId: 'thread' } } } as unknown as ISessionsService);
	services.registerInstance(IGitHubService, {
		onDidChange: associations.event,
		getSessionPullRequests: () => [{ uri: URI.parse('https://ghe.example/team/repo/pull/7'), owner: 'team', repo: 'repo', number: 7, state: 'open' }],
	} as unknown as IGitHubService);
	services.registerInstance(IAccountService, { onDidChangeAccounts: accounts.event } as unknown as IAccountService);
	services.registerInstance(IGitHubApi, {
		listAccounts: async () => [{ id: 'enterprise', host: 'ghe.example', status: 'ready' }],
		readPullRequest: async () => ({ headCommit: 'reviewed-head' }),
		...api,
	} as IGitHubApi);
	const model = resources.add(services.createInstance(ChecksViewModel));
	return { resources, model, accounts, associations };
}

async function ready(model: ChecksViewModel): Promise<void> {
	if (!model.checksObs.get().loading) { return; }
	await new Promise<void>(resolve => {
		const listener = model.checksObs.onDidChange(state => {
			if (!state.loading) { listener.dispose(); resolve(); }
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
					checks: [{ id: page, name: page === 1 ? 'Build' : 'Tests', status: 'completed', conclusion: page === 1 ? 'success' : 'timed_out', detailsUrl: null }],
					statuses: [{ context: 'legacy', state: 'error', description: null, targetUrl: null }],
					nextPage: page === 1 ? 2 : null,
				};
			}
		});
		using owner = context.resources;
		await ready(context.model);
		assert.deepEqual(reads, [1, 2].map(page => ({ repository: { host: 'ghe.example', owner: 'team', name: 'repo', accountId: 'enterprise' }, commit: 'reviewed-head', page })));
		assert.deepEqual(context.model.checksObs.get().checks.map(entry => [entry.pullRequest, entry.check.name, getCheckStateLabel(entry.check)]), [
			['team/repo #7', 'Build', 'Successful'], ['team/repo #7', 'legacy', 'Failed'], ['team/repo #7', 'Tests', 'Failed'],
		]);
	});

	test('account changes clear private results and cancellation rejects a late response', async () => {
		const pending = new DeferredPromise<GitHubChecks>();
		const started = new DeferredPromise<CancellationToken>();
		const context = fixture({
			readChecks: async (_repository, _commit, _page, token) => {
				await started.complete(token!);
				return pending.p;
			}
		});
		using owner = context.resources;
		const token = await started.p;
		context.accounts.fire({ revision: 2n, accounts: [] });
		assert.equal(token.isCancellationRequested, true);
		assert.deepEqual(context.model.checksObs.get().checks, []);
		// Dispose before the invalidation timer starts another read.
		context.model.dispose();
		await pending.complete({ state: 'success', checks: [{ id: 1, name: 'Private check', status: 'completed', conclusion: 'success', detailsUrl: null }], statuses: [], nextPage: null });
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(context.model.checksObs.get().checks, []);
		assert.equal(context.accounts.hasListeners(), false);
		assert.equal(context.associations.hasListeners(), false);
	});

	test('repeated pagination is an explicit failure instead of an unbounded read', async () => {
		let reads = 0;
		const context = fixture({ readChecks: async () => { reads++; return { state: 'pending', checks: [], statuses: [], nextPage: 1 }; } });
		using owner = context.resources;
		await ready(context.model);
		assert.equal(reads, 1);
		assert.deepEqual(context.model.checksObs.get(), { loading: false, checks: [], error: 'Could not read all check results.' });
	});
});
