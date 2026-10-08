import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { StorageScope, StorageTarget } from '../../common/storage.js';
import { type IStorageIdentity, type IStorageSnapshot, validateStorageSnapshot } from '../../common/storageIpc.js';
import { StorageMainService } from '../../electron-main/storageMainService.js';
import { StorageDatabaseChannel } from '../../electron-main/storageIpc.js';

suite('Desktop storage owner', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const application: IStorageIdentity = { scope: StorageScope.APPLICATION, id: 'application' };
	const entry = (value: string) => ({ value, target: StorageTarget.MACHINE });

	test('close waits for startup migration and leaves no writes after closing', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-store-'));
		try {
			const file = join(directory, 'state.json');
			const source = JSON.stringify({ version: 1, storages: [{ identity: { ...application, applicationId: 'code' }, revision: 3, isNew: false, entries: { saved: entry('retained') } }] });
			await writeFile(file, source);
			using storage = new StorageMainService(file);
			const initializing = storage.initialize();
			try {
				const closing = storage.close();
				assert.equal(storage.close(), closing);
				await closing;
				const closedDocument = await readFile(file, 'utf8');
				assert.equal(JSON.parse(closedDocument).version, 2, 'Close must wait for startup disk work');
				assert.equal(await readFile(`${file}.v1`, 'utf8'), source);
				assert.throws(() => storage.updateItems(application, 'saved', entry('late')), /storage is closing/);
				await initializing;
				await storage.flush();
				assert.equal(await readFile(file, 'utf8'), closedDocument, 'No accepted disk work may outlive close');
			} finally { await initializing; }
		} finally { await rm(directory, { recursive: true, force: true }); }
	});

	test('requests queued during initialization read saved scopes before merging new keys', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-store-'));
		try {
			const file = join(directory, 'state.json');
			await writeFile(file, JSON.stringify({ version: 2, storages: [{ identity: application, revision: 3, isNew: false, entries: { saved: entry('retained') } }] }));
			using storage = new StorageMainService(file);
			const channel = new StorageDatabaseChannel(storage);
			const initializing = storage.initialize();
			const snapshot = channel.call<IStorageSnapshot>('window:1', 'getItems', { identity: application });
			const updating = channel.call('window:2', 'updateItems', { identity: application, key: 'added', entry: entry('new') });
			const [, loaded] = await Promise.all([initializing, snapshot, updating]);
			assert.deepEqual({ ...loaded.entries }, { saved: entry('retained') });
			await storage.close();
			using restored = new StorageMainService(file);
			await restored.initialize();
			assert.deepEqual({ ...(await restored.getItems(application)).entries }, { saved: entry('retained'), added: entry('new') });
		} finally { await rm(directory, { recursive: true, force: true }); }
	});

	test('flush waits for pending startup migration before reporting durable state', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-store-'));
		try {
			const file = join(directory, 'state.json');
			const source = JSON.stringify({ version: 1, storages: [{ identity: { ...application, applicationId: 'code' }, revision: 3, isNew: false, entries: { saved: entry('retained') } }] });
			await writeFile(file, source);
			using storage = new StorageMainService(file);
			const initializing = storage.initialize();
			try {
				await storage.flush();
				assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 2, 'Flush includes startup disk work already accepted by the owner');
				assert.equal(await readFile(`${file}.v1`, 'utf8'), source);
				assert.deepEqual({ ...(await storage.getItems(application)).entries }, { saved: entry('retained') });
			} finally { await initializing; }
		} finally { await rm(directory, { recursive: true, force: true }); }
	});

	test('parallel and repeated initialization share one load without replacing later writes', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-store-'));
		try {
			const file = join(directory, 'state.json');
			await writeFile(file, JSON.stringify({ version: 2, storages: [{ identity: application, revision: 0, isNew: false, entries: { saved: entry('before') } }] }));
			using storage = new StorageMainService(file);
			await Promise.all([storage.initialize(), storage.initialize()]);
			let reentered: Promise<void> | undefined;
			using listener = storage.onDidChangeStorage(() => { reentered = storage.initialize(); });
			await storage.updateItems(application, 'saved', entry('after'));
			assert.ok(reentered);
			await reentered;
			await storage.initialize();
			await storage.close();
			assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).storages[0].entries, { saved: entry('after') });
		} finally { await rm(directory, { recursive: true, force: true }); }
	});

	test('close before initialization rejects startup without creating a storage file', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-store-'));
		try {
			const file = join(directory, 'unused', 'state.json');
			using storage = new StorageMainService(file);
			await storage.close();
			const failure: unknown = await storage.initialize().catch(error => error);
			assert.ok(failure instanceof Error);
			assert.match(failure.message, /storage is closing/);
			await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' });
		} finally { await rm(directory, { recursive: true, force: true }); }
	});

	test('initialization after disposal returns a rejection that catch can handle', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-store-'));
		try {
			const file = join(directory, 'unused', 'state.json');
			using storage = new StorageMainService(file);
			storage.dispose();
			const failure: unknown = await storage.initialize().catch(error => error);
			assert.ok(failure instanceof ReferenceError);
			await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' });
		} finally { await rm(directory, { recursive: true, force: true }); }
	});

	test('initialization failures remain visible and close drains the failed startup', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-store-'));
		try {
			const file = join(directory, 'state.json');
			const source = JSON.stringify({ version: 99, storages: [] });
			await writeFile(file, source);
			using storage = new StorageMainService(file);
			const initializing = storage.initialize();
			const closing = storage.close();
			await assert.rejects(initializing, /Invalid Desktop storage file/);
			await closing;
			await assert.rejects(storage.initialize(), /Invalid Desktop storage file/);
			assert.equal(await readFile(file, 'utf8'), source);
			await writeFile(file, JSON.stringify({ version: 2, storages: [{ identity: application, revision: 0, isNew: false, entries: { saved: entry('repaired') } }] }));
			await assert.rejects(storage.initialize(), /Invalid Desktop storage file/, 'Failed startup remains cached even after repairing the file');
			using restored = new StorageMainService(file);
			await restored.initialize();
			assert.deepEqual({ ...(await restored.getItems(application)).entries }, { saved: entry('repaired') });
		} finally { await rm(directory, { recursive: true, force: true }); }
	});

	test('a rejected mutation does not poison flush or writes to another scope', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-store-'));
		try {
			const file = join(directory, 'state.json');
			using storage = new StorageMainService(file);
			await storage.initialize();
			await storage.getItems(application, { saved: entry('retained') });
			await assert.rejects(storage.getItems(application, { saved: entry('conflict') }), /migration conflict/);
			await storage.flush();
			const workspace: IStorageIdentity = { scope: StorageScope.WORKSPACE, id: 'research' };
			await storage.getItems(workspace);
			await storage.updateItems(workspace, 'layout', entry('saved'));
			await storage.flush();
			await storage.close();
			using restored = new StorageMainService(file);
			await restored.initialize();
			assert.deepEqual({ ...(await restored.getItems(application)).entries }, { saved: entry('retained') });
			assert.deepEqual({ ...(await restored.getItems(workspace)).entries }, { layout: entry('saved') });
		} finally { await rm(directory, { recursive: true, force: true }); }
	});

	test('a disk write failure preserves durable data and later writes can be flushed', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-store-'));
		try {
			const file = join(directory, 'state.json');
			using storage = new StorageMainService(file);
			await storage.initialize();
			await storage.getItems(application, { saved: entry('retained') });
			const durable = await readFile(file, 'utf8');
			const changes: IStorageSnapshot[] = [];
			using listener = storage.onDidChangeStorage(snapshot => changes.push(snapshot));
			const temporary = `${file}.${process.pid}.tmp`;
			await mkdir(temporary);
			await assert.rejects(storage.updateItems(application, 'saved', entry('failed')), { code: 'EISDIR' });
			await storage.flush();
			assert.equal(await readFile(file, 'utf8'), durable);
			assert.deepEqual(changes, []);
			await rm(temporary, { recursive: true });
			const workspace: IStorageIdentity = { scope: StorageScope.WORKSPACE, id: 'research' };
			await storage.getItems(workspace);
			await storage.updateItems(workspace, 'layout', entry('saved'));
			await storage.updateItems(application, 'saved', entry('retried'));
			await storage.flush();
			await storage.close();
			using restored = new StorageMainService(file);
			await restored.initialize();
			assert.deepEqual({ ...(await restored.getItems(application)).entries }, { saved: entry('retried') });
			assert.deepEqual({ ...(await restored.getItems(workspace)).entries }, { layout: entry('saved') });
		} finally { await rm(directory, { recursive: true, force: true }); }
	});

	for (const reversed of [false, true]) {
		test(`startup migrates v1 scopes and archives the source before v2 writes (reversed: ${reversed})`, async () => {
			const directory = await mkdtemp(join(tmpdir(), 'ash-store-'));
			try {
				const file = join(directory, 'state.json');
				const identity = { scope: StorageScope.WORKSPACE, id: 'research' };
				const storages = [
					{ identity: { ...identity, applicationId: 'academic' }, revision: 5, isNew: false, entries: { editors: entry('paper'), layout: entry('academic') } },
					{ identity: { ...identity, applicationId: 'code' }, revision: 2, isNew: false, entries: { layout: entry('code') } },
					{ identity: { applicationId: 'academic', scope: StorageScope.PROFILE, id: 'sessions' }, revision: 1, isNew: false, entries: { sidebar: entry('360') } },
					{ identity: { ...application, applicationId: 'code' }, revision: 3, isNew: false, entries: { fonts: entry('cache') } },
				];
				const source = JSON.stringify({ version: 1, storages: reversed ? storages.reverse() : storages });
				await writeFile(file, source);
				using storage = new StorageMainService(file);
				await storage.initialize();
				assert.deepEqual({ ...(await storage.getItems(identity)).entries }, { editors: entry('paper'), layout: entry('code') });
				assert.equal((await storage.getItems(identity)).revision, 6);
				assert.deepEqual({ ...(await storage.getItems({ scope: StorageScope.PROFILE, id: 'sessions' })).entries }, { sidebar: entry('360') });
				assert.deepEqual({ ...(await storage.getItems(application)).entries }, { fonts: entry('cache') });
				assert.equal(await readFile(`${file}.v1`, 'utf8'), source);
				await storage.updateItems(identity, 'editors', null);
				await storage.close();
				using restored = new StorageMainService(file);
				await restored.initialize();
				assert.deepEqual({ ...(await restored.getItems(identity)).entries }, { layout: entry('code') }, 'Archived data must never be replayed');
				const data = JSON.parse(await readFile(file, 'utf8'));
				assert.equal(data.version, 2);
				assert.equal(data.storages.length, 3);
				assert.equal(data.storages.some((snapshot: { identity: object; }) => 'applicationId' in snapshot.identity), false);
				assert.equal(await readFile(`${file}.v1`, 'utf8'), source);
			} finally { await rm(directory, { recursive: true, force: true }); }
		});
	}

	test('invalid v1 identities and failed archival leave the original file untouched', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-store-'));
		try {
			const file = join(directory, 'state.json');
			const snapshot = { identity: { ...application, applicationId: 'unknown' }, revision: 0, isNew: false, entries: {} };
			const invalid = JSON.stringify({ version: 1, storages: [snapshot] });
			await writeFile(file, invalid);
			using invalidStorage = new StorageMainService(file);
			await assert.rejects(invalidStorage.initialize(), /Invalid legacy Desktop storage identity/);
			assert.equal(await readFile(file, 'utf8'), invalid);
			snapshot.identity.applicationId = 'code';
			const source = JSON.stringify({ version: 1, storages: [snapshot] });
			await writeFile(file, source);
			await mkdir(`${file}.v1`);
			using storage = new StorageMainService(file);
			await assert.rejects(storage.initialize(), { code: 'EISDIR' });
			assert.equal(await readFile(file, 'utf8'), source);
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
			assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 2);
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
			using active = channel.listen('window:1', 'onDidChangeStorage', { ...application, scope: StorageScope.WORKSPACE, id: 'empty-window-live' })(() => { });
			await storage.cleanUpStorage(new Set(['empty-window-restore']));
			const data = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
			assert.deepEqual(data.storages.map((snapshot: { identity: IStorageIdentity; }) => snapshot.identity.id), ['empty-window-live', 'empty-window-restore', 'sessions', 'folder-hash']);
			active.dispose();
			await storage.cleanUpStorage(new Set(['empty-window-restore']));
			const cleaned = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
			assert.deepEqual(cleaned.storages.map((snapshot: { identity: IStorageIdentity; }) => snapshot.identity.id), ['empty-window-restore', 'sessions', 'folder-hash']);
		} finally { await rm(directory, { recursive: true, force: true }); }
	});
});
