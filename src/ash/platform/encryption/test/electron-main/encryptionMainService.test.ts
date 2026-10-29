import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { EncryptionMainService } from '../../electron-main/encryptionMainService.js';
import { KnownStorageProvider } from '../../common/encryptionService.js';

suite('Main encryption', () => {
	test('round trips a versioned value, rejects malformed ciphertext and redacts native failures', async () => {
		let fail = false;
		const service = new EncryptionMainService({
			isEncryptionAvailable: () => true,
			encryptString: value => { if (fail) { throw new Error(value); } return Buffer.from(value); },
			decryptString: bytes => { if (fail) { throw new Error(bytes.toString()); } return bytes.toString(); },
		} as Electron.SafeStorage, 'win32');
		const value = await service.encrypt('秘密 🔐');
		assert.equal(await service.decrypt(value), '秘密 🔐');
		assert.equal(await service.getKeyStorageProvider(), KnownStorageProvider.dplib);
		for (const invalid of ['secret', 'ash-encrypted:2:YWJj', 'ash-encrypted:1:YWJj!', 'ash-encrypted:1:YR==']) {
			await assert.rejects(service.decrypt(invalid), /Invalid encrypted value|Decryption unavailable/);
		}
		fail = true;
		await assert.rejects(service.encrypt('must-not-leak'), { message: 'Encryption unavailable' });
		await assert.rejects(service.decrypt(value), { message: 'Decryption unavailable' });
		await assert.rejects(service.encrypt('a'.repeat(1024 * 1024 + 1)), /Invalid encryption input/);
	});

	test('Linux basic storage requires explicit opt-in and an unavailable keyring never falls back', async () => {
		let available = true;
		let optIn = false;
		const service = new EncryptionMainService({
			isEncryptionAvailable: () => available,
			getSelectedStorageBackend: () => 'basic_text',
			setUsePlainTextEncryption: value => { optIn = value; },
			encryptString: value => Buffer.from(value),
		} as Electron.SafeStorage, 'linux');
		assert.equal(await service.isEncryptionAvailable(), false);
		await assert.rejects(service.encrypt('secret'), /Encryption unavailable/);
		assert.equal(optIn, false);
		await service.setUsePlainTextEncryption();
		assert.equal(await service.isEncryptionAvailable(), true);
		assert.equal(optIn, true);
		available = false;
		await assert.rejects(service.encrypt('secret'), /Encryption unavailable/);
	});
});
