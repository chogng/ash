import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { SearchHistoryService } from '../../common/searchHistoryService.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';

test('search history persists across service recreation and keeps separate input channels', async () => {
	const dom = new JSDOM('<body></body>', { url: 'https://ash.test' });
	try {
		using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'workspace', flushInterval: 0 });
		using history = new SearchHistoryService(storage);
		const values = { search: ['needle', 'first\nsecond'], replace: ['$1!'], include: ['src/**'], exclude: ['**/*.test.ts'] };
		history.save(values);
		await storage.flush();
		using restoredStorage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'workspace', flushInterval: 0 });
		using restored = new SearchHistoryService(restoredStorage);
		assert.deepEqual(restored.load(), values);
		let cleared = 0;
		using listener = restored.onDidClearHistory(() => { cleared++; });
		restored.clearHistory();
		assert.deepEqual({ values: restored.load(), cleared }, { values: {}, cleared: 1 });
	} finally { dom.window.close(); }
});

test('search history validates stored values and bounds each channel to the latest 100 entries', () => {
	const dom = new JSDOM('<body></body>', { url: 'https://ash.test' });
	try {
		using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'workspace', flushInterval: 0 });
		using history = new SearchHistoryService(storage);
		history.save({ search: Array.from({ length: 120 }, (_, index) => `${index}`) });
		assert.deepEqual(history.load(), { search: Array.from({ length: 100 }, (_, index) => `${index + 20}`) });
		storage.store(SearchHistoryService.SEARCH_HISTORY_KEY, '{"search":[1]}', StorageScope.WORKSPACE, StorageTarget.USER);
		assert.throws(() => history.load(), /Invalid search history values/);
	} finally { dom.window.close(); }
});
