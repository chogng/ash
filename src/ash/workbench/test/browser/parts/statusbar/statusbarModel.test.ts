import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { StatusbarViewModel } from '../../../../browser/parts/statusbar/statusbarModel.js';

const key = 'workbench.statusbar.hidden';

test('status bar visibility survives a new model and storage session in the same profile', async () => {
	const browser = new JSDOM('', { url: 'https://ash.test' });
	try {
		using services = new InstantiationService();
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'first', flushInterval: 0 });
		services.registerInstance(IStorageService, storage);
		using model = services.createInstance(StatusbarViewModel);
		const changes: { id: string; visible: boolean; }[] = [];
		using listener = model.onDidChangeEntryVisibility(event => changes.push(event));
		model.hide('branch');
		model.hide('branch');
		assert.deepEqual(changes, [{ id: 'branch', visible: false }]);
		assert.deepEqual(storage.keys(StorageScope.PROFILE, StorageTarget.USER), [key]);
		await storage.flush();
		using restoredStorage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'other', flushInterval: 0 });
		using restoredServices = new InstantiationService();
		restoredServices.registerInstance(IStorageService, restoredStorage);
		using restored = restoredServices.createInstance(StatusbarViewModel);
		assert.equal(restored.isHidden('branch'), true);
		restored.show('branch');
		assert.equal(restoredStorage.get(key, StorageScope.PROFILE), undefined);
	} finally {
		browser.window.close();
	}
});

test('status bar models project shared storage changes once and stop observing after disposal', () => {
	const browser = new JSDOM('', { url: 'https://ash.test' });
	try {
		using services = new InstantiationService();
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'first', flushInterval: 0 });
		services.registerInstance(IStorageService, storage);
		using first = services.createInstance(StatusbarViewModel);
		using second = services.createInstance(StatusbarViewModel);
		const changes: { id: string; visible: boolean; }[] = [];
		using listener = second.onDidChangeEntryVisibility(event => changes.push(event));
		first.hide('one');
		second.hide('two');
		first.show('one');
		assert.equal(first.isHidden('two'), true);
		assert.deepEqual(changes, [{ id: 'one', visible: false }, { id: 'two', visible: false }, { id: 'one', visible: true }]);
		second.dispose();
		first.show('two');
		second.hide('retired');
		assert.equal(storage.get(key, StorageScope.PROFILE), undefined);
		assert.equal(changes.length, 3);
	} finally {
		browser.window.close();
	}
});

test('invalid persisted status bar visibility preserves the last valid state and stored input', () => {
	const browser = new JSDOM('', { url: 'https://ash.test' });
	const warning = mock.method(console, 'warn', () => { });
	try {
		using services = new InstantiationService();
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'first', flushInterval: 0 });
		services.registerInstance(IStorageService, storage);
		using model = services.createInstance(StatusbarViewModel);
		model.hide('one');
		for (const invalid of ['{', '{}', '["one", 2]', '[""]']) {
			storage.store(key, invalid, StorageScope.PROFILE, StorageTarget.USER);
			assert.equal(model.isHidden('one'), true);
			assert.equal(storage.get(key, StorageScope.PROFILE), invalid);
		}
		assert.equal(warning.mock.callCount(), 4);
		storage.remove(key, StorageScope.PROFILE);
		assert.equal(model.isHidden('one'), false);
	} finally {
		warning.mock.restore();
		browser.window.close();
	}
});

test('external profile storage changes update status bar visibility without writing them back', () => {
	const browser = new JSDOM('', { url: 'https://ash.test' });
	try {
		using services = new InstantiationService();
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'first', flushInterval: 0 });
		using writer = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'other', flushInterval: 0 });
		services.registerInstance(IStorageService, storage);
		using model = services.createInstance(StatusbarViewModel);
		const changes: { id: string; visible: boolean; }[] = [];
		using listener = model.onDidChangeEntryVisibility(event => changes.push(event));
		writer.store(key, '["branch"]', StorageScope.PROFILE, StorageTarget.USER);
		const storageKey = 'ash.storage.profile.default';
		const source = browser.window.localStorage.getItem(storageKey);
		browser.window.dispatchEvent(new browser.window.StorageEvent('storage', { key: storageKey, newValue: source }));
		assert.equal(model.isHidden('branch'), true);
		assert.deepEqual(changes, [{ id: 'branch', visible: false }]);
		assert.equal(browser.window.localStorage.getItem(storageKey), source);
		writer.remove(key, StorageScope.PROFILE);
		browser.window.dispatchEvent(new browser.window.StorageEvent('storage', { key: storageKey, newValue: browser.window.localStorage.getItem(storageKey) }));
		assert.equal(model.isHidden('branch'), false);
		assert.deepEqual(changes, [{ id: 'branch', visible: false }, { id: 'branch', visible: true }]);
	} finally {
		browser.window.close();
	}
});
