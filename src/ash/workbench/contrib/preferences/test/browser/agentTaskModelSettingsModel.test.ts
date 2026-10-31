import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IAgentModelsService, ModelPurpose, type AgentModelDefaults } from '../../../../../platform/agentHost/common/agentModels.js';
import { ILanguageModelsService } from '../../../chat/common/languageModels.js';
import { AgentTaskModelSettingsModel } from '../../browser/agentTaskModelSettingsModel.js';
import type { SettingsSectionField } from '../../../../services/preferences/common/preferences.js';
import { modelRefIdentity } from '../../../../services/chat/common/modelCatalog.js';
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';

for (const [kind, purpose, otherPurpose] of [
	['codeReviewModel', ModelPurpose.Review, ModelPurpose.Commit],
	['commitMessageModel', ModelPurpose.Commit, ModelPurpose.Review],
] as const) {
	test(`${kind} follows catalog recommendations while retaining a saved unmarked model`, async () => {
		using resources = new DisposableStore();
		const changes = resources.add(new Emitter<void>());
		const saved = { provider: 'fixture', model: 'saved' };
		const recommended = { provider: 'fixture', model: 'recommended' };
		const other = { provider: 'fixture', model: 'other' };
		let uses = [purpose];
		const snapshot: AgentModelDefaults = { revision: 1, model: null, reasoningEffort: null, codeReviewModel: null, commitMessageModel: null, commitMessageEnabled: false, [kind]: saved };
		const model = resources.add(new AgentTaskModelSettingsModel(kind,
			{ readDefaults: async () => snapshot } as IAgentModelsService,
			{
				onDidChangeModels: changes.event, isModelVisible: () => true,
				listModelCatalog: async () => [
					{ model: saved, displayName: 'Saved' },
					{ model: recommended, displayName: 'Recommended', recommendedFor: uses },
					{ model: other, displayName: 'Other', recommendedFor: [otherPurpose] },
				],
			} as unknown as ILanguageModelsService));
		const selector = () => model.fields.find(field => field.kind === 'select') as Extract<SettingsSectionField, { kind: 'select'; }>;
		const ready = () => new Promise<void>(resolve => {
			const listener = resources.add(model.onDidChange(() => { if (selector().enabled) { listener.dispose(); resolve(); } }));
		});
		let loaded = ready(); model.setVisible(true); await loaded;
		assert.deepEqual(selector().options.map(option => option.label), [kind === 'codeReviewModel' ? 'Follow Current Model' : 'Inherit conversation model', 'Recommended', 'Saved']);
		assert.equal(selector().value, modelRefIdentity(saved));
		uses = [];
		loaded = ready(); changes.fire(); await loaded;
		assert.equal(selector().options.some(option => option.value === modelRefIdentity(recommended)), false);
		assert.equal(selector().value, modelRefIdentity(saved));
	});
}

for (const kind of ['codeReviewModel', 'commitMessageModel'] as const) {
	test(`${kind} saves immediately, restores on reopen and clears without changing other defaults`, async () => {
		using resources = new DisposableStore();
		const services = resources.add(new InstantiationService());
		const chat = { provider: 'openai', model: 'chat' };
		const review = { provider: 'anthropic', model: 'review' };
		let snapshot: AgentModelDefaults = { revision: 1, model: chat, reasoningEffort: null, codeReviewModel: null, commitMessageModel: null, commitMessageEnabled: false };
		const writes: unknown[] = [];
		let reject = false;
		const changes = resources.add(new Emitter<void>());
		services.registerInstance(IAgentModelsService, {
			readDefaults: async () => snapshot,
			configureDefaults: async (update, expectedRevision) => {
				assert.equal(expectedRevision, snapshot.revision);
				if (reject) { throw new Error('controlled rejection'); }
				writes.push(update);
				snapshot = { ...snapshot, ...update, revision: snapshot.revision + 1 };
			},
		} as IAgentModelsService);
		services.registerInstance(ILanguageModelsService, {
			onDidChangeModels: changes.event, isModelVisible: () => true,
			listModelCatalog: async () => [{ model: review, displayName: 'Review fixture', recommendedFor: [ModelPurpose.Review, ModelPurpose.Commit] }],
		} as unknown as ILanguageModelsService);
		const model = resources.add(services.createInstance(AgentTaskModelSettingsModel, kind));
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
		// A different settings section has saved since this selector loaded.
		snapshot = { ...snapshot, revision: snapshot.revision + 1 };
		pending = settled();
		selector().setValue(modelRefIdentity(review));
		await pending;
		assert.equal(selector().value, modelRefIdentity(review));
		assert.deepEqual(writes, [{ [kind]: review }]);
		assert.deepEqual(snapshot.model, chat);
		assert.equal(snapshot[kind === 'codeReviewModel' ? 'commitMessageModel' : 'codeReviewModel'], null);
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
		assert.equal(snapshot[kind === 'codeReviewModel' ? 'commitMessageModel' : 'codeReviewModel'], null);
		assert.deepEqual(writes, [{ [kind]: review }, { [kind]: null }]);
		if (kind === 'commitMessageModel') {
			const toggle = () => model.fields.find(field => field.kind === 'boolean') as Extract<SettingsSectionField, { kind: 'boolean'; }>;
			pending = settled(); selector().setValue(modelRefIdentity(review)); await pending;
			pending = settled(); toggle().setValue(true); await pending;
			assert.equal(toggle().value, true);
			pending = settled(); toggle().setValue(false); await pending;
			assert.equal(toggle().value, false);
			assert.equal(selector().value, modelRefIdentity(review));
			assert.deepEqual(writes.slice(-2), [{ commitMessageEnabled: true }, { commitMessageEnabled: false }]);
		}
	});
}

test('Task model labels and help use Chinese localization', () => {
	const catalog = productLanguagePackCatalogs.find(item => item.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using model = new AgentTaskModelSettingsModel('codeReviewModel', {} as IAgentModelsService, { onDidChangeModels: Event.None } as ILanguageModelsService);
		assert.equal(model.title, '审查');
		const selector = model.fields[0] as Extract<SettingsSectionField, { kind: 'select'; }>;
		assert.equal(selector.options[0].label, '跟随当前模型');
		using commit = new AgentTaskModelSettingsModel('commitMessageModel', {} as IAgentModelsService, { onDidChangeModels: Event.None } as ILanguageModelsService);
		assert.equal(commit.title, '提交');
		assert.ok(commit.description.includes('授权'));
		assert.ok(commit.help.startsWith('提交信息设置'));
		const commitSelector = commit.fields.find(field => field.kind === 'select') as Extract<SettingsSectionField, { kind: 'select'; }>;
		assert.equal(commitSelector.options[0].label, '继承对话模型');
		assert.equal(commit.fields[0].kind, 'boolean');
	} finally { resetNlsResolver(); }
});
