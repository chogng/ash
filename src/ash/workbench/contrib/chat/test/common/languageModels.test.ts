import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event, Emitter } from '../../../../../base/common/event.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { AccountDto, AccountReadResult, ModelListResult, ProviderListResult, ProviderModelsListResult, ServerNotification } from '../../../../../../../.build/protocol/typescript/index.js';
import { IAppServerApi, IServerEventApi, type AppServerConnectionState } from '../../../../../platform/agentHost/common/appServerApi.js';
import { IModelApi } from '../../../../../platform/sessions/common/sessionApi.js';
import type { IAccountApi } from '../../../../../platform/accounts/common/accountApi.js';
import { IAccountService } from '../../../../../platform/accounts/common/accountService.js';
import { AppServerAccountService } from '../../../../services/accounts/browser/appServerAccountService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { LanguageModelsService } from '../../common/languageModels.js';
import { ILanguageModelsConfigurationService } from '../../common/languageModelsConfiguration.js';

test('retirement-only catalog changes notify consumers and keep date-only evidence intact', async () => {
	const resources = new DisposableStore();
	try {
		const entry = modelEntry();
		const models = resources.add(new LanguageModelsService(
			{ listModels: async () => ({ models: [entry] }), listProviders: async () => ({ providers: [] }) } as unknown as IModelApi,
			{ onConnectionState: () => ({ dispose() { } }) } as unknown as IAppServerApi,
			{ subscribe: () => ({ dispose() { } }) } as unknown as IServerEventApi,
			{ onDidChangeModels: Event.None } as unknown as ILanguageModelsConfigurationService,
			{ onDidChangeAccounts: Event.None, read: async () => ({ revision: 1n, accounts: [] }) } as unknown as IAccountService,
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

function modelEntry(model = 'example', provider = 'openai'): ModelListResult['models'][number] {
	return {
		model: { provider, model },
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
		{ onDidChangeAccounts: Event.None, read: async () => ({ revision: 1n, accounts: [] }) } as unknown as IAccountService,
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

function catalogFixture(resources: DisposableStore, omitAccounts = false) {
	const events = resources.add(new Emitter<ServerNotification>());
	const states = resources.add(new Emitter<AppServerConnectionState>());
	const services = resources.add(new InstantiationService());
	const source = {
		generation: 1,
		catalog: [modelEntry('initial')],
		providers: [{ provider: 'openai', connection: 'chatgpt-subscription', access: 'subscription', active: true, configured: true, ready: true, displayName: 'ChatGPT', apiKeyPolicy: 'unsupported', apiKeyConfigured: false }] as ProviderListResult['providers'],
		catalogReads: 0,
		providerReads: 0,
		account: accountRead(),
		accountReads: 0,
		readAccount: undefined as (() => Promise<AccountReadResult>) | undefined,
		discoveries: [] as string[],
		selectionWrites: 0,
		configWrites: 0,
		changes: 0,
		readCatalog: undefined as (() => Promise<ModelListResult>) | undefined,
		readDiscovery: undefined as ((connection: string) => Promise<ModelListResult['models']>) | undefined,
	};
	services.registerInstance(IAppServerApi, {
		get connectionGeneration() { return source.generation; },
		getConnectionState: async () => 'ready',
		getSlashCommands: async () => [],
		onConnectionState: states.event,
	});
	services.registerInstance(IServerEventApi, { subscribe: events.event });
	if (!omitAccounts) {
		services.registerInstance(IAccountService, resources.add(new AppServerAccountService({
			read: async () => { source.accountReads++; return source.readAccount ? source.readAccount() : source.account; },
		} as IAccountApi, { subscribe: events.event })));
	}
	services.registerInstance(IModelApi, {
		listModels: async () => { source.catalogReads++; return source.readCatalog ? source.readCatalog() : { models: source.catalog }; },
		listProviders: async () => { source.providerReads++; return { providers: source.providers }; },
		listProviderModels: async (connection: string) => { source.discoveries.push(connection); return source.readDiscovery ? source.readDiscovery(connection) : []; },
		setModel: async () => { source.configWrites++; },
	} as unknown as IModelApi);
	services.registerInstance(ILanguageModelsConfigurationService, {
		onDidChangeModels: Event.None,
		isModelVisible: () => true,
		setModelVisible: async () => { source.selectionWrites++; },
		getDefaultNewChatModel: () => undefined,
		rememberSelectedModel: () => { source.selectionWrites++; },
	});
	const models = resources.add(services.createInstance(LanguageModelsService));
	resources.add(models.onDidChangeModels(() => { source.changes++; }));
	return { source, models, events, states };
}

function modelsUpdated(result: ProviderModelsListResult = { type: 'empty' }): ServerNotification {
	return {
		method: 'provider/models/updated',
		params: { connection: 'chatgpt-subscription', accountId: 'account-a', organization: null, plan: 'Plus', result },
	};
}

function accountRead(update: Partial<AccountDto> = {}): AccountReadResult {
	return {
		revision: '1',
		accounts: [{ provider: 'chatgpt-subscription', accountId: 'account-a', email: null, displayName: null, organization: null, plan: 'Plus', status: 'ready', credentialRevision: '1', ...update }],
	};
}

function accountUpdate(update: Partial<AccountDto> = {}): ServerNotification {
	return { method: 'account/updated', params: { account: accountRead(update) } };
}

async function settleCatalogEvents(): Promise<void> {
	await new Promise<void>(resolve => setImmediate(resolve));
}

test('provider model notifications reread the authoritative catalog and provider state', async () => {
	using resources = new DisposableStore();
	const { source, models, events } = catalogFixture(resources);
	await models.listModelCatalog();
	source.catalog = [modelEntry('current'), modelEntry('unrelated', 'other')];
	events.fire(modelsUpdated({ type: 'models', models: [modelEntry('payload-only')] }));
	await settleCatalogEvents();
	assert.deepEqual({ models: (await models.listModelCatalog()).map(entry => entry.model), reads: [source.catalogReads, source.providerReads], writes: [source.configWrites, source.selectionWrites] }, {
		models: [{ provider: 'openai', model: 'current' }, { provider: 'other', model: 'unrelated' }], reads: [2, 2], writes: [0, 0],
	});
});

for (const result of [{ type: 'empty' }, { type: 'failed', failure: { code: 'rateLimited' } }] as const) {
	test(`${result.type} model notifications preserve backend catalog meaning instead of replacing the global array`, async () => {
		using resources = new DisposableStore();
		const { source, models, events } = catalogFixture(resources);
		await models.listModelCatalog();
		source.catalog = [modelEntry('bundled')];
		events.fire(modelsUpdated(result));
		await settleCatalogEvents();
		assert.deepEqual({ names: (await models.listModels()).map(entry => entry.model.model), reads: source.catalogReads }, { names: ['bundled'], reads: 2 });
	});
}

test('an authoritative empty catalog removes rows instead of retaining them as a failed refresh', async () => {
	using resources = new DisposableStore();
	const { source, models, events } = catalogFixture(resources);
	await models.listModels();
	const changes = source.changes;
	source.catalog = [];
	events.fire(modelsUpdated());
	await settleCatalogEvents();
	assert.deepEqual(await models.listModels(), []);
	assert.equal(source.changes, changes + 1);
});

test('identical authoritative refreshes stay quiet', async () => {
	using resources = new DisposableStore();
	const { source, models, events } = catalogFixture(resources);
	await models.listModelCatalog();
	const changes = source.changes;
	events.fire(modelsUpdated());
	await settleCatalogEvents();
	assert.deepEqual({ changes: source.changes, reads: source.catalogReads }, { changes, reads: 2 });
});

test('a notification at the load completion boundary schedules a fresh authoritative read', async () => {
	using resources = new DisposableStore();
	const { source, models, events } = catalogFixture(resources);
	let queued = false;
	resources.add(models.onDidChangeModels(() => {
		if (queued) { return; }
		queued = true;
		source.catalog = [modelEntry('latest')];
		queueMicrotask(() => events.fire(modelsUpdated()));
	}));
	await models.refreshModels();
	await settleCatalogEvents();
	assert.deepEqual({ names: (await models.listModels()).map(entry => entry.model.model), reads: [source.catalogReads, source.providerReads] }, { names: ['latest'], reads: [2, 2] });
});

test('simultaneous retired and current completions leave the open picker on the current account', async () => {
	using resources = new DisposableStore();
	const { source, models, events } = catalogFixture(resources);
	const old = new DeferredPromise<ModelListResult>();
	source.readCatalog = () => old.p;
	let displayed: string[] = [];
	const retired = models.listModels().then(entries => { displayed = entries.map(entry => entry.model.model); });
	resources.add(models.onDidChangeModels(() => {
		void models.listModels().then(entries => { displayed = entries.map(entry => entry.model.model); });
	}));
	const current = new DeferredPromise<ModelListResult>();
	source.readCatalog = () => current.p;
	events.fire(accountUpdate({ accountId: 'account-b' }));
	void old.complete({ models: [modelEntry('old-account')] });
	void current.complete({ models: [modelEntry('current-account')] });
	await retired;
	await settleCatalogEvents();
	assert.deepEqual(displayed, ['current-account']);
});

for (const rejects of [false, true]) {
	test(`notifications during a load retire its ${rejects ? 'failure' : 'snapshot'} and coalesce a fresh read`, async () => {
		using resources = new DisposableStore();
		const { source, models, events } = catalogFixture(resources);
		await models.listModelCatalog();
		const pending = new DeferredPromise<ModelListResult>();
		source.readCatalog = () => pending.p;
		const refresh = models.refreshModels();
		source.readCatalog = undefined;
		source.catalog = [modelEntry('latest')];
		events.fire(modelsUpdated());
		events.fire(modelsUpdated());
		if (rejects) await pending.error(new Error('Retired catalog read'));
		else await pending.complete({ models: [modelEntry('obsolete')] });
		const refreshed = await refresh;
		assert.deepEqual({ names: refreshed.map(entry => entry.model.model), reads: source.catalogReads, changes: source.changes }, { names: ['latest'], reads: 3, changes: 2 });
	});
}

test('a reconnect can load immediately and old completion cannot publish or clear its successor', async () => {
	using resources = new DisposableStore();
	const { source, models, states } = catalogFixture(resources);
	await models.listModelCatalog();
	const old = new DeferredPromise<ModelListResult>();
	source.readCatalog = () => old.p;
	const retired = models.refreshModels();
	states.fire('crashed');
	source.generation++;
	const current = new DeferredPromise<ModelListResult>();
	source.readCatalog = () => current.p;
	states.fire('ready');
	const fresh = models.refreshModels();
	await old.complete({ models: [modelEntry('retired')] });
	await settleCatalogEvents();
	const joined = models.refreshModels();
	await current.complete({ models: [modelEntry('restored')] });
	assert.deepEqual((await retired).map(entry => entry.model.model), ['restored']);
	assert.deepEqual({ fresh: (await fresh).map(entry => entry.model.model), joined: (await joined).map(entry => entry.model.model), reads: source.catalogReads }, { fresh: ['restored'], joined: ['restored'], reads: 3 });
});

test('connection generation changes cannot return a previous cached scope even without a state callback', async () => {
	using resources = new DisposableStore();
	const { source, models } = catalogFixture(resources);
	await models.listModels();
	const pending = new DeferredPromise<ModelListResult>();
	source.readCatalog = () => pending.p;
	const retired = models.refreshModels();
	source.generation++;
	await pending.complete({ models: [modelEntry('retired')] });
	assert.deepEqual(await retired, []);
	assert.deepEqual(await models.listModels(), []);
});

test('an account boundary queued by acceptance gives the original caller the successor scope', async () => {
	using resources = new DisposableStore();
	const { source, models, events } = catalogFixture(resources);
	let queued = false;
	resources.add(models.onDidChangeModels(() => {
		if (queued) { return; }
		queued = true;
		source.catalog = [modelEntry('successor')];
		queueMicrotask(() => events.fire(accountUpdate({ accountId: 'account-b' })));
	}));
	assert.deepEqual((await models.refreshModels()).map(entry => entry.model.model), ['successor']);
});

test('a notification at the failure completion boundary is not lost', async () => {
	using resources = new DisposableStore();
	const { source, models, events } = catalogFixture(resources);
	await models.listModels();
	const pending = new DeferredPromise<ModelListResult>();
	source.readCatalog = () => pending.p;
	const refresh = models.refreshModels();
	await Promise.resolve();
	void pending.p.catch(() => queueMicrotask(() => queueMicrotask(() => events.fire(modelsUpdated()))));
	source.readCatalog = undefined;
	source.catalog = [modelEntry('latest')];
	await pending.error(new Error('Retired failed read'));
	await refresh;
	await settleCatalogEvents();
	assert.deepEqual({ names: (await models.listModels()).map(entry => entry.model.model), reads: source.catalogReads }, { names: ['latest'], reads: 3 });
});

test('disposing a pending catalog read rejects late data and does not start dynamic discovery', async () => {
	using resources = new DisposableStore();
	const { source, models } = catalogFixture(resources);
	const pending = new DeferredPromise<ModelListResult>();
	source.readCatalog = () => pending.p;
	source.providers = [{ provider: 'kimi', connection: 'kimi-desktop', access: 'local', active: true, configured: true, ready: true, displayName: 'Kimi', apiKeyPolicy: 'unsupported', apiKeyConfigured: false }];
	const result = models.refreshModels();
	const rejected = assert.rejects(result, error => isCancellationError(error));
	models.dispose();
	await pending.complete({ models: [modelEntry('late')] });
	await rejected;
	assert.deepEqual({ changes: source.changes, discoveries: source.discoveries }, { changes: 0, discoveries: [] });
});

for (const changed of [{ accountId: 'account-b' }, { organization: 'org-b' }, { plan: 'Pro' }, { status: 'reauthenticationRequired' }] as const) {
	test(`account scope changes clear prior selectable rows even when rereading fails (${Object.keys(changed)[0]})`, async () => {
		using resources = new DisposableStore();
		const { source, models, events } = catalogFixture(resources);
		events.fire(accountUpdate());
		await settleCatalogEvents();
		assert.deepEqual((await models.listModels()).map(entry => entry.model.model), ['initial']);
		let displayed = ['initial'];
		resources.add(models.onDidChangeModels(() => {
			void models.listModels().then(entries => { displayed = entries.map(entry => entry.model.model); }).catch(() => { });
		}));
		source.readCatalog = async () => { throw new Error('New account unavailable'); };
		events.fire(accountUpdate(changed));
		await settleCatalogEvents();
		assert.deepEqual(await models.listModels(), []);
		assert.deepEqual(displayed, []);
		assert.deepEqual([source.configWrites, source.selectionWrites], [0, 0]);
	});
}

test('same-account read failure keeps the last valid catalog without notifying a false empty result', async () => {
	using resources = new DisposableStore();
	const { source, models, events } = catalogFixture(resources);
	events.fire(accountUpdate());
	await settleCatalogEvents();
	const snapshot = await models.listModelCatalog();
	const changes = source.changes;
	source.readCatalog = async () => { throw new Error('Temporary catalog failure'); };
	events.fire(modelsUpdated({ type: 'failed', failure: { code: 'unreachable' } }));
	await settleCatalogEvents();
	assert.equal(await models.listModelCatalog(), snapshot);
	assert.equal(source.changes, changes);
});

test('same-account credential rotation retains usable model metadata when rereading fails', async () => {
	using resources = new DisposableStore();
	const { source, models, events } = catalogFixture(resources);
	events.fire(accountUpdate());
	await settleCatalogEvents();
	const snapshot = await models.listModelCatalog();
	const changes = source.changes;
	source.readCatalog = async () => { throw new Error('Temporary refresh failure'); };
	events.fire(accountUpdate({ credentialRevision: '2' }));
	await settleCatalogEvents();
	assert.equal(await models.listModelCatalog(), snapshot);
	assert.equal(source.changes, changes);
});

test('an unrelated GitHub account update cannot clear the model catalog after a failed reread', async () => {
	using resources = new DisposableStore();
	const { source, models, events } = catalogFixture(resources);
	const initial = accountUpdate();
	assert.equal(initial.method, 'account/updated');
	if (initial.method !== 'account/updated') { throw new Error('Expected account snapshot'); }
	events.fire(initial);
	await settleCatalogEvents();
	const snapshot = await models.listModelCatalog();
	const changes = source.changes;
	source.readCatalog = async () => { throw new Error('Temporary refresh failure'); };
	events.fire({ method: 'account/updated', params: { account: { revision: '2', accounts: [...initial.params.account.accounts, { provider: 'github', accountId: 'github-user', email: null, displayName: null, organization: null, plan: null, status: 'ready', credentialRevision: '1' }] } } });
	await settleCatalogEvents();
	assert.equal(await models.listModelCatalog(), snapshot);
	events.fire(initial);
	await settleCatalogEvents();
	assert.equal(await models.listModelCatalog(), snapshot);
	assert.equal(source.changes, changes);
});

for (const rejects of [false, true]) {
	test(`account changes retire old ${rejects ? 'failures' : 'results'} without giving an older caller old-account models`, async () => {
		using resources = new DisposableStore();
		const { source, models, events } = catalogFixture(resources);
		events.fire(accountUpdate());
		await settleCatalogEvents();
		const old = new DeferredPromise<ModelListResult>();
		source.readCatalog = () => old.p;
		const retired = models.refreshModels();
		source.readCatalog = undefined;
		source.catalog = [modelEntry('new-account')];
		events.fire(accountUpdate({ accountId: 'account-b' }));
		await settleCatalogEvents();
		if (rejects) await old.error(new Error('Retired account unavailable'));
		else await old.complete({ models: [modelEntry('old-account')] });
		assert.deepEqual((await retired).map(entry => entry.model.model), ['new-account']);
	});
}

test('logging out publishes an empty selectable view before a failing catalog read completes', async () => {
	using resources = new DisposableStore();
	const { source, models, events } = catalogFixture(resources);
	events.fire(accountUpdate());
	await settleCatalogEvents();
	source.readCatalog = async () => { throw new Error('Signed out'); };
	events.fire({ method: 'account/updated', params: { account: { revision: '2', accounts: [] } } });
	await settleCatalogEvents();
	assert.deepEqual(await models.listModels(), []);
});

test('login completion updates the catalog while a duplicate account update stays quiet', async () => {
	using resources = new DisposableStore();
	const { source, models, events } = catalogFixture(resources);
	events.fire(accountUpdate());
	await settleCatalogEvents();
	const updated = accountUpdate({ accountId: 'account-b' });
	if (updated.method !== 'account/updated') { throw new Error('Expected account snapshot'); }
	source.catalog = [modelEntry('signed-in')];
	events.fire({ method: 'account/login/completed', params: { loginId: 'login-b', status: { type: 'succeeded' }, account: updated.params.account } });
	await settleCatalogEvents();
	const changes = source.changes;
	events.fire(updated);
	await settleCatalogEvents();
	assert.deepEqual((await models.listModels()).map(entry => entry.model.model), ['signed-in']);
	assert.equal(source.changes, changes);
	assert.deepEqual([source.configWrites, source.selectionWrites], [0, 0]);
});

test('failed login with the same model account does not clear usable catalog metadata', async () => {
	using resources = new DisposableStore();
	const { source, models, events } = catalogFixture(resources);
	const initial = accountUpdate();
	if (initial.method !== 'account/updated') { throw new Error('Expected account snapshot'); }
	events.fire(initial);
	await settleCatalogEvents();
	const snapshot = await models.listModelCatalog();
	const changes = source.changes;
	source.readCatalog = async () => { throw new Error('Temporary refresh failure'); };
	events.fire({ method: 'account/login/completed', params: { loginId: 'login-failed', status: { type: 'failed', failure: { code: 'cancelled', message: 'Cancelled' } }, account: initial.params.account } });
	await settleCatalogEvents();
	assert.equal(await models.listModelCatalog(), snapshot);
	assert.equal(source.changes, changes);
});

test('API key changes retire pending data and notify even when the new credential read fails', async () => {
	using resources = new DisposableStore();
	const { source, models, events } = catalogFixture(resources);
	await models.listModelCatalog();
	const old = new DeferredPromise<ModelListResult>();
	source.readCatalog = () => old.p;
	const retired = models.refreshModels();
	source.readCatalog = async () => { throw new Error('New credential unavailable'); };
	events.fire({ method: 'provider/apiKey/changed', params: { connection: 'openai-api', apiKeyConfigured: true } });
	await settleCatalogEvents();
	await old.complete({ models: [modelEntry('old-credential')] });
	assert.deepEqual(await retired, []);
	const changes = source.changes;
	events.fire({ method: 'provider/apiKey/changed', params: { connection: 'openai-api', apiKeyConfigured: false } });
	await settleCatalogEvents();
	assert.equal(source.changes, changes + 1);
	assert.deepEqual(await models.listModels(), []);
	assert.deepEqual([source.configWrites, source.selectionWrites], [0, 0]);
});

test('provider-only readiness changes notify consumers even when model metadata is identical', async () => {
	using resources = new DisposableStore();
	const { source, models, events } = catalogFixture(resources);
	source.providers = [{ provider: 'openai', connection: 'openai-api', access: 'apiKey', active: true, configured: true, ready: false, displayName: 'OpenAI', apiKeyPolicy: 'required', apiKeyConfigured: false }];
	await models.listModelCatalog();
	const changes = source.changes;
	source.providers = source.providers.map(provider => ({ ...provider, ready: true, apiKeyConfigured: true }));
	events.fire(modelsUpdated());
	await settleCatalogEvents();
	assert.equal(source.changes, changes + 1);
	events.fire(modelsUpdated());
	await settleCatalogEvents();
	assert.equal(source.changes, changes + 1);
});

for (const event of [
	accountUpdate({ credentialRevision: '2' }),
	{ method: 'account/login/completed', params: { loginId: 'first-login', status: { type: 'failed', failure: { code: 'cancelled', message: 'Cancelled' } }, account: accountRead() } },
] satisfies ServerNotification[]) {
	test(`the first same-account ${event.method} keeps a loaded catalog when rereading fails`, async () => {
		using resources = new DisposableStore();
		const { source, models, events } = catalogFixture(resources);
		const snapshot = await models.listModelCatalog();
		const changes = source.changes;
		source.readCatalog = async () => { throw new Error('Temporary catalog failure'); };
		events.fire(event);
		await settleCatalogEvents();
		assert.equal(await models.listModelCatalog(), snapshot);
		assert.deepEqual({ changes: source.changes, accountReads: source.accountReads, catalogReads: source.catalogReads }, { changes, accountReads: 1, catalogReads: 2 });
	});
}

test('the first unrelated account event keeps a loaded catalog when rereading fails', async () => {
	using resources = new DisposableStore();
	const { source, models, events } = catalogFixture(resources);
	const snapshot = await models.listModelCatalog();
	const changes = source.changes;
	source.readCatalog = async () => { throw new Error('Temporary catalog failure'); };
	events.fire({ method: 'account/updated', params: { account: { revision: '2', accounts: [...source.account.accounts, { provider: 'github', accountId: 'github-user', email: null, displayName: null, organization: null, plan: null, status: 'ready', credentialRevision: '1' }] } } });
	await settleCatalogEvents();
	assert.equal(await models.listModelCatalog(), snapshot);
	assert.deepEqual({ changes: source.changes, accountReads: source.accountReads, catalogReads: source.catalogReads }, { changes, accountReads: 1, catalogReads: 2 });
});

test('the first changed model account clears a loaded catalog before a failing reread', async () => {
	using resources = new DisposableStore();
	const { source, models, events } = catalogFixture(resources);
	await models.listModels();
	source.readCatalog = async () => { throw new Error('New account unavailable'); };
	events.fire(accountUpdate({ accountId: 'account-b' }));
	const immediate = await models.listModels();
	await settleCatalogEvents();
	assert.deepEqual({ immediate, settled: await models.listModels() }, { immediate: [], settled: [] });
});

test('an initial account snapshot gates catalog acceptance and cannot replace a changed account', async () => {
	using resources = new DisposableStore();
	const { source, models, events } = catalogFixture(resources);
	const account = new DeferredPromise<AccountReadResult>();
	const catalog = new DeferredPromise<ModelListResult>();
	source.readAccount = () => account.p;
	source.readCatalog = () => catalog.p;
	let completed = false;
	const pending = models.listModels().then(entries => { completed = true; return entries; });
	await catalog.complete({ models: [modelEntry('old-account')] });
	await settleCatalogEvents();
	const acceptedBeforeAccount = completed;
	source.catalog = [modelEntry('new-account')];
	source.readCatalog = undefined;
	events.fire(accountUpdate({ accountId: 'account-b' }));
	await settleCatalogEvents();
	await account.complete(accountRead());
	const current = await pending;
	source.readCatalog = async () => { throw new Error('Temporary catalog failure'); };
	events.fire(accountUpdate({ accountId: 'account-b', credentialRevision: '2' }));
	await settleCatalogEvents();
	assert.deepEqual({ acceptedBeforeAccount, returned: current.map(entry => entry.model.model), retained: (await models.listModels()).map(entry => entry.model.model) }, { acceptedBeforeAccount: false, returned: ['new-account'], retained: ['new-account'] });
});

for (const rejects of [false, true]) {
	test(`a reconnected catalog ignores an old account snapshot ${rejects ? 'failure' : 'completion'}`, async () => {
		using resources = new DisposableStore();
		const { source, models, events, states } = catalogFixture(resources);
		const account = new DeferredPromise<AccountReadResult>();
		void account.p.catch(() => { });
		source.readAccount = () => account.p;
		const retired = models.listModels();
		states.fire('crashed');
		source.generation++;
		source.readAccount = undefined;
		source.account = accountRead({ accountId: 'account-b' });
		source.catalog = [modelEntry('restored')];
		states.fire('ready');
		await settleCatalogEvents();
		if (rejects) await account.error(new Error('Retired account read'));
		else await account.complete(accountRead());
		const current = await retired;
		source.readCatalog = async () => { throw new Error('Temporary catalog failure'); };
		events.fire(accountUpdate({ accountId: 'account-b', credentialRevision: '2' }));
		await settleCatalogEvents();
		assert.deepEqual({ returned: current.map(entry => entry.model.model), retained: (await models.listModels()).map(entry => entry.model.model) }, { returned: ['restored'], retained: ['restored'] });
	});
}

test('a failed initial account read cannot publish an unscoped catalog and can retry', async () => {
	using resources = new DisposableStore();
	const { source, models } = catalogFixture(resources);
	source.readAccount = async () => { throw new Error('Account snapshot unavailable'); };
	let failure: unknown;
	try { await models.listModels(); } catch (error) { failure = error; }
	const changesBeforeRetry = source.changes;
	source.readAccount = undefined;
	assert.deepEqual({ failure: failure instanceof Error ? failure.message : undefined, changesBeforeRetry, recovered: (await models.listModels()).map(entry => entry.model.model), accountReads: source.accountReads }, { failure: 'Account snapshot unavailable', changesBeforeRetry: 0, recovered: ['initial'], accountReads: 2 });
});

test('model catalog creation rejects a missing required account service', () => {
	using resources = new DisposableStore();
	assert.throws(() => catalogFixture(resources, true), { message: `Unknown service: ${IAccountService.description}` });
});
