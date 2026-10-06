import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IStorageEntry, IStorageIdentity, IStorageSnapshot } from '../../src/ash/platform/storage/common/storageIpc.js';
import type { PlaywrightApplication } from './playwrightDriver.js';

export async function readStorageEntries(application: PlaywrightApplication, page: Page, identity: IStorageIdentity): Promise<Readonly<Record<string, IStorageEntry>>> {
	if ('windows' in application) {
		const directory = await application.evaluate(({ app }) => app.getPath('userData'));
		const document = JSON.parse(await readFile(join(directory, 'workbench-state.json'), 'utf8')) as { storages: IStorageSnapshot[]; };
		return document.storages.find(snapshot => snapshot.identity.scope === identity.scope && snapshot.identity.id === identity.id)?.entries ?? {};
	}
	return page.evaluate(identity => {
		const key = `ash.storage.${identity.scope}${identity.scope === 'application' ? '' : `.${encodeURIComponent(identity.id)}`}`;
		const value = localStorage.getItem(key);
		return value ? JSON.parse(value).entries : {};
	}, identity);
}

/** Arranges persisted input before the next renderer reads it, without exposing a test API in production. */
export async function seedStorageOnNextLoad(application: PlaywrightApplication, page: Page, identity: IStorageIdentity, entries: Readonly<Record<string, IStorageEntry | null>>): Promise<void> {
	if ('windows' in application) {
		const modulePath = resolve(import.meta.dirname, '../../../.build/app-ts/main/src/ash/platform/storage/electron-main/storageMainService.js');
		await application.evaluate((_electron, { modulePath, identity: target, entries }) => {
			const require = process.getBuiltinModule('module').createRequire(modulePath);
			const { StorageMainService } = require(modulePath);
			const original = StorageMainService.prototype.getItems;
			StorageMainService.prototype.getItems = async function (identity: IStorageIdentity, legacy?: Readonly<Record<string, IStorageEntry>>) {
				if (identity.scope !== target.scope || identity.id !== target.id) {
					return original.call(this, identity, legacy);
				}
				// This fixture is consumed once; subsequent writes and reloads use the unmodified owner.
				StorageMainService.prototype.getItems = original;
				await original.call(this, identity, legacy);
				for (const [key, entry] of Object.entries(entries)) { await this.updateItems(identity, key, entry); }
				return original.call(this, identity);
			};
		}, { modulePath, identity, entries });
		return;
	}
	await page.addInitScript(({ identity, entries, marker }) => {
		if (sessionStorage.getItem(marker)) { return; }
		const key = `ash.storage.${identity.scope}${identity.scope === 'application' ? '' : `.${encodeURIComponent(identity.id)}`}`;
		const source = localStorage.getItem(key);
		const document = source ? JSON.parse(source) : { version: 1, entries: {} };
		for (const [key, entry] of Object.entries(entries)) {
			if (entry === null) { delete document.entries[key]; }
			else { document.entries[key] = entry; }
		}
		localStorage.setItem(key, JSON.stringify(document));
		sessionStorage.setItem(marker, 'true');
	}, { identity, entries, marker: `ash-storage-fixture-${randomUUID()}` });
}
