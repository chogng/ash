import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IAgentModelsService, type AgentModelDefaults } from '../../../../../platform/agentHost/common/agentModels.js';
import { ILanguageModelsService } from '../../../chat/common/languageModels.js';
import { CodeReviewSettingsModel } from '../../browser/codeReviewSettingsModel.js';
import type { SettingsSectionField } from '../../browser/settingsTreeModels.js';
import { modelRefIdentity } from '../../../../services/chat/common/modelCatalog.js';
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';

test('Review model saves immediately, restores on reopen and clears without changing chat defaults', async () => {
	using resources = new DisposableStore();
	const services = resources.add(new InstantiationService());
	const chat = { provider: 'openai', model: 'chat' };
	const review = { provider: 'anthropic', model: 'review' };
	let snapshot: AgentModelDefaults = { revision: 1, model: chat, reasoningEffort: null, codeReviewModel: null };
	const writes: unknown[] = [];
	let reject = false;
	const changes = resources.add(new Emitter<void>());
	services.registerInstance(IAgentModelsService, {
		readDefaults: async () => snapshot,
		configureDefaults: async (update, expectedRevision) => {
			assert.equal(expectedRevision, snapshot.revision);
			if (reject) { throw new Error('controlled rejection'); }
			writes.push(update);
			snapshot = { ...snapshot, codeReviewModel: update.codeReviewModel ?? null, revision: snapshot.revision + 1 };
		},
	} as IAgentModelsService);
	services.registerInstance(ILanguageModelsService, {
		onDidChangeModels: changes.event, isModelVisible: () => true,
		listModelCatalog: async () => [{ model: review, displayName: 'Review fixture' }],
	} as unknown as ILanguageModelsService);
	const model = resources.add(services.createInstance(CodeReviewSettingsModel));
	const selector = () => model.fields.find(field => field.kind === 'select') as Extract<SettingsSectionField, { kind: 'select'; }>;
	const settled = () => new Promise<void>(resolve => {
		const listener = resources.add(model.onDidChange(() => {
			if (selector().enabled) { listener.dispose(); resolve(); }
		}));
	});
	let pending = settled();
	model.setVisible(true);
	await pending;
	assert.equal(selector().value, '');
	pending = settled();
	selector().setValue(modelRefIdentity(review));
	await pending;
	assert.equal(selector().value, modelRefIdentity(review));
	assert.deepEqual(writes, [{ codeReviewModel: review }]);
	assert.deepEqual(snapshot.model, chat);
	model.setVisible(false);
	pending = settled(); model.setVisible(true); await pending;
	assert.equal(selector().value, modelRefIdentity(review));
	reject = true;
	pending = settled(); selector().setValue(''); await pending;
	assert.equal(selector().value, modelRefIdentity(review));
	assert.ok(model.fields.some(field => field.kind === 'status' && field.text.includes('controlled rejection')));
	reject = false;
	pending = settled(); selector().setValue(''); await pending;
	assert.equal(selector().value, '');
	assert.deepEqual(snapshot.model, chat);
	assert.deepEqual(writes, [{ codeReviewModel: review }, { codeReviewModel: null }]);
});

test('Review model labels use Chinese localization', () => {
	const catalog = productLanguagePackCatalogs.find(item => item.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using model = new CodeReviewSettingsModel({} as IAgentModelsService, { onDidChangeModels: Event.None } as ILanguageModelsService);
		assert.equal(model.title, '审查模型');
		const selector = model.fields[0] as Extract<SettingsSectionField, { kind: 'select'; }>;
		assert.equal(selector.options[0].label, '跟随当前模型');
	} finally { resetNlsResolver(); }
});
