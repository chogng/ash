import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import type { Page } from '@playwright/test';
import type { PlaywrightApplication } from '../../../automation/playwrightDriver.js';
import { expect, test } from '../../../automation/test.js';

test('clearing one notification toast updates the center while hiding toasts retains other records', async ({ workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('notifications.clearAll');
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	const buttons = page.locator('.ash-notification-host').getByRole('button', { name: 'Remove notification', exact: true });
	await expect(buttons).toHaveCount(2);
	const removedId = await buttons.first().getAttribute('data-notification-close');
	const retainedId = await buttons.last().getAttribute('data-notification-close');
	await buttons.first().click();
	await expect(page.locator(`[data-notification-close="${removedId}"]`)).toHaveCount(0);
	await expect(page.locator(`[data-notification-close="${retainedId}"]`)).toBeVisible();

	await workbench.quickaccess.runCommand('notifications.showList');
	const center = page.getByRole('region', { name: 'Notification Center', exact: true });
	await expect(center.locator(`[data-notification-id="${removedId}"]`)).toHaveCount(0);
	await expect(center.locator(`[data-notification-id="${retainedId}"]`)).toBeVisible();
	await workbench.quickaccess.runCommand('notifications.hideList');
	await expect(buttons).toHaveCount(0);
	await workbench.quickaccess.runCommand('notifications.showList');
	await expect(center.locator(`[data-notification-id="${retainedId}"]`)).toBeVisible();
	await center.getByRole('button', { name: 'Clear All', exact: true }).click();
	await expect(center).toBeHidden();
	await workbench.quickaccess.runCommand('notifications.showList');
	await expect(center.getByText('No notifications', { exact: true })).toBeVisible();
});

test('keyboard clearing moves between notification toasts and restores focus after the last record', async ({ workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('notifications.clearAll');
	for (let index = 0; index < 3; index++) {
		await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	}
	const buttons = page.locator('.ash-notification-host').getByRole('button', { name: 'Remove notification', exact: true });
	await expect(buttons).toHaveCount(3);
	const ids = await buttons.evaluateAll(elements => elements.map(element => (element as HTMLButtonElement).dataset.notificationClose!));
	const close = (index: number) => page.locator(`[data-notification-close="${ids[index]}"]`);
	const origin = page.getByRole('button', { name: 'Show Notification Center', exact: true });
	await origin.focus();
	await close(1).focus();
	await page.keyboard.press('Enter');
	await expect(close(1)).toHaveCount(0);
	await expect(close(2)).toBeFocused();
	await page.keyboard.press('Space');
	await expect(close(2)).toHaveCount(0);
	await expect(close(0)).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(buttons).toHaveCount(0);
	await expect(origin).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('region', { name: 'Notification Center', exact: true }).getByText('No notifications', { exact: true })).toBeVisible();
});

test('notification toast removal uses the Chinese label and clears the localized center', async ({ workbench, restartWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language', exact: true });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	({ workbench } = await restartWorkbench());
	const page = workbench.page;
	await workbench.quickaccess.runCommand('notifications.clearAll');
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	const toast = page.locator('.ash-notification-host').getByRole('button', { name: '移除通知', exact: true });
	await expect(toast).toBeVisible();
	await toast.click();
	await expect(toast).toHaveCount(0);
	await workbench.quickaccess.runCommand('notifications.showList');
	await expect(page.getByRole('region', { name: '通知中心', exact: true }).getByText('没有通知', { exact: true })).toBeVisible();
});

test('center keyboard removal keeps other records open and restores focus after the last row', async ({ workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('notifications.clearAll');
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	const origin = page.getByRole('button', { name: 'Show Notification Center', exact: true });
	await origin.focus();
	await origin.press('Enter');
	const center = page.getByRole('region', { name: 'Notification Center', exact: true });
	const rows = center.locator('[data-notification-id]');
	await expect(rows).toHaveCount(2);
	const ids = await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-notification-id')));
	const row = (index: number) => center.locator(`[data-notification-id="${ids[index]}"]`);
	await row(0).focus();
	await page.keyboard.press('Delete');
	await expect(row(0)).toHaveCount(0);
	await expect(center).toBeVisible();
	await expect(row(1)).toBeFocused();
	await page.keyboard.press('Delete');
	await expect(center).toBeHidden();
	await expect(origin).toBeFocused();
	await page.keyboard.press('Delete');
	await expect(origin).toBeFocused();
	await origin.press('Enter');
	await expect(center.getByText('No notifications', { exact: true })).toBeVisible();
});

for (const useCommand of [false, true]) {
	test(`Clear All ${useCommand ? 'command' : 'toolbar'} closes the center and restores focus`, async ({ workbench }) => {
		const page = workbench.page;
		await workbench.quickaccess.runCommand('notifications.clearAll');
		await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
		await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
		const origin = page.getByRole('button', { name: 'Show Notification Center', exact: true });
		await origin.focus();
		await origin.press('Enter');
		const center = page.getByRole('region', { name: 'Notification Center', exact: true });
		await expect(center.locator('[data-notification-id]')).toHaveCount(2);
		if (useCommand) {
			await workbench.quickaccess.runCommand('notifications.clearAll');
		} else {
			await center.getByRole('button', { name: 'Clear All', exact: true }).focus();
			await page.keyboard.press('Space');
		}
		await expect(center).toBeHidden();
		await expect(origin).toBeFocused();
		await origin.press('Enter');
		await expect(center.getByText('No notifications', { exact: true })).toBeVisible();
		await expect(center.getByRole('button', { name: 'Clear All', exact: true })).toBeDisabled();
		await workbench.quickaccess.runCommand('notifications.clearAll');
		await expect(center).toBeHidden();
		await expect(origin).toBeFocused();
	});
}

test('a notification arriving in an explicitly opened empty center keeps the center open', async ({ workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('notifications.clearAll');
	const origin = page.getByRole('button', { name: 'Show Notification Center', exact: true });
	await origin.focus();
	await origin.press('Enter');
	const center = page.getByRole('region', { name: 'Notification Center', exact: true });
	await expect(center.getByText('No notifications', { exact: true })).toBeVisible();
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	await expect(center).toBeVisible();
	await expect(center.locator('[data-notification-id]')).toHaveCount(1);
	await expect(page.locator('.ash-notification-host .ash-notification')).toHaveCount(0);
	await center.getByRole('button', { name: 'Remove notification', exact: true }).focus();
	await page.keyboard.press('Enter');
	await expect(center).toBeHidden();
	await expect(origin).toBeFocused();
});

test('clearing the last toast tolerates its previous focus control being removed', async ({ workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('notifications.clearAll');
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	await page.evaluate(() => {
		const origin = document.createElement('button');
		origin.id = 'notification-test-focus-origin';
		origin.textContent = 'Notification focus origin';
		document.body.append(origin);
	});
	const origin = page.getByRole('button', { name: 'Notification focus origin', exact: true });
	await origin.focus();
	const remove = page.locator('.ash-notification-host').getByRole('button', { name: 'Remove notification', exact: true });
	await remove.focus();
	await origin.evaluate(element => element.remove());
	await page.keyboard.press('Enter');
	await expect(remove).toHaveCount(0);
	await expect(page.locator('#notification-test-focus-origin')).toHaveCount(0);
	await workbench.quickaccess.runCommand('notifications.showList');
	await expect(page.getByRole('region', { name: 'Notification Center', exact: true }).getByText('No notifications', { exact: true })).toBeVisible();
});

for (const useCenter of [false, true]) {
	test(`notification ${useCenter ? 'center' : 'toast'} action failure reports the real settings write error`, async ({ workbench, application, driver }, testInfo) => {
		const page = workbench.page;
		await workbench.quickaccess.runCommand('notifications.clearAll');
		await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
		if (useCenter) await workbench.quickaccess.runCommand('notifications.showList');
		const surface = page.locator(useCenter ? '.ash-notifications-center' : '.ash-notification-host');
		const original = surface.getByRole('button', { name: 'Always Enable', exact: true });
		await expect(original).toBeVisible();
		const failure = await blockConfigurationWrite(page, application);
		try {
			await original.click();
			const errors = surface.locator('.ash-notification-message').filter({ hasText: failure.message });
			// The old implementation logs the same real rejection. Wait for that boundary,
			// then require the shared notification model to expose it to the user.
			await expect.poll(async () => (await errors.allTextContents()).some(message => message.includes(failure.message))
				|| driver.diagnostics.consoleErrors.some(message => message.includes(failure.message))).toBe(true);
			await failure.assertUnchanged();
			await testInfo.attach('notification-action-failure', {
				body: JSON.stringify({
					view: useCenter ? 'center' : 'toast', expectedError: failure.message,
					errorMessages: await errors.allTextContents(), consoleErrors: driver.diagnostics.consoleErrors,
				}), contentType: 'application/json'
			});
			await expect(errors).toHaveCount(1);
			await expect(errors).toContainText(failure.message);
			await expect(original).toBeVisible();
			await workbench.quickaccess.runCommand('notifications.showList');
			await expect(page.locator('.ash-notifications-center [data-notification-id]')).toHaveCount(2);
			expect(driver.diagnostics.consoleErrors.filter(message => message.includes(failure.message))).toEqual([]);
		} finally {
			try { await failure.assertUnchanged(); } finally { await failure.dispose(); }
		}
	});
}

for (const scenario of [
	{ control: 'action', change: 'add', count: 2, focusedIndex: 1 },
	{ control: 'remove', change: 'add', count: 2, focusedIndex: 1 },
	{ control: 'action', change: 'remove', count: 2, focusedIndex: 1 },
	{ control: 'remove', change: 'remove', count: 2, focusedIndex: 1 },
	{ control: 'action', change: 'add', count: 3, focusedIndex: 1 },
	{ control: 'remove', change: 'add', count: 3, focusedIndex: 0 },
] as const) {
	test(`toast focus ${scenario.count === 3 && scenario.focusedIndex === 0 ? 'is not restored to an evicted' : 'stays on a retained'} ${scenario.control} when backend completion ${scenario.change}s a record with ${scenario.count} toasts`, async ({ workbench, application }) => {
		const page = workbench.page;
		await workbench.quickaccess.runCommand('notifications.clearAll');
		for (let index = 0; index < scenario.count; index++) await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
		const surface = page.locator('.ash-notification-host');
		const ids = await surface.locator('[data-notification-close]').evaluateAll(elements => elements.map(element => (element as HTMLButtonElement).dataset.notificationClose!));
		expect(ids).toHaveLength(scenario.count);
		const toast = (id: string) => surface.locator(`.ash-notification:has([data-notification-close="${id}"])`);
		const focusedId = ids[scenario.focusedIndex];
		const target = scenario.control === 'remove' ? toast(focusedId).getByRole('button', { name: 'Remove notification', exact: true }) : toast(focusedId).getByRole('button', { name: 'Always Enable', exact: true });
		const triggeringId = ids[scenario.count - 1 === scenario.focusedIndex ? 0 : scenario.count - 1];
		const trigger = toast(triggeringId).getByRole('button', { name: 'Always Enable', exact: true });
		const failure = scenario.change === 'add' ? await blockConfigurationWrite(page, application) : undefined;
		try {
			// The real action is deferred. Focus the other control before its backend
			// completion adds an error or lets the producer close its own record.
			await page.evaluate(({ button, focus }) => {
				if (!(button instanceof HTMLButtonElement) || !(focus instanceof HTMLElement)) throw new Error('Expected visible toast controls');
				button.click();
				focus.focus();
			}, { button: await trigger.elementHandle(), focus: await target.elementHandle() });
			if (failure) {
				await expect(surface.locator('.ash-notification-message').filter({ hasText: failure.message })).toHaveCount(1);
				await failure.assertUnchanged();
			} else {
				await expect(toast(triggeringId)).toHaveCount(0);
			}
			const evicted = scenario.count === 3 && scenario.focusedIndex === 0;
			if (evicted) {
				await expect(target).toHaveCount(0);
				expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
			} else {
				await expect(target).toBeFocused();
			}
			await expect(surface.locator('.ash-notification')).toHaveCount(Math.min(3, scenario.count + (failure ? 1 : -1)));
			await workbench.quickaccess.runCommand('notifications.showList');
			const center = page.locator('.ash-notifications-center');
			await expect(center.locator('[data-notification-id]')).toHaveCount(scenario.count + (failure ? 1 : -1));
			await expect(center.locator(`[data-notification-id="${focusedId}"]`)).toHaveCount(1);
		} finally {
			if (failure) { try { await failure.assertUnchanged(); } finally { await failure.dispose(); } }
		}
	});
}

interface StoredConfiguration {
	key: 'settings.json';
	revision: number;
	document: { version: 1; source: string; };
}

async function browserConfiguration(page: Page, operation: 'block' | 'read' | 'restore', original?: StoredConfiguration | null): Promise<StoredConfiguration | null> {
	return page.evaluate(async ({ operation, original }) => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const opening = indexedDB.open('ash-configuration', 1);
			opening.onsuccess = () => resolve(opening.result);
			opening.onerror = () => reject(opening.error);
		});
		try {
			return await new Promise<StoredConfiguration | null>((resolve, reject) => {
				const transaction = database.transaction('resources', operation === 'read' ? 'readonly' : 'readwrite');
				const store = transaction.objectStore('resources');
				const request = store.get('settings.json');
				let stored: StoredConfiguration | null;
				request.onsuccess = () => {
					stored = request.result ?? null;
					if (operation === 'block') {
						// No broadcast: the real renderer retains its revision and the real
						// IndexedDB compare-and-swap rejects its subsequent write.
						store.put({
							key: 'settings.json', revision: (stored?.revision ?? 0) + 1,
							document: stored?.document ?? { version: 1, source: '{}\n' }
						});
					} else if (operation === 'restore') {
						if (original) store.put(original);
						else store.delete('settings.json');
					}
				};
				transaction.oncomplete = () => resolve(stored);
				transaction.onerror = () => reject(transaction.error);
				transaction.onabort = () => reject(transaction.error);
			});
		} finally { database.close(); }
	}, { operation, original });
}

async function blockConfigurationWrite(page: Page, application: PlaywrightApplication): Promise<{ message: string; assertUnchanged(): Promise<void>; dispose(): Promise<void>; }> {
	if (!('windows' in application)) {
		// Each browser fixture owns a fresh BrowserContext, including this database.
		const original = await browserConfiguration(page, 'block');
		const expected = {
			key: 'settings.json', revision: (original?.revision ?? 0) + 1,
			document: original?.document ?? { version: 1, source: '{}\n' }
		};
		return {
			message: `Configuration revision conflict: expected ${expected.revision - 1}, actual ${expected.revision}`,
			async assertUnchanged() { expect(await browserConfiguration(page, 'read')).toEqual(expected); },
			async dispose() {
				await browserConfiguration(page, 'restore', original);
				expect(await browserConfiguration(page, 'read')).toEqual(original);
			},
		};
	}
	const processProfile = await application.evaluate(({ app }) => ({ pid: process.pid, profile: process.env.ASH_HOME, userData: app.getPath('userData') }));
	assert.ok(processProfile.profile);
	const [profile, userData, temporaryRoot] = await Promise.all([realpath(processProfile.profile), realpath(processProfile.userData), realpath(tmpdir())]);
	assert.equal(relative(userData, profile), 'profile');
	assert.equal(relative(temporaryRoot, userData), basename(userData));
	assert.ok(basename(userData).startsWith('ash-'));
	const settings = join(profile, 'settings.json');
	const blocker = `${settings}.${processProfile.pid}.tmp`;
	const original = await page.evaluate(() => globalThis.ashTestMainProcess.call('configuration', 'read'));
	const source = await readFile(settings).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
	// Exclusive mkdir never replaces an existing file or directory. The owner writes
	// this exact temporary path before rename; rmdir only removes our empty blocker.
	await mkdir(blocker);
	return {
		message: 'EISDIR',
		async assertUnchanged() {
			expect(await page.evaluate(() => globalThis.ashTestMainProcess.call('configuration', 'read'))).toEqual(original);
			assert.deepEqual(await readFile(settings).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; }), source);
		},
		async dispose() { await rmdir(blocker); },
	};
}
