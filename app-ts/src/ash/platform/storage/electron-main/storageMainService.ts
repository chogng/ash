import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import { StorageScope } from '../common/storage.js';
import { storageIdentityKey, validateStorageEntries, validateStorageSnapshot, type IStorageIdentity, type IStorageEntry, type IStorageSnapshot } from '../common/storageIpc.js';

/** One Desktop writer merges key mutations; renderer snapshots never replace an entire scope. */
export class StorageMainService extends Disposable {
	private readonly changes = this._register(new Emitter<IStorageSnapshot>());
	public readonly onDidChangeStorage = this.changes.event;
	private readonly storages = new Map<string, IStorageSnapshot>();
	private readonly users = new Map<string, number>();
	private queue: Promise<void> = Promise.resolve();
	private closing: Promise<void> | undefined;

	constructor(private readonly filePath: string) { super(); }

	public async initialize(): Promise<void> {
		this.assertNotDisposed();
		await mkdir(dirname(this.filePath), { recursive: true });
		let source: string;
		try { source = await readFile(this.filePath, 'utf8'); }
		catch (error) {
			if (isRecord(error) && error.code === 'ENOENT') { return; }
			throw error;
		}
		const data: unknown = JSON.parse(source);
		if (!isRecord(data) || (data.version !== 1 && data.version !== 2) || !Array.isArray(data.storages)) { throw new TypeError('Invalid Desktop storage file'); }
		if (data.version === 1) {
			const migrated = migrateStorage(data.storages);
			// The original document is an archive, never a second runtime storage source.
			await writeFile(`${this.filePath}.v1`, source, 'utf8');
			await this.write(migrated);
			for (const [key, snapshot] of migrated) { this.storages.set(key, snapshot); }
			return;
		}
		for (const candidate of data.storages) {
			const snapshot = validateStorageSnapshot(candidate);
			const key = storageIdentityKey(snapshot.identity);
			if (this.storages.has(key)) { throw new TypeError('Duplicate Desktop storage identity'); }
			this.storages.set(key, { ...snapshot, isNew: false });
		}
	}

	public getItems(identity: IStorageIdentity, legacy?: Readonly<Record<string, IStorageEntry>>): Promise<IStorageSnapshot> {
		return this.run(async () => {
			const key = storageIdentityKey(identity);
			const existing = this.storages.get(key);
			if (existing) {
				// An interrupted migration can be completed only when its source still equals the durable target.
				if (legacy && !sameEntries(legacy, existing.entries)) { throw new Error('Desktop storage migration conflict'); }
				return { ...existing, isNew: false };
			}
			const snapshot: IStorageSnapshot = { identity, revision: 0, isNew: true, entries: legacy ?? validateStorageEntries({}) };
			await this.persist(key, snapshot);
			return snapshot;
		});
	}

	public updateItems(identity: IStorageIdentity, key: string, entry: IStorageEntry | null): Promise<IStorageSnapshot> {
		return this.run(async () => {
			const identityKey = storageIdentityKey(identity);
			const current = this.storages.get(identityKey);
			if (!current) { throw new Error('Storage scope has not been initialized'); }
			const entries: Record<string, IStorageEntry> = Object.assign(Object.create(null), current.entries);
			if (entry) { entries[key] = entry; } else { delete entries[key]; }
			const snapshot = { ...current, revision: current.revision + 1, entries };
			await this.persist(identityKey, snapshot);
			this.changes.fire(snapshot);
			return snapshot;
		});
	}

	public cleanUpStorage(protectedWorkspaceIds: ReadonlySet<string>): Promise<void> {
		return this.run(async () => {
			const next = new Map(this.storages);
			for (const [key, snapshot] of next) {
				if (snapshot.identity.scope === StorageScope.WORKSPACE && snapshot.identity.id.startsWith('empty-window-') && !protectedWorkspaceIds.has(snapshot.identity.id) && !this.users.has(key)) {
					next.delete(key);
				}
			}
			if (next.size !== this.storages.size) { await this.write(next); }
			this.storages.clear();
			for (const [key, snapshot] of next) { this.storages.set(key, snapshot); }
		});
	}

	/** Subscriptions protect a scope until the window disconnects, including windows opened during cleanup. */
	public use(identity: IStorageIdentity): IDisposable {
		this.assertNotDisposed();
		const key = storageIdentityKey(identity);
		this.users.set(key, (this.users.get(key) ?? 0) + 1);
		return toDisposable(() => {
			const remaining = this.users.get(key)! - 1;
			if (remaining === 0) { this.users.delete(key); }
			else { this.users.set(key, remaining); }
		});
	}

	public flush(): Promise<void> { return this.queue; }
	public close(): Promise<void> {
		this.closing ??= this.queue;
		return this.closing;
	}

	private run<T>(operation: () => Promise<T>): Promise<T> {
		this.assertNotDisposed();
		if (this.closing) { throw new Error('Desktop storage is closing'); }
		const result = this.queue.then(operation);
		// A rejected request settles its caller; it must not block unrelated scopes.
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}

	private async persist(key: string, snapshot: IStorageSnapshot): Promise<void> {
		const next = new Map(this.storages);
		next.set(key, snapshot);
		await this.write(next);
		this.storages.set(key, snapshot);
	}

	private async write(storages: ReadonlyMap<string, IStorageSnapshot>): Promise<void> {
		const temporary = `${this.filePath}.${process.pid}.tmp`;
		await writeFile(temporary, JSON.stringify({ version: 2, storages: [...storages.values()].map(snapshot => ({ ...snapshot, isNew: false })) }), 'utf8');
		await rename(temporary, this.filePath);
	}
}

/** Retires the old product dimension; Code wins collisions regardless of file order. */
function migrateStorage(candidates: readonly unknown[]): ReadonlyMap<string, IStorageSnapshot> {
	const sources = new Map<string, { applicationId: string; snapshot: IStorageSnapshot }>();
	for (const candidate of candidates) {
		if (!isRecord(candidate) || !isRecord(candidate.identity) || !['code', 'academic'].includes(candidate.identity.applicationId as string)) {
			throw new TypeError('Invalid legacy Desktop storage identity');
		}
		const snapshot = validateStorageSnapshot(candidate);
		const key = JSON.stringify([candidate.identity.applicationId, snapshot.identity.scope, snapshot.identity.id]);
		if (sources.has(key)) { throw new TypeError('Duplicate Desktop storage identity'); }
		sources.set(key, { applicationId: candidate.identity.applicationId as string, snapshot });
	}
	const storages = new Map<string, IStorageSnapshot>();
	for (const applicationId of ['code', 'academic']) {
		for (const { applicationId: sourceApplicationId, snapshot: source } of sources.values()) {
			if (sourceApplicationId !== applicationId) { continue; }
			const key = storageIdentityKey(source.identity);
			const target = storages.get(key);
			storages.set(key, {
				...source,
				isNew: false,
				revision: target ? Math.max(target.revision, source.revision) + 1 : source.revision,
				entries: Object.assign(Object.create(null), source.entries, target?.entries),
			});
		}
	}
	return storages;
}

function sameEntries(left: Readonly<Record<string, IStorageEntry>>, right: Readonly<Record<string, IStorageEntry>>): boolean {
	const keys = Object.keys(left);
	return keys.length === Object.keys(right).length && keys.every(key => left[key]!.value === right[key]?.value && left[key]!.target === right[key]?.target);
}
