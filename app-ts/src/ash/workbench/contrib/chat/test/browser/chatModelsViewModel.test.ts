import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { NotificationService } from '../../../../services/notification/common/notificationService.js';
import type { CustomModelProvider } from '../../../../../platform/sessions/common/sessionApi.js';
import type { ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import { ILanguageModelsService } from '../../common/languageModels.js';
import { ChatModelsViewModel } from '../../browser/chatManagement/chatModelsViewModel.js';

function fixture(provider: CustomModelProvider) {
	const resources = new DisposableStore();
	const notifications = resources.add(new NotificationService());
	const services = resources.add(new InstantiationService());
	const enabled = new Set<string>();
	let discoveryCalls = 0;
	const tests: string[] = [];
	const writes: CustomModelProvider[] = [];
	let catalog: readonly ModelCatalogEntry[] = [];
	let failDiscovery = false;
	let failSave = false;
	let pendingProbe: Promise<{ type: 'passed'; }> | undefined;
	const models: ILanguageModelsService = {
		readApprovalReviewModel: async () => ({ type: 'automatic' }),
		setApprovalReviewModel: async () => { },
		setModelPreferences: async () => { },
		onDidChangeModels: Event.None,
		listModels: async () => [],
		getDefaultNewChatModel: () => undefined,
		rememberSelectedModel() { },
		listModelCatalog: async () => catalog,
		listCustomModelProviders: async () => [provider],
		saveCustomModelProvider: async value => { if (failSave) throw new Error('Write rejected'); writes.push(value); },
		testProviderModel: async (_provider, id) => {
			tests.push(id);
			if (pendingProbe) return pendingProbe;
			return id === 'rejected' ? { type: 'failed', message: 'Not authorized' } : { type: 'passed' };
		},
		listModelProviders: async () => [],
		setModelProviderApiKey: async () => { },
		removeModelProviderApiKey: async () => { },
		listAdvisorModels: async () => [],
		refreshModels: async () => catalog,
		isModelVisible: model => enabled.has(model.model),
		setModelVisible: async (model, value) => { if (value) enabled.add(model.model); else enabled.delete(model.model); },
		discoverProviderModels: async () => {
			discoveryCalls++;
			if (failDiscovery) throw new Error('Endpoint unavailable');
			return catalog;
		},
	};
	services.registerInstance(ILanguageModelsService, models);
	services.registerInstance(INotificationService, notifications);
	const view = resources.add(services.createInstance(ChatModelsViewModel, provider, false));
	return {
		resources, view, notifications, enabled, tests, writes,
		get discoveryCalls() { return discoveryCalls; },
		set catalog(value: readonly ModelCatalogEntry[]) { catalog = value; },
		set failDiscovery(value: boolean) { failDiscovery = value; },
		set failSave(value: boolean) { failSave = value; },
		set pendingProbe(value: Promise<{ type: 'passed'; }>) { pendingProbe = value; },
	};
}
const provider: CustomModelProvider = { id: 'custom-test', name: 'Test gateway', baseUrl: 'https://test.example/v1', apiFormat: 'chatCompletions', order: 1, models: [] };
const discovered = (id: string): ModelCatalogEntry => ({ model: { provider: provider.id, model: id }, displayName: id, contextWindowOptions: [], discovered: true });

test('Test models discovers an empty table once, tests every row and reports one summary without enabling models', async () => {
	const context = fixture(provider);
	using resources = context.resources;
	context.catalog = [discovered('available'), discovered('rejected')];
	await context.view.testModels(async () => { });
	assert.equal(context.discoveryCalls, 1);
	assert.deepEqual(context.tests, ['available', 'rejected']);
	assert.deepEqual(context.view.rows.map(row => [row.id, row.status]), [['available', 'passed'], ['rejected', 'failed']]);
	assert.deepEqual([...context.enabled], []);
	assert.deepEqual(context.notifications.getNotifications().map(item => [item.severity, item.message]), [['warning', 'Test gateway: 1 of 2 models passed.']]);
	await context.view.testModels(async () => { });
	assert.equal(context.discoveryCalls, 1);
	assert.deepEqual(context.tests, ['available', 'rejected', 'available', 'rejected']);
});

test('Refreshing and reopening retain discovered membership, context mappings and enabled choices', async () => {
	const config = { ...provider, models: [{ id: 'available', contextWindow: 1_000_000 }, { id: 'local-alias', contextWindow: 128_000, upstreamModel: 'available' }] };
	const context = fixture(config);
	using resources = context.resources;
	context.catalog = [discovered('available'), { model: { provider: provider.id, model: 'local-alias' }, displayName: 'local-alias', contextWindowOptions: [] }];
	await context.view.initialize();
	await context.view.setEnabled('available', true);
	await context.view.removeModel('available');
	assert.deepEqual(context.view.rows.map(row => [row.id, row.manual]), [['available', false], ['local-alias', true]]);
	assert.equal(context.view.isEnabled('available'), false);
	await context.view.setEnabled('available', true);
	await context.view.refresh(async () => { });
	assert.equal(context.view.isEnabled('available'), true);
	assert.deepEqual(context.view.provider.models, [{ id: 'local-alias', contextWindow: 128_000, upstreamModel: 'available' }]);
	context.failDiscovery = true;
	const before = context.view.rows.map(row => row.id);
	await context.view.refresh(async () => { });
	assert.deepEqual(context.view.rows.map(row => row.id), before);
	assert.match(context.notifications.getNotifications().at(-1)!.message, /Endpoint unavailable/);
});

test('Manual-only IDs test without discovery and failed deletion preserves the declaration', async () => {
	const context = fixture({ ...provider, models: [{ id: 'manual', contextWindow: 128_000 }] });
	using resources = context.resources;
	await context.view.testModels(async () => { });
	assert.equal(context.discoveryCalls, 0);
	assert.deepEqual(context.tests, ['manual']);
	context.failSave = true;
	await assert.rejects(context.view.removeModel('manual'), /Write rejected/);
	assert.deepEqual(context.view.provider.models, [{ id: 'manual', contextWindow: 128_000 }]);
});

test('An empty successful response stays distinct from a discovery failure', async () => {
	const context = fixture(provider);
	using resources = context.resources;
	await context.view.refresh(async () => { });
	assert.match(context.view.message, /returned no models/);
	assert.equal(context.notifications.getNotifications().length, 0);
	context.failDiscovery = true;
	await context.view.testModels(async () => { });
	assert.deepEqual(context.tests, []);
	assert.equal(context.view.busy, false);
	assert.match(context.view.message, /Endpoint unavailable/);
	assert.equal(context.notifications.getNotifications().length, 1);
});

test('Disposing a testing card prevents its late response from announcing success', async () => {
	const context = fixture({ ...provider, models: [{ id: 'manual', contextWindow: 128_000 }] });
	using resources = context.resources;
	const pending = new DeferredPromise<{ type: 'passed'; }>();
	context.pendingProbe = pending.p;
	const testing = context.view.testModels(async () => { });
	await new Promise<void>(resolve => setTimeout(resolve, 0));
	assert.equal(context.view.busy, true);
	context.view.dispose();
	pending.complete({ type: 'passed' });
	await testing;
	assert.deepEqual(context.notifications.getNotifications(), []);
});
