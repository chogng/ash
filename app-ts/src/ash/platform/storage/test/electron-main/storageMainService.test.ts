import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { StorageScope, StorageTarget } from '../../common/storage.js';
import { type IStorageIdentity, validateStorageSnapshot } from '../../common/storageIpc.js';
import { StorageMainService } from '../../electron-main/storageMainService.js';
import { StorageDatabaseChannel } from '../../electron-main/storageIpc.js';

suite('Desktop storage owner', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const application: IStorageIdentity = { applicationId: 'ash.code', scope: StorageScope.APPLICATION, id: 'application' };
	const entry = (value: string) => ({ value, target: StorageTarget.MACHINE });

	test('retiring an application moves resources by scope and preserves conflicting target state', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-store-'));
		try {
			const file = join(directory, 'state.json');
			using storage = new StorageMainService(file);
			await storage.initialize();
			const oldIdentity = { applicationId: 'academic', scope: StorageScope.WORKSPACE, id: 'research' };
			const newIdentity = { ...oldIdentity, applicationId: 'code' };
			await storage.getItems(oldIdentity, { editors: entry('paper.ash-academic'), layout: entry('academic-layout') });
			await storage.getItems(newIdentity, { layout: entry('code-layout') });
			assert.deepEqual(await storage.migrateApplicationStorage('academic', 'code'), ['workspace/research/layout']);
			assert.deepEqual({ ...(await storage.getItems(newIdentity)).entries }, { editors: entry('paper.ash-academic'), layout: entry('code-layout') });
			assert.deepEqual({ ...(await storage.getItems(oldIdentity)).entries }, { layout: entry('academic-layout') });
			await storage.updateItems(newIdentity, 'layout', entry('academic-layout'));
			assert.deepEqual(await storage.migrateApplicationStorage('academic', 'code'), []);
			assert.deepEqual(await storage.migrateApplicationStorage('academic', 'code'), []);
			await storage.close();
			using restored = new StorageMainService(file);
			await restored.initialize();
			assert.deepEqual({ ...(await restored.getItems(newIdentity)).entries }, { editors: entry('paper.ash-academic'), layout: entry('academic-layout') });
			const data = JSON.parse(await readFile(file, 'utf8'));
			assert.equal(data.storages.some((snapshot: { identity: IStorageIdentity }) => snapshot.identity.applicationId === 'academic'), false);
		} finally { await rm(directory, { recursive: true, force: true }); }
	});

	test('concurrent windows merge independent keys and restore the durable result', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-store-'));
		try {
			const file = join(directory, 'state.json');
			using storage = new StorageMainService(file);
			await storage.initialize();
			const channel = new StorageDatabaseChannel(storage);
			await channel.call('window:1', 'getItems', { identity: application });
			await Promise.all([
				channel.call('window:1', 'updateItems', { identity: application, key: 'first', entry: entry('one') }),
				channel.call('window:2', 'updateItems', { identity: application, key: 'second', entry: entry('two') }),
			]);
			await storage.close();
			using restored = new StorageMainService(file);
			await restored.initialize();
			assert.deepEqual({ ...(await restored.getItems(application)).entries }, { first: entry('one'), second: entry('two') });
			assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 1);
		} finally { await rm(directory, { recursive: true, force: true }); }
	});

	test('legacy import is durable, idempotent and reports conflicts without replacing state', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-store-'));
		try {
			using storage = new StorageMainService(join(directory, 'state.json'));
			await storage.initialize();
			const legacy = { layout: entry('saved') };
			await storage.getItems(application, legacy);
			assert.equal((await storage.getItems(application, legacy)).isNew, false);
			await assert.rejects(storage.getItems(application, { layout: entry('conflict') }), /migration conflict/);
			assert.deepEqual({ ...(await storage.getItems(application)).entries }, legacy);
			const channel = new StorageDatabaseChannel(storage);
			await assert.rejects(channel.call('window:1', 'updateItems', { identity: application, key: 'invalid', entry: { value: 1, target: StorageTarget.USER } }), /Invalid storage entry/);
			assert.throws(() => validateStorageSnapshot({ identity: application, revision: -1, isNew: true, entries: {} }), /Invalid storage snapshot/);
		} finally { await rm(directory, { recursive: true, force: true }); }
	});

	test('maintenance retains live and restorable empty windows, Agents and real workspaces', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-store-'));
		try {
			using storage = new StorageMainService(join(directory, 'state.json'));
			await storage.initialize();
			const ids = ['empty-window-live', 'empty-window-restore', 'empty-window-unused', 'sessions', 'folder-hash'];
			for (const id of ids) { await storage.getItems({ ...application, scope: StorageScope.WORKSPACE, id }, { layout: entry(id) }); }
			const channel = new StorageDatabaseChannel(storage);
			using active = channel.listen('window:1', 'onDidChangeStorage', { ...application, scope: StorageScope.WORKSPACE, id: 'empty-window-live' })(() => {});
			await storage.cleanUpStorage(new Set(['empty-window-restore']));
			const data = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
			assert.deepEqual(data.storages.map((snapshot: { identity: IStorageIdentity }) => snapshot.identity.id), ['empty-window-live', 'empty-window-restore', 'sessions', 'folder-hash']);
			active.dispose();
			await storage.cleanUpStorage(new Set(['empty-window-restore']));
			const cleaned = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
			assert.deepEqual(cleaned.storages.map((snapshot: { identity: IStorageIdentity }) => snapshot.identity.id), ['empty-window-restore', 'sessions', 'folder-hash']);
		} finally { await rm(directory, { recursive: true, force: true }); }
	});
});
