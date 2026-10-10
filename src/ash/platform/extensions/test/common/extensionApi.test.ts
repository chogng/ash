import { readFile } from 'node:fs/promises';
import { setNlsMessages, resetNlsResolver } from '../../../../nls.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import type { ExtensionCatalog, ExtensionResourceRequest, IExtensionApi } from '../../common/extensionApi.js';
import { createBrowserExtensionApi, withBuiltInExtensions } from '../../browser/extensionApi.js';
import { ExtensionResourceLoaderService } from '../../../extensionResourceLoader/browser/extensionResourceLoaderService.js';
import { strict as assert } from "node:assert";
import { test } from "mocha";
import { MAX_EXTENSION_RESOURCE_BYTES, normalizeExtensionCatalog } from "../../common/extensionApi.js";

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

test('browser package loading retries a failed asset fetch and retains successful static bytes', async () => {
	let calls = 0;
	const catalog = packageSnapshot(1, 'ash.builtIn', 'builtIn');
	const api = createBrowserExtensionApi(async () => {
		if (++calls === 1) { throw new Error('temporary failure'); }
		return new Response(JSON.stringify({ catalog, resources: { 'ash.builtIn': { 'resource.txt': Buffer.from('browser resource').toString('base64') } } }));
	});
	await assert.rejects(api.list('cached'), /temporary failure/);
	assert.deepEqual(await api.list('refresh'), catalog);
	assert.deepEqual(await api.list('cached'), catalog);
	assert.equal(new TextDecoder().decode(await api.resources.readExtensionResourceBytes({ generation: 1, extensionId: 'ash.builtIn', path: 'resource.txt' })), 'browser resource');
	assert.equal(calls, 2);
});

test('browser resources reject oversized data before decoding and unsafe paths', async () => {
	const catalog = packageSnapshot(1, 'ash.builtIn', 'builtIn');
	const api = createBrowserExtensionApi(async () => new Response(JSON.stringify({ catalog, resources: { 'ash.builtIn': { 'large.txt': 'A'.repeat(4 * Math.ceil(MAX_EXTENSION_RESOURCE_BYTES / 3) + 1) } } })));
	await api.list('cached');
	await assert.rejects(api.resources.readExtensionResourceBytes({ generation: 1, extensionId: 'ash.builtIn', path: 'large.txt' }), RangeError);
	await assert.rejects(api.resources.readExtensionResourceBytes({ generation: 1, extensionId: 'ash.builtIn', path: '../large.txt' }), TypeError);
});

test('client assets take precedence and external resources retain their own backend generation', async () => {
	const local = packageSnapshot(1, 'ash.builtIn', 'builtIn');
	let remote: ExtensionCatalog = { ...packageSnapshot(17, 'ash.external'), extensions: [...packageSnapshot(17, 'ash.builtIn').extensions, ...packageSnapshot(17, 'ash.external').extensions] };
	const reads: ExtensionResourceRequest[] = [];
	const builtIn = packageApi(() => local, async request => { reads.push(request); return new TextEncoder().encode('client'); });
	const installed = packageApi(() => remote, async request => { reads.push(request); return new TextEncoder().encode('server'); });
	const api = withBuiltInExtensions(installed, builtIn);
	const first = await api.list('refresh');
	assert.deepEqual(first.extensions.map(extension => [extension.id, extension.sourceKind]), [['ash.builtIn', 'builtIn'], ['ash.external', 'user']]);
	assert.equal(first.diagnostics[0]?.code, 'duplicateExtension');
	assert.strictEqual(await api.list('refresh'), first);
	const request = (extensionId: string): ExtensionResourceRequest => ({ generation: first.generation, extensionId, path: 'resource.txt' });
	assert.equal(new TextDecoder().decode(await api.resources.readExtensionResourceBytes(request('ash.builtIn'))), 'client');
	assert.equal(new TextDecoder().decode(await api.resources.readExtensionResourceBytes(request('ash.external'))), 'server');
	assert.deepEqual(reads, [{ ...request('ash.builtIn'), generation: 1 }, { ...request('ash.external'), generation: 17 }]);
	remote = packageSnapshot(18, 'ash.external');
	const updated = await api.list('refresh');
	assert.equal(updated.generation, first.generation + 1);
	await assert.rejects(api.resources.readExtensionResourceBytes(request('ash.builtIn')), /generation/);
});

test('refresh fences pending resource reads and detects a backend restart with reused generation', async () => {
	let remote = packageSnapshot(1, 'ash.external');
	const deferred = new DeferredPromise<Uint8Array>();
	const installed = packageApi(() => remote, () => deferred.p);
	const api = withBuiltInExtensions(installed, packageApi(() => packageSnapshot(1, 'ash.builtIn', 'builtIn'), async () => new Uint8Array()));
	const first = await api.list('cached');
	const reading = api.resources.readExtensionResourceBytes({ generation: first.generation, extensionId: 'ash.external', path: 'resource.txt' });
	remote = packageSnapshot(1, 'ash.replacement');
	const next = await api.list('refresh');
	deferred.complete(new Uint8Array([42]));
	await assert.rejects(reading, /generation/);
	assert.equal(next.generation, first.generation + 1);
});

test('a failed external refresh preserves published client resources and later refresh can recover', async () => {
	let failed = false;
	const installed = packageApi(() => { if (failed) { throw new Error('backend unavailable'); } return packageSnapshot(1, 'ash.external'); }, async () => new Uint8Array());
	const api = withBuiltInExtensions(installed, packageApi(() => packageSnapshot(1, 'ash.builtIn', 'builtIn'), async () => new Uint8Array([42])));
	const first = await api.list('cached');
	failed = true;
	await assert.rejects(api.list('refresh'), /backend unavailable/);
	assert.deepEqual(await api.resources.readExtensionResourceBytes({ generation: first.generation, extensionId: 'ash.builtIn', path: 'resource.txt' }), new Uint8Array([42]));
	failed = false;
	assert.strictEqual(await api.list('refresh'), first);
});

test('client composition preserves gallery URL and read contracts', async () => {
	const bytes = new TextEncoder().encode('gallery');
	const installed: IExtensionApi = {
		list: async () => ({ generation: 1, extensions: [], diagnostics: [] }),
		resources: new ExtensionResourceLoaderService(async () => { throw new Error('not installed'); }, {
			template: async () => 'https://gallery.example/assets/{publisher}/{name}/{version}/{path}',
			read: async () => bytes,
		}),
	};
	const api = withBuiltInExtensions(installed, packageApi(() => packageSnapshot(1, 'ash.builtIn', 'builtIn'), async () => new Uint8Array()));
	const uri = await api.resources.getExtensionGalleryResourceURL({ publisher: 'test', name: 'theme', version: '1.0.0' }, 'themes/theme.json');
	assert.equal(uri?.toString(), 'https://gallery.example/assets/test/theme/1.0.0/themes/theme.json');
	assert.equal(await api.resources.supportsExtensionGalleryResources(), true);
	assert.equal(await api.resources.isExtensionGalleryResource(uri!), true);
	assert.equal(await api.resources.readExtensionResource(uri!), 'gallery');
});


test('resource composition reports duplicate packages and retired resources in Chinese', async () => {
	const messages = JSON.parse(await readFile('localization/zh-CN/workbench.json', 'utf8'));
	setNlsMessages('zh-CN', messages);
	try {
		const api = withBuiltInExtensions(packageApi(() => packageSnapshot(1, 'ash.builtIn'), async () => new Uint8Array()), packageApi(() => packageSnapshot(1, 'ash.builtIn', 'builtIn'), async () => new Uint8Array()));
		assert.equal((await api.list('cached')).diagnostics[0]?.message, '产品已提供同名扩展。');
		await assert.rejects(api.resources.readExtensionResourceBytes({ generation: 0, extensionId: 'ash.builtIn', path: 'resource.txt' }), /扩展资源版本已失效/);
	} finally {
		resetNlsResolver();
	}
});
