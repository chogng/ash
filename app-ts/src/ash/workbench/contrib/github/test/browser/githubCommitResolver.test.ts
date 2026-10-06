import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IGitHubService, type GitHubCommit } from '../../../../../platform/github/common/githubService.js';
import { createDisconnectedGitHubService } from '../../../../../platform/github/browser/appServerGitHubService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { GitHubCommitResolver } from '../../browser/githubCommitResolver.js';

const commit: GitHubCommit = { sha: 'a'.repeat(40), url: `https://github.com/team/repo/commit/${'a'.repeat(40)}`, message: 'Fix links\n\nDescription', author: 'Ada', committedAt: '2026-01-01T00:00:00Z', additions: 4, deletions: 2 };

test('commit links share a request and discard a late result after the final link is removed', async () => {
	using services = new InstantiationService();
	let complete!: (value: GitHubCommit) => void;
	let token!: CancellationToken;
	let reads = 0;
	services.registerInstance(IGitHubService, {
		...createDisconnectedGitHubService(), readCommit: async (_repository, _sha, cancellation) => {
			reads++;
			token = cancellation!;
			return new Promise<GitHubCommit>(resolve => { complete = resolve; });
		}
	});
	using resolver = services.createInstance(GitHubCommitResolver);
	const target = { owner: 'team', repo: 'repo', sha: 'a'.repeat(40) };
	const value = resolver.get(target);
	const first = resolver.resolve(target);
	const second = resolver.resolve({ ...target, owner: 'TEAM' });
	await Promise.resolve();
	resolver.retain([]);
	complete(commit);
	await Promise.all([first, second]);
	assert.deepEqual({ reads, canceled: token.isCancellationRequested, value: value.get() }, { reads: 1, canceled: true, value: undefined });
});

test('commit metadata is delivered through the observable used by the provider', async () => {
	using services = new InstantiationService();
	services.registerInstance(IGitHubService, { ...createDisconnectedGitHubService(), readCommit: async () => commit });
	using resolver = services.createInstance(GitHubCommitResolver);
	const target = { owner: 'team', repo: 'repo', sha: 'a'.repeat(40) };
	const value = resolver.get(target);
	await resolver.resolve(target);
	assert.deepEqual(value.get(), commit);
});

test('a failed commit read can be retried by a new link without retaining the rejected promise', async () => {
	using services = new InstantiationService();
	let attempts = 0;
	services.registerInstance(IGitHubService, {
		...createDisconnectedGitHubService(), readCommit: async () => {
			if (++attempts === 1) { throw new Error('Connection lost'); }
			return commit;
		}
	});
	using resolver = services.createInstance(GitHubCommitResolver);
	const target = { owner: 'team', repo: 'repo', sha: 'a'.repeat(40) };
	const value = resolver.get(target);
	await assert.rejects(resolver.resolve(target), /Connection lost/);
	assert.equal(value.get(), undefined);
	await resolver.resolve(target);
	await resolver.resolve(target);
	assert.deepEqual({ attempts, value: value.get() }, { attempts: 2, value: commit });
});
