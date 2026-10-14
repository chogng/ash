import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import { localize } from '../../../nls.js';

/** Current profile storage observation; availability never reveals saved credentials. */
export type SecretStorageStatus = 'available' | 'unavailable' | 'accessDenied' | 'keyMissing' | 'corrupted' | 'migrationFailed' | 'failure';

/** Storage failures shared by consumers of credentials owned by the App Server. */
export class SecretStorageError extends Error {
	constructor(public readonly status: Exclude<SecretStorageStatus, 'available'>) {
		super(secretStorageMessage(status));
		this.name = 'SecretStorageError';
	}
}

export function secretStorageMessage(status: SecretStorageStatus): string {
	switch (status) {
		case 'available': return localize('credentials.storage.available', 'Credential storage is available.');
		case 'unavailable': return localize('credentials.storage.unavailable', 'System credential storage is unavailable. Start or unlock your system keyring, then retry.');
		case 'accessDenied': return localize('credentials.storage.accessDenied', 'Credential storage access was denied. Check profile permissions, unlock your system keyring and allow Ash to access it, then retry.');
		case 'keyMissing': return localize('credentials.storage.keyMissing', 'The encryption key is missing. Restore the original system keyring entry. Your encrypted credentials have been preserved.');
		case 'corrupted': return localize('credentials.storage.corrupted', 'Stored credentials could not be decrypted. Restore the original keyring entry or a matching backup. Your files have been preserved.');
		case 'migrationFailed': return localize('credentials.storage.migrationFailed', 'Credential storage migration could not finish. Check profile access and retry. Remaining original files have been preserved.');
		case 'failure': return localize('credentials.storage.failure', 'Credential storage could not be accessed. Check your system keyring and profile permissions, then retry.');
	}
}

/** Profile storage health only; credential access stays with its owning domain. */
export interface ISecretStorageStatusService {
	readStatus(): Promise<SecretStorageStatus>;
}

export const ISecretStorageStatusService = createServiceIdentifier<ISecretStorageStatusService>('secretStorageStatusService');
