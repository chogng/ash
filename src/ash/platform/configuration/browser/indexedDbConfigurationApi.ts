import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { emptyConfigurationDocument, validateConfigurationSnapshot, validateConfigurationUpdateRequest } from '../common/configurationIpc.js';
import type { IConfigurationApi, IConfigurationSnapshot, IConfigurationSubscription, IConfigurationUpdateRequest } from '../common/configurationIpc.js';

const DATABASE_NAME = 'ash-configuration';
const STORE_NAME = 'resources';
const RESOURCE_KEY = 'settings.json';

interface StoredConfiguration extends IConfigurationSnapshot {
	readonly key: typeof RESOURCE_KEY;
}

/** The browser profile's settings document, shared by Workbench and Sessions pages on one origin. */
export class IndexedDbConfigurationApi extends Disposable implements IConfigurationApi {
	private readonly database = openDatabase();
	private readonly changes = this._register(new Emitter<IConfigurationSnapshot>());
	private readonly channel = new BroadcastChannel(DATABASE_NAME);

	constructor() {
		super();
		this.channel.addEventListener('message', this.handleMessage);
		this._register(toDisposable(() => this.channel.removeEventListener('message', this.handleMessage)));
		this._register(toDisposable(() => this.channel.close()));
		this._register(toDisposable(() => { void this.database.then(database => database.close(), () => undefined); }));
	}

	public onDidChange(listener: (snapshot: unknown) => void): IConfigurationSubscription {
		return this.changes.event(listener);
	}

	public async read(): Promise<IConfigurationSnapshot> {
		const database = await this.database;
		const transaction = database.transaction(STORE_NAME, 'readonly');
		const request = transaction.objectStore(STORE_NAME).get(RESOURCE_KEY);
		return new Promise((resolve, reject) => {
			request.onsuccess = () => {
				try {
					resolve(request.result === undefined
						? { revision: 0, document: emptyConfigurationDocument() }
						: readStoredConfiguration(request.result));
				} catch (error) {
					reject(error);
				}
			};
			request.onerror = () => reject(request.error ?? new Error('Failed to read browser settings'));
		});
	}

	public async update(candidate: IConfigurationUpdateRequest): Promise<IConfigurationSnapshot> {
		const request = validateConfigurationUpdateRequest(candidate);
		const database = await this.database;
		let next: IConfigurationSnapshot | undefined;
		const snapshot = await new Promise<IConfigurationSnapshot>((resolve, reject) => {
			// The read and write must use one transaction so another page cannot overwrite this revision.
			const transaction = database.transaction(STORE_NAME, 'readwrite');
			const stored = transaction.objectStore(STORE_NAME).get(RESOURCE_KEY);
			let result: IConfigurationSnapshot;
			stored.onsuccess = () => {
				try {
					const current = stored.result === undefined
						? { revision: 0, document: emptyConfigurationDocument() }
						: readStoredConfiguration(stored.result);
					if (current.revision !== request.expectedRevision) {
						throw new Error(`Configuration revision conflict: expected ${request.expectedRevision}, actual ${current.revision}`);
					}
					result = current;
					if (current.document.source !== request.document.source) {
						result = next = { revision: current.revision + 1, document: request.document };
						transaction.objectStore(STORE_NAME).put({ key: RESOURCE_KEY, ...result } satisfies StoredConfiguration);
					}
				} catch (error) {
					transaction.abort();
					reject(error);
				}
			};
			transaction.oncomplete = () => resolve(result);
			transaction.onerror = () => reject(transaction.error ?? new Error('Failed to write browser settings'));
			transaction.onabort = () => reject(transaction.error ?? new Error('Browser settings transaction was aborted'));
		});
		if (next) {
			this.changes.fire(snapshot);
			this.channel.postMessage(RESOURCE_KEY);
		}
		return snapshot;
	}

	private readonly handleMessage = (event: MessageEvent): void => {
		if (event.data !== RESOURCE_KEY) return;
		void this.read().then(snapshot => {
			if (!this.isDisposed) this.changes.fire(snapshot);
		}).catch(error => console.error('Failed to reload browser settings', error));
	};
}

function readStoredConfiguration(value: unknown): IConfigurationSnapshot {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Browser settings record must be an object');
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	if (keys.join(',') !== 'document,key,revision' || record.key !== RESOURCE_KEY) throw new Error('Browser settings record is invalid');
	return validateConfigurationSnapshot({ document: record.document, revision: record.revision });
}

function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const opening = indexedDB.open(DATABASE_NAME, 1);
		opening.onupgradeneeded = () => opening.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
		opening.onsuccess = () => resolve(opening.result);
		opening.onerror = () => reject(opening.error ?? new Error('Failed to open browser settings'));
		opening.onblocked = () => reject(new Error('Browser settings database upgrade is blocked'));
	});
}
