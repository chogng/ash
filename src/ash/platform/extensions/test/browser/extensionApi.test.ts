import { strict as assert } from 'node:assert';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import type { IResourceApi } from '../../../agentHost/common/appServerApi.js';
import type { AppServerProtocolClient } from '../../../agentHost/browser/appServerProtocolClient.js';
import { createAppServerExtensionApi } from '../../browser/extensionApi.js';
import { MAX_EXTENSION_RESOURCE_BYTES, type ExtensionResourceRequest, type IExtensionApi } from '../../common/extensionApi.js';
import { createHash } from 'node:crypto';

test('App Server extension resources require a published catalog before opening a handle', async () => {
	let requests = 0;
	const connection = { request: async () => { requests++; throw new Error('Unexpected request'); } } as unknown as AppServerProtocolClient;
	const api = createAppServerExtensionApi(connection, resourceApi({}));
	await assert.rejects(api.resources.readExtensionResourceBytes({ generation: 1, extensionId: 'ash.demo', path: 'demo.json' }), /generation/);
	assert.equal(requests, 0);
});

test('concurrent cached extension reads share one request while refresh stays queued', async () => {
	const cached = new DeferredPromise<{ generation: number; extensions: []; diagnostics: []; }>();
	const refreshed = new DeferredPromise<{ generation: number; extensions: []; diagnostics: []; }>();
	const requests: string[] = [];
	const connection = {
		request: async (_definition: unknown, params: { reload: string; }) => {
			requests.push(params.reload);
			return requests.length === 1 ? cached.p : refreshed.p;
		},
	} as unknown as AppServerProtocolClient;
	const api = createAppServerExtensionApi(connection, resourceApi({}));

	const first = api.list('cached');
	const second = api.list('cached');
	const refresh = api.list('refresh');
	const duplicateRefresh = api.list('refresh');
	const cachedDuringRefresh = api.list('cached');
	assert.deepEqual(requests, ['cached']);

	cached.complete({ generation: 17, extensions: [], diagnostics: [] });
	const firstCatalog = await first;
	assert.strictEqual(await second, firstCatalog);
	assert.deepEqual(requests, ['cached', 'refresh']);

	refreshed.complete({ generation: 18, extensions: [], diagnostics: [] });
	const refreshedCatalog = await refresh;
	assert.strictEqual(await duplicateRefresh, refreshedCatalog);
	assert.strictEqual(await cachedDuringRefresh, refreshedCatalog);
	assert.equal(refreshedCatalog.generation, firstCatalog.generation + 1);
	assert.deepEqual(requests, ['cached', 'refresh']);
});

test('extension catalogs reuse only a backend-confirmed version from the same connection', async () => {
	let connectionGeneration = 1;
	const requests: unknown[] = [];
	let reply: unknown = { status: 'updated', generation: 17, extensions: [], diagnostics: [] };
	const connection = {
		request: async (_definition: unknown, params: unknown) => { requests.push(params); return reply; },
	} as unknown as AppServerProtocolClient;
	const resources = { ...resourceApi({}), get connectionGeneration() { return connectionGeneration; } };
	const api = createAppServerExtensionApi(connection, resources);
	const first = await api.list('cached');
	reply = { status: 'unchanged', generation: 17 };
	assert.strictEqual(await api.list('cached'), first);
	assert.deepEqual(requests, [
		{ reload: 'cached', knownGeneration: null }, { reload: 'cached', knownGeneration: 17 },
	]);
	reply = { status: 'unchanged', generation: 18 };
	await assert.rejects(api.list('cached'), /retired/);
	connectionGeneration++;
	reply = { status: 'unchanged', generation: 17 };
	await assert.rejects(api.list('cached'), /retired/);
	assert.deepEqual(requests.at(-1), { reload: 'cached', knownGeneration: null });
	reply = { status: 'updated', generation: 17, extensions: [], diagnostics: [] };
	const reconnected = await api.list('cached');
	assert.notStrictEqual(reconnected, first);
	assert.equal(reconnected.generation, first.generation + 1);
	await api.list('refresh');
	assert.deepEqual(requests.at(-1), { reload: 'refresh', knownGeneration: null });
	reply = { status: 'unchanged', generation: 17 };
	await assert.rejects(api.list('refresh'), /retired/);
});

test('Vite extension resources reject oversized open metadata before reading', async () => {
	let reads = 0;
	let releases = 0;
	const { api, request } = await initializedExtensionApi({
		resource: metadata(MAX_EXTENSION_RESOURCE_BYTES + 1),
	}, resourceApi({
		read: async () => {
			reads += 1;
			throw new Error('resource read must not run');
		},
		release: async () => { releases++; },
	}));

	await assert.rejects(api.resources.readExtensionResourceBytes(request), /size/);
	assert.equal(reads, 0);
	assert.equal(releases, 1);
});

for (const size of [0, 300_000]) {
	test(`Vite extension resources assemble and verify ${size} bytes within the chunk limit`, async () => {
		const bytes = Buffer.alloc(size, 'a');
		const requests: unknown[] = [];
		let releases = 0;
		const resource = { ...metadata(size), sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
		const { api, request } = await initializedExtensionApi({ resource }, resourceApi({
			read: async request => {
				requests.push(request);
				const chunk = bytes.subarray(request.offset, request.offset + request.maxBytes);
				return { resourceId: resource.resourceId, offset: request.offset, decodedLength: chunk.length, dataBase64: chunk.toString('base64'), eof: request.offset + chunk.length === size };
			},
			release: async () => { releases++; },
		}));
		assert.deepEqual(await api.resources.readExtensionResourceBytes(request), Uint8Array.from(bytes));
		assert.deepEqual(requests, size === 0 ? [] : [{ resourceId: resource.resourceId, offset: 0, maxBytes: 262_144 }, { resourceId: resource.resourceId, offset: 262_144, maxBytes: size - 262_144 }]);
		assert.equal(releases, 1);
	});
}

test('Vite extension resources reject extra metadata fields and release the handle', async () => {
	let releases = 0;
	const { api, request } = await initializedExtensionApi({ resource: { ...metadata(1), privatePath: '/host/private' } }, resourceApi({ release: async () => { releases++; } }));
	await assert.rejects(api.resources.readExtensionResourceBytes(request), /shape/u);
	assert.equal(releases, 1);
});

for (const invalid of [{ offset: 1 }, { resourceId: 'other-resource' }, { decodedLength: 2 }, { eof: false }, { dataBase64: 'invalid!' }]) {
	test(`Vite extension resources reject inconsistent ${Object.keys(invalid)[0]} and release the handle`, async () => {
		let releases = 0;
		const { api, request } = await initializedExtensionApi({ resource: metadata(1) }, resourceApi({
			read: async () => ({ resourceId: 'resource_0000000000000001', offset: 0, dataBase64: 'YQ==', decodedLength: 1, eof: true, ...invalid }),
			release: async () => { releases++; },
		}));
		await assert.rejects(api.resources.readExtensionResourceBytes(request));
		assert.equal(releases, 1);
	});
}

test('Vite extension resources reject malformed chunks and release the handle', async () => {
	let releases = 0;
	const { api, request } = await initializedExtensionApi({ resource: metadata(1) }, resourceApi({
		read: async () => ({
			resourceId: 'resource_0000000000000001',
			offset: 0,
			dataBase64: 'YQ==',
			decodedLength: 1,
			eof: true,
			unexpected: true,
		} as never),
		release: async () => { releases += 1; },
	}));

	await assert.rejects(api.resources.readExtensionResourceBytes(request), /shape/);
	assert.equal(releases, 1);
});

test('Vite extension resources verify assembled bytes and release a corrupted handle', async () => {
	let releases = 0;
	const { api, request } = await initializedExtensionApi({ resource: metadata(1) }, resourceApi({
		read: async () => ({ resourceId: 'resource_0000000000000001', offset: 0, dataBase64: 'YQ==', decodedLength: 1, eof: true }),
		release: async () => { releases += 1; },
	}));

	await assert.rejects(api.resources.readExtensionResourceBytes(request), /digest/);
	assert.equal(releases, 1);
});

async function initializedExtensionApi(opened: unknown, resources: IResourceApi): Promise<{ api: IExtensionApi; request: ExtensionResourceRequest; }> {
	const connection = {
		request: async ({ method }: { method: string; }, params: unknown) => {
			if (method === 'extensions/list') {
				return {
					generation: 17,
					extensions: [{
						id: 'ash.demo',
						name: 'demo',
						publisher: 'ash',
						version: '1.0.0',
						displayName: 'Demo',
						sourceKind: 'user',
						manifestJson: '{}',
						manifestSha256: `sha256:${'a'.repeat(64)}`,
						packageSha256: `sha256:${'b'.repeat(64)}`,
					}],
					diagnostics: [],
				};
			}
			assert.equal(method, 'extensions/resource/open');
			assert.deepEqual(params, { generation: 17, extensionId: 'ash.demo', path: 'demo.json' });
			return opened;
		},
	} as unknown as AppServerProtocolClient;
	const api = createAppServerExtensionApi(connection, resources);
	const catalog = await api.list('cached');
	return { api, request: { generation: catalog.generation, extensionId: 'ash.demo', path: 'demo.json' } };
}

test('Rust catalog reconnection retires old resource references even when the backend reuses its generation', async () => {
	const bytes = Buffer.from('export function activate() {}');
	const resource = { ...metadata(bytes.length), sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
	const resources = resourceApi({
		read: async () => ({ resourceId: resource.resourceId, offset: 0, dataBase64: bytes.toString('base64'), decodedLength: bytes.length, eof: true }),
	});
	const opened: unknown[] = [];
	const connection = {
		request: async ({ method }: { method: string; }, params: unknown) => {
			if (method === 'extensions/list') return { generation: 17, diagnostics: [], extensions: [{ id: 'ash.git', name: 'git', publisher: 'ash', version: '1', displayName: 'Git', sourceKind: 'builtIn', manifestJson: '{"browser":"browser/extension.ts"}', manifestSha256: `sha256:${'a'.repeat(64)}`, packageSha256: `sha256:${'b'.repeat(64)}` }] };
			assert.equal(method, 'extensions/resource/open'); opened.push(params); return { resource };
		}
	} as unknown as AppServerProtocolClient;
	const api = createAppServerExtensionApi(connection, resources);
	const first = await api.list('cached');
	assert.strictEqual(await api.list('refresh'), first);
	const request = { generation: first.generation, extensionId: 'ash.git', path: 'browser/extension.ts' };
	assert.deepEqual(await api.resources.readExtensionResourceBytes(request), Uint8Array.from(bytes));
	assert.deepEqual(opened, [{ ...request, generation: 17 }]);
	Object.assign(resources, { connectionGeneration: 1 });
	await assert.rejects(api.resources.readExtensionResourceBytes(request), /generation/);
	const second = await api.list('cached');
	assert.equal(second.generation, first.generation + 1);
	await assert.rejects(api.resources.readExtensionResourceBytes(request), /generation/);
	assert.deepEqual(await api.resources.readExtensionResourceBytes({ ...request, generation: second.generation }), Uint8Array.from(bytes));
});

test('an in-flight resource read cannot publish bytes after the Rust catalog has changed', async () => {
	const bytes = Buffer.from('old data');
	const deferred = new DeferredPromise<Awaited<ReturnType<IResourceApi['read']>>>();
	const resource = { ...metadata(bytes.length), sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
	let generation = 1;
	let releases = 0;
	const resources = resourceApi({ read: () => deferred.p, release: async () => { releases++; } });
	const connection = { request: async ({ method }: { method: string; }) => method === 'extensions/list' ? { generation, diagnostics: [], extensions: [] } : { resource } } as unknown as AppServerProtocolClient;
	const api = createAppServerExtensionApi(connection, resources);
	const catalog = await api.list('cached');
	const reading = api.resources.readExtensionResourceBytes({ generation: catalog.generation, extensionId: 'ash.git', path: 'package.json' });
	generation++;
	await api.list('refresh');
	deferred.complete({ resourceId: resource.resourceId, offset: 0, dataBase64: bytes.toString('base64'), decodedLength: bytes.length, eof: true });
	await assert.rejects(reading, /generation/);
	assert.equal(releases, 1);
});

function resourceApi(overrides: Partial<IResourceApi>): IResourceApi {
	return {
		connectionGeneration: 0,
		metadata: async () => metadata(0),
		read: async () => { throw new Error('resource read is unavailable'); },
		release: async () => { },
		...overrides,
	};
}

function metadata(size: number) {
	return {
		resourceId: 'resource_0000000000000001',
		mimeType: 'application/json',
		size,
		sha256: `sha256:${'a'.repeat(64)}`,
	};
}
