import type { Event } from '../../../base/common/event.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { isRecord } from '../../../base/common/types.js';
import type { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { storageIdentityKey, validateStorageEntries, validateStorageIdentity } from '../common/storageIpc.js';
import type { StorageMainService } from './storageMainService.js';

export class StorageDatabaseChannel implements IServerChannel {
	constructor(private readonly storage: StorageMainService) { }

	public async call<T>(_context: string, command: string, arg: unknown): Promise<T> {
		if (command === 'flush' && arg === undefined) { await this.storage.flush(); return undefined as T; }
		if (!isRecord(arg)) { throw new TypeError('Invalid storage request'); }
		const identity = validateStorageIdentity(arg.identity);
		switch (command) {
			case 'getItems': return await this.storage.getItems(identity, arg.legacy === undefined ? undefined : validateStorageEntries(arg.legacy)) as T;
			case 'updateItems': {
				if (typeof arg.key !== 'string' || !arg.key.trim()) { throw new TypeError('Invalid storage key'); }
				const entry = arg.entry === null ? null : validateStorageEntries({ [arg.key]: arg.entry })[arg.key]!;
				return await this.storage.updateItems(identity, arg.key, entry) as T;
			}
			default: throw new Error(`Unknown storage command: ${command}`);
		}
	}

	public listen<T>(_context: string, event: string, arg: unknown): Event<T> {
		if (event !== 'onDidChangeStorage') { throw new Error(`Unknown storage event: ${event}`); }
		const identity = validateStorageIdentity(arg);
		return (listener, thisArgs, disposables) => {
			const resources = new DisposableStore();
			if (Array.isArray(disposables)) { disposables.push(resources); }
			else { disposables?.add(resources); }
			resources.add(this.storage.use(identity));
			resources.add(this.storage.onDidChangeStorage(snapshot => {
				if (storageIdentityKey(snapshot.identity) === storageIdentityKey(identity)) {
					listener.call(thisArgs, snapshot as T);
				}
			}));
			return resources;
		};
	}
}
