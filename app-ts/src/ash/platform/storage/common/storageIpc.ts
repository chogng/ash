import { isRecord } from '../../../base/common/types.js';
import { StorageScope, StorageTarget } from './storage.js';

export interface IStorageIdentity {
	readonly applicationId: string;
	readonly scope: StorageScope;
	readonly id: string;
}

export interface IStorageEntry {
	readonly value: string;
	readonly target: StorageTarget;
}

export interface IStorageSnapshot {
	readonly identity: IStorageIdentity;
	readonly revision: number;
	readonly isNew: boolean;
	readonly entries: Readonly<Record<string, IStorageEntry>>;
}

export function validateStorageIdentity(value: unknown): IStorageIdentity {
	if (!isRecord(value) || ![StorageScope.APPLICATION, StorageScope.PROFILE, StorageScope.WORKSPACE].includes(value.scope as StorageScope)) {
		throw new TypeError('Invalid storage identity');
	}
	for (const key of ['applicationId', 'id']) {
		if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 1024) {
			throw new TypeError('Invalid storage identity');
		}
	}
	return { applicationId: value.applicationId as string, scope: value.scope as StorageScope, id: value.id as string };
}

export function validateStorageEntries(value: unknown): Record<string, IStorageEntry> {
	if (!isRecord(value)) { throw new TypeError('Invalid storage entries'); }
	const entries: Record<string, IStorageEntry> = Object.create(null);
	for (const [key, entry] of Object.entries(value)) {
		if (!key.trim() || !isRecord(entry) || typeof entry.value !== 'string' || (entry.target !== StorageTarget.USER && entry.target !== StorageTarget.MACHINE)) {
			throw new TypeError('Invalid storage entry');
		}
		entries[key] = { value: entry.value, target: entry.target };
	}
	return entries;
}

export function validateStorageSnapshot(value: unknown): IStorageSnapshot {
	if (!isRecord(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || typeof value.isNew !== 'boolean') {
		throw new TypeError('Invalid storage snapshot');
	}
	return { identity: validateStorageIdentity(value.identity), revision: value.revision as number, isNew: value.isNew, entries: validateStorageEntries(value.entries) };
}

export function storageIdentityKey(identity: IStorageIdentity): string {
	return JSON.stringify([identity.applicationId, identity.scope, identity.id]);
}
