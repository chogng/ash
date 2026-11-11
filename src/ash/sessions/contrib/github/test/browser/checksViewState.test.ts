import assert from 'node:assert/strict';
import { setup, suite, teardown, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { checksCollapseStateKey, checksThreadKey, legacyChecksCollapseStateKey, migrateChecksCollapseState, readCollapsedChecks, setChecksCollapsed } from '../../browser/checksViewState.js';

suite('Checks collapse state migration', () => {
	const sessionThread = checksThreadKey('session', 'thread');
	const peerThread = checksThreadKey('session', 'peer');
	const otherSession = checksThreadKey('other', 'thread');
	const legacyRest = { version: 1, changesets: [['ash-session-changes:/session?thread=thread', 'capture']], details: [], reviewed: [] };
	const legacy = JSON.stringify({
		...legacyRest,
		sections: [
			['ash-session-changes:/session?thread=thread', { checks: true }],
			['ash-session-changes:/session?thread=peer', { checks: false }],
			['ash-session-changes:/other?thread=thread', { checks: true }],
		],
	});

	let dom: JSDOM;
	let storage: BrowserStorageService;
	teardown(() => {
		storage.dispose();
		dom.window.close();
	});
	ensureNoDisposablesAreLeakedInTestSuite();
	setup(() => {
		dom = new JSDOM('<!doctype html><body></body>', { url: 'https://checks.test' });
		storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'checks', flushInterval: 0 });
		storage.store(legacyChecksCollapseStateKey, legacy, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	});

	test('preserves the collapse preference per session and thread and retains the remaining Changes state', async () => {
		const migration = migrateChecksCollapseState(storage);
		assert.deepEqual([...readCollapsedChecks(storage)], [sessionThread, otherSession]);
		await migration;
		assert.deepEqual(JSON.parse(storage.get(legacyChecksCollapseStateKey, StorageScope.WORKSPACE)!), legacyRest);
		assert.ok(storage.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE).includes(checksCollapseStateKey));

		setChecksCollapsed(storage, sessionThread, false);
		setChecksCollapsed(storage, peerThread, true);
		await migrateChecksCollapseState(storage);
		assert.deepEqual([...readCollapsedChecks(storage)], [otherSession, peerThread]);
		await storage.switchWorkspace('other');
		assert.deepEqual([...readCollapsedChecks(storage)], []);
	});

	test('retains both values when saved Checks state differs from the legacy state', async () => {
		setChecksCollapsed(storage, peerThread, true);
		await assert.rejects(migrateChecksCollapseState(storage), /conflicts with saved Checks state/);
		assert.deepEqual([...readCollapsedChecks(storage)], [peerThread]);
		assert.equal(storage.get(legacyChecksCollapseStateKey, StorageScope.WORKSPACE), legacy);
	});

	test('keeps the legacy preference after a failed flush and removes it after retry', async () => {
		const flush = storage.flush.bind(storage);
		storage.flush = async () => { throw new Error('write failed'); };
		await assert.rejects(migrateChecksCollapseState(storage), /write failed/);
		assert.equal(storage.get(legacyChecksCollapseStateKey, StorageScope.WORKSPACE), legacy);

		storage.flush = flush;
		await migrateChecksCollapseState(storage);
		assert.deepEqual([...readCollapsedChecks(storage)], [sessionThread, otherSession]);
		assert.deepEqual(JSON.parse(storage.get(legacyChecksCollapseStateKey, StorageScope.WORKSPACE)!), legacyRest);
	});
});
