import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import { localize } from '../../../nls.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../base/common/event.js';

export interface ISecretStorageProvider {
	type: 'in-memory' | 'persisted' | 'unknown';
	get(key: string): Promise<string | undefined>;
	set(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
	keys?(): Promise<string[]>;
}

export interface ISecretStorageService extends ISecretStorageProvider {
	readonly onDidChangeSecret: Event<string>;
}

export const ISecretStorageService = createServiceIdentifier<ISecretStorageService>('secretStorageService');

/** Ephemeral host credentials survive renderer reloads, and disappear with their window.
 * Profile credentials remain with the shared backend's existing secret store. */
export class BaseSecretStorageService extends Disposable implements ISecretStorageService {
	readonly type = 'in-memory' as const;
	private readonly values = new Map<string, string>();
	private readonly changed = this._register(new Emitter<string>());
	readonly onDidChangeSecret = this.changed.event;

	async get(key: string): Promise<string | undefined> { this.validateKey(key); return this.values.get(key); }
	async keys(): Promise<string[]> { return [...this.values.keys()]; }
	async set(key: string, value: string): Promise<void> {
		this.validateKey(key);
		if (typeof value !== 'string' || value.length > 1024 * 1024 || (!this.values.has(key) && this.values.size >= 64)) throw new Error('Invalid secret storage value');
		this.values.set(key, value);
		this.changed.fire(key);
	}
	async delete(key: string): Promise<void> {
		this.validateKey(key);
		if (this.values.delete(key)) this.changed.fire(key);
	}
	private validateKey(key: string): void {
		this.assertNotDisposed();
		if (typeof key !== 'string' || !key.length || key.length > 512) throw new Error('Invalid secret storage key');
	}
	protected override disposeCore(): void { this.values.clear(); super.disposeCore(); }
}

/** Current profile storage observation; availability never reveals saved credentials. */
export type SecretStorageStatus = 'available' | 'unavailable' | 'accessDenied' | 'keyMissing' | 'corrupted' | 'migrationFailed' | 'failure';

export type SecretStorageMode = 'encrypted' | 'file';

export interface SecretStorageState {
	readonly status: SecretStorageStatus;
	readonly mode?: SecretStorageMode;
	readonly storageType?: 'persisted' | 'in-memory';
}

export function secretStorageStateMessage(state: SecretStorageState): string {
	const message = state.status === 'available' ? '' : secretStorageMessage(state.status);
	if (state.storageType !== 'in-memory') return message;
	const persistence = localize('credentials.storage.inMemory', 'Credentials are stored in memory for this run only and will be lost when Ash exits. Existing encrypted credentials are preserved.');
	return message ? `${message} ${persistence}` : persistence;
}

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
		case 'accessDenied': return localize('credentials.storage.accessDenied', 'Credential storage access was denied. Check profile permissions or use Authorize system keyring to request access. Background operations do not show system dialogs.');
		case 'keyMissing': return localize('credentials.storage.keyMissing', 'The encryption key is missing. Restore the original system keyring entry. Your encrypted credentials have been preserved.');
		case 'corrupted': return localize('credentials.storage.corrupted', 'Stored credentials could not be decrypted. Restore the original keyring entry or a matching backup. Your files have been preserved.');
		case 'migrationFailed': return localize('credentials.storage.migrationFailed', 'Credential storage migration could not finish. Check profile access and retry. Remaining original files have been preserved.');
		case 'failure': return localize('credentials.storage.failure', 'Credential storage could not be accessed. Check your system keyring and profile permissions, then retry.');
	}
}

/** Profile storage health and explicit persistence controls; credentials stay with their domain. */
export interface ISecretStorageStatusService {
	readState(): Promise<SecretStorageState>;
	/** User gesture only: the operating system may ask for authorization. */
	authorizeAccess(): Promise<SecretStorageState>;
	/** Migrates existing values; selecting encrypted storage may request system authorization. */
	setStorageMode(mode: SecretStorageMode): Promise<SecretStorageState>;
}

export const ISecretStorageStatusService = createServiceIdentifier<ISecretStorageStatusService>('secretStorageStatusService');
