import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import { AppServerLocalGitService } from '../../browser/appServerLocalGitService.js';
import { decodeAppServerRequestParams } from '../../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import { AppServerRemoteError } from '../../../agentHost/common/appServerError.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';

test('worktree choices use the captured workspace repositories and exclude unavailable or owned checkouts', async () => {
	const calls: unknown[] = [];
	const service = new AppServerLocalGitService({
		generation: 1, state: 'ready', onStateChange: Event.None,
		request: async (definition: { method: 'git/repositories' | 'git/worktree/list'; }, params: unknown) => {
			decodeAppServerRequestParams(definition.method, params);
			calls.push([definition.method, params]);
			if (definition.method === 'git/repositories') { return { repositories: [{ id: 'repo', label: 'Project', path: '.' }] }; }
			return {
				worktrees: [
					{ path: '/source', branch: 'main', current: true, state: 'ready' },
					{ path: '/review', branch: null, current: false, state: 'ready' },
					{ path: '/locked', branch: null, current: false, state: 'locked' },
					{ path: '/owned', branch: null, current: false, state: 'threadOwned' },
				]
			};
		},
	} as unknown as AppServerProtocolClient);
	assert.deepEqual(await service.listWorktrees(CancellationToken.None), [
		{ label: 'main', path: '/source', sourcePath: '/source' },
		{ label: 'Project', path: '/review', sourcePath: '/source' },
	]);
	assert.deepEqual(calls, [['git/repositories', {}], ['git/worktree/list', { repositoryId: 'repo' }]]);
});

test('worktrees for a draft outside the window use the selected source and exclude unavailable checkouts', async () => {
	const sourcePath = '/draft/repo';
	const service = new AppServerLocalGitService({
		generation: 1, state: 'ready', onStateChange: Event.None,
		request: async (definition: { method: string; }, params: unknown) => {
			assert.equal(definition.method, 'git/worktree/list');
			assert.deepEqual(params, { sourcePath });
			decodeAppServerRequestParams('git/worktree/list', params);
			return {
				worktrees: [
					{ path: '/resolved/repo', branch: 'main', current: true, state: 'ready' },
					{ path: '/review', branch: 'review', current: false, state: 'ready' },
					{ path: '/owned', branch: null, current: false, state: 'threadOwned' },
				]
			};
		},
	} as unknown as AppServerProtocolClient);
	assert.deepEqual(await service.listWorktrees(CancellationToken.None, sourcePath), [
		{ label: 'main', path: sourcePath, sourcePath },
		{ label: 'review', path: '/review', sourcePath },
	]);
});

test('App local Git sends typed clone and cancellation requests with the same operation identity', async () => {
	const requests: unknown[] = [];
	const connection = {
		request: async (definition: { method: 'git/cloneTo' | 'git/cloneTo/cancel'; }, params: unknown, options: unknown) => {
			decodeAppServerRequestParams(definition.method, params);
			requests.push([definition.method, params, options]);
			return {};
		},
	} as unknown as AppServerProtocolClient;
	const service = new AppServerLocalGitService(connection);
	await service.clone('operation', 'https://example.test/plugin.git', '/workspace/new', 'release');
	await service.cancel('operation');
	assert.deepEqual(requests, [
		['git/cloneTo', { operationId: 'operation', url: 'https://example.test/plugin.git', targetPath: '/workspace/new', reference: 'release' }, { timeoutMs: 1_200_000 }],
		['git/cloneTo/cancel', { operationId: 'operation' }, undefined],
	]);
});

test('The generated local Git decoder rejects unbounded identities and arbitrary command arguments', () => {
	const params = { operationId: 'operation', url: 'url', targetPath: '/workspace/new', reference: null };
	assert.throws(() => decodeAppServerRequestParams('git/cloneTo', { ...params, operationId: 'x'.repeat(129) }));
	assert.throws(() => decodeAppServerRequestParams('git/cloneTo', { ...params, args: ['reset', '--hard'] }));
});

test('App local Git translates structured host cancellation into a domain cancellation error', async () => {
	const connection = { request: async () => { throw new AppServerRemoteError(-32800, 'cancelled', { kind: 'RequestCancelled' }); } } as unknown as AppServerProtocolClient;
	await assert.rejects(new AppServerLocalGitService(connection).clone('operation', 'url', '/workspace/new'), { name: 'CancellationError' });
});


test('Session repository contexts use the captured connection and retain typed metadata without transport DTOs', async () => {
	const { Event } = await import('../../../../base/common/event.js');
	const calls: unknown[] = [];
	const service = new AppServerLocalGitService({
		generation: 2, state: 'ready', onStateChange: Event.None,
		request: async (definition: { method: string; }, params: unknown) => {
			decodeAppServerRequestParams('git/repositoryContexts', params);
			calls.push([definition.method, params]);
			return { repositories: [{ id: 'same-repo', label: 'Repo', path: 'nested', rootPath: '/historical/nested', head: { type: 'detached', objectId: 'a'.repeat(40) }, remotes: [{ name: 'origin', identity: null }] }] };
		},
	} as unknown as AppServerProtocolClient);
	assert.deepEqual(await service.readRepositoryContexts({ sessionId: 'same-session', path: '/historical' }), [{
		id: 'same-repo', label: 'Repo', path: 'nested', rootPath: '/historical/nested',
		head: { type: 'detached', name: '', objectId: 'a'.repeat(40) }, remotes: [{ name: 'origin' }],
	}]);
	assert.deepEqual(calls, [['git/repositoryContexts', { sessionDirectory: { sessionId: 'same-session', path: '/historical' } }]]);
});

test('session repository contexts are empty when inspection is denied and propagate Git failures', async () => {
	let failure = new AppServerRemoteError(-32043, 'PermissionRequired', { kind: 'PermissionRequired' });
	const service = new AppServerLocalGitService({
		generation: 1, state: 'ready', onStateChange: Event.None, request: async () => { throw failure; },
	} as unknown as AppServerProtocolClient);
	const directory = { sessionId: 'session', path: '/history' };
	assert.deepEqual(await service.readRepositoryContexts(directory), []);
	failure = new AppServerRemoteError(-32061, 'GitOperationFailed', { kind: 'GitOperationFailed' });
	await assert.rejects(service.readRepositoryContexts(directory), error => error === failure);
});

test('repository reads retire on caller cancellation or connection replacement and cannot publish late snapshots', async () => {
	const { DeferredPromise } = await import('../../../../base/common/async.js');
	const { CancellationTokenSource } = await import('../../../../base/common/cancellation.js');
	const { Emitter } = await import('../../../../base/common/event.js');
	using changes = new Emitter<import('../../../agentHost/common/appServerApi.js').AppServerConnectionState>();
	let response = new DeferredPromise<unknown>();
	const service = new AppServerLocalGitService({
		generation: 1, state: 'ready', onStateChange: changes.event, request: () => response.p,
	} as unknown as AppServerProtocolClient);
	using source = new CancellationTokenSource();
	const first = service.readRepositoryContexts({ sessionId: 'session', path: '/repo' }, source.token);
	const cancelled = assert.rejects(first, { name: 'CancellationError' });
	source.cancel();
	await cancelled;
	await response.complete({ repositories: [] });
	response = new DeferredPromise<unknown>();
	const next = service.readRepositoryContexts({ sessionId: 'session', path: '/repo' });
	const retired = assert.rejects(next, { name: 'CancellationError' });
	changes.fire('restarting');
	await retired;
	await response.complete({ repositories: [] });
});
