export class DBClosedError extends Error {
	constructor(name: string) {
		super(`IndexedDB '${name}' is closed`);
		this.name = 'DBClosedError';
	}
}

/** Owns a database connection and the transactions that must end before it closes. */
export class IndexedDB {
	private readonly transactions = new Set<IDBTransaction>();
	private closed = false;

	constructor(private readonly database: IDBDatabase, private readonly name: string) {
		database.onversionchange = () => this.close();
	}

	public static create(name: string, version: number | undefined, stores: string[], factory: IDBFactory = indexedDB): Promise<IndexedDB> {
		return new Promise((resolve, reject) => {
			const request = factory.open(name, version);
			let blocked = false;
			request.onupgradeneeded = () => {
				for (const store of stores) {
					if (!request.result.objectStoreNames.contains(store)) {
						request.result.createObjectStore(store);
					}
				}
			};
			request.onblocked = () => {
				blocked = true;
				reject(new Error(`IndexedDB '${name}' upgrade is blocked`));
			};
			request.onerror = () => reject(request.error ?? new Error(`IndexedDB '${name}' failed to open`));
			request.onsuccess = () => {
				if (blocked) {
					request.result.close();
					return;
				}
				const missing = stores.filter(store => !request.result.objectStoreNames.contains(store));
				if (missing.length) {
					request.result.close();
					reject(new Error(`IndexedDB '${name}' is missing stores: ${missing.join(', ')}`));
					return;
				}
				resolve(new IndexedDB(request.result, name));
			};
		});
	}

	public hasPendingTransactions(): boolean {
		return this.transactions.size > 0;
	}

	public close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.database.onversionchange = null;
		for (const transaction of this.transactions) {
			try { transaction.abort(); } catch { /* A commit may have finished before its completion event is delivered. */ }
		}
		this.database.close();
	}

	public runInTransaction<T>(store: string, mode: IDBTransactionMode, requests: (store: IDBObjectStore) => IDBRequest<T>[]): Promise<T[]>;
	public runInTransaction<T>(store: string, mode: IDBTransactionMode, requests: (store: IDBObjectStore) => IDBRequest<T>): Promise<T>;
	public runInTransaction<T>(store: string, mode: IDBTransactionMode, requests: (store: IDBObjectStore) => IDBRequest<T> | IDBRequest<T>[]): Promise<T | T[]> {
		if (this.closed) {
			return Promise.reject(new DBClosedError(this.name));
		}
		return new Promise<T | T[]>((resolve, reject) => {
			const transaction = this.database.transaction(store, mode);
			this.transactions.add(transaction);
			let result: IDBRequest<T> | IDBRequest<T>[];
			let failure: unknown;
			transaction.oncomplete = () => {
				this.transactions.delete(transaction);
				resolve(Array.isArray(result) ? result.map(request => request.result) : result.result);
			};
			transaction.onabort = () => {
				this.transactions.delete(transaction);
				reject(failure ?? transaction.error ?? new DBClosedError(this.name));
			};
			transaction.onerror = () => {
				failure = transaction.error ?? new Error(`IndexedDB '${this.name}' transaction failed`);
			};
			try {
				result = requests(transaction.objectStore(store));
			} catch (error) {
				failure = error;
				transaction.abort();
			}
		});
	}
}
