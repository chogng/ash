import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { GlobalExtensionEnablementService } from '../../common/extensionEnablementService.js';
import { BrowserStorageService } from '../../../../workbench/services/storage/browser/storageService.js';
import { StorageScope, StorageTarget } from '../../../storage/common/storage.js';
import { withEnabledBuiltInExtensions } from '../../../extensions/browser/extensionApi.js';
import { normalizeExtensionCatalog } from '../../../extensions/common/extensionApi.js';
import { ExtensionResourceLoaderService } from '../../../extensionResourceLoader/browser/extensionResourceLoaderService.js';

test('editor enablement persists in the profile across workspaces and preserves unrelated state', async () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'one', profileId: 'default', flushInterval: 0 });
		using enablement = new GlobalExtensionEnablementService(storage);
		storage.store('draft', 'keep', StorageScope.PROFILE, StorageTarget.USER);
		let changes = 0;
		using listener = enablement.onDidChangeEnablement(() => changes++);
		assert.equal(await enablement.disableExtension({ id: 'ASH.Git' }), true);
		assert.equal(await enablement.disableExtension({ id: 'ash.git' }), false);
		assert.equal(changes, 1);
		using restoredStorage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'two', profileId: 'default', flushInterval: 0 });
		using restored = new GlobalExtensionEnablementService(restoredStorage);
		assert.deepEqual(restored.getDisabledExtensions(), [{ id: 'ash.git' }]);
		assert.equal(restoredStorage.get('draft', StorageScope.PROFILE), 'keep');
		using otherStorage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'two', profileId: 'other', flushInterval: 0 });
		using other = new GlobalExtensionEnablementService(otherStorage);
		assert.deepEqual(other.getDisabledExtensions(), []);
		assert.equal(await enablement.enableExtension({ id: 'ash.git' }), true);
		assert.equal(await enablement.enableExtension({ id: 'ash.git' }), false);
		assert.deepEqual(enablement.getDisabledExtensions(), []);
		assert.equal(changes, 2);
	} finally { dom.window.close(); }
});

test('editor enablement rejects invalid identifiers and malformed persisted input before writing', async () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'one', flushInterval: 0 });
		using enablement = new GlobalExtensionEnablementService(storage);
		await assert.rejects(enablement.disableExtension({ id: '../git' }), /Invalid extension identifier/);
		assert.deepEqual(enablement.getDisabledExtensions(), []);
		storage.store('extensionsIdentifiers/disabled', '[{"id":12}]', StorageScope.PROFILE, StorageTarget.USER);
		assert.throws(() => enablement.getDisabledExtensions(), /Invalid extension identifier/);
		await assert.rejects(enablement.disableExtension({ id: 'ash.git' }), /Invalid extension identifier/);
		assert.equal(storage.get('extensionsIdentifiers/disabled', StorageScope.PROFILE), '[{"id":12}]');
	} finally { dom.window.close(); }
});

test('disabled built-ins leave installed execution policy and immutable package resources with their owners', async () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'one', flushInterval: 0 });
		using enablement = new GlobalExtensionEnablementService(storage);
		const catalog = normalizeExtensionCatalog({ generation: 7, diagnostics: [], extensions: ['ash.git', 'user.language'].map((id, index) => ({ id, name: id, publisher: 'test', version: '1', displayName: id, sourceKind: index === 0 ? 'builtIn' : 'user', manifestJson: '{}', manifestSha256: 'sha256:' + 'a'.repeat(64), packageSha256: 'sha256:' + 'b'.repeat(64) })) });
		const packages = withEnabledBuiltInExtensions({ list: async () => catalog, resources: new ExtensionResourceLoaderService(async request => new TextEncoder().encode(request.path)) }, enablement);
		let changes = 0;
		using listener = packages.onDidChange!(() => changes++);
		await enablement.disableExtension({ id: 'ash.git' });
		await enablement.disableExtension({ id: 'user.language' });
		assert.deepEqual((await packages.list('refresh')).extensions.map(extension => extension.id), ['user.language']);
		assert.equal(changes, 2);
		await enablement.enableExtension({ id: 'ash.git' });
		assert.deepEqual((await packages.list('cached')).extensions.map(extension => extension.id), ['ash.git', 'user.language']);
		assert.equal(new TextDecoder().decode(await packages.resources.readExtensionResourceBytes({ generation: 7, extensionId: 'ash.git', path: 'package.nls.json' })), 'package.nls.json');
	} finally { dom.window.close(); }
});
