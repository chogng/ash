import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { URI } from '../../../../../base/common/uri.js';
import { IndexedDbWorkingCopyBackupService } from '../../browser/indexedDbWorkingCopyBackupService.js';

const resource = URI.file('/project/draft.ts');
const backup = { resource, kind: 'text' as const, content: 'unsaved changes', updatedAt: 42, languageId: 'typescript', label: 'Draft' };

test('empty backup reads and deletions never create a database', async () => {
	const indexedDb = createIndexedDb();
	using service = new IndexedDbWorkingCopyBackupService('workspace', indexedDb.factory);
	assert.equal(indexedDb.openCount, 0);
	const listing = service.list();
	void indexedDb.catalog.complete([]);
	assert.deepEqual(await listing, []);
	await service.delete(resource);
	assert.equal(indexedDb.openCount, 0);
});

test('existing crash backups remain pending until the database has opened', async () => {
	const indexedDb = createIndexedDb();
	indexedDb.records.set('workspace\0' + resource.toString(), { ...backup, resource: resource.toString(), key: 'workspace\0' + resource.toString(), workspaceId: 'workspace' });
	using service = new IndexedDbWorkingCopyBackupService('workspace', indexedDb.factory);
	let restored = false;
	const listing = service.list().then(value => { restored = true; return value; });
	void indexedDb.catalog.complete([{ name: 'ash-working-copy-backups', version: 1 }]);
	await indexedDb.openingStarted.p;
	assert.equal(restored, false);
	indexedDb.finishOpening();
	assert.deepEqual(await listing, [backup]);
});

test('a first backup write wins a concurrent empty catalog read without opening twice', async () => {
	const indexedDb = createIndexedDb();
	using service = new IndexedDbWorkingCopyBackupService('workspace', indexedDb.factory);
	const listing = service.list();
	const deletion = service.delete(URI.file('/project/another.ts'));
	const writing = service.store(backup);
	await indexedDb.openingStarted.p;
	indexedDb.finishOpening();
	await writing;
	void indexedDb.catalog.complete([]);
	assert.deepEqual(await listing, [backup]);
	await deletion;
	assert.equal(indexedDb.openCount, 1);
	service.switchWorkspace('another');
	assert.deepEqual(await service.list(), []);
	service.switchWorkspace('workspace');
	assert.deepEqual(await service.list(), [backup]);
	await service.delete(resource);
	assert.deepEqual(await service.list(), []);
});

test('concurrent first backup writes share one database connection', async () => {
	const indexedDb = createIndexedDb();
	using service = new IndexedDbWorkingCopyBackupService('workspace', indexedDb.factory);
	const secondBackup = { ...backup, resource: URI.file('/project/second.ts'), updatedAt: 43 };
	const writing = Promise.all([service.store(backup), service.store(secondBackup)]);
	await indexedDb.openingStarted.p;
	indexedDb.finishOpening();
	await writing;
	assert.equal(indexedDb.openCount, 1);
	assert.deepEqual(await service.list(), [backup, secondBackup]);
});

test('backup catalog errors are reported instead of treating recovery as empty', async () => {
	const indexedDb = createIndexedDb();
	using service = new IndexedDbWorkingCopyBackupService('workspace', indexedDb.factory);
	const listing = assert.rejects(service.list(), /catalog unavailable/);
	void indexedDb.catalog.error(new Error('catalog unavailable'));
	await listing;
	assert.equal(indexedDb.openCount, 0);
});

test('backup open errors are reported instead of treating recovery as empty', async () => {
	const indexedDb = createIndexedDb();
	using service = new IndexedDbWorkingCopyBackupService('workspace', indexedDb.factory);
	const listing = assert.rejects(service.list(), /storage unavailable/);
	void indexedDb.catalog.complete([{ name: 'ash-working-copy-backups', version: 1 }]);
	await indexedDb.openingStarted.p;
	indexedDb.failOpening(new DOMException('storage unavailable', 'SecurityError'));
	await listing;
});

test('disposing during a catalog read cannot open a late backup connection', async () => {
	const indexedDb = createIndexedDb();
	const service = new IndexedDbWorkingCopyBackupService('workspace', indexedDb.factory);
	const listing = assert.rejects(service.list());
	service.dispose();
	void indexedDb.catalog.complete([{ name: 'ash-working-copy-backups', version: 1 }]);
	await listing;
	assert.equal(indexedDb.openCount, 0);
});

test('a backup connection that finishes opening after disposal is closed', async () => {
	const indexedDb = createIndexedDb();
	const service = new IndexedDbWorkingCopyBackupService('workspace', indexedDb.factory);
	const writing = assert.rejects(service.store(backup), /database closed/);
	await indexedDb.openingStarted.p;
	service.dispose();
	indexedDb.finishOpening();
	await writing;
	assert.equal(indexedDb.closeCount, 1);
});

interface StoredRecord {
	readonly key: string;
	readonly workspaceId: string;
	readonly resource: string;
}

interface TestIndexedDb {
	readonly catalog: DeferredPromise<IDBDatabaseInfo[]>;
	readonly openingStarted: DeferredPromise<void>;
	readonly records: Map<string, StoredRecord>;
	readonly openCount: number;
	readonly closeCount: number;
	readonly factory: IDBFactory;
	finishOpening(): void;
	failOpening(error: DOMException): void;
}

function createIndexedDb(): TestIndexedDb {
	const catalog = new DeferredPromise<IDBDatabaseInfo[]>();
	const openingStarted = new DeferredPromise<void>();
	const records = new Map<string, StoredRecord>();
	let openCount = 0;
	let closeCount = 0;
	const database = {
		close: () => { closeCount++; },
		transaction: () => {
			if (closeCount > 0) throw new Error('database closed');
			const transaction = {
				oncomplete: null,
				objectStore: () => ({
					index: () => ({
						getAll: (workspaceId: string) => {
							const request = { result: [...records.values()].filter(record => record.workspaceId === workspaceId), onsuccess: null } as unknown as IDBRequest<StoredRecord[]>;
							queueMicrotask(() => request.onsuccess?.call(request, new Event('success')));
							return request;
						},
					}),
					put: (record: StoredRecord) => {
						records.set(record.key, record);
						queueMicrotask(() => transaction.oncomplete?.call(transaction, new Event('complete')));
					},
					delete: (key: string) => {
						records.delete(key);
						queueMicrotask(() => transaction.oncomplete?.call(transaction, new Event('complete')));
					},
				}),
			} as unknown as IDBTransaction;
			return transaction;
		},
	} as unknown as IDBDatabase;
	const opening = { result: database, onsuccess: null } as unknown as IDBOpenDBRequest;
	return {
		catalog, openingStarted, records,
		get openCount() { return openCount; },
		get closeCount() { return closeCount; },
		factory: {
			databases: () => catalog.p,
			open: () => { openCount++; void openingStarted.complete(); return opening; },
		} as unknown as IDBFactory,
		finishOpening: () => opening.onsuccess?.call(opening, new Event('success')),
		failOpening: error => {
			Object.defineProperty(opening, 'error', { value: error });
			opening.onerror?.call(opening, new Event('error'));
		},
	};
}
