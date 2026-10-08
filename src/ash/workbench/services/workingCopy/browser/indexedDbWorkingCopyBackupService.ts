import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { URI } from "../../../../base/common/uri.js";
import { type IWorkingCopyBackupService, type WorkingCopyBackup } from "../common/workingCopyBackupService.js";
import { generateUuid } from '../../../../base/common/uuid.js';
import { BackupError } from '../../../../platform/backup/common/backup.js';

interface StoredBackup {
	readonly key: string;
	readonly workspaceId: string;
	readonly resource: string;
	readonly kind: WorkingCopyBackup["kind"];
	readonly content: string;
	readonly updatedAt: number;
	readonly revision?: string;
	readonly languageId?: string;
	readonly contentType?: string;
	readonly label?: string;
}

const DATABASE_NAME = "ash-working-copy-backups";
const DATABASE_VERSION = 1;
const STORE_NAME = "backups";

/** IndexedDB-backed backups for browser and disconnected UI runtimes. */
export class IndexedDbWorkingCopyBackupService extends Disposable implements IWorkingCopyBackupService {
	private readonly database: Promise<IDBDatabase | undefined>;
	private readonly fallback = new Map<string, StoredBackup>();
	private readonly observed = new Map<string, StoredBackup>();
	private readonly snapshots = new WeakMap<WorkingCopyBackup, StoredBackup>();

	constructor(private workspaceId: string, factory: IDBFactory | undefined = globalThis.indexedDB) {
		super();
		if (!workspaceId.trim()) throw new TypeError("Working-copy backup service requires a workspace id");
		this.database = factory ? openDatabase(factory) : Promise.resolve(undefined);
		this._register(toDisposable(() => { void this.database.then(database => database?.close()).catch(() => undefined); }));
	}

	async list(): Promise<readonly WorkingCopyBackup[]> {
		const workspaceId = this.workspaceId;
		const database = await this.database;
		const records = database
			? await request<StoredBackup[]>(database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).index("workspaceId").getAll(workspaceId))
			: [...this.fallback.values()].filter(record => record.workspaceId === workspaceId);
		const result = deserialize(records);
		const byResource = new Map(records.map(record => [record.resource, record]));
		for (const backup of result) {
			const record = byResource.get(backup.resource.toString())!;
			this.observed.set(record.key, record);
			this.snapshots.set(backup, record);
		}
		return result;
	}

	async store(backup: WorkingCopyBackup): Promise<void> {
		validateBackup(backup);
		const workspaceId = this.workspaceId;
		const key = backupKey(workspaceId, backup.resource);
		const expected = this.observed.get(key);
		const database = await this.database;
		const record = { key, workspaceId, resource: backup.resource.toString(), kind: backup.kind, content: backup.content, updatedAt: backup.updatedAt, revision: generateUuid(), ...(backup.languageId ? { languageId: backup.languageId } : {}), ...(backup.contentType ? { contentType: backup.contentType } : {}), ...(backup.label ? { label: backup.label } : {}) } satisfies StoredBackup;
		if (!database) {
			if (!sameVersion(this.fallback.get(key), expected)) throw new BackupError('conflict');
			this.fallback.set(key, record);
		} else {
			const transaction = database.transaction(STORE_NAME, 'readwrite');
			const store = transaction.objectStore(STORE_NAME);
			const reading = store.get(key) as IDBRequest<StoredBackup | undefined>;
			let conflict = false;
			reading.onsuccess = () => {
				if (!sameVersion(reading.result, expected)) {
					conflict = true;
					transaction.abort();
					return;
				}
				store.put(record);
			};
			try { await transactionDone(transaction); }
			catch (error) { if (conflict) throw new BackupError('conflict'); throw error; }
		}
		this.observed.set(key, record);
	}

	async delete(resource: URI): Promise<void> {
		const expected = this.observed.get(backupKey(this.workspaceId, resource));
		// An unopened recovery record is not evidence that this writer may discard it.
		if (expected) await this.deleteRecordIfUnchanged(expected);
	}

	switchWorkspace(workspaceId: string): void {
		if (!workspaceId.trim()) throw new TypeError("Working-copy backup service requires a workspace id");
		this.workspaceId = workspaceId;
		this.observed.clear();
	}

	/** Migration may remove only the source version acknowledged by the new storage owner. */
	async deleteIfUnchanged(backup: WorkingCopyBackup): Promise<void> {
		const expected = this.snapshots.get(backup) ?? { ...backup, key: backupKey(this.workspaceId, backup.resource), workspaceId: this.workspaceId, resource: backup.resource.toString() };
		await this.deleteRecordIfUnchanged(expected);
	}

	private async deleteRecordIfUnchanged(expected: StoredBackup): Promise<void> {
		const key = expected.key;
		const database = await this.database;
		if (!database) {
			const record = this.fallback.get(key);
			if (record && !sameVersion(record, expected)) throw new BackupError('conflict');
			this.fallback.delete(key);
		} else {
			const transaction = database.transaction(STORE_NAME, 'readwrite');
			const store = transaction.objectStore(STORE_NAME);
			const reading = store.get(key) as IDBRequest<StoredBackup | undefined>;
			let conflict = false;
			reading.onsuccess = () => {
				if (!reading.result) return;
				if (sameVersion(reading.result, expected)) store.delete(key);
				else conflict = true;
			};
			await transactionDone(transaction);
			if (conflict) throw new BackupError('conflict');
		}
		if (sameVersion(this.observed.get(key), expected)) this.observed.delete(key);
	}
}

function sameVersion(record: StoredBackup | undefined, expected: StoredBackup | undefined): boolean {
	if (!record || !expected) return record === expected;
	return record.revision === expected.revision && record.kind === expected.kind && record.content === expected.content && record.updatedAt === expected.updatedAt
		&& record.languageId === expected.languageId && record.contentType === expected.contentType && record.label === expected.label;
}

function backupKey(workspaceId: string, resource: URI): string {
	return `${workspaceId}\0${resource.toString()}`;
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const opening = factory.open(DATABASE_NAME, DATABASE_VERSION);
		opening.onupgradeneeded = () => {
			if (opening.result.objectStoreNames.contains(STORE_NAME)) return;
			opening.result.createObjectStore(STORE_NAME, { keyPath: "key" }).createIndex("workspaceId", "workspaceId", { unique: false });
		};
		opening.onsuccess = () => resolve(opening.result);
		opening.onerror = () => reject(opening.error ?? new Error("Failed to open working-copy backup database"));
		opening.onblocked = () => reject(new Error("Working-copy backup database upgrade is blocked"));
	});
}

function deserialize(records: readonly StoredBackup[]): readonly WorkingCopyBackup[] {
	const backups: WorkingCopyBackup[] = [];
	for (const record of [...records].sort((left, right) => left.updatedAt - right.updatedAt)) {
		try {
			backups.push(Object.freeze({ resource: URI.parse(record.resource), kind: record.kind, content: record.content, updatedAt: record.updatedAt, ...(record.languageId ? { languageId: record.languageId } : {}), ...(record.contentType ? { contentType: record.contentType } : {}), ...(record.label ? { label: record.label } : {}) }));
		} catch (error) {
			console.error(`Ignoring invalid working-copy backup '${record.resource}'`, error);
		}
	}
	return Object.freeze(backups);
}

function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		value.onsuccess = () => resolve(value.result);
		value.onerror = () => reject(value.error ?? new Error("Working-copy backup database request failed"));
	});
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error("Working-copy backup transaction failed"));
		transaction.onabort = () => reject(transaction.error ?? new Error("Working-copy backup transaction was aborted"));
	});
}

function validateBackup(backup: WorkingCopyBackup): void {
	if (!backup.resource || typeof backup.content !== "string") throw new TypeError("Working-copy backup requires a resource and serialized content");
	if (backup.kind !== "text" && backup.kind !== "structuredDocument") throw new TypeError("Working-copy backup kind is invalid");
	if (!Number.isSafeInteger(backup.updatedAt) || backup.updatedAt < 0) throw new RangeError("Working-copy backup timestamp is invalid");
}
