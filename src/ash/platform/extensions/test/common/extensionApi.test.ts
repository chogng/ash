import type { ExtensionCatalog, ExtensionResourceRequest, IExtensionApi } from '../../common/extensionApi.js';
import { createDisconnectedExtensionApi, withEnabledBuiltInExtensions } from '../../browser/extensionApi.js';
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
