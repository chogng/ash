import { createHash } from 'node:crypto';
import { Disposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { isRecord } from '../../../base/common/types.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IEncryptionMainService, KnownStorageProvider } from '../../encryption/common/encryptionService.js';
import { IApplicationStorageMainService } from '../../storage/electron-main/storageMainService.js';
import { StorageScope, StorageTarget } from '../../storage/common/storage.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import type { BrowserPasswordState, IBrowserPasswordService } from '../common/browserPasswordService.js';
import '../common/browserPasswordService.js';
import type { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';

const storageIdentity = { scope: StorageScope.APPLICATION, id: 'application' };
const prefix = 'browser.passwords.';
interface PasswordValue {
	readonly session: string;
	readonly scope: 'global' | 'workspace';
	readonly origin: string;
	readonly username: string;
	readonly password: string;
}

export const IBrowserPasswordMainService = createDecorator<BrowserPasswordMainService>('browserPasswordMainService');

/** One profile vault; pages own transient submissions, and the application storage owns disk writes. */
export class BrowserPasswordMainService extends Disposable implements IBrowserPasswordService {
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private turn: Promise<void> = Promise.resolve();

	constructor(
		@IEncryptionMainService private readonly encryption: IEncryptionMainService,
		@IApplicationStorageMainService private readonly storage: IApplicationStorageMainService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) { super(); }

	get saveEnabled(): boolean { return this.configuration.getValue<boolean>('workbench.browser.savePasswords') !== false; }
	get autofillEnabled(): boolean { return this.configuration.getValue<boolean>('workbench.browser.autofillPasswords') !== false; }

	private async available(): Promise<boolean> {
		return await this.encryption.isEncryptionAvailable() && await this.encryption.getKeyStorageProvider() !== KnownStorageProvider.basicText;
	}
	async canSave(): Promise<boolean> { return this.saveEnabled && await this.available(); }

	private key(value: Pick<PasswordValue, 'session' | 'origin' | 'username'>): string {
		return prefix + value.session + '.' + createHash('sha256').update(JSON.stringify([value.origin, value.username])).digest('hex');
	}

	private async decode(id: string, ciphertext: string): Promise<PasswordValue> {
		const value: unknown = JSON.parse(await this.encryption.decrypt(ciphertext));
		if (!isRecord(value) || value.version !== 1 || typeof value.session !== 'string' || !/^[a-f0-9]{64}$/u.test(value.session)
			|| !['global', 'workspace'].includes(value.scope as string) || typeof value.origin !== 'string' || value.origin.length > 2048
			|| !validCredentials(value.username, value.password)) { throw new Error('Invalid saved password'); }
		const normalized = value as unknown as PasswordValue;
		if (new URL(normalized.origin).origin !== normalized.origin || this.key(normalized) !== id) { throw new Error('Invalid saved password'); }
		return normalized;
	}

	async readState(): Promise<BrowserPasswordState> {
		return this.run(async () => {
			if (!await this.available()) { return { available: false, entries: [], corrupted: 0 }; }
			const snapshot = await this.storage.getItems(storageIdentity);
			const entries: BrowserPasswordState['entries'][number][] = [];
			let corrupted = 0;
			for (const [id, entry] of Object.entries(snapshot.entries)) {
				if (!id.startsWith(prefix)) { continue; }
				try {
					const value = await this.decode(id, entry.value);
					entries.push({ id, origin: value.origin, username: value.username, scope: value.scope });
				} catch { corrupted++; }
			}
			return { available: true, entries: entries.sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username)), corrupted };
		});
	}

	/** Plaintext stays in Main and is read again when the page accepts a scoped fill. */
	async find(session: string, origin: string): Promise<readonly (PasswordValue & { readonly id: string; })[]> {
		return this.run(async () => {
			if (!await this.available()) { return []; }
			const snapshot = await this.storage.getItems(storageIdentity);
			const matches: (PasswordValue & { id: string; })[] = [];
			for (const [id, entry] of Object.entries(snapshot.entries)) {
				if (!id.startsWith(prefix + session + '.')) { continue; }
				try { const value = await this.decode(id, entry.value); if (value.origin === origin) { matches.push({ ...value, id }); } }
				catch { /* Preserve unreadable records until an explicit management action. */ }
			}
			return matches;
		});
	}

	async save(value: PasswordValue): Promise<void> {
		await this.run(async () => {
			if (!this.saveEnabled || !await this.available()) { throw new Error('Browser password storage unavailable'); }
			await this.write(value);
		});
	}

	async update(id: string, username: string, password: string): Promise<void> {
		await this.run(async () => {
			if (!await this.available()) { throw new Error('Browser password storage unavailable'); }
			const snapshot = await this.storage.getItems(storageIdentity);
			const entry = snapshot.entries[id];
			if (!entry) { throw new Error('Saved password no longer exists'); }
			const old = await this.decode(id, entry.value);
			const next = { ...old, username, password };
			const nextId = this.key(next);
			if (nextId !== id && snapshot.entries[nextId]) { throw new Error('An account already exists for this username'); }
			await this.write(next);
			if (nextId !== id) { await this.storage.updateItems(storageIdentity, id, null); }
		});
	}

	private async write(value: PasswordValue): Promise<void> {
		const id = this.key(value);
		const ciphertext = await this.encryption.encrypt(JSON.stringify({ ...value, version: 1 }));
		await this.storage.updateItems(storageIdentity, id, { value: ciphertext, target: StorageTarget.MACHINE });
		this.changed.fire();
	}

	async delete(id: string): Promise<void> {
		await this.run(async () => { await this.storage.updateItems(storageIdentity, id, null); this.changed.fire(); });
	}
	async clear(): Promise<void> { await this.clearSession(); }
	async clearSession(session?: string): Promise<void> {
		await this.run(async () => {
			const snapshot = await this.storage.getItems(storageIdentity);
			for (const id of Object.keys(snapshot.entries)) {
				if (id.startsWith(session ? prefix + session + '.' : prefix)) { await this.storage.updateItems(storageIdentity, id, null); }
			}
			this.changed.fire();
		});
	}
	private run<T>(action: () => Promise<T>): Promise<T> {
		this.assertNotDisposed();
		const result = this.turn.then(action);
		this.turn = result.then(() => undefined, () => undefined);
		return result;
	}
}

function validCredentials(username: unknown, password: unknown): boolean {
	return typeof username === 'string' && username.length > 0 && username.length <= 4096 && !/[\x00-\x1f\x7f]/u.test(username)
		&& typeof password === 'string' && password.length > 0 && password.length <= 4096 && !/[\x00\r\n]/u.test(password);
}

/** Management IPC has no read-password or arbitrary encryption operation. */
export function browserPasswordChannel(service: IBrowserPasswordService): IServerChannel<string> {
	return {
		listen: <T>(_context: string, event: string) => { if (event !== 'onDidChange') { throw new Error('Unknown password event'); } return service.onDidChange as import('../../../base/common/event.js').Event<T>; },
		call: async <T>(_context: string, command: string, args: unknown): Promise<T> => {
			if (!Array.isArray(args)) { throw new TypeError('Invalid password command'); }
			const validId = typeof args[0] === 'string' && /^browser\.passwords\.[a-f0-9]{64}\.[a-f0-9]{64}$/u.test(args[0]);
			if (command === 'readState' && args.length === 0) { return await service.readState() as T; }
			if (command === 'clear' && args.length === 0) { return await service.clear() as T; }
			if (command === 'delete' && args.length === 1 && validId) { return await service.delete(args[0]) as T; }
			if (command === 'update' && args.length === 3 && validId && validCredentials(args[1], args[2])) { return await service.update(args[0], args[1], args[2]) as T; }
			throw new TypeError('Invalid password command');
		},
	};
}
