import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../../services/storage/browser/storageService.js';
import { ChatEditingSessionStorage, type StoredSessionState } from '../../../browser/chatEditing/chatEditingSessionStorage.js';

const state: StoredSessionState = {
	version: 1,
	entries: [
		{
			kind: 'text',
			resource: 'file:///workspace/file.txt',
			original: 'original',
			current: 'agent',
			sources: [{ threadId: 'chat', turnId: 'turn', outcome: 'completed' }],
		},
	],
};

test('unchanged review state skips global flushing while failed writes and removals still retry', async () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		using storage = new BrowserStorageService({
			ownerWindow: dom.window as unknown as Window,
			workspaceId: 'review-flush',
			flushInterval: 0,
		});
		using services = new InstantiationService();
		services.registerInstance(IStorageService, storage);
		const persistence = services.createInstance(ChatEditingSessionStorage);
		persistence.restoreState();
		let failed = true;
		let flushes = 0;
		storage.flush = async () => {
			flushes++;
			if (failed) throw new Error('Storage unavailable');
		};
		await persistence.storeState({ version: 1, entries: [] });
		assert.equal(flushes, 0);
		await assert.rejects(persistence.storeState(state), /Storage unavailable/);
		failed = false;
		await persistence.storeState(state);
		assert.equal(flushes, 2);
		await persistence.storeState(state);
		assert.equal(flushes, 2);
		failed = true;
		await assert.rejects(persistence.storeState({ version: 1, entries: [] }), /Storage unavailable/);
		failed = false;
		await persistence.storeState({ version: 1, entries: [] });
		assert.equal(flushes, 4);
		assert.equal(persistence.restoreState(), undefined);
	} finally {
		dom.window.close();
	}
});

test('review storage round trips editor snapshots without changing unrelated workspace state', async () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		using storage = new BrowserStorageService({
			ownerWindow: dom.window as unknown as Window,
			workspaceId: 'review-storage',
			flushInterval: 0,
		});
		using services = new InstantiationService();
		services.registerInstance(IStorageService, storage);
		const persistence = services.createInstance(ChatEditingSessionStorage);
		storage.store('unrelated', 'keep', StorageScope.WORKSPACE, StorageTarget.USER);
		assert.equal(persistence.restoreState(), undefined);
		await persistence.storeState(state);
		assert.deepEqual(services.createInstance(ChatEditingSessionStorage).restoreState(), state);
		assert.deepEqual(storage.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE), ['chatEditing.sessions']);
		await persistence.storeState({ version: 1, entries: [] });
		assert.equal(storage.get('chatEditing.sessions', StorageScope.WORKSPACE), undefined);
		assert.equal(storage.get('unrelated', StorageScope.WORKSPACE), 'keep');
	} finally {
		dom.window.close();
	}
});

test('review storage rejects malformed snapshots and duplicate resource owners without rewriting them', () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		using storage = new BrowserStorageService({
			ownerWindow: dom.window as unknown as Window,
			workspaceId: 'review-validation',
			flushInterval: 0,
		});
		using services = new InstantiationService();
		services.registerInstance(IStorageService, storage);
		for (const invalid of [
			'{',
			JSON.stringify({ ...state, version: 2 }),
			JSON.stringify({ ...state, entries: [{ ...state.entries[0], pendingSaveSource: 1 }] }),
			JSON.stringify({ ...state, entries: [state.entries[0], state.entries[0]] }),
			JSON.stringify({ version: 1, entries: [{ ...state.entries[0], sources: [] }] }),
			JSON.stringify({
				version: 1,
				entries: [{ ...state.entries[0], sources: [{ threadId: 'chat', turnId: 'turn', outcome: 'unexpected' }] }],
			}),
		]) {
			storage.store('chatEditing.sessions', invalid, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			assert.throws(() => services.createInstance(ChatEditingSessionStorage).restoreState());
			assert.equal(storage.get('chatEditing.sessions', StorageScope.WORKSPACE), invalid);
		}
	} finally {
		dom.window.close();
	}
});

test('a stale review storage writer cannot replace a newer saved snapshot', async () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		using storage = new BrowserStorageService({
			ownerWindow: dom.window as unknown as Window,
			workspaceId: 'review-conflict',
			flushInterval: 0,
		});
		using services = new InstantiationService();
		services.registerInstance(IStorageService, storage);
		const first = services.createInstance(ChatEditingSessionStorage);
		const stale = services.createInstance(ChatEditingSessionStorage);
		first.restoreState();
		stale.restoreState();
		await first.storeState(state);
		await assert.rejects(stale.storeState({ version: 1, entries: [] }), /Another window changed/);
		assert.deepEqual(services.createInstance(ChatEditingSessionStorage).restoreState(), state);
	} finally {
		dom.window.close();
	}
});

test('review storage retains a pending rejection source for a later model-backed retry', async () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		using storage = new BrowserStorageService({
			ownerWindow: dom.window as unknown as Window,
			workspaceId: 'review-retry',
			flushInterval: 0,
		});
		using services = new InstantiationService();
		services.registerInstance(IStorageService, storage);
		const persistence = services.createInstance(ChatEditingSessionStorage);
		persistence.restoreState();
		const pending: StoredSessionState = {
			...state,
			entries: [
				{
					...state.entries[0]!,
					kind: 'text',
					resource: 'file:///workspace/file.txt',
					original: 'original',
					current: 'original',
					pendingSaveSource: 'agent',
				},
			],
		};
		await persistence.storeState(pending);
		assert.deepEqual(services.createInstance(ChatEditingSessionStorage).restoreState(), pending);
	} finally {
		dom.window.close();
	}
});
