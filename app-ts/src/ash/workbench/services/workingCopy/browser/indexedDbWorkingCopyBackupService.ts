import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { URI } from "../../../../base/common/uri.js";
import { type IWorkingCopyBackupService, type WorkingCopyBackup } from "../common/workingCopyBackupService.js";

interface StoredBackup {
	readonly key: string;
	readonly workspaceId: string;
	readonly resource: string;
	readonly kind: WorkingCopyBackup["kind"];
	readonly content: string;
	readonly updatedAt: number;
	readonly languageId?: string;
	readonly contentType?: string;
	readonly label?: string;
}

const DATABASE_NAME = "ash-working-copy-backups";
const DATABASE_VERSION = 1;
const STORE_NAME = "backups";

/** IndexedDB-backed working-copy backups shared by browser and Electron renderers. */
export class IndexedDbWorkingCopyBackupService extends Disposable implements IWorkingCopyBackupService {
	private readonly database: Promise<IDBDatabase | undefined>;
	private readonly fallback = new Map<string, StoredBackup>();

	constructor(private workspaceId: string, factory: IDBFactory | undefined = globalThis.indexedDB) {
		super();
		if (!workspaceId.trim()) throw new TypeError("Working-copy backup service requires a workspace id");
		this.database = factory ? openDatabase(factory) : Promise.resolve(undefined);
		this._register(toDisposable(() => { void this.database.then(database => database?.close()).catch(() => undefined); }));
	}

	async list(): Promise<readonly WorkingCopyBackup[]> {
		const workspaceId = this.workspaceId;
		const database = await this.database;
		if (!database) return deserialize([...this.fallback.values()].filter(record => record.workspaceId === workspaceId));
		const records = await request<StoredBackup[]>(database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).index("workspaceId").getAll(workspaceId));
		return deserialize(records);
	}

	async store(backup: WorkingCopyBackup): Promise<void> {
		validateBackup(backup);
		const workspaceId = this.workspaceId;
		const database = await this.database;
		const record = { key: backupKey(workspaceId, backup.resource), workspaceId, resource: backup.resource.toString(), kind: backup.kind, content: backup.content, updatedAt: backup.updatedAt, ...(backup.languageId ? { languageId: backup.languageId } : {}), ...(backup.contentType ? { contentType: backup.contentType } : {}), ...(backup.label ? { label: backup.label } : {}) } satisfies StoredBackup;
		if (!database) { this.fallback.set(record.key, record); return; }
		const transaction = database.transaction(STORE_NAME, "readwrite");
		transaction.objectStore(STORE_NAME).put(record);
		await transactionDone(transaction);
	}

	async delete(resource: URI): Promise<void> {
		const workspaceId = this.workspaceId;
		const database = await this.database;
		if (!database) { this.fallback.delete(backupKey(workspaceId, resource)); return; }
		const transaction = database.transaction(STORE_NAME, "readwrite");
		transaction.objectStore(STORE_NAME).delete(backupKey(workspaceId, resource));
		await transactionDone(transaction);
	}

	switchWorkspace(workspaceId: string): void {
		if (!workspaceId.trim()) throw new TypeError("Working-copy backup service requires a workspace id");
		this.workspaceId = workspaceId;
	}
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
