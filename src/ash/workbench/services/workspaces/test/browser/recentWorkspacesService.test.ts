import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { URI } from '../../../../../base/common/uri.js';
import { BrowserStorageService } from '../../../storage/browser/storageService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import {
	IWorkspacesService,
	LEGACY_RECENT_WORKSPACES_STORAGE_KEY,
	RECENTLY_OPENED_STORAGE_KEY,
} from '../../../../../platform/workspaces/common/workspaces.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { BrowserWorkspacesService } from '../../browser/workspacesService.js';
import { TestWorkspaceService } from '../../../configuration/test/common/testServices.js';

test('BrowserWorkspacesService records accepted folders and workspace identities in one durable history', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	try {
		using storage = new BrowserStorageService({
			ownerWindow: browser.window as unknown as Window,
			workspaceId: 'alpha',
			backend: browser.window.localStorage,
			flushInterval: 0,
		});
		using workspace = new TestWorkspaceService({ id: 'alpha', uri: URI.file('/workspaces/alpha') });
		using services = new InstantiationService();
		services.registerInstance(IStorageService, storage);
		services.registerInstance(IWorkspaceContextService, workspace);
		using history = services.createInstance(BrowserWorkspacesService);
		assert.deepEqual(
			(await history.getRecentlyOpened()).workspaces.map(recent => recent.label),
			['alpha'],
		);
		workspace.updateWorkspace({ id: 'beta', uri: URI.file('/workspaces/beta') });
		workspace.updateWorkspace({ id: 'alpha', uri: URI.file('/workspaces/alpha') });
		assert.deepEqual(
			(await history.getRecentlyOpened()).workspaces.map(recent => recent.label),
			['alpha', 'beta'],
		);
		workspace.updateWorkspace({
			id: 'team',
			folders: [{ id: 'alpha', uri: URI.file('/workspaces/alpha'), name: 'alpha', index: 0 }],
			configuration: URI.file('/workspaces/team.code-workspace'),
			name: 'Team',
		});
		const recents = (await history.getRecentlyOpened()).workspaces;
		assert.deepEqual(
			recents.map(recent => recent.label),
			['Team', 'alpha', 'beta'],
		);
		assert.equal('workspace' in recents[0]!, true);
		await storage.flush();
		using restoredStorage = new BrowserStorageService({
			ownerWindow: browser.window as unknown as Window,
			workspaceId: 'restored',
			backend: browser.window.localStorage,
			flushInterval: 0,
		});
		using restoredWorkspace = new TestWorkspaceService({ id: 'empty' });
		using restoredServices = new InstantiationService();
		restoredServices.registerInstance(IStorageService, restoredStorage);
		restoredServices.registerInstance(IWorkspaceContextService, restoredWorkspace);
		using restored = restoredServices.createInstance(BrowserWorkspacesService);
		assert.deepEqual(
			(await restored.getRecentlyOpened()).workspaces.map(recent => recent.label),
			['Team', 'alpha', 'beta'],
		);
		await restored.removeRecentlyOpened([URI.file('/workspaces/alpha')]);
		assert.deepEqual(
			(await restored.getRecentlyOpened()).workspaces.map(recent => recent.label),
			['Team', 'beta'],
		);
		await restored.clearRecentlyOpened();
		assert.deepEqual((await restored.getRecentlyOpened()).workspaces, []);
	} finally {
		browser.window.close();
	}
});

test('browser history migrates Welcome records and clears the old key', async () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	try {
		using storage = new BrowserStorageService({
			ownerWindow: browser.window as unknown as Window,
			workspaceId: 'empty',
			backend: browser.window.localStorage,
			flushInterval: 0,
		});
		storage.store(
			LEGACY_RECENT_WORKSPACES_STORAGE_KEY,
			JSON.stringify([
				{ root: '/workspaces/team.code-workspace', name: 'Team', lastOpened: 2 },
				{ root: '/workspaces/alpha', name: 'alpha', lastOpened: 1 },
			]),
			StorageScope.PROFILE,
			StorageTarget.USER,
		);
		using services = new InstantiationService();
		services.registerInstance(IStorageService, storage);
		using workspace = new TestWorkspaceService({ id: 'empty' });
		services.registerInstance(IWorkspaceContextService, workspace);
		using history = services.createInstance(BrowserWorkspacesService);
		const migrated = await history.getRecentlyOpened();
		assert.equal(migrated.workspaces.length, 2);
		assert.equal('workspace' in migrated.workspaces[0]!, true);
		await history.addRecentlyOpened([{ folderUri: URI.file('/workspaces/beta') }]);
		assert.equal(storage.get(LEGACY_RECENT_WORKSPACES_STORAGE_KEY, StorageScope.PROFILE), undefined);
		assert.notEqual(storage.get(RECENTLY_OPENED_STORAGE_KEY, StorageScope.PROFILE), undefined);
		assert.deepEqual(
			(await history.getRecentlyOpened()).workspaces.map(recent => recent.label),
			[undefined, 'Team', 'alpha'],
		);
	} finally {
		browser.window.close();
	}
});
