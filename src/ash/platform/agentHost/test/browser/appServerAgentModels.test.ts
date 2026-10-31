import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { AppServerProtocolClient } from '../../browser/appServerProtocolClient.js';
import type {
	ConfigUpdateParams,
	ModelPreferencesUpdateParams
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
		for (const operation of [() => api.listProviders(), () => api.listModels(), () => api.setProviderApiKey({ connection: 'openai', apiKey: 'fake' }), () => api.removeProviderApiKey('openai')]) {
			await assert.rejects(operation(), error => {
				assert.ok(error instanceof SecretStorageError);
				assert.equal(error.status, 'accessDenied');
				assert.equal(error.message, '凭据存储访问被拒绝。请检查配置目录权限，或使用“授权系统钥匙串”请求访问。后台操作不会显示系统窗口。');
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
		async request(definition: { method: string; }, params: ModelPreferencesUpdateParams): Promise<unknown> {
			if (definition.method === 'config/read') {
				return { revision: 7 };
			}
			assert.equal(definition.method, 'model/preferences/update');
			writes.push(params);
			return {};
		}
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
			{ expected_revision: 7, model, acceleration: null }
		]
	);
	assert.equal(new Set(writes.map((write) => write.command_id)).size, 3);
});

test('Review model saves only independent review settings with the current config revision', async () => {
	const selection = {
		type: 'explicit',
		model: { provider: 'openai', model: 'gpt-6-luna' },
		connection: 'openai',
		reasoningEffort: 'low'
	} as const;
	const writes: ConfigUpdateParams[] = [];
	const connection = {
		async request(definition: { method: string; }, params: ConfigUpdateParams): Promise<unknown> {
			if (definition.method === 'config/read')
				return {
					revision: 9,
					approvalReviewModel: selection,
					model: { provider: 'openai', model: 'gpt-6-astra' }
				};
			assert.equal(definition.method, 'config/update');
			writes.push(params);
			return {};
		}
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
			{ expectedRevision: 9, approvalReviewModel: { type: 'automatic' } }
		]
	);
});


for (const kind of ['codeReviewModel', 'commitMessageModel'] as const) {
	test(`${kind} is saved and cleared independently of the chat model`, async () => {
		const model = { provider: 'anthropic', model: 'task-model' };
		const writes: ConfigUpdateParams[] = [];
		const api = createAppServerAgentModelsService({
			async request(definition: { method: string; }, params: ConfigUpdateParams): Promise<unknown> {
				if (definition.method === 'config/read') { return { revision: 4, commitMessageEnabled: false, [kind]: model, model: { provider: 'openai', model: 'chat-model' } }; }
				writes.push(params); return {};
			},
		} as unknown as AppServerProtocolClient);
		const defaults = await api.readDefaults();
		assert.deepEqual(defaults[kind], model);
		assert.notEqual(defaults[kind], model);
		await api.configureDefaults({ [kind]: model }, defaults.revision);
		await api.configureDefaults({ [kind]: null }, defaults.revision);
		assert.deepEqual(writes.map(({ commandId, ...write }) => write), [{ expectedRevision: 4, [kind]: model }, { expectedRevision: 4, [kind]: null }]);
		if (kind === 'commitMessageModel') {
			await api.configureDefaults({ commitMessageEnabled: true }, defaults.revision);
			await api.configureDefaults({ commitMessageEnabled: false }, defaults.revision);
			assert.deepEqual(writes.slice(-2).map(({ commandId, ...write }) => write), [{ expectedRevision: 4, commitMessageEnabled: true }, { expectedRevision: 4, commitMessageEnabled: false }]);
		}
	});
}

test('Profile model defaults preserve an unset model and clear effort without clearing unrelated configuration', async () => {
	const writes: ConfigUpdateParams[] = [];
	const configured = { commitMessageEnabled: false, revision: 12, model: { provider: 'example', model: 'reasoning' }, modelReasoningEffort: 'high' };
	const api = createAppServerAgentModelsService({
		async request(definition: { method: string; }, params: ConfigUpdateParams): Promise<unknown> {
			if (definition.method === 'config/read') return configured;
			writes.push(params); return {};
		},
	} as unknown as AppServerProtocolClient);
	const snapshot = await api.readDefaults();
	assert.deepEqual(snapshot, { codeReviewModel: null, commitMessageModel: null, commitMessageEnabled: false, revision: 12, model: configured.model, reasoningEffort: 'high' });
	assert.notEqual(snapshot.model, configured.model);
	await api.configureDefaults({ reasoningEffort: null }, snapshot.revision);
	await api.configureDefaults({ model: null, reasoningEffort: null }, snapshot.revision);
	assert.deepEqual(writes.map(({ commandId, ...write }) => {
		assert.ok(commandId);
		return write;
	}), [
		{ expectedRevision: 12, modelReasoningEffort: null },
		{ expectedRevision: 12, model: null, modelReasoningEffort: null },
	]);
});

test('Profile selection failures propagate and do not report a successful save', async () => {
	const api = createAppServerAgentModelsService({
		async request(): Promise<unknown> { throw new Error('revision conflict'); },
	} as unknown as AppServerProtocolClient);
	await assert.rejects(api.configureDefaults({ model: null }, 3), /revision conflict/);
	await assert.rejects(api.readDefaults(), /revision conflict/);
});


test('Removing a configured custom provider uses the latest config revision and rejects built-in identities', async () => {
	const writes: unknown[] = [];
	const api = createAppServerAgentModelsService({
		async request(definition: { method: string; }, params: unknown): Promise<unknown> {
			if (definition.method === 'config/read') { return { revision: 42, connections: { 'custom-test': { custom: true }, openai: { custom: false } } }; }
			assert.equal(definition.method, 'provider/remove');
			writes.push(params);
			return {};
		},
	} as unknown as AppServerProtocolClient);
	await assert.rejects(api.removeCustomProvider('openai'), /Only a configured custom provider/);
	await assert.rejects(api.removeCustomProvider('custom-missing'), /Only a configured custom provider/);
	assert.deepEqual(writes, []);
	await api.removeCustomProvider('custom-test');
	assert.match((writes[0] as { commandId: string; }).commandId, /^[0-9a-f-]{36}$/);
	assert.deepEqual(writes[0], { commandId: (writes[0] as { commandId: string; }).commandId, expectedRevision: 42, connection: 'custom-test' });
});

test('Catalog statuses preserve connection identity and immutable discovery categories', async () => {
	const issues = ['refreshFailed'];
	const api = createAppServerAgentModelsService({
		request: async () => ({ models: [], catalog_statuses: [{ provider: 'custom-one', connection: 'custom-one', freshness: 'staleUsable', issues }] }),
	} as unknown as AppServerProtocolClient);
	const result = await api.listModels();
	issues.push('authenticationRequired');
	assert.deepEqual(result.statuses, [{ provider: 'custom-one', connection: 'custom-one', freshness: 'staleUsable', issues: ['refreshFailed'] }]);
	assert.ok(Object.isFrozen(result.statuses));
	assert.ok(Object.isFrozen(result.statuses![0].issues));
});
