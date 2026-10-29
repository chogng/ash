import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { OutlineSortOrder } from '../../browser/outline.js';
import { OutlineViewState } from '../../browser/outlineViewState.js';

test('Outline preferences restore after storage reload without leaking into another workspace', async () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		const options = { ownerWindow: dom.window as unknown as Window, backend: dom.window.localStorage, flushInterval: 0 };
		using storage = new BrowserStorageService({ ...options, workspaceId: 'first' });
		using state = new OutlineViewState(storage);
		state.followCursor = true;
		state.filterOnType = false;
		state.sortBy = OutlineSortOrder.ByName;
		await storage.flush();
		using restoredStorage = new BrowserStorageService({ ...options, workspaceId: 'first' });
		using restored = new OutlineViewState(restoredStorage);
		assert.deepEqual([restored.followCursor, restored.filterOnType, restored.sortBy], [true, false, OutlineSortOrder.ByName]);
		assert.deepEqual(restoredStorage.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE), ['outline/state']);
		using otherStorage = new BrowserStorageService({ ...options, workspaceId: 'other' });
		using other = new OutlineViewState(otherStorage);
		assert.deepEqual([other.followCursor, other.filterOnType, other.sortBy], [false, true, OutlineSortOrder.ByPosition]);
	} finally { dom.window.close(); }
});

test('Outline ignores malformed state and validates restored preferences independently', () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'test', flushInterval: 0 });
		for (const raw of ['{', 'null', '[]', '{"followCursor":"false","sortBy":42,"filterOnType":false}']) {
			storage.store('outline/state', raw, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			using state = new OutlineViewState(storage);
			assert.equal(state.followCursor, false);
			assert.equal(state.sortBy, OutlineSortOrder.ByPosition);
			assert.equal(state.filterOnType, raw.startsWith('{"') ? false : true);
		}
	} finally { dom.window.close(); }
});
