import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { createDisconnectedGitHubService } from '../../../../../platform/github/browser/appServerGitHubService.js';
import { IGitHubService, type GitHubPullRequestChecks, type GitHubPullRequest } from '../../../../../platform/github/common/githubService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { LazyGitHubResourceResolver, parseGitHubReferenceTarget } from '../../browser/lazyGitHubResourceHover.js';

const target = { owner: 'team', repo: 'repo', number: 7 };
const pullRequest: GitHubPullRequest = { number: 7, title: 'Fix links', body: 'Details', url: 'https://github.com/team/repo/pull/7', state: 'open', draft: false, mergedAt: null, headCommit: 'a'.repeat(40), headBranch: 'feature', headRepository: 'contributor/fork', baseBranch: 'main', mergeable: null, autoMerge: false };

test('public reference parsing rejects enterprise hosts and unsafe reference identities', () => {
	assert.deepEqual(parseGitHubReferenceTarget(URI.parse('https://github.com/team/repo/pull/7?tab=files#discussion'), 'pullRequest'), target);
	for (const uri of ['http://github.com/team/repo/pull/7', 'https://enterprise.test/team/repo/pull/7', 'https://github.com/team/repo/pull/0', 'https://github.com/team/repo/pull/07', 'https://github.com/team/repo/pull/9007199254740992', 'https://github.com/team/repo/pull/7/files']) {
		assert.equal(parseGitHubReferenceTarget(URI.parse(uri), 'pullRequest'), undefined);
	}
	assert.throws(() => URI.parse('https://user@github.com/team/repo/pull/7'), /credentials/);
});

test('hover intent loads the required check summary once for the prefetched PR head', async () => {
	using services = new InstantiationService();
	const reads: string[] = [];
	services.registerInstance(IGitHubService, {
		...createDisconnectedGitHubService(),
		readPullRequest: async () => { reads.push('core'); return pullRequest; },
		readPullRequestChecks: async (_repository, number, commit) => {
			assert.equal(number, pullRequest.number);
			assert.equal(commit, pullRequest.headCommit);
			reads.push('checks');
			return { status: 'pending', unreportedRequiredChecks: ['gate'] };
		},
	});
	using resolver = services.createInstance(LazyGitHubResourceResolver);
	await resolver.prefetchPullRequest(target);
	assert.deepEqual(reads, ['core']);
	const [first, second] = await Promise.all([resolver.resolvePullRequest(target), resolver.resolvePullRequest(target)]);
	await resolver.resolvePullRequest(target);
	assert.deepEqual({ reads, sameResult: first === second, checks: first.checks, state: resolver.getPullRequestState(target).get() }, {
		reads: ['core', 'checks'], sameResult: true, checks: { status: 'pending', unreportedRequiredChecks: ['gate'] }, state: { status: 'resolved', value: first },
	});
});

test('a failed checks request can be retried without losing the loaded PR', async () => {
	using services = new InstantiationService();
	let attempts = 0;
	services.registerInstance(IGitHubService, {
		...createDisconnectedGitHubService(), readPullRequest: async () => pullRequest, readPullRequestChecks: async () => {
			if (++attempts === 1) { throw new Error('Checks temporarily unavailable'); }
			return { status: 'success' };
		}
	});
	using resolver = services.createInstance(LazyGitHubResourceResolver);
	await assert.rejects(resolver.resolvePullRequest(target), /temporarily unavailable/);
	assert.deepEqual(resolver.getPullRequestState(target).get(), { status: 'resolved', value: { pullRequest, checks: undefined } });
	await resolver.resolvePullRequest(target);
	assert.equal(attempts, 2);
});

test('retiring a link cancels in-flight checks and prevents late state from reappearing', async () => {
	using services = new InstantiationService();
	let release!: (checks: GitHubPullRequestChecks) => void;
	let cancellation!: CancellationToken;
	let entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	services.registerInstance(IGitHubService, {
		...createDisconnectedGitHubService(), readPullRequest: async () => pullRequest, readPullRequestChecks: async (_repository, _number, _commit, token) => {
			cancellation = token!;
			entered();
			return new Promise<GitHubPullRequestChecks>(resolve => { release = resolve; });
		}
	});
	using resolver = services.createInstance(LazyGitHubResourceResolver);
	const state = resolver.getPullRequestState(target);
	const pending = resolver.resolvePullRequest(target);
	await started;
	resolver.retain([]);
	release({ status: 'success' });
	await pending;
	assert.deepEqual({ canceled: cancellation.isCancellationRequested, state: state.get() }, { canceled: true, state: { status: 'resolved', value: { pullRequest, checks: undefined } } });
});
