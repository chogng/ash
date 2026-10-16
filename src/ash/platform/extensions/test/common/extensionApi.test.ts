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

test("normalizes an extension catalog and preserves explicit diagnostics", () => {
	const catalog = normalizeExtensionCatalog({
		generation: 3,
		extensions: [{
			id: "ash.demo",
			name: "demo",
			publisher: "ash",
			version: "1.0.0",
			displayName: "Demo",
			sourceKind: "builtIn",
			manifestJson: "{}",
			manifestSha256: `sha256:${"a".repeat(64)}`,
			packageSha256: `sha256:${"b".repeat(64)}`,
		}],
		diagnostics: [{
			source: "user",
			subject: null,
			code: "invalidManifest",
			message: "manifest is invalid",
		}],
	});

	assert.equal(catalog.generation, 3);
	assert.equal(catalog.extensions[0]?.id, "ash.demo");
	assert.equal(catalog.extensions[0]?.packageSha256, `sha256:${"b".repeat(64)}`);
	assert.equal(catalog.diagnostics[0]?.subject, undefined);
	assert(Object.isFrozen(catalog));
});

test("rejects unknown extension diagnostics", () => {
	assert.throws(() => normalizeExtensionCatalog({
		generation: 1,
		extensions: [],
		diagnostics: [{ source: "user", subject: null, code: "unknown", message: "bad" }],
	}));
});

test("rejects malformed extension package digests", () => {
	assert.throws(() => normalizeExtensionCatalog({
		generation: 1,
		extensions: [{
			id: "ash.demo",
			name: "demo",
			publisher: "ash",
			version: "1.0.0",
			displayName: "Demo",
			sourceKind: "builtIn",
			manifestJson: "{}",
			manifestSha256: `sha256:${"a".repeat(64)}`,
			packageSha256: "sha256:not-a-digest",
		}],
		diagnostics: [],
	}), /package digest/);
});


function packageSnapshot(generation: number, id: string, sourceKind: 'builtIn' | 'user' = 'user'): ExtensionCatalog {
	return normalizeExtensionCatalog({ generation, diagnostics: [], extensions: [{ id, name: id.split('.')[1], publisher: id.split('.')[0], version: '1.0.0', displayName: id, sourceKind, manifestJson: '{}', manifestSha256: `sha256:${'a'.repeat(64)}`, packageSha256: `sha256:${'b'.repeat(64)}` }] });
}

function packageApi(catalog: () => ExtensionCatalog, read: (request: ExtensionResourceRequest) => Promise<Uint8Array>): IExtensionApi {
	return { list: async () => catalog(), resources: new ExtensionResourceLoaderService(read) };
}

test('management can inspect disabled built-ins without enabling activation or backend access', async () => {
	const catalog = packageSnapshot(1, 'ash.disabled', 'builtIn');
	const api = withEnabledBuiltInExtensions(packageApi(() => catalog, async () => new Uint8Array()), {
		onDidChangeEnablement: Event.None, getDisabledExtensions: () => [{ id: 'ash.disabled' }],
		enableExtension: async () => false, disableExtension: async () => false,
	});
	assert.deepEqual((await api.list('cached')).extensions, []);
	assert.strictEqual(await api.list('cached', { includeDisabled: true }), catalog);
	assert.deepEqual((await api.list('cached')).extensions, []);
});

test('disconnected clients report catalog and resource unavailability without a browser fallback', async () => {
	const api = createDisconnectedExtensionApi(unavailableOperation);
	const catalog = await api.list('cached');
	assert.deepEqual(catalog.extensions, []);
	assert.equal(catalog.diagnostics[0].code, 'sourceUnavailable');
	await assert.rejects(api.resources.readExtensionResourceBytes({ generation: 1, extensionId: 'ash.git', path: 'browser/extension.ts' }), WebAppServerUnavailableError);
	assert.equal(await api.resources.supportsExtensionGalleryResources(), false);
});


test('an idle catalog request reaches the backend immediately and queued reads recover after failure', async () => {
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
	const failed = assert.rejects(api.list('refresh'), /source scan failed/);
	assert.deepEqual(requests, [{ reload: 'refresh' }], 'Backend work starts before the caller yields to Workbench construction');
	const queued = api.list('cached');
	assert.equal(requests.length, 1, 'Catalog publication remains serialized');
	await first.error(new Error('source scan failed'));
	await failed;
	assert.deepEqual(requests, [{ reload: 'refresh' }, { reload: 'cached' }]);
	await second.complete({ generation: 2, extensions: [], diagnostics: [] });
	assert.equal((await queued).generation, 1);
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
		get connectionGeneration() { return incarnation; },
		metadata: async () => { throw new Error('unused'); },
		read: async request => {
			if (rejectNext) { rejectNext = false; throw new Error('read failed'); }
			const bytes = new Uint8Array(size).fill(7);
			return { resourceId: request.resourceId, offset: 0, dataBase64: Buffer.from(bytes).toString('base64'), decodedLength: size, eof: true };
		},
		release: async () => { releases++; },
	};
	const complete = async () => {
		const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(size).fill(7));
		await opened.complete({ resource: { resourceId: 'resource', mimeType: 'application/json', size, sha256: `sha256:${Buffer.from(digest).toString('hex')}` } });
	};
	const api = createAppServerExtensionApi(connection, resources);
	let catalog = await api.list('refresh');
	const read = (path = 'theme.json') => api.resources.readExtensionResourceBytes({ generation: catalog.generation, extensionId: 'ash.theme', path });
	const first = read(); const second = read();
	assert.equal(opens, 1);
	await complete();
	const bytes = await first; bytes[0] = 99;
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
