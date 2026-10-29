import { expect, type Locator, type Page } from '@playwright/test';
import { FileKind } from '../../src/ash/platform/files/common/files.js';
import { QuickAccess } from './quickaccess.js';

/** Reads the actual profile file through the same generic transport as Desktop editors. */
export async function readUserSettings(page: Page): Promise<{ resource: string; content: string; revision?: string }> {
	return page.evaluate(async () => {
		if (document.querySelector<HTMLElement>('#app')?.dataset.runtime !== 'electron') {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('ash-user-data-files', 1);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				return await new Promise((resolve, reject) => {
					const resource = 'ash-userdata:/user/settings.json';
					const request = database.transaction('files', 'readonly').objectStore('files').get(resource);
					request.onsuccess = () =>
						resolve({
							resource,
							content: request.result ? new TextDecoder().decode(request.result.bytes) : '{}\n',
							revision: request.result?.revision,
						});
					request.onerror = () => reject(request.error);
				});
			} finally {
				database.close();
			}
		}
		const home = await globalThis.ashTestMainProcess.call<string>('localFilesystem', 'userDataHome');
		const resource = home.replace(/\/$/u, '') + '/settings.json';
		try {
			const file = await globalThis.ashTestMainProcess.call<{ bytes: string; revision: string }>(
				'localFilesystem',
				'readFile',
				{ resource },
			);
			const content = new TextDecoder().decode(
				Uint8Array.from(atob(file.bytes), character => character.charCodeAt(0)),
			);
			return { resource, content, revision: file.revision };
		} catch (error) {
			if (error instanceof Error && error.name === 'FileNotFoundError') return { resource, content: '{}\n' };
			throw error;
		}
	});
}

/** Conditional raw-file save used by external-edit scenarios, without a configuration channel. */
export async function writeUserSettings(page: Page, content: string, expectedRevision?: string): Promise<void> {
	if (!(await page.evaluate(() => document.querySelector<HTMLElement>('#app')?.dataset.runtime === 'electron'))) {
		await page.evaluate(
			async ({ content, expectedRevision, fileKind }) => {
				const database = await new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open('ash-user-data-files', 1);
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				});
				try {
					await new Promise<void>((resolve, reject) => {
						const resource = 'ash-userdata:/user/settings.json';
						const transaction = database.transaction('files', 'readwrite');
						const store = transaction.objectStore('files');
						const read = store.get(resource);
						read.onsuccess = () => {
							if (read.result?.revision !== expectedRevision) {
								transaction.abort();
								return;
							}
							store.put(
								{
									kind: fileKind,
									bytes: new TextEncoder().encode(content),
									revision: crypto.randomUUID(),
									modifiedAtMillis: Date.now(),
								},
								resource,
							);
						};
						transaction.oncomplete = () => resolve();
						transaction.onerror = () => reject(transaction.error);
						transaction.onabort = () =>
							reject(transaction.error ?? new Error('Settings file revision conflict'));
					});
				} finally {
					database.close();
				}
			},
			{ content, expectedRevision, fileKind: FileKind.File },
		);
		return;
	}
	const home = await page.evaluate(() =>
		globalThis.ashTestMainProcess.call<string>('localFilesystem', 'userDataHome'),
	);
	const resource = home.replace(/\/$/u, '') + '/settings.json';
	const bytes = Buffer.from(content, 'utf8').toString('base64');
	await page.evaluate(
		({ resource, bytes, expectedRevision }) =>
			globalThis.ashTestMainProcess.call('localFilesystem', 'writeFile', {
				resource,
				bytes,
				options: { create: true, overwrite: expectedRevision !== undefined, expectedRevision },
			}),
		{ resource, bytes, expectedRevision },
	);
}

/** Navigation shared by settings scenarios; callers own feature assertions. */
export class SettingsEditor {
	public readonly element: Locator;

	constructor(
		private readonly page: Page,
		private readonly quickaccess: QuickAccess,
	) {
		this.element = page.getByRole('dialog').filter({ has: page.locator('.ash-settings-editor') });
	}

	public async openUserSettingsUI(): Promise<void> {
		await this.quickaccess.runCommand('workbench.action.openSettings2');
		await expect(this.element).toBeVisible();
	}

	public async selectCategory(categoryId: string): Promise<void> {
		const category = this.element
			.getByRole('treeitem')
			.filter({ has: this.page.locator(`[data-settings-category-id="${categoryId}"]`) });
		await category.click();
		await expect(category).toHaveAttribute('aria-selected', 'true');
	}

	public async selectEditorCategory(categoryId: string): Promise<void> {
		await this.selectGroup('editor');
		await this.selectCategory(categoryId);
	}

	public async selectGroup(groupId: string): Promise<void> {
		const group = this.element
			.getByRole('treeitem')
			.filter({ has: this.page.locator(`[data-settings-group-id="${groupId}"]`) });
		if ((await group.getAttribute('aria-expanded')) !== 'true') {
			await group.click();
		}
		await expect(group).toHaveAttribute('aria-expanded', 'true');
	}
}
