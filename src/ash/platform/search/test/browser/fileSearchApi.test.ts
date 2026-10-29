import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { AppServerConnectionState } from '../../../agentHost/common/appServerApi.js';
import type { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import type { FileFuzzyResult } from '../../../../../../.build/protocol/typescript/index.js';
import { createAppServerFileSearchApi } from '../../browser/fileSearchApi.js';

const directory = {
	resource: URI.parse('ssh://host/workspace'),
	target: { type: 'workspace' as const, dirId: 'folder' },
};

test('fuzzy RPC preserves backend scores, root URI and an explicit query', async () => {
	const connection = {
		generation: 1,
		state: 'ready',
		onStateChange: () => Disposable.None,
		async request(definition: { method: string }, params: { operationId: string }): Promise<FileFuzzyResult> {
			assert.equal(definition.method, 'file/search/fuzzy');
			assert.ok(params.operationId);
			assert.deepEqual({ ...params, operationId: undefined }, { operationId: undefined, target: directory.target, query: '中文 service', maxResults: 100 });
			return { matches: [{ path: 'src/中文Service.ts', score: 42 }], totalMatches: 1, freshness: 'indexed' };
		},
	} as unknown as AppServerProtocolClient;
	assert.deepEqual(await createAppServerFileSearchApi(connection).fuzzy(directory, { query: '中文 service', maxResults: 100 }), {
		matches: [
			{
				path: 'src/中文Service.ts',
				score: 42,
				resource: URI.joinPath(directory.resource, 'src/中文Service.ts'),
			},
		],
		totalMatches: 1,
	});
});

test('fuzzy cancellation keeps the terminal response and discards its late matches', async () => {
	const response = new DeferredPromise<FileFuzzyResult>();
	const cancelled = new DeferredPromise<void>();
	let operationId = '';
	const connection = {
		generation: 1,
		state: 'ready',
		onStateChange: () => Disposable.None,
		async request(definition: { method: string }, params: { operationId: string }): Promise<unknown> {
			if (definition.method === 'file/search/fuzzy') {
				operationId = params.operationId;
				return response.p;
			}
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

for (const kind of ['glob', 'fuzzy'] as const) {
	for (const replacement of [false, true]) {
		test(`${kind} retires old results and cancellation after ${replacement ? 'connection replacement' : 'close without a generation change'}`, async () => {
			using changed = new Emitter<AppServerConnectionState>();
			const response = new DeferredPromise<unknown>();
			const methods: string[] = [];
			const connection = {
				generation: 1,
				state: 'ready' as AppServerConnectionState,
				onStateChange: changed.event,
				request: async (definition: { method: string }) => {
					methods.push(definition.method);
					return methods.length === 1 ? response.p : {};
				},
			};
			const api = createAppServerFileSearchApi(connection as unknown as AppServerProtocolClient);
			const controller = new AbortController();
			const pending =
				kind === 'glob'
					? api.glob(directory, { includePatterns: [], excludePatterns: [], maxResults: 1 }, controller.signal)
					: api.fuzzy(directory, { query: 'main', maxResults: 1 }, controller.signal);
			const rejected = assert.rejects(pending, isCancellationError);
			if (replacement) {
				connection.generation++;
			} else {
				connection.state = 'stopped';
			}
			changed.fire(connection.state);
			controller.abort();
			await response.complete(kind === 'glob' ? { paths: ['main.ts'], totalMatches: 1 } : { matches: [{ path: 'main.ts', score: 1 }], totalMatches: 1 });
			await rejected;
			assert.deepEqual(methods, [`file/search/${kind}`], 'an obsolete cancel handle must not send through a replacement connection');
			assert.equal(changed.hasListeners(), false);
		});
	}

	test(`${kind} discards a resolved response if close precedes its consumer continuation`, async () => {
		using changed = new Emitter<AppServerConnectionState>();
		const response = new DeferredPromise<unknown>();
		const connection = {
			generation: 1,
			state: 'ready' as AppServerConnectionState,
			onStateChange: changed.event,
			request: () => response.p,
		};
		const api = createAppServerFileSearchApi(connection as unknown as AppServerProtocolClient);
		const pending = kind === 'glob' ? api.glob(directory, { includePatterns: [], excludePatterns: [], maxResults: 1 }) : api.fuzzy(directory, { query: 'main', maxResults: 1 });
		const rejected = assert.rejects(pending, isCancellationError);
		void response.complete(kind === 'glob' ? { paths: ['main.ts'], totalMatches: 1 } : { matches: [{ path: 'main.ts', score: 1 }], totalMatches: 1 });
		connection.state = 'stopped';
		changed.fire('stopped');
		await rejected;
		assert.equal(changed.hasListeners(), false);
	});
}

test('filename RPC carries filtering constraints to the owning backend before truncation', async () => {
	const requests: { method: string; params: unknown }[] = [];
	const connection = {
		generation: 1,
		state: 'ready',
		onStateChange: () => Disposable.None,
		async request(definition: { method: string }, params: Record<string, unknown>) {
			requests.push({ method: definition.method, params: { ...params, operationId: undefined } });
			return definition.method === 'file/search/glob'
				? { paths: ['src/needle.ts'], totalMatches: 1 }
				: { matches: [{ path: 'src/needle.ts', score: 42 }], totalMatches: 1, freshness: 'current' };
		},
	} as unknown as AppServerProtocolClient;
	const api = createAppServerFileSearchApi(connection);
	const constraints = { includePatterns: ['src/**'], excludePatterns: ['**/*.test.ts'], maxResults: 1 };
	await api.glob(directory, { ...constraints, requiredPattern: '**/*needle*' });
	await api.fuzzy(directory, { ...constraints, query: 'needle' });
	assert.deepEqual(requests, [
		{
			method: 'file/search/glob',
			params: {
				operationId: undefined,
				target: directory.target,
				...constraints,
				requiredPattern: '**/*needle*',
			},
		},
		{
			method: 'file/search/fuzzy',
			params: { operationId: undefined, target: directory.target, ...constraints, query: 'needle' },
		},
	]);
});
