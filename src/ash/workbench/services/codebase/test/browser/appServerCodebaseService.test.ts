import assert from 'node:assert/strict';
import { test } from 'mocha';
import { decodeAppServerResult } from '../../../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import type { CodebaseConfigureParams, CodebaseStatusResult } from '../../../../../../../.build/protocol/typescript/index.js';
import type { ICodebaseApi } from '../../../../../platform/codebase/common/codebaseApi.js';
import { AppServerCodebaseService } from '../../browser/appServerCodebaseService.js';

const sourceReady: CodebaseStatusResult = {
	sourceState: 'ready',
	embedding: { type: 'disabled' },
	rootId: 'dir-1',
	generation: 7,
	indexedFileCount: 2,
	indexedChunkCount: 3,
	indexedSourceBytes: 120,
	skippedFileCount: 0,
	truncatedFileCount: 0,
	fileLimitHit: false,
	sourceBytesLimitHit: false,
};

test('Codebase policy excludes provider configuration and preserves revision conflicts', async () => {
	const writes: CodebaseConfigureParams[] = [];
	const models = { embeddingModel: { provider: 'openai-compatible', model: 'embed-v1' }, rerankModel: null };
	const api: ICodebaseApi = {
		readConfig: async () => ({
			revision: 4,
			generation: 9,
			codebase: { models, automaticContext: 'off' },
			providers: { 'openai-compatible': { provider: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' } },
		}),
		configure: async params => {
			writes.push(params);
			if (params.expectedRevision !== 4) {
				throw new Error('revision conflict');
			}
			return { revision: 5, generation: 10, disposition: 'updated' };
		},
		status: async () => sourceReady,
	};
	const service = new AppServerCodebaseService(api);
	assert.deepEqual(await service.readConfig(), {
		revision: 4,
		generation: 9,
		codebase: { models, automaticContext: 'off' },
	});
	assert.deepEqual(await service.configure(undefined, 'firstInvocation', 4), {
		revision: 5,
		generation: 10,
		disposition: 'updated',
	});
	assert.deepEqual(writes[0], {
		commandId: writes[0].commandId,
		expectedRevision: 4,
		models: null,
		automaticContext: 'firstInvocation',
	});
	await assert.rejects(service.configure(models, 'off', 3), /revision conflict/);
	assert.deepEqual(writes[1].models, models);
	assert.notEqual(writes[0].commandId, writes[1].commandId);
});

test('Codebase status preserves source readiness while embedding is unavailable or failed', async () => {
	const statuses: CodebaseStatusResult[] = [
		{ ...sourceReady, embedding: { type: 'unavailable' } },
		{
			...sourceReady,
			embedding: {
				type: 'active',
				state: 'failed',
				targetGeneration: 7,
				publishedGeneration: 6,
				totalChunkCount: 3,
				processedChunkCount: 1,
				reusedEmbeddingCount: 1,
				embeddedChunkCount: 0,
				lastErrorCode: 'modelInvocationFailed',
			},
		},
	];
	for (const status of statuses) {
		const api: ICodebaseApi = {
			readConfig: async () => {
				throw new Error('unexpected config read');
			},
			configure: async () => {
				throw new Error('unexpected configuration write');
			},
			status: async () => decodeAppServerResult('codebase/status', status),
		};
		assert.deepEqual(await new AppServerCodebaseService(api).status(), status);
	}
});

test('Codebase wire status requires separate source and embedding states', () => {
	assert.deepEqual(decodeAppServerResult('codebase/status', sourceReady), sourceReady);
	const { sourceState, ...legacyStatus } = sourceReady;
	assert.throws(() => decodeAppServerResult('codebase/status', { ...legacyStatus, state: sourceState }));
	assert.throws(() => decodeAppServerResult('codebase/status', { ...sourceReady, embedding: { type: 'ready' } }));
});
