import type { Page } from '@playwright/test';

export async function hasWorkingCopyBackup(page: Page, content: string): Promise<boolean> {
	return page.evaluate(async expectedContent => {
		const name = 'ash-working-copy-backups';
		const databases = await indexedDB.databases();
		if (!databases.some(database => database.name === name)) return false;
		const database = await new Promise<IDBDatabase | undefined>((resolve, reject) => {
			// An observer must neither create the product's database nor perform schema upgrades.
			const opening = indexedDB.open(name);
			let creationAborted = false;
			opening.onupgradeneeded = () => {
				// The database was deleted after the catalog read; roll back its recreation.
				creationAborted = true;
				opening.transaction!.abort();
			};
			opening.onsuccess = () => resolve(opening.result);
			opening.onerror = () => {
				if (creationAborted) resolve(undefined);
				else reject(opening.error ?? new Error('Could not inspect working-copy backups'));
			};
		});
		if (!database) return false;
		try {
			const records = await new Promise<Array<{ readonly content?: string }>>((resolve, reject) => {
				const request = database.transaction('backups', 'readonly').objectStore('backups').getAll();
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error ?? new Error('Could not read working-copy backups'));
			});
			return records.some(record => record.content === expectedContent);
		} finally {
			database.close();
		}
	}, content);
}
