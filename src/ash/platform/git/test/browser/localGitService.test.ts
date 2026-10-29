import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import { AppServerLocalGitService } from '../../browser/appServerLocalGitService.js';
import { decodeAppServerRequestParams } from '../../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import { AppServerRemoteError } from '../../../agentHost/common/appServerError.js';

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
