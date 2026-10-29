import type { IExtensionManagementService, ExtensionsBuiltInProviders } from '../../../extensionManagement/common/extensionManagementService.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import type { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import type { IResourceApi } from '../../../agentHost/common/appServerApi.js';
import type { ExtensionCatalog, ExtensionResourceRequest, IExtensionApi } from '../../common/extensionApi.js';
import { createAppServerExtensionApi, createDisconnectedExtensionApi, withEnabledBuiltInExtensions } from '../../browser/extensionApi.js';
import { Event } from '../../../../base/common/event.js';
import { ExtensionResourceLoaderService } from '../../../extensionResourceLoader/browser/extensionResourceLoaderService.js';
import { unavailableOperation, WebAppServerUnavailableError } from '../../../renderer/browser/disconnectedHost.js';
import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { normalizeExtensionCatalog } from '../../common/extensionApi.js';

test('normalizes an extension catalog and preserves explicit diagnostics', () => {
	const catalog = normalizeExtensionCatalog({
		generation: 3,
		extensions: [
			{
				id: 'ash.demo',
				name: 'demo',
				publisher: 'ash',
				version: '1.0.0',
				displayName: 'Demo',
				sourceKind: 'builtIn',
				manifestJson: '{}',
				manifestSha256: `sha256:${'a'.repeat(64)}`,
				packageSha256: `sha256:${'b'.repeat(64)}`,
			},
		],
		diagnostics: [
			{
				source: 'user',
				subject: null,
				code: 'invalidManifest',
				message: 'manifest is invalid',
			},
		],
	});

	assert.equal(catalog.generation, 3);
	assert.equal(catalog.extensions[0]?.id, 'ash.demo');
	assert.equal(catalog.extensions[0]?.packageSha256, `sha256:${'b'.repeat(64)}`);
	assert.equal(catalog.diagnostics[0]?.subject, undefined);
	assert(Object.isFrozen(catalog));
});

test('rejects unknown extension diagnostics', () => {
	assert.throws(() =>
		normalizeExtensionCatalog({
			generation: 1,
			extensions: [],
			diagnostics: [{ source: 'user', subject: null, code: 'unknown', message: 'bad' }],
		}),
	);
});

test('rejects malformed extension package digests', () => {
	assert.throws(
		() =>
			normalizeExtensionCatalog({
				generation: 1,
				extensions: [
					{
						id: 'ash.demo',
						name: 'demo',
						publisher: 'ash',
						version: '1.0.0',
						displayName: 'Demo',
						sourceKind: 'builtIn',
						manifestJson: '{}',
						manifestSha256: `sha256:${'a'.repeat(64)}`,
						packageSha256: 'sha256:not-a-digest',
					},
				],
				diagnostics: [],
			}),
		/package digest/,
	);
});

function packageSnapshot(generation: number, id: string, sourceKind: 'builtIn' | 'user' = 'user'): ExtensionCatalog {
	return normalizeExtensionCatalog({
		generation,
		diagnostics: [],
		extensions: [
			{
				id,
				name: id.split('.')[1],
				publisher: id.split('.')[0],
				version: '1.0.0',
				displayName: id,
				sourceKind,
				manifestJson: '{}',
				manifestSha256: `sha256:${'a'.repeat(64)}`,
				packageSha256: `sha256:${'b'.repeat(64)}`,
			},
		],
	});
}

function packageApi(catalog: () => ExtensionCatalog, read: (request: ExtensionResourceRequest) => Promise<Uint8Array>): IExtensionApi {
	return { list: async () => catalog(), resources: new ExtensionResourceLoaderService(read) };
}

test('management can inspect disabled built-ins without enabling activation or backend access', async () => {
	const catalog = packageSnapshot(1, 'ash.disabled', 'builtIn');
	const api = withEnabledBuiltInExtensions(
		packageApi(
			() => catalog,
			async () => new Uint8Array(),
		),
		{
			onDidChangeEnablement: Event.None,
			getDisabledExtensions: () => [{ id: 'ash.disabled' }],
			enableExtension: async () => false,
			disableExtension: async () => false,
		},
	);
	assert.deepEqual((await api.list('cached')).extensions, []);
	assert.strictEqual(await api.list('cached', { includeDisabled: true }), catalog);
	assert.deepEqual((await api.list('cached')).extensions, []);
});

test('disconnected clients report catalog and resource unavailability without a browser fallback', async () => {
	const api = createDisconnectedExtensionApi(unavailableOperation);
	const catalog = await api.list('cached');
	assert.deepEqual(catalog.extensions, []);
	assert.equal(catalog.diagnostics[0].code, 'sourceUnavailable');
	await assert.rejects(
		api.resources.readExtensionResourceBytes({
			generation: 1,
			extensionId: 'ash.git',
			path: 'browser/extension.ts',
		}),
		WebAppServerUnavailableError,
	);
});

test('an idle catalog request starts immediately, concurrent reads share failure, and a later read retries', async () => {
	const first = new DeferredPromise<unknown>();
	const second = new DeferredPromise<unknown>();
	const requests: unknown[] = [];
	const connection = {
		request: (_method: unknown, params: unknown) => {
			requests.push(params);
			return requests.length === 1 ? first.p : requests.length === 2 ? second.p : Promise.resolve({ generation: 3, extensions: [], diagnostics: [] });
		},
	} as unknown as AppServerProtocolClient;
	const api = createAppServerExtensionApi(connection, { connectionGeneration: 1 } as IResourceApi);
	const refresh = api.list('refresh');
	const failed = assert.rejects(refresh, /source scan failed/);
	assert.deepEqual(requests, [{ reload: 'refresh', knownGeneration: null }], 'Backend work starts before the caller yields to Workbench construction');
	const concurrent = api.list('cached');
	assert.strictEqual(concurrent, refresh, 'Concurrent consumers share the same catalog operation');
	const concurrentFailed = assert.rejects(concurrent, /source scan failed/);
	assert.equal(requests.length, 1, 'Catalog publication remains serialized');
	await first.error(new Error('source scan failed'));
	await Promise.all([failed, concurrentFailed]);
	assert.deepEqual(requests, [{ reload: 'refresh', knownGeneration: null }], 'A shared failure does not silently retry discovery');
	const retry = api.list('cached');
	assert.deepEqual(requests, [
		{ reload: 'refresh', knownGeneration: null },
		{ reload: 'cached', knownGeneration: null },
	]);
	await second.complete({ generation: 2, extensions: [], diagnostics: [] });
	assert.equal((await retry).generation, 1);
	const idle = api.list('cached');
	assert.equal(requests.length, 3);
	assert.equal((await idle).generation, 2);
});

test('small frozen resources share reads without sharing mutable bytes or retired generations', async () => {
	let generation = 1;
	let incarnation = 1;
	let opens = 0;
	let releases = 0;
	let rejectNext = false;
	let size = 3;
	let opened = new DeferredPromise<unknown>();
	const connection = {
		request: (_method: unknown, params: unknown) => {
			if ('reload' in (params as object)) return Promise.resolve({ generation, extensions: [], diagnostics: [] });
			opens++;
			return opened.p;
		},
	} as unknown as AppServerProtocolClient;
	const resources: IResourceApi = {
		get connectionGeneration() {
			return incarnation;
		},
		metadata: async () => {
			throw new Error('unused');
		},
		read: async request => {
			if (rejectNext) {
				rejectNext = false;
				throw new Error('read failed');
			}
			const bytes = new Uint8Array(size).fill(7);
			return {
				resourceId: request.resourceId,
				offset: 0,
				dataBase64: Buffer.from(bytes).toString('base64'),
				decodedLength: size,
				eof: true,
			};
		},
		release: async () => {
			releases++;
		},
	};
	const complete = async () => {
		const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(size).fill(7));
		await opened.complete({
			resource: {
				resourceId: 'resource',
				mimeType: 'application/json',
				size,
				sha256: `sha256:${Buffer.from(digest).toString('hex')}`,
			},
		});
	};
	const api = createAppServerExtensionApi(connection, resources);
	let catalog = await api.list('refresh');
	const read = (path = 'theme.json') => api.resources.readExtensionResourceBytes({ generation: catalog.generation, extensionId: 'ash.theme', path });
	const first = read();
	const second = read();
	assert.equal(opens, 1);
	await complete();
	const bytes = await first;
	bytes[0] = 99;
	assert.equal((await second)[0], 7);
	await api.list('refresh');
	assert.equal((await read())[0], 7);
	assert.equal(opens, 1, 'unchanged catalog retains verified resources');
	assert.equal(releases, 1, 'the single backend handle is released');

	for (let index = 0; index < 65; index++) await read(`entry-${index}.json`);
	const beforeEviction = opens;
	await read();
	assert.equal(opens, beforeEviction + 1, 'LRU bound evicts old resources');
	generation++;
	catalog = await api.list('refresh');
	const beforeGeneration = opens;
	await read();
	assert.equal(opens, beforeGeneration + 1);
	incarnation++;
	await assert.rejects(read(), /retired/);
	catalog = await api.list('cached');
	const beforeReconnect = opens;
	await read();
	assert.equal(opens, beforeReconnect + 1);

	rejectNext = true;
	await assert.rejects(read('retry.json'), /read failed/);
	const beforeRetry = opens;
	await read('retry.json');
	assert.equal(opens, beforeRetry + 1, 'failures are never retained');
	size = 128 * 1024 + 1;
	opened = new DeferredPromise<unknown>();
	const large = read('large.json');
	await complete();
	await large;
	const beforeLarge = opens;
	await read('large.json');
	assert.equal(opens, beforeLarge + 1, 'oversized resources are not retained');

	opened = new DeferredPromise<unknown>();
	const oldRead = assert.rejects(read('pending.json'), /retired/);
	generation++;
	catalog = await api.list('refresh');
	await complete();
	await oldRead;
});

test('language extension syntax follows backend enablement, including revocation and offline failure', async () => {
	const base = packageSnapshot(1, 'ash.rust', 'builtIn');
	const catalog = {
		...base,
		extensions: [
			{
				...base.extensions[0]!,
				manifestJson: JSON.stringify({ ashLanguageServers: { version: 1, servers: [] } }),
			},
		],
	};
	let enabled = true;
	let offline = false;
	const management = {
		onDidChangeInstalled: Event.None,
		listBuiltInProviders: async () => {
			if (offline) throw new Error('offline');
			return { revision: 1, providers: [{ id: 'ash.rust', enabled, running: false }] };
		},
	} as unknown as IExtensionManagementService;
	const api = withEnabledBuiltInExtensions(
		packageApi(
			() => catalog,
			async () => new Uint8Array(),
		),
		{
			onDidChangeEnablement: Event.None,
			getDisabledExtensions: () => [{ id: 'ash.rust' }],
			enableExtension: async () => {
				throw new Error('must not duplicate backend policy');
			},
			disableExtension: async () => {
				throw new Error('must not duplicate backend policy');
			},
		},
		management,
	);
	assert.equal((await api.list('cached')).extensions.length, 1);
	enabled = false;
	assert.equal((await api.list('cached')).extensions.length, 0);
	assert.equal((await api.list('cached', { includeDisabled: true })).extensions.length, 1);
	enabled = true;
	offline = true;
	assert.equal((await api.list('cached')).extensions.length, 0);
});

test('warm language catalog reads overlap provider IO and share only its pending result', async () => {
	const base = packageSnapshot(1, 'ash.language', 'builtIn');
	const catalog = {
		...base,
		extensions: [
			{
				...base.extensions[0]!,
				manifestJson: JSON.stringify({ ashLanguageServers: { version: 1, servers: [] } }),
			},
		],
	};
	let catalogRead: DeferredPromise<ExtensionCatalog> | undefined;
	let providerRead: DeferredPromise<ExtensionsBuiltInProviders> | undefined;
	const providerStarted = new DeferredPromise<void>();
	let reads = 0;
	const management = {
		onDidChangeInstalled: Event.None,
		listBuiltInProviders: async () => {
			reads++;
			if (reads === 2) void providerStarted.complete();
			return (
				providerRead?.p ?? {
					revision: reads,
					canChangeEnablement: false,
					providers: [{ id: 'ash.language', enabled: true, running: false }],
				}
			);
		},
	} as unknown as IExtensionManagementService;
	const api = withEnabledBuiltInExtensions(
		{
			list: () => catalogRead?.p ?? Promise.resolve(catalog),
			resources: new ExtensionResourceLoaderService(async () => new Uint8Array()),
		},
		{
			onDidChangeEnablement: Event.None,
			getDisabledExtensions: () => [],
			enableExtension: async () => false,
			disableExtension: async () => false,
		},
		management,
	);
	assert.equal((await api.list('cached')).extensions.length, 1);
	catalogRead = new DeferredPromise<ExtensionCatalog>();
	providerRead = new DeferredPromise<ExtensionsBuiltInProviders>();
	const first = api.list('cached');
	const second = api.list('cached');
	await providerStarted.p;
	assert.equal(reads, 2, 'provider IO starts before the catalog reply and overlapping callers share it');
	await providerRead.complete({
		revision: 2,
		canChangeEnablement: false,
		providers: [{ id: 'ash.language', enabled: false, running: false }],
	});
	await catalogRead.complete(catalog);
	assert.deepEqual(
		(await Promise.all([first, second])).map(value => value.extensions),
		[[], []],
	);
	catalogRead = undefined;
	providerRead = undefined;
	assert.equal((await api.list('cached')).extensions.length, 1, 'the next read observes re-enablement instead of retaining the previous result');
	assert.equal(reads, 3);
	await api.list('cached', { includeDisabled: true });
	assert.equal(reads, 3, 'management inspection does not issue enablement reads');
});

test('renderer admission preserves exact backend identity and rejects unsafe resources or unsupported APIs', () => {
	const owner = packageSnapshot(1, 'ash.academy').extensions[0];
	const admission = {
		runtimeId: 'marketplace:ash.academy:editor-extension:editor',
		apiVersion: 1,
		entry: 'dist/editor.js',
		digest: `sha256:${'c'.repeat(64)}`,
		style: 'dist/editor.css',
		styleDigest: `sha256:${'d'.repeat(64)}`,
		sourceDigest: `sha256:${'e'.repeat(64)}`,
	};
	const normalize = (rendererClient: unknown) => normalizeExtensionCatalog({ generation: 1, diagnostics: [], extensions: [{ ...owner, rendererClient }] });
	const actual = normalize(admission).extensions[0].rendererClient;
	assert.deepEqual(actual, admission);
	assert.ok(Object.isFrozen(actual));
	for (const invalid of [
		{ ...admission, apiVersion: 2 },
		{ ...admission, entry: '../other/editor.js' },
		{ ...admission, style: 'https://other/editor.css' },
		{ ...admission, styleDigest: 'sha256:bad' },
		{ ...admission, sourceDigest: 'sha256:bad' },
	])
		assert.throws(() => normalize(invalid));
	assert.equal(normalize(null).extensions[0].rendererClient, undefined);
});
