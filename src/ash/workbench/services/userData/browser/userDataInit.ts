import { parseJsonc } from '../../../../base/common/jsonc.js';
import { validateJsonValue } from '../../../../base/common/jsonValue.js';
import { equals } from '../../../../base/common/objects.js';
import { dirname } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { FileSystemProviderErrorCode, toFileSystemProviderErrorCode, type IFileSystemProvider } from '../../../../platform/files/common/files.js';

/** One-way migration from the former settings-only database into the profile file provider. */
export async function migrateLegacyBrowserSettings(factory: IDBFactory, files: IFileSystemProvider, resource: URI): Promise<void> {
	const database = await new Promise<IDBDatabase | undefined>((resolve, reject) => {
		const request = factory.open('ash-configuration', 1);
		let absent = false;
		request.onupgradeneeded = () => {
			absent = true;
			request.transaction!.abort();
			resolve(undefined);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => { if (!absent) reject(request.error); };
		request.onblocked = () => reject(new Error('Legacy settings migration is blocked'));
	});
	if (!database) return;
	try {
		const legacy = await new Promise<unknown>((resolve, reject) => {
			const transaction = database.transaction('resources', 'readonly');
			const read = transaction.objectStore('resources').get('settings.json');
			read.onsuccess = () => resolve(read.result);
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error);
		});
		if (legacy === undefined) return;
		if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw new TypeError('Invalid legacy settings record');
		const record = legacy as Record<string, unknown>;
		const document = record.document as Record<string, unknown> | undefined;
		if (Object.keys(record).sort().join(',') !== 'document,key,revision' || record.key !== 'settings.json' || !Number.isSafeInteger(record.revision) || (record.revision as number) < 0 ||
			!document || Object.keys(document).sort().join(',') !== 'source,version' || document.version !== 1 || typeof document.source !== 'string') {
			throw new TypeError('Invalid legacy settings record');
		}
		const source = document.source;
		const previous = settingsValue(source);
		let current: string | undefined;
		try { current = new TextDecoder('utf-8', { fatal: true }).decode((await files.readFile(resource)).bytes); }
		catch (error) {
			if (toFileSystemProviderErrorCode(error as Error) !== FileSystemProviderErrorCode.FileNotFound) throw error;
		}
		if (current === undefined) {
			await files.createDirectory(dirname(resource));
			try { await files.writeFile(resource, new TextEncoder().encode(source), { create: true, overwrite: false }); }
			catch (error) {
				if (toFileSystemProviderErrorCode(error as Error) !== FileSystemProviderErrorCode.FileExists) throw error;
			}
			current = new TextDecoder('utf-8', { fatal: true }).decode((await files.readFile(resource)).bytes);
		}
		if (!equals(previous, settingsValue(current))) throw new Error('Legacy settings conflict with the profile settings.json; both sources were preserved');
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction('resources', 'readwrite');
			const store = transaction.objectStore('resources');
			const read = store.get('settings.json');
			read.onsuccess = () => {
				if (read.result === undefined) return;
				if (!equals(read.result, legacy)) { transaction.abort(); return; }
				store.delete('settings.json');
			};
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error ?? new Error('Legacy settings changed during migration'));
		});
	} finally {
		database.close();
	}
}

function settingsValue(source: string): unknown {
	if (source.length > 4 * 1024 * 1024) throw new TypeError('Settings source is too large');
	const value = parseJsonc(source);
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Settings must be an object');
	return validateJsonValue(value);
}
