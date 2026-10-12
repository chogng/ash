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
