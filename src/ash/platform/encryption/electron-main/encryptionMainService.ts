import type { SafeStorage } from 'electron/main';
import { IEncryptionMainService, KnownStorageProvider } from '../common/encryptionService.js';

const prefix = 'ash-encrypted:1:';
const maxBytes = 1024 * 1024;

/** Main owns OS encryption. This service neither persists values nor chooses credential scope. */
export class EncryptionMainService implements IEncryptionMainService {
	declare readonly _serviceBrand: undefined;
	private plainTextRequested = false;

	constructor(
		private readonly storage: SafeStorage,
		private readonly platform: NodeJS.Platform = process.platform,
	) {}

	async encrypt(value: string): Promise<string> {
		if (typeof value !== 'string' || Buffer.byteLength(value) > maxBytes) {
			throw new Error('Invalid encryption input');
		}
		try {
			if (!(await this.isEncryptionAvailable())) {
				throw new Error();
			}
			return prefix + this.storage.encryptString(value).toString('base64');
		} catch {
			// Native errors can include OS metadata or the submitted value.
			throw new Error('Encryption unavailable');
		}
	}

	async decrypt(value: string): Promise<string> {
		if (typeof value !== 'string' || value.length > 2 * maxBytes || !value.startsWith(prefix)) {
			throw new Error('Invalid encrypted value');
		}
		const encoded = value.slice(prefix.length);
		if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
			throw new Error('Invalid encrypted value');
		}
		try {
			if (!(await this.isEncryptionAvailable())) {
				throw new Error();
			}
			const bytes = Buffer.from(encoded, 'base64');
			if (bytes.toString('base64') !== encoded) {
				throw new Error();
			}
			const result = this.storage.decryptString(bytes);
			if (Buffer.byteLength(result) > maxBytes) {
				throw new Error();
			}
			return result;
		} catch {
			throw new Error('Decryption unavailable');
		}
	}

	async isEncryptionAvailable(): Promise<boolean> {
		try {
			return (
				this.storage.isEncryptionAvailable() &&
				(this.platform !== 'linux' ||
					this.plainTextRequested ||
					(await this.getKeyStorageProvider()) !== KnownStorageProvider.basicText)
			);
		} catch {
			return false;
		}
	}

	async getKeyStorageProvider(): Promise<KnownStorageProvider> {
		if (this.platform === 'win32') {
			return KnownStorageProvider.dplib;
		}
		if (this.platform === 'darwin') {
			return KnownStorageProvider.keychainAccess;
		}
		if (this.platform !== 'linux') {
			return KnownStorageProvider.unknown;
		}
		try {
			return this.storage.getSelectedStorageBackend() as KnownStorageProvider;
		} catch {
			return KnownStorageProvider.unknown;
		}
	}

	/** Explicit caller opt-in only; browser credential persistence never requests this mode. */
	async setUsePlainTextEncryption(): Promise<void> {
		if (this.platform !== 'linux') {
			return;
		}
		try {
			this.storage.setUsePlainTextEncryption(true);
			this.plainTextRequested = true;
		} catch {
			throw new Error('Plain text encryption unavailable');
		}
	}
}
