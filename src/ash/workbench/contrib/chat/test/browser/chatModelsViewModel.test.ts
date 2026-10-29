import assert from 'node:assert/strict';
import { test } from 'mocha';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import { renderMarkdown } from '../../../../../base/browser/markdownRenderer.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import type { ModelProviderCredentialStatus } from '../../../../../platform/agentHost/common/agentModels.js';
import { modelRefIdentity, type ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import { ILanguageModelsService } from '../../common/languageModels.js';
import { ChatModelsViewModel, isLanguageModelProviderEntry, isStatusEntry, type ILanguageModelEntry, type IViewModelEntry } from '../../browser/chatManagement/chatModelsViewModel.js';
import { getModelHoverContent } from '../../browser/chatManagement/chatModelsWidget.js';

const catalog: readonly ModelCatalogEntry[] = [
	{
		model: { provider: 'first', model: 'newest' },
		displayName: 'New Model',
		longContext: null,
		inputModalities: ['text', 'image'],
		description: 'A supplied description.',
		contextWindow: 128000,
	},
	{
		model: { provider: 'first', model: 'older' },
		displayName: 'Older Model',
		longContext: null,
		inputModalities: ['text'],
	},
	{ model: { provider: 'second', model: 'other' }, displayName: 'Other', longContext: null },
];

function setup(resources: DisposableStore) {
	const services = resources.add(new InstantiationService());
	const changed = resources.add(new Emitter<void>());
	const enabled = new Set([modelRefIdentity(catalog[0].model)]);
	const writes: { provider: string; model: string; visible: boolean }[] = [];
	const source = {
		read: async (): Promise<readonly ModelCatalogEntry[]> => catalog,
		providers: async (): Promise<readonly ModelProviderCredentialStatus[]> =>
			[
				{ connection: 'first', provider: 'vendor-a', displayName: 'First Provider' },
				{ connection: 'second', provider: 'vendor-b', displayName: 'Second Provider' },
			] as ModelProviderCredentialStatus[],
		failWrite: false,
	};
	services.registerInstance(ILanguageModelsService, {
		onDidChangeModels: changed.event,
		listModelCatalog: () => source.read(),
		listModelProviders: () => source.providers(),
		isModelVisible: model => enabled.has(modelRefIdentity(model)),
		setModelVisible: async (model, visible) => {
			if (source.failWrite) {
				throw new Error('Write rejected');
			}
			writes.push({ ...model, visible });
			if (visible) {
				enabled.add(modelRefIdentity(model));
			} else {
				enabled.delete(modelRefIdentity(model));
			}
			changed.fire();
		},
	} as ILanguageModelsService);
	const view = resources.add(services.createInstance(ChatModelsViewModel));
	const models = (filter: string): ILanguageModelEntry[] => view.filter(filter).filter((entry): entry is ILanguageModelEntry => entry.type === 'model');
	return { view, source, changed, enabled, writes, models };
}

test('Catalog construction requires its domain service and refresh produces real splice events', async () => {
	using resources = new DisposableStore();
	const empty = resources.add(new InstantiationService());
	assert.throws(() => empty.createInstance(ChatModelsViewModel), /languageModelsService/);
	const { view } = setup(resources);
	const projection: IViewModelEntry[] = [];
	resources.add(
		view.onDidChange(event => {
			projection.splice(event.at, event.removed, ...event.added);
			assert.deepEqual(projection, view.viewModelEntries);
		}),
	);
	assert.equal(view.shouldRefilter(), true);
	await view.refresh();
	assert.equal(view.shouldRefilter(), false);
	assert.equal(projection.filter(entry => entry.type === 'model').length, 3);
	assert.equal(projection.filter(isLanguageModelProviderEntry).length, 2);
});

test('Catalog filters quoted provider names, OR providers, text and declared vision without inferring unknown capabilities', async () => {
	using resources = new DisposableStore();
	const { view, models } = setup(resources);
	await view.refresh();
	assert.deepEqual(
		models('@provider:"FIRST Provider"').map(entry => entry.model.model.model),
		['newest', 'older'],
	);
	assert.equal(models('@provider:first @provider:second').length, 3);
	assert.deepEqual(
		models('@provider:first @capability:vision "new model"').map(entry => entry.model.model.model),
		['newest'],
	);
	assert.equal(models('@capability:tools').length, 0);
	assert.equal(models('@capability:agent').length, 0);
	assert.equal(models('@capability:vision @provider:second').length, 0);
	assert.equal(models('first/older').length, 1);
	assert.equal(models('second provider').length, 1);
	assert.equal(models('  ').length, 3);
});

test('Group visibility is scoped by connection identity even when provider labels are identical', async () => {
	using resources = new DisposableStore();
	const { view, source, writes, models } = setup(resources);
	source.providers = async () =>
		['first', 'second'].map(connection => ({
			connection,
			provider: 'same-vendor',
			displayName: 'Same name',
		})) as ModelProviderCredentialStatus[];
	await view.refresh();
	const groups = view.viewModelEntries.filter(isLanguageModelProviderEntry);
	assert.equal(groups.length, 2);
	assert.notEqual(groups[0].id, groups[1].id);
	assert.deepEqual(
		view.getModelsForGroup(groups[0]).map(model => model.model.model),
		['newest', 'older'],
	);
	view.filter('@provider:first older');
	const filteredGroup = view.viewModelEntries.find(isLanguageModelProviderEntry)!;
	assert.equal(filteredGroup.hidden, false, 'A hidden search result does not hide another enabled model in the same connection');
	await view.toggleGroupHidden(filteredGroup);
	assert.deepEqual(
		writes.map(write => [write.provider, write.model, write.visible]),
		[
			['first', 'newest', false],
			['first', 'older', false],
		],
	);
	assert.equal(models('@provider:second')[0].model.hidden, true);
	await view.setModelsHidden(models('@provider:first'), false);
	assert.ok(models('@provider:first').every(entry => !entry.model.hidden));
});

test('Collapsing provider groups and searching uses one projection and preserves a surviving selection', async () => {
	using resources = new DisposableStore();
	const { view, models } = setup(resources);
	await view.refresh();
	view.selectedEntry = models('')[0];
	const id = view.selectedEntry.id;
	await view.refresh();
	assert.equal(view.selectedEntry?.id, id);
	view.collapseAll();
	assert.equal(view.viewModelEntries.filter(entry => entry.type === 'model').length, 0);
	const group = view.viewModelEntries.filter(isLanguageModelProviderEntry)[0];
	view.toggleCollapsed(group);
	assert.equal(view.viewModelEntries.filter(entry => entry.type === 'model').length, 2);
	assert.equal(models('other').length, 1, 'A new search expands its matching groups');
	view.collapseAll();
	assert.equal(view.viewModelEntries.filter(entry => entry.type === 'model').length, 0, 'Collapse remains effective while searching');
	assert.equal(models('').length, 3);
});

test('Catalog refresh is independent of a pending provider credential observation', async () => {
	using resources = new DisposableStore();
	const { view, source, models } = setup(resources);
	const providers = new DeferredPromise<readonly ModelProviderCredentialStatus[]>();
	source.providers = () => providers.p;
	await view.refresh();
	assert.equal(models('').length, 3);
	assert.deepEqual(
		view.getConfiguredVendors().map(provider => provider.group.vendor),
		['first', 'second'],
	);
	assert.deepEqual(
		view.getVendors().map(provider => provider.vendor),
		['first', 'second'],
	);
	await providers.complete([]);
});

test('Retired refresh results and failures cannot overwrite a successor catalog or a disposed model', async () => {
	using resources = new DisposableStore();
	const { view, source, models } = setup(resources);
	const first = new DeferredPromise<readonly ModelCatalogEntry[]>();
	source.read = () => first.p;
	const retired = view.refresh();
	source.read = async () => [catalog[2]];
	await view.refresh();
	await first.complete([catalog[0]]);
	await retired;
	assert.deepEqual(
		models('').map(entry => entry.model.displayName),
		['Other'],
	);
	const late = new DeferredPromise<readonly ModelCatalogEntry[]>();
	source.read = () => late.p;
	const pending = view.refresh();
	view.dispose();
	await late.complete(catalog);
	await pending;
	assert.deepEqual(
		view.viewModelEntries.filter(entry => entry.type === 'model').map(entry => entry.model.displayName),
		['Other'],
	);
});

test('A failed refresh keeps the last catalog with an error status and a failed visibility write keeps service truth', async () => {
	using resources = new DisposableStore();
	const { view, source, models } = setup(resources);
	await view.refresh();
	source.read = async () => {
		throw new Error('Offline');
	};
	await assert.rejects(view.refresh(), /Offline/);
	assert.equal(view.viewModelEntries.filter(entry => entry.type === 'model').length, 3);
	assert.ok(view.viewModelEntries.some(isStatusEntry));
	source.failWrite = true;
	const entry = models('newest')[0];
	await assert.rejects(view.toggleModelHidden(entry), /Write rejected/);
	assert.equal(models('newest')[0].model.hidden, false);
});

test('Model hover exposes supplied identity, description and context without fabricated pricing or capabilities', async () => {
	using resources = new DisposableStore();
	const { view, models } = setup(resources);
	await view.refresh();
	const hover = getModelHoverContent(models('newest')[0].model);
	using rendered = renderMarkdown(hover, { ownerDocument: browserEnvironment.window.document });
	const text = rendered.element.textContent!.replaceAll('\u00a0', ' ');
	assert.ok(text.includes('A supplied description.'));
	assert.ok(text.includes('128,000'));
	assert.equal(hover.isTrusted, false);
	assert.doesNotMatch(hover.value, /credits|cost|tool calling/iu);
});
