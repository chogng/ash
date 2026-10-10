import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
import type { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import type { FileFuzzyResult } from '../../../../../../.build/protocol/typescript/index.js';
import { createAppServerFileSearchApi } from '../../browser/fileSearchApi.js';

const directory = { resource: URI.parse('ssh://host/workspace'), target: { type: 'workspace' as const, dirId: 'folder' } };

test('fuzzy RPC preserves backend scores, root URI and an explicit query', async () => {
	const connection = {
		async request(definition: { method: string; }, params: { operationId: string; }): Promise<FileFuzzyResult> {
			assert.equal(definition.method, 'file/search/fuzzy');
			assert.ok(params.operationId);
			assert.deepEqual({ ...params, operationId: undefined }, { operationId: undefined, target: directory.target, query: '中文 service', maxResults: 100 });
			return { matches: [{ path: 'src/中文Service.ts', score: 42 }], totalMatches: 1, freshness: 'indexed' };
		},
	} as unknown as AppServerProtocolClient;
	assert.deepEqual(await createAppServerFileSearchApi(connection).fuzzy(directory, { query: '中文 service', maxResults: 100 }), {
		matches: [{ path: 'src/中文Service.ts', score: 42, resource: URI.joinPath(directory.resource, 'src/中文Service.ts') }], totalMatches: 1,
	});
});

test('fuzzy cancellation keeps the terminal response and discards its late matches', async () => {
	const response = new DeferredPromise<FileFuzzyResult>();
	const cancelled = new DeferredPromise<void>();
	let operationId = '';
	const connection = {
		async request(definition: { method: string; }, params: { operationId: string; }): Promise<unknown> {
			if (definition.method === 'file/search/fuzzy') { operationId = params.operationId; return response.p; }
			assert.equal(definition.method, 'file/search/fuzzy/cancel');
			assert.equal(params.operationId, operationId);
			cancelled.complete();
			return {};
		},
	} as unknown as AppServerProtocolClient;
	const controller = new AbortController();
	const pending = createAppServerFileSearchApi(connection).fuzzy(directory, { query: 'main', maxResults: 1 }, controller.signal);
	const rejected = assert.rejects(pending, isCancellationError);
	controller.abort();
	await cancelled.p;
	response.complete({ matches: [{ path: 'main.ts', score: 10 }], totalMatches: 1, freshness: 'current' });
	await rejected;
});
