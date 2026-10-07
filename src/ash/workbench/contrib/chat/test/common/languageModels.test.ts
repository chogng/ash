import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { ModelListResult } from '../../../../../../../.build/protocol/typescript/index.js';
import type { IAppServerApi, IServerEventApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import type { IModelApi } from '../../../../../platform/sessions/common/sessionApi.js';
import { LanguageModelsService } from '../../common/languageModels.js';
import type { ILanguageModelsConfigurationService } from '../../common/languageModelsConfiguration.js';

test('retirement-only catalog changes notify consumers and keep date-only evidence intact', async () => {
	const resources = new DisposableStore();
	try {
		const entry = modelEntry();
		const models = resources.add(new LanguageModelsService(
			{ listModels: async () => ({ models: [entry] }), listProviders: async () => ({ providers: [] }) } as unknown as IModelApi,
			{ onConnectionState: () => ({ dispose() { } }) } as unknown as IAppServerApi,
			{ subscribe: () => ({ dispose() { } }) } as unknown as IServerEventApi,
			{ onDidChangeModels: Event.None } as unknown as ILanguageModelsConfigurationService,
		));
		let changes = 0;
		resources.add(models.onDidChangeModels(() => changes++));
		assert.equal((await models.refreshModels())[0].retirement, undefined);
		for (const [retirement, expected] of [
			[{ shutdown_date: null }, { shutdownDate: null }],
			[{ shutdown_date: '2027-01-31' }, { shutdownDate: '2027-01-31' }],
			[{ shutdown_date: '2027-02-28' }, { shutdownDate: '2027-02-28' }],
			[undefined, undefined],
		] as const) {
			entry.retirement = retirement;
			const previous = changes;
			assert.deepEqual((await models.refreshModels())[0].retirement, expected);
			assert.equal(changes, previous + 1);
			await models.refreshModels();
			assert.equal(changes, previous + 1);
		}
	} finally {
		resources.dispose();
	}
});

function modelEntry(): ModelListResult['models'][number] {
	return {
		model: { provider: 'openai', model: 'example' },
		display_name: 'Example',
		description: null,
		context_window: null,
		default_context_window: null,
		maximum_context_window: null,
		auto_compact_token_limit: null,
		available_context_window: null,
		long_context: null,
		selected_acceleration: null,
		acceleration_options: [],
		supported_reasoning_efforts: [],
		default_reasoning_effort: null,
		default_personality: null,
		capabilities: {
			tools: 'unknown',
			reasoning: 'unknown',
			parallel_tool_calls: 'unknown',
			personality: 'unknown',
			image_detail_original: 'unknown',
			fast_mode: 'unknown',
		},
		settings: {
			input_modalities: null,
			verbosity: 'unknown',
			default_verbosity: null,
			reasoning_summary: 'unknown',
			default_reasoning_summary: null,
			service_tiers: [],
			default_service_tier: null,
			acceleration: null,
			tool_output_limit: null,
		},
	};
}

test('model input capabilities notify consumers and do not change previous catalog snapshots', async () => {
	using resources = new DisposableStore();
	const entry = modelEntry();
	const models = resources.add(new LanguageModelsService(
		{ listModels: async () => ({ models: [entry] }), listProviders: async () => ({ providers: [] }) } as unknown as IModelApi,
		{ onConnectionState: () => ({ dispose() { } }) } as unknown as IAppServerApi,
		{ subscribe: () => ({ dispose() { } }) } as unknown as IServerEventApi,
		{ onDidChangeModels: Event.None } as unknown as ILanguageModelsConfigurationService,
	));
	const snapshots = [];
	let changes = 0;
	resources.add(models.onDidChangeModels(() => changes++));
	for (const modalities of [null, ['text'], ['text', 'image'], null] as const) {
		entry.settings.input_modalities = modalities === null ? null : [...modalities];
		snapshots.push((await models.refreshModels())[0].inputModalities);
		await models.refreshModels();
	}
	assert.deepEqual({ snapshots, changes }, { snapshots: [null, ['text'], ['text', 'image'], null], changes: 4 });
});
