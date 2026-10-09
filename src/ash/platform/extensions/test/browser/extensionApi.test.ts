import { strict as assert } from "node:assert";
import { test } from "mocha";
import type { IResourceApi } from "../../../agentHost/common/appServerApi.js";
import type { AppServerProtocolClient } from "../../../agentHost/browser/appServerProtocolClient.js";
import { createAppServerExtensionApi } from "../../browser/extensionApi.js";
import { MAX_EXTENSION_RESOURCE_BYTES } from "../../common/extensionApi.js";
import { createHash } from 'node:crypto';

test("Vite extension resources reject oversized open metadata before reading", async () => {
	let reads = 0;
	let releases = 0;
	const api = createAppServerExtensionApi(connectionReturning({
		resource: metadata(MAX_EXTENSION_RESOURCE_BYTES + 1),
	}), resourceApi({
		read: async () => {
			reads += 1;
			throw new Error("resource read must not run");
		},
		release: async () => { releases++; },
	}));

	await assert.rejects(api.resources.readExtensionResourceBytes({ generation: 1, extensionId: "ash.demo", path: "demo.json" }), /size/);
	assert.equal(reads, 0);
	assert.equal(releases, 1);
});

for (const size of [0, 300_000]) {
	test(`Vite extension resources assemble and verify ${size} bytes within the chunk limit`, async () => {
		const bytes = Buffer.alloc(size, 'a');
		const requests: unknown[] = [];
		let releases = 0;
		const resource = { ...metadata(size), sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
		const api = createAppServerExtensionApi(connectionReturning({ resource }), resourceApi({
			read: async request => {
				requests.push(request);
				const chunk = bytes.subarray(request.offset, request.offset + request.maxBytes);
				return { resourceId: resource.resourceId, offset: request.offset, decodedLength: chunk.length, dataBase64: chunk.toString('base64'), eof: request.offset + chunk.length === size };
			},
			release: async () => { releases++; },
		}));
		assert.deepEqual(await api.resources.readExtensionResourceBytes({ generation: 1, extensionId: 'ash.demo', path: 'demo.json' }), Uint8Array.from(bytes));
		assert.deepEqual(requests, size === 0 ? [] : [{ resourceId: resource.resourceId, offset: 0, maxBytes: 262_144 }, { resourceId: resource.resourceId, offset: 262_144, maxBytes: size - 262_144 }]);
		assert.equal(releases, 1);
	});
}

test('Vite extension resources reject extra metadata fields and release the handle', async () => {
	let releases = 0;
	const api = createAppServerExtensionApi(connectionReturning({ resource: { ...metadata(1), privatePath: '/host/private' } }), resourceApi({ release: async () => { releases++; } }));
	await assert.rejects(api.resources.readExtensionResourceBytes({ generation: 1, extensionId: 'ash.demo', path: 'demo.json' }), /shape/u);
	assert.equal(releases, 1);
});

for (const invalid of [{ offset: 1 }, { resourceId: 'other-resource' }, { decodedLength: 2 }, { eof: false }, { dataBase64: 'invalid!' }]) {
	test(`Vite extension resources reject inconsistent ${Object.keys(invalid)[0]} and release the handle`, async () => {
		let releases = 0;
		const api = createAppServerExtensionApi(connectionReturning({ resource: metadata(1) }), resourceApi({
			read: async () => ({ resourceId: 'resource_0000000000000001', offset: 0, dataBase64: 'YQ==', decodedLength: 1, eof: true, ...invalid }),
			release: async () => { releases++; },
		}));
		await assert.rejects(api.resources.readExtensionResourceBytes({ generation: 1, extensionId: 'ash.demo', path: 'demo.json' }));
		assert.equal(releases, 1);
	});
}

test("Vite extension resources reject malformed chunks and release the handle", async () => {
	let releases = 0;
	const api = createAppServerExtensionApi(connectionReturning({ resource: metadata(1) }), resourceApi({
		read: async () => ({
			resourceId: "resource_0000000000000001",
			offset: 0,
			dataBase64: "YQ==",
			decodedLength: 1,
			eof: true,
			unexpected: true,
		} as never),
		release: async () => { releases += 1; },
	}));

	await assert.rejects(api.resources.readExtensionResourceBytes({ generation: 1, extensionId: "ash.demo", path: "demo.json" }), /shape/);
	assert.equal(releases, 1);
});

test("Vite extension resources verify assembled bytes and release a corrupted handle", async () => {
	let releases = 0;
	const api = createAppServerExtensionApi(connectionReturning({ resource: metadata(1) }), resourceApi({
		read: async () => ({ resourceId: "resource_0000000000000001", offset: 0, dataBase64: "YQ==", decodedLength: 1, eof: true }),
		release: async () => { releases += 1; },
	}));

	await assert.rejects(api.resources.readExtensionResourceBytes({ generation: 1, extensionId: "ash.demo", path: "demo.json" }), /digest/);
	assert.equal(releases, 1);
});

function connectionReturning(result: unknown): AppServerProtocolClient {
	return { request: async () => result } as unknown as AppServerProtocolClient;
}

test('gallery resources use the negotiated backend, verify bytes and release their connection handle', async () => {
	const bytes = Buffer.from('{"name":"sample"}');
	const resource = { ...metadata(bytes.length), sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
	const requests: unknown[] = [];
	let releases = 0;
	const connection = {
		capabilities: { contracts: { extensionGalleryResources: { version: 1 } } },
		request: async ({ method }: { method: string; }, params: unknown) => {
			requests.push({ method, params });
			if (method === 'extensions/gallery') {
				return { resourceUrlTemplate: 'https://registry.example/api/{publisher}/{name}/universal/{version}/file/{path}' };
			}
			assert.equal(method, 'extensions/gallery/resource/open');
			return { resource };
		},
	} as unknown as AppServerProtocolClient;
	const api = createAppServerExtensionApi(connection, resourceApi({
		read: async () => ({ resourceId: resource.resourceId, offset: 0, decodedLength: bytes.length, dataBase64: bytes.toString('base64'), eof: true }),
		release: async () => { releases++; },
	}));
	const uri = await api.resources.getExtensionGalleryResourceURL({ publisher: 'publisher', name: 'sample', version: '1.0.0' }, 'package.json');
	assert.equal(await api.resources.readExtensionResource(uri!), bytes.toString());
	assert.deepEqual(requests.at(-1), { method: 'extensions/gallery/resource/open', params: { resourceUrlTemplate: 'https://registry.example/api/{publisher}/{name}/universal/{version}/file/{path}', publisher: 'publisher', name: 'sample', version: '1.0.0', path: 'package.json' } });
	assert.equal(releases, 1);
});

test('a backend without the gallery contract does not receive unsupported gallery requests', async () => {
	let requests = 0;
	const connection = { request: async () => { requests++; throw new Error('Unexpected request'); } } as unknown as AppServerProtocolClient;
	const api = createAppServerExtensionApi(connection, resourceApi({}));
	assert.equal(await api.resources.supportsExtensionGalleryResources(), false);
	assert.equal(requests, 0);
});

function resourceApi(overrides: Partial<IResourceApi>): IResourceApi {
	return {
		connectionGeneration: 0,
		metadata: async () => metadata(0),
		read: async () => { throw new Error("resource read is unavailable"); },
		release: async () => { },
		...overrides,
	};
}

function metadata(size: number) {
	return {
		resourceId: "resource_0000000000000001",
		mimeType: "application/json",
		size,
		sha256: `sha256:${"a".repeat(64)}`,
	};
}
