import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { AgentToolsCatalog } from '../../../../../../platform/agentHost/common/agentToolsApi.js';
import { createDisconnectedAgentToolsApi } from '../../../../../../platform/agentHost/browser/agentToolsApi.js';
import { IAgentToolsApi } from '../../../../../../platform/agentHost/common/agentToolsApi.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { unavailableOperation, WebAppServerUnavailableError } from '../../../../../../platform/renderer/browser/disconnectedHost.js';
import { LanguageModelToolsService } from '../../../browser/tools/languageModelToolsService.js';
import { createDisconnectedAppServerApi } from '../../../../../../platform/agentHost/browser/appServerApi.js';
import { IAppServerApi } from '../../../../../../platform/agentHost/common/appServerApi.js';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { isCancellationError } from '../../../../../../base/common/errors.js';
import { getSingletonServiceDescriptors } from '../../../../../../platform/instantiation/common/extensions.js';
import { ILanguageModelToolsService, isToolSet } from '../../../common/tools/languageModelToolsService.js';
import { createTestLanguageModelToolsService } from '../../common/tools/testLanguageModelToolsService.js';
import '../../../browser/chat.shared.contribution.js';

type TestCatalog = Omit<AgentToolsCatalog, 'sourceGroups'> & {
	sourceGroups: (Omit<AgentToolsCatalog['sourceGroups'][number], 'tools'> & { tools: string[] })[];
};

test('Tool catalog service requires its transport API and reads current backend tools without an environment snapshot', async () => {
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(LanguageModelToolsService), /Unknown service: agentToolsApi/);
	services.registerInstance(IAppServerApi, createDisconnectedAppServerApi(unavailableOperation));
	let catalog: TestCatalog = {
		tools: [
			{
				name: 'search_docs',
				description: 'Search documents',
				source: 'mcp',
				sourceChain: [
					{
						type: 'plugin',
						pluginId: 'docs',
						version: '1.0.0',
						packageDigest: `sha256:${'a'.repeat(64)}`,
						contributionId: 'mcp-docs',
					},
					{
						type: 'mcp',
						serverId: 'docs-server',
						remoteName: 'search',
						catalogGeneration: 1,
						connectionGeneration: 1,
					},
				],
				exposure: 'deferred',
				authority: 'providerDefined',
			},
		],
		toolSets: [],
		profiles: [],
		sourceGroups: [{ id: 'docs-set', source: 'mcp', sourceId: 'docs-server', tools: ['search_docs'] }],
	};
	let reads = 0;
	services.registerInstance(IAgentToolsApi, {
		isAvailable: true,
		onDidChangeTools: Event.None,
		read: async () => {
			reads++;
			return catalog;
		},
	});
	using service = services.createInstance(LanguageModelToolsService);
	assert.equal(service.isAvailable, true);
	await service.refresh();
	const first = [...service.getAllToolsIncludingDisabled()];
	const set = [...service.toolSets.get()][0]!;
	assert.deepEqual(first, [
		{
			id: 'search_docs',
			toolReferenceName: 'search_docs',
			displayName: 'search_docs',
			modelDescription: 'Search documents',
			canBeReferencedInPrompt: true,
			category: undefined,
			source: 'mcp',
			sourceDetails: ['docs@1.0.0', 'docs-server'],
			exposure: 'deferred',
			authority: 'providerDefined',
		},
	]);
	assert.equal([...set.getTools()][0], first[0], 'Tool sets return the catalog object, not a second copy');
	catalog.sourceGroups[0]!.tools.push('new_tool');
	catalog = { tools: [], toolSets: [], profiles: [], sourceGroups: [] };
	await service.refresh();
	assert.deepEqual([...service.getAllToolsIncludingDisabled()], []);
	assert.deepEqual([...service.toolSets.get()], []);
	assert.equal(reads, 2);
	assert.deepEqual(
		[...set.getTools()].map(tool => tool.id),
		['search_docs'],
		'A new backend catalog must not mutate an open picker snapshot',
	);
});

test('Disconnected hosts expose unavailable tools and preserve the host error', async () => {
	using services = new InstantiationService();
	services.registerInstance(IAgentToolsApi, createDisconnectedAgentToolsApi(unavailableOperation));
	services.registerInstance(IAppServerApi, createDisconnectedAppServerApi(unavailableOperation));
	using service = services.createInstance(LanguageModelToolsService);
	assert.equal(service.isAvailable, false);
	await assert.rejects(service.refresh(), WebAppServerUnavailableError);
});

test('Tool catalog read failures propagate and a later read can recover', async () => {
	using services = new InstantiationService();
	const failure = new Error('Catalog unavailable');
	services.registerInstance(IAppServerApi, createDisconnectedAppServerApi(unavailableOperation));
	let fail = true;
	services.registerInstance(IAgentToolsApi, {
		isAvailable: true,
		onDidChangeTools: Event.None,
		read: async () => {
			if (fail) throw failure;
			return { tools: [], toolSets: [], profiles: [], sourceGroups: [] };
		},
	});
	using service = services.createInstance(LanguageModelToolsService);
	await assert.rejects(service.refresh(), error => error === failure);
	fail = false;
	await service.refresh();
	assert.deepEqual([...service.getAllToolsIncludingDisabled()], []);
});

test('Shared contribution registers one delayed tools service with the real constructor', () => {
	const registrations = getSingletonServiceDescriptors().filter(([id]) => id === ILanguageModelToolsService);
	assert.equal(registrations.length, 1);
	assert.equal(registrations[0]![1].ctor, LanguageModelToolsService);
	assert.equal(registrations[0]![1].supportsDelayedInstantiation, true);
});

test('Backend invalidation refreshes the single catalog and collapses changes during an in-flight read', async () => {
	using invalidated = new Emitter<void>();
	const late = new DeferredPromise<TestCatalog>();
	const catalog = (name: string): TestCatalog => ({
		tools: [
			{
				name,
				description: name,
				source: 'local',
				sourceChain: [],
				exposure: 'direct',
				authority: 'directoryRead',
			},
		],
		toolSets: [],
		profiles: [],
		sourceGroups: [{ id: 'directory', source: 'local', sourceId: 'directory', tools: [name] }],
	});
	let reads = 0;
	using service = new LanguageModelToolsService(
		{
			isAvailable: true,
			onDidChangeTools: invalidated.event,
			read: async () => {
				reads++;
				return reads === 2 ? late.p : catalog(reads === 1 ? 'first' : 'current');
			},
		},
		createDisconnectedAppServerApi(unavailableOperation),
	);
	const observed: string[][] = [];
	using subscription = service.onDidChangeTools(() => observed.push([...service.getFullReferenceNames()]));
	invalidated.fire();
	assert.equal(reads, 0, 'Unopened catalogs load on demand');
	await service.refresh();
	invalidated.fire();
	assert.equal(reads, 2, 'Notification starts a real backend read');
	const refresh = service.refresh();
	invalidated.fire();
	invalidated.fire();
	await late.complete(catalog('stale'));
	await refresh;
	assert.equal(reads, 3, 'Multiple invalidations require only one follow-up read');
	assert.deepEqual(observed, [
		['first', 'local/directory'],
		['current', 'local/directory'],
	]);
	assert.equal(service.getToolByFullReferenceName('stale'), undefined);
	service.dispose();
	assert.equal(invalidated.hasListeners(), false);
	invalidated.fire();
	assert.equal(reads, 3);
});

test('References qualify external tools and tool sets, round-trip to catalog objects and retain backend ID aliases', async () => {
	using service = createTestLanguageModelToolsService({
		isAvailable: true,
		read: async () => ({
			tools: [
				{
					name: 'read_file',
					description: 'Read',
					source: 'local',
					sourceDetails: [],
					exposure: 'direct',
					authority: 'directoryRead',
				},
				{
					name: 'search_docs',
					description: 'Search',
					source: 'mcp',
					sourceDetails: ['docs/server'],
					exposure: 'deferred',
					authority: 'providerDefined',
				},
				{
					name: 'hidden',
					description: 'Hidden',
					source: 'mcp',
					sourceDetails: [],
					exposure: 'hidden',
					authority: 'providerDefined',
				},
				{
					name: 'model_only',
					description: 'Model',
					source: 'mcp',
					sourceDetails: [],
					exposure: 'modelOnly',
					authority: 'providerDefined',
				},
			],
			toolSets: [],
			profiles: [],
			sourceGroups: [
				{ id: 'local-set', source: 'local', sourceId: 'directory', tools: ['read_file'] },
				{
					id: 'mcp-set',
					source: 'mcp',
					sourceId: 'docs/server',
					tools: ['search_docs', 'hidden', 'model_only'],
				},
			],
		}),
	});
	await service.refresh();
	assert.deepEqual([...service.getFullReferenceNames()], ['read_file', 'mcp/docs%2Fserver/search_docs', 'local/directory', 'mcp/docs%2Fserver/*']);
	for (const name of service.getFullReferenceNames()) {
		const item = service.getToolByFullReferenceName(name)!;
		assert.equal(service.getFullReferenceName(item), name);
	}
	const tool = service.getToolByFullReferenceName('search_docs');
	assert.equal(tool, service.getToolByFullReferenceName('mcp/docs%2Fserver/search_docs'));
	const localSet = [...service.toolSets.get()][0]!;
	const localTool = [...localSet.getTools()][0]!;
	assert.equal(service.getToolByFullReferenceName(service.getFullReferenceName(localTool, localSet)), localTool);
	assert.equal(isToolSet(service.getToolByFullReferenceName('mcp/docs%2Fserver/*')), true);
	assert.equal(service.getToolByFullReferenceName('hidden'), undefined);
	assert.equal(service.getToolByFullReferenceName('model_only'), undefined);
	assert.equal(service.getToolByFullReferenceName('missing'), undefined);
	await service.refresh();
	assert.equal(service.getFullReferenceName(tool!), 'mcp/docs%2Fserver/search_docs', 'An open picker keeps qualified names after another consumer refreshes');
	assert.notEqual(service.getToolByFullReferenceName('mcp/docs%2Fserver/search_docs'), tool);
});

test('An unscoped source reference cannot shadow a backend tool ID or a literal marker source ID', async () => {
	using service = createTestLanguageModelToolsService({
		isAvailable: true,
		read: async () => ({
			tools: ['local', 'another'].map(name => ({
				name,
				description: name,
				source: 'local',
				sourceDetails: [],
				exposure: 'direct',
				authority: 'directoryRead',
			})),
			toolSets: [],
			profiles: [],
			sourceGroups: [
				{ id: 'unscoped', source: 'local', sourceId: '', tools: ['local'] },
				{ id: 'marker', source: 'local', sourceId: '@', tools: ['another'] },
			],
		}),
	});
	await service.refresh();
	assert.deepEqual([...service.getFullReferenceNames()], ['local', 'another', 'local/@', 'local/%40']);
	assert.equal(isToolSet(service.getToolByFullReferenceName('local')), false);
	assert.equal(service.getToolByFullReferenceName('local/@')?.id, 'unscoped');
	assert.equal(service.getToolByFullReferenceName('local/%40')?.id, 'marker');
});

for (const retire of ['disconnect', 'dispose'] as const) {
	test(`Concurrent refreshes share the backend read and a late reply cannot survive ${retire}`, async () => {
		using changed = new Emitter<'ready' | 'crashed'>();
		const pending = new DeferredPromise<TestCatalog>();
		let reads = 0;
		using service = new LanguageModelToolsService(
			{
				isAvailable: true,
				onDidChangeTools: Event.None,
				read: () => {
					reads++;
					return pending.p;
				},
			},
			{
				...createDisconnectedAppServerApi(unavailableOperation),
				onConnectionState: listener => changed.event(listener),
			},
		);
		const first = service.refresh();
		const second = service.refresh();
		assert.equal(first, second);
		assert.equal(reads, 1);
		const rejection = assert.rejects(first, isCancellationError);
		if (retire === 'disconnect') changed.fire('crashed');
		else service.dispose();
		await pending.complete({
			tools: [
				{
					name: 'late',
					description: 'Late',
					source: 'local',
					sourceChain: [],
					exposure: 'direct',
					authority: 'directoryRead',
				},
			],
			toolSets: [],
			profiles: [],
			sourceGroups: [],
		});
		await rejection;
		assert.deepEqual([...service.getAllToolsIncludingDisabled()], []);
	});
}

test('Tool sets observe actual snapshot replacement and a retired connection cannot overwrite a reconnected catalog', async () => {
	using changed = new Emitter<'ready' | 'crashed'>();
	const pending = new DeferredPromise<TestCatalog>();
	let generation = 1;
	let reads = 0;
	const catalog = (name: string): TestCatalog => ({
		tools: [
			{
				name,
				description: name,
				source: 'local',
				sourceChain: [],
				exposure: 'direct',
				authority: 'directoryRead',
			},
		],
		toolSets: [],
		profiles: [],
		sourceGroups: [{ id: 'directory', source: 'local', sourceId: '', tools: [name] }],
	});
	using service = new LanguageModelToolsService(
		{
			isAvailable: true,
			onDidChangeTools: Event.None,
			read: async () => {
				reads++;
				return reads === 2 ? pending.p : catalog(reads === 1 ? 'first' : 'current');
			},
		},
		{
			...createDisconnectedAppServerApi(unavailableOperation),
			get connectionGeneration() {
				return generation;
			},
			onConnectionState: listener => changed.event(listener),
		},
	);
	const observed: string[][] = [];
	using subscription = service.toolSets.onDidChange(sets => observed.push([...sets].flatMap(set => [...set.getTools()].map(tool => tool.id))));
	await service.refresh();
	const old = service.refresh();
	const rejected = assert.rejects(old, isCancellationError);
	changed.fire('crashed');
	assert.deepEqual([...service.getFullReferenceNames()], []);
	generation++;
	changed.fire('ready');
	await service.refresh();
	await pending.complete(catalog('retired'));
	await rejected;
	assert.deepEqual(
		[...service.getAllToolsIncludingDisabled()].map(tool => tool.id),
		['current'],
	);
	assert.deepEqual(observed, [['first'], [], ['current']]);
	assert.equal(service.getToolByFullReferenceName('retired'), undefined);
});

test('Capability sets compose catalog members without changing provider references', async () => {
	using service = new LanguageModelToolsService(
		{
			isAvailable: true,
			onDidChangeTools: Event.None,
			read: async () => ({
				tools: [
					{
						name: 'read_file',
						description: 'Read files',
						category: 'read',
						source: 'local',
						sourceChain: [],
						exposure: 'direct',
						authority: 'directoryRead',
					},
					{
						name: 'search_docs',
						description: 'Search docs',
						category: 'search',
						source: 'mcp',
						sourceChain: [],
						exposure: 'deferred',
						authority: 'providerDefined',
					},
				],
				sourceGroups: [{ id: 'docs', source: 'mcp', sourceId: 'docs', tools: ['search_docs'] }],
				toolSets: [{ id: 'product.research', tools: ['read_file', 'search_docs'] }],
				profiles: [
					{ id: 'code', sets: ['product.research'], status: 'ready' },
					{ id: 'design', sets: [], status: 'planned' },
				],
			}),
		},
		createDisconnectedAppServerApi(unavailableOperation),
	);
	await service.refresh();
	const sets = [...service.toolSets.get()];
	assert.deepEqual(
		sets.map(set => [set.id, set.kind]),
		[
			['docs', 'source'],
			['product.research', 'capability'],
		],
	);
	assert.deepEqual(
		[...sets[1]!.getTools()].map(tool => [tool.id, tool.category]),
		[
			['read_file', 'read'],
			['search_docs', 'search'],
		],
	);
	const search = service.getToolByFullReferenceName('search_docs')!;
	assert.equal(service.getFullReferenceName(search), 'mcp/docs/search_docs');
	assert.equal(service.getToolByFullReferenceName('product.research'), sets[1]);
	assert.equal([...sets[1]!.getTools()][1], search);
	assert.deepEqual(service.profiles.get(), [
		{ id: 'code', sets: ['product.research'], status: 'ready' },
		{ id: 'design', sets: [], status: 'planned' },
	]);
});
