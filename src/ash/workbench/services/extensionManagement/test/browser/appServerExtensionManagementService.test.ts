import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { ServerNotification } from '../../../../../../../.build/protocol/typescript/index.js';
import type { IServerEventApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import type { IExtensionManagementApi } from '../../../../../platform/extensionManagement/common/extensionManagementApi.js';
import { AppServerExtensionManagementService } from '../../browser/appServerExtensionManagementService.js';
import { ExtensionUiTarget } from '../../../../../platform/extensionManagement/common/extensionManagementService.js';

test('Extensions paged adapter preserves source, cursor and filters without keeping a second catalog', async () => {
	const requests: unknown[] = [];
	const summary = {
		id: 'example/review@ash',
		version: '1.0.0',
		packageType: 'skill',
		displayName: 'Review',
		description: 'Review changes.',
		uiTargets: ['agents' as const],
	};
	const api: Pick<IExtensionManagementApi, 'searchPage'> = {
		searchPage: async params => {
			requests.push(params);
			return { packages: [summary], total: 257n, nextCursor: 'backend-page-two' };
		},
	};
	using service = new AppServerExtensionManagementService(api as IExtensionManagementApi, { subscribe: () => ({ dispose() {} }) } as IServerEventApi);
	assert.deepEqual(
		await service.searchPage('review', {
			sourceId: 'signed',
			capabilityKind: 'skill',
			pageSize: 30,
			cursor: 'backend-page-one',
		}),
		{
			packages: [{ ...summary, uiTargets: [ExtensionUiTarget.Agents] }],
			total: 257,
			nextCursor: 'backend-page-two',
		},
	);
	assert.deepEqual(requests, [
		{
			query: 'review',
			sourceId: 'signed',
			capabilityKind: 'skill',
			pageSize: 30,
			cursor: 'backend-page-one',
			packageType: null,
			languageId: null,
		},
	]);
});

test('Extensions browse snapshots survive view recreation and invalidate after lifecycle changes', async () => {
	let searches = 0;
	const requests: Parameters<IExtensionManagementApi['search']>[0][] = [];
	let installedReads = 0;
	let eventListener: ((event: ServerNotification) => void) | undefined;
	const summary = {
		id: 'example/docs',
		version: '1.0.0',
		packageType: 'mcp',
		displayName: 'Docs',
		description: 'Documentation search.',
		uiTargets: ['ide' as const, 'agents' as const],
	};
	const packageReference = { id: summary.id, version: summary.version, digest: `sha256:${'a'.repeat(64)}` };
	const details = {
		package: packageReference,
		packageType: summary.packageType,
		displayName: summary.displayName,
		description: summary.description,
		license: 'MIT',
		source: 'thirdParty' as const,
		upstream: null,
		capabilities: [],
		uiTargets: summary.uiTargets,
	};
	const extension = { ...summary, id: 'example/editor@ash', packageType: 'editor' };
	const detailRequests: string[] = [];
	const installed = {
		installationId: 'installed-1',
		package: packageReference,
		state: 'installed' as const,
		capabilities: [],
	};
	const api = {
		recommendationEnvironment: async () => ({ platform: 'other', executables: [] }),
		searchPage: async () => {
			throw new Error('This test exercises the existing browse API');
		},
		builtInProviders: async () => ({ revision: 1, canChangeEnablement: true, providers: [] }),
		setBuiltInProviderEnablement: async () => {
			throw new Error('unused');
		},
		sources: async () => ({ revision: 0, sources: [] }),
		addSource: async () => ({ revision: 1, sources: [] }),
		setSourceEnabled: async () => ({ revision: 2, sources: [] }),
		editorExtensions: async () => ({ revision: 1, extensions: [] }),
		setEditorExtensionPolicy: async () => {
			throw new Error('unused');
		},
		search: async (params: Parameters<IExtensionManagementApi['search']>[0]) => {
			requests.push(params);
			searches += 1;
			return { packages: [summary, extension], unavailableSources: [] };
		},
		get: async (params: Parameters<IExtensionManagementApi['get']>[0]) => {
			detailRequests.push(params.packageId);
			return details;
		},
		download: async () => ({ id: 'artifact-1', package: packageReference }),
		install: async () => installed,
		update: async () => installed,
		uninstall: async () => {},
		listInstalled: async () => {
			installedReads += 1;
			return { instanceId: 'extensionManagement-runtime-1', generation: 1, packages: [] };
		},
		acquireCapability: async () => {
			throw new Error('unused');
		},
		releaseCapability: async () => {},
		openResource: async () => {
			throw new Error('unused');
		},
	} as IExtensionManagementApi;
	const events = {
		subscribe: (listener: (event: ServerNotification) => void) => {
			eventListener = listener;
			return {
				dispose: () => {
					eventListener = undefined;
				},
			};
		},
	} as IServerEventApi;
	using service = new AppServerExtensionManagementService(api, events);
	let installedChanges = 0;
	service.onDidChangeInstalled(() => installedChanges++);

	const first = await service.browse('', { limit: 100 });
	const reopened = await service.browse('', { limit: 100 });
	assert.equal(reopened, first);
	assert.equal(service.cachedBrowse('', { limit: 100 }), first);
	assert.equal(searches, 1);
	assert.equal(installedReads, 1);
	assert.deepEqual(first.packages[1]!.details, {
		...details,
		uiTargets: [ExtensionUiTarget.IDE, ExtensionUiTarget.Agents],
	});
	assert.deepEqual(first.packages[0]!.summary.uiTargets, [ExtensionUiTarget.IDE, ExtensionUiTarget.Agents]);
	assert.deepEqual(detailRequests, [summary.id, extension.id], 'browsing reads signed metadata for each Ash package');
	await service.get(extension.id, extension.version);
	assert.deepEqual(detailRequests, [summary.id, extension.id, extension.id], 'an explicit details refresh reads the selected Ash metadata');

	await service.install(summary.id, summary.version);
	assert.equal(installedChanges, 0);
	assert.equal(service.cachedBrowse('', { limit: 100 }), first);

	eventListener?.({
		method: 'extensions/changed',
		params: { instanceId: 'extensionManagement-runtime-1', generation: 2 },
	});
	assert.equal(installedChanges, 1);
	assert.equal(service.cachedBrowse('', { limit: 100 }), undefined);
	await service.browse('', { limit: 100 });
	assert.equal(searches, 2);
	assert.equal(installedReads, 2);

	eventListener?.({
		method: 'extensions/changed',
		params: { instanceId: 'extensionManagement-runtime-1', generation: 2 },
	});
	assert.equal(installedChanges, 1, 'replayed generations are ignored');

	eventListener?.({
		method: 'extensions/changed',
		params: { instanceId: 'extensionManagement-runtime-1', generation: 3 },
	});
	assert.equal(installedChanges, 2, 'another connection invalidates this service');

	eventListener?.({
		method: 'extensions/changed',
		params: { instanceId: 'extensionManagement-runtime-2', generation: 1 },
	});
	assert.equal(installedChanges, 3, 'a restarted authority accepts its lower initial generation');
	const skills = await service.browse('', { capabilityKind: 'skill' });
	const lsp = await service.browse('', { capabilityKind: 'executable', languageId: 'typescriptreact' });
	assert.notEqual(skills, lsp);
	assert.equal(await service.browse('', { capabilityKind: 'skill' }), skills);
	assert.deepEqual(requests.slice(-2), [
		{ query: '', packageType: null, limit: null, capabilityKind: 'skill', languageId: null },
		{ query: '', packageType: null, limit: null, capabilityKind: 'executable', languageId: 'typescriptreact' },
	]);
	await service.addSource(
		{
			sourceId: 'vendor',
			metadataBaseUrl: 'https://vendor.example/metadata/',
			targetsBaseUrl: 'https://vendor.example/targets/',
			trustedRootJson: '{}',
		},
		0,
	);
	assert.equal(service.cachedBrowse('', { capabilityKind: 'skill' }), undefined, 'source changes invalidate browsing before a notification arrives');
	await service.browse('', { capabilityKind: 'skill' });
	await service.setSourceEnabled('vendor', false, 1);
	assert.equal(service.cachedBrowse('', { capabilityKind: 'skill' }), undefined, 'pausing a source cannot reuse its cached search results');
});

test('Legacy summaries and details keep their missing UI declaration through the adapter', async () => {
	const summary = {
		id: 'example/legacy@ash',
		version: '1.0.0',
		packageType: 'editor',
		displayName: 'Legacy',
		description: 'No window declaration.',
	};
	const details = {
		package: { id: summary.id, version: summary.version, digest: 'digest' },
		packageType: summary.packageType,
		displayName: summary.displayName,
		description: summary.description,
		license: 'MIT',
		source: 'official' as const,
		upstream: null,
		capabilities: [],
	};
	const api: Pick<IExtensionManagementApi, 'search' | 'get'> = {
		search: async () => ({ packages: [summary], unavailableSources: [] }),
		get: async () => details,
	};
	using service = new AppServerExtensionManagementService(api as IExtensionManagementApi, { subscribe: () => ({ dispose() {} }) } as IServerEventApi);
	assert.deepEqual(await service.search('legacy'), [summary]);
	assert.deepEqual(await service.get(summary.id), details);
});

test('Tool recommendations read the current host through the API without keeping a second environment snapshot', async () => {
	let executables = ['python3'];
	const api: Pick<IExtensionManagementApi, 'recommendationEnvironment'> = {
		recommendationEnvironment: async () => ({ platform: 'linux', executables }),
	};
	using service = new AppServerExtensionManagementService(api as IExtensionManagementApi, { subscribe: () => ({ dispose() {} }) } as IServerEventApi);
	assert.deepEqual(await service.recommendationEnvironment(), { platform: 'linux', executables: ['python3'] });
	executables = ['node'];
	assert.deepEqual(await service.recommendationEnvironment(), { platform: 'linux', executables: ['node'] });
});
