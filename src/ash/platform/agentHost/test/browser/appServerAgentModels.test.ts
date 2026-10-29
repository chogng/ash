import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { AppServerProtocolClient } from '../../browser/appServerProtocolClient.js';
import type {
	ConfigUpdateParams,
	ModelPreferencesUpdateParams,
} from '../../../../../../.build/protocol/typescript/index.js';
import { createAppServerAgentModelsService } from '../../browser/appServerAgentModels.js';
import { SecretStorageError } from '../../../secrets/common/secrets.js';
import { AppServerRemoteError } from '../../common/appServerError.js';
import { setNlsMessages } from '../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../workbench/services/localization/common/localizationCatalogs.js';

test('Credential operations preserve storage failures as domain errors and translate Chinese recovery text', async () => {
	const catalog = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(catalog.locale, catalog.bundles);
	try {
		const api = createAppServerAgentModelsService({
			async request(): Promise<never> {
				throw new AppServerRemoteError(-32094, 'Untrusted diagnostic', { kind: 'SecretStorageAccessDenied' });
			},
		} as unknown as AppServerProtocolClient);
		for (const operation of [
			() => api.listProviders(),
			() => api.listModels(),
			() => api.setProviderApiKey({ connection: 'openai', apiKey: 'fake' }),
			() => api.removeProviderApiKey('openai'),
		]) {
			await assert.rejects(operation(), error => {
				assert.ok(error instanceof SecretStorageError);
				assert.equal(error.status, 'accessDenied');
				assert.equal(
					error.message,
					'凭据存储访问被拒绝。请检查配置目录权限，或使用“授权系统钥匙串”请求访问。后台操作不会显示系统窗口。',
				);
				return true;
			});
		}
	} finally {
		setNlsMessages('en', {});
	}
});

test('Model preferences send a targeted update with the current revision', async () => {
	const writes: ModelPreferencesUpdateParams[] = [];
	const connection = {
		async request(definition: { method: string }, params: ModelPreferencesUpdateParams): Promise<unknown> {
			if (definition.method === 'config/read') {
				return { revision: 7 };
			}
			assert.equal(definition.method, 'model/preferences/update');
			writes.push(params);
			return {};
		},
	} as unknown as AppServerProtocolClient;
	const api = createAppServerAgentModelsService(connection);
	const model = { provider: 'openai', model: 'test-model' };
	await api.setModelPreferences(model, { acceleration: 'priority' });
	await api.setModelPreferences(model, { longContext: true });
	await api.setModelPreferences(model, { acceleration: null });
	assert.deepEqual(
		writes.map(({ command_id, ...update }) => {
			assert.ok(command_id);
			return update;
		}),
		[
			{ expected_revision: 7, model, acceleration: 'priority' },
			{ expected_revision: 7, model, long_context: true },
			{ expected_revision: 7, model, acceleration: null },
		],
	);
	assert.equal(new Set(writes.map(write => write.command_id)).size, 3);
});

test('Review model saves only independent review settings with the current config revision', async () => {
	const selection = {
		type: 'explicit',
		model: { provider: 'openai', model: 'gpt-6-luna' },
		connection: 'openai',
		reasoningEffort: 'low',
	} as const;
	const writes: ConfigUpdateParams[] = [];
	const connection = {
		async request(definition: { method: string }, params: ConfigUpdateParams): Promise<unknown> {
			if (definition.method === 'config/read')
				return {
					revision: 9,
					approvalReviewModel: selection,
					model: { provider: 'openai', model: 'gpt-6-astra' },
				};
			assert.equal(definition.method, 'config/update');
			writes.push(params);
			return {};
		},
	} as unknown as AppServerProtocolClient;
	const api = createAppServerAgentModelsService(connection);
	assert.deepEqual(await api.readApprovalReviewModel(), selection);
	await api.setApprovalReviewModel(selection);
	await api.setApprovalReviewModel({ type: 'automatic' });
	assert.deepEqual(
		writes.map(({ commandId, ...write }) => {
			assert.ok(commandId);
			return write;
		}),
		[
			{ expectedRevision: 9, approvalReviewModel: selection },
			{ expectedRevision: 9, approvalReviewModel: { type: 'automatic' } },
		],
	);
});

test('Profile model defaults preserve an unset model and clear effort without clearing unrelated configuration', async () => {
	const writes: ConfigUpdateParams[] = [];
	const configured = {
		revision: 12,
		model: { provider: 'example', model: 'reasoning' },
		modelReasoningEffort: 'high',
	};
	const api = createAppServerAgentModelsService({
		async request(definition: { method: string }, params: ConfigUpdateParams): Promise<unknown> {
			if (definition.method === 'config/read') return configured;
			writes.push(params);
			return {};
		},
	} as unknown as AppServerProtocolClient);
	const snapshot = await api.readDefaults();
	assert.deepEqual(snapshot, { revision: 12, model: configured.model, reasoningEffort: 'high' });
	assert.notEqual(snapshot.model, configured.model);
	await api.configureDefaults({ reasoningEffort: null }, snapshot.revision);
	await api.configureDefaults({ model: null, reasoningEffort: null }, snapshot.revision);
	assert.deepEqual(
		writes.map(({ commandId, ...write }) => {
			assert.ok(commandId);
			return write;
		}),
		[
			{ expectedRevision: 12, modelReasoningEffort: null },
			{ expectedRevision: 12, model: null, modelReasoningEffort: null },
		],
	);
});

test('Profile selection failures propagate and do not report a successful save', async () => {
	const api = createAppServerAgentModelsService({
		async request(): Promise<unknown> {
			throw new Error('revision conflict');
		},
	} as unknown as AppServerProtocolClient);
	await assert.rejects(api.configureDefaults({ model: null }, 3), /revision conflict/);
	await assert.rejects(api.readDefaults(), /revision conflict/);
});
