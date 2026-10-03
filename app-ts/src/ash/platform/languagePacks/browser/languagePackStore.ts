import { parseLanguagePackCatalog } from '../common/languagePackCatalog.js';
import type { ILanguagePackStore } from '../common/languagePackStore.js';
import type { LanguagePackCatalog } from '../common/languagePacksService.js';

/** The browser profile owns these resources independently of App Server availability. */
export class BrowserLanguagePackStore implements ILanguagePackStore {
	public async read(locale: string): Promise<LanguagePackCatalog | undefined> {
		const value = await this.transact('readonly', store => store.get(locale));
		if (value === undefined) { return undefined; }
		const catalog = parseLanguagePackCatalog(value);
		if (!catalog || catalog.locale !== locale) { throw new Error(`Invalid display language resource: ${locale}`); }
		return catalog;
	}

	public async write(catalog: LanguagePackCatalog): Promise<void> {
		await this.transact('readwrite', store => store.put(catalog));
	}

	private async transact(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('ash-language-packs', 1);
			request.onupgradeneeded = () => request.result.createObjectStore('catalogs', { keyPath: 'locale' });
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			return await new Promise((resolve, reject) => {
				const transaction = database.transaction('catalogs', mode);
				const request = operation(transaction.objectStore('catalogs'));
				transaction.oncomplete = () => resolve(request.result);
				transaction.onerror = () => reject(transaction.error);
				transaction.onabort = () => reject(transaction.error);
			});
		} finally { database.close(); }
	}
}
