import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import type { CustomModelProvider } from '../../../../../platform/agentHost/common/agentModels.js';
import { TestNotificationService } from '../../../../services/notification/test/common/testNotificationService.js';
import type { ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import { ILanguageModelsService } from '../../../chat/common/languageModels.js';
import { ModelProviderSettingsRenderer } from '../../browser/modelProviderSettingsRenderer.js';

const provider: CustomModelProvider = {
	id: 'custom-test',
	name: 'Test gateway',
	baseUrl: 'https://test.example/v1',
	apiFormat: 'chatCompletions',
	order: 1,
	models: [],
};
const discovered = (id: string): ModelCatalogEntry => ({
	model: { provider: provider.id, model: id },
	displayName: id,
	longContext: null,
	discovered: true,
});
const nextTurn = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

function setup(resources: DisposableStore, configuration = provider) {
	const document = browserEnvironment.window.document;
	const services = resources.add(new InstantiationService());
	const notifications = resources.add(new TestNotificationService());
	const enabled = new Set<string>();
	const calls = { discovery: 0, probes: [] as string[], writes: [] as CustomModelProvider[] };
	const source = {
		catalog: [] as readonly ModelCatalogEntry[],
		failDiscovery: false,
		failSave: false,
		probe: undefined as Promise<{ type: 'passed' }> | undefined,
	};
	services.registerInstance(INotificationService, notifications);
	services.registerInstance(IContextViewService, resources.add(new BrowserContextViewService(document.body)));
	const models: Partial<ILanguageModelsService> = {
		onDidChangeModels: Event.None,
		listModelCatalog: async () => source.catalog,
		refreshModels: async () => source.catalog,
		isModelVisible: model => enabled.has(model.model),
		setModelVisible: async (model, visible) => {
			if (visible) {
				enabled.add(model.model);
			} else {
				enabled.delete(model.model);
			}
		},
		saveCustomModelProvider: async value => {
			if (source.failSave) {
				throw new Error('Write rejected');
			}
			calls.writes.push(value);
		},
		testProviderModel: async (_provider, id) => {
			calls.probes.push(id);
			return (
				source.probe ?? (id === 'rejected' ? { type: 'failed', message: 'Not authorized' } : { type: 'passed' })
			);
		},
		discoverProviderModels: async () => {
			calls.discovery++;
			if (source.failDiscovery) {
				throw new Error('Endpoint unavailable');
			}
			return source.catalog;
		},
	};
	services.registerInstance(ILanguageModelsService, models as ILanguageModelsService);
	const card = resources.add(
		services.createInstance(ModelProviderSettingsRenderer, document, configuration, false, false),
	);
	document.body.append(card.domNode);
	resources.add(toDisposable(() => card.domNode.remove()));
	const button = (label: string): HTMLButtonElement =>
		[...card.domNode.querySelectorAll('button')].find(
			button => button.textContent === label || button.getAttribute('aria-label') === label,
		)!;
	return { card, notifications, enabled, calls, source, button };
}

test('Provider Test models discovers an empty table once and tests every row without enabling models', async () => {
	using resources = new DisposableStore();
	const { card, source, calls, button, enabled, notifications } = setup(resources);
	source.catalog = [discovered('available'), discovered('rejected')];
	button('Test models').click();
	await nextTurn();
	assert.equal(calls.discovery, 1);
	assert.deepEqual(calls.probes, ['available', 'rejected']);
	assert.deepEqual([...enabled], []);
	assert.equal(card.domNode.querySelectorAll('tbody > tr').length, 2);
	assert.deepEqual(
		notifications.model.getNotifications().map(item => [item.severity, item.message]),
		[[Severity.Warning, 'Test gateway: 1 of 2 models passed.']],
	);
	button('Test models').click();
	await nextTurn();
	assert.equal(calls.discovery, 1);
	assert.deepEqual(calls.probes, ['available', 'rejected', 'available', 'rejected']);
});

test('Provider refresh retains manual mappings, discovery membership and visibility after deleting a declaration', async () => {
	using resources = new DisposableStore();
	const { card, source, calls, enabled, button } = setup(resources, {
		...provider,
		models: [
			{ id: 'available', contextWindow: 1_000_000 },
			{ id: 'local-alias', contextWindow: 128000, upstreamModel: 'available' },
		],
	});
	source.catalog = [discovered('available')];
	await card.initialize();
	card.domNode.querySelector<HTMLInputElement>('input[aria-label="Enable available"]')!.click();
	await nextTurn();
	assert.equal(enabled.has('available'), true);
	button('Delete model available').click();
	await nextTurn();
	assert.equal(enabled.has('available'), false);
	assert.deepEqual(calls.writes.at(-1)?.models, [
		{ id: 'local-alias', contextWindow: 128000, upstreamModel: 'available' },
	]);
	card.domNode.querySelector<HTMLInputElement>('input[aria-label="Enable available"]')!.click();
	button('Refresh models').click();
	await nextTurn();
	assert.equal(enabled.has('available'), true);
	assert.match(card.getAccessibleContent(), /local-alias/);
	const rows = card.domNode.querySelectorAll('tbody > tr').length;
	source.failDiscovery = true;
	button('Refresh models').click();
	await nextTurn();
	assert.equal(card.domNode.querySelectorAll('tbody > tr').length, rows);
	assert.match(card.getAccessibleContent(), /Endpoint unavailable/);
});

test('Provider manual models test without discovery and a failed deletion preserves the declaration', async () => {
	using resources = new DisposableStore();
	const { card, calls, source, button } = setup(resources, {
		...provider,
		models: [{ id: 'manual', contextWindow: 128000 }],
	});
	button('Test models').click();
	await nextTurn();
	assert.equal(calls.discovery, 0);
	assert.deepEqual(calls.probes, ['manual']);
	source.failSave = true;
	button('Delete model manual').click();
	await nextTurn();
	assert.equal(card.domNode.querySelectorAll('tbody > tr').length, 1);
	assert.match(card.getAccessibleContent(), /manual/);
	assert.match(card.getAccessibleContent(), /Write rejected/);
});

test('Provider empty discovery stays distinct from a failed discovery and permits retry', async () => {
	using resources = new DisposableStore();
	const { card, source, calls, button, notifications } = setup(resources);
	button('Refresh models').click();
	await nextTurn();
	assert.match(card.getAccessibleContent(), /returned no models/);
	assert.equal(notifications.model.getNotifications().length, 0);
	source.failDiscovery = true;
	button('Test models').click();
	await nextTurn();
	assert.deepEqual(calls.probes, []);
	assert.equal(button('Test models').disabled, false);
	assert.match(card.getAccessibleContent(), /Endpoint unavailable/);
});

test('Disposing a provider form prevents its pending probe from announcing a late success', async () => {
	using resources = new DisposableStore();
	const { card, source, button, notifications } = setup(resources, {
		...provider,
		models: [{ id: 'manual', contextWindow: 128000 }],
	});
	const probe = new DeferredPromise<{ type: 'passed' }>();
	source.probe = probe.p;
	button('Test models').click();
	await nextTurn();
	assert.equal(button('Test models').disabled, true);
	card.dispose();
	await probe.complete({ type: 'passed' });
	await nextTurn();
	assert.equal(notifications.model.getNotifications().length, 0);
});
