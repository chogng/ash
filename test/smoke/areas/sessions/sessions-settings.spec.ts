import { expect, test } from '../../../automation/test.js';
import { captureElectronMenu } from '../../../automation/menus.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Workbench } from '../../../automation/workbench.js';

test('Sessions Modified Settings refreshes after external writes, reset and window reload', async ({ application, target, workbench, runningApplication }, testInfo) => {
	const workbenchUrl = workbench.page.url();
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	const group = workbench.editors.groupAt(0);
	await group.editor.input.press('ControlOrMeta+A');
	await group.editor.input.evaluate((element, source) => {
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', source);
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	}, '{ "window.menuStyle": "custom", "sessions.activityBar.compact": false, "workbench.activityBar.compact": true }');
	await group.editor.input.press('ControlOrMeta+S');
	await expect(group.tabs.filter({ hasText: 'User Settings (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	let sessionsPage = await workbench.openAgentsWindow(target.kind);
	const openSettings = async (): Promise<void> => {
		await sessionsPage.locator('[data-part="activitybar"] .ash-sessions-activity-bottom button').last().click();
		await sessionsPage.getByRole('menuitem', { name: 'Settings', exact: true }).click();
	};
	await openSettings();
	let settings = sessionsPage.getByRole('dialog', { name: 'Sessions Settings' });
	await settings.getByRole('searchbox').fill('compact @id:sessions.activityBar.compact');
	const filter = settings.getByRole('button', { name: 'Filter Settings', exact: true });
	const inputBounds = await settings.getByRole('searchbox').boundingBox();
	const filterBounds = await filter.boundingBox();
	if (!inputBounds || !filterBounds) throw new Error('Settings search controls must be visible');
	expect(inputBounds.x + inputBounds.width).toBeLessThanOrEqual(filterBounds.x);
	expect(Math.abs(inputBounds.y - filterBounds.y)).toBeLessThanOrEqual(1);
	await filter.press('Enter');
	await settings.getByRole('menuitem', { name: 'Modified', exact: true }).press('Enter');
	await expect(settings.getByRole('searchbox')).toHaveValue('compact @id:sessions.activityBar.compact @modified');
	await expect(settings.getByRole('searchbox')).toBeFocused();
	const row = settings.locator('[data-settings-item-id="sessions.activityBar.compact"]');
	await expect(row.getByRole('switch')).not.toBeChecked();
	await expect(settings.locator('[data-settings-item-id="workbench.activityBar.compact"]')).toHaveCount(0);
	await expect(settings.locator('.ash-models-settings-model-row')).toHaveCount(0);
	let writer: Workbench | undefined;
	const saveExternal = async (compact: boolean | undefined): Promise<void> => {
		const source = JSON.stringify({ 'window.menuStyle': 'custom', 'workbench.activityBar.compact': true, ...(compact === undefined ? {} : { 'sessions.activityBar.compact': compact }) });
		if ('windows' in application) {
			await sessionsPage.evaluate(async source => {
				const current = await globalThis.ashTestMainProcess.call<{ revision: number; }>('configuration', 'read');
				await globalThis.ashTestMainProcess.call('configuration', 'update', { expectedRevision: current.revision, document: { version: 1, source } });
			}, source);
		} else {
			if (!writer) {
				const writerPage = await sessionsPage.context().newPage();
				writer = new Workbench(writerPage);
				await writerPage.goto(workbenchUrl);
				await writer.waitForReady();
				await writer.quickaccess.runCommand('workbench.action.openSettingsJson');
			}
			const writerGroup = writer.editors.groupAt(0);
			await writerGroup.editor.input.press('ControlOrMeta+A');
			await writerGroup.editor.input.evaluate((element, source) => {
				const clipboardData = new DataTransfer();
				clipboardData.setData('text/plain', source);
				element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
			}, source);
			await writerGroup.editor.input.press('ControlOrMeta+S');
			await expect(writerGroup.tabs.filter({ hasText: 'User Settings (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
		}
	};
	try {
		await saveExternal(true);
		await expect(row.getByRole('switch')).toBeChecked();
		await saveExternal(undefined);
		await expect(row).toHaveCount(0);
		await saveExternal(false);
		await expect(row.getByRole('switch')).not.toBeChecked();
	} finally {
		if (writer) {
			await writer.quickaccess.runCommand('workbench.action.closeAllEditors');
			await expect(writer.editors.groupAt(0).tabs).toHaveCount(0);
			await writer.page.close();
		}
	}
	await row.getByRole('button', { name: /^More actions/u }).press('Enter');
	await settings.getByRole('menuitem', { name: 'Reset Setting', exact: true }).press('Enter');
	await expect(row).toHaveCount(0);
	await expect(settings.getByRole('status').filter({ hasText: 'No settings found.' })).toBeVisible();
	await settings.evaluate(element => (element as HTMLDialogElement).requestClose());
	await expect(settings).toHaveCount(0);
	const remaining = { 'window.menuStyle': 'custom', 'workbench.activityBar.compact': true };
	if ('windows' in application) {
		const profile = await application.evaluate(() => process.env.ASH_HOME!);
		await expect.poll(async () => JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8'))).toEqual(remaining);
	} else {
		await expect.poll(() => sessionsPage.evaluate(async () => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('ash-configuration');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				return await new Promise<unknown>((resolve, reject) => {
					const request = database.transaction('resources', 'readonly').objectStore('resources').get('settings.json');
					request.onsuccess = () => resolve(JSON.parse(request.result.document.source));
					request.onerror = () => reject(request.error);
				});
			} finally { database.close(); }
		})).toEqual(remaining);
	}
	sessionsPage = await workbench.reopenAgentsWindow(application, sessionsPage);
	await openSettings();
	settings = sessionsPage.getByRole('dialog', { name: 'Sessions Settings' });
	await settings.getByRole('searchbox').fill('@modified @id:sessions.activityBar.compact');
	await expect(settings.locator('[data-settings-item-id="sessions.activityBar.compact"]')).toHaveCount(0);
	await settings.getByRole('button', { name: 'Filter Settings', exact: true }).press('Enter');
	await settings.getByRole('menuitem', { name: 'Clear Filters', exact: true }).press('Enter');
	await expect(settings.getByRole('searchbox')).toHaveValue('');
	await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
	await expect(settings.locator('[data-settings-item-id="sessions.activityBar.compact"]').getByRole('switch')).not.toBeChecked();
	await settings.evaluate(element => (element as HTMLDialogElement).requestClose());
	await testInfo.attach('sessions-modified-settings-diagnostics', { body: JSON.stringify(runningApplication.diagnostics), contentType: 'application/json' });
	expect(runningApplication.diagnostics.errors).toEqual([]);
});

test('Sessions setting menus copy their current registered value as JSON', async ({ application, target, workbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	const group = workbench.editors.groupAt(0);
	await group.editor.input.press('ControlOrMeta+A');
	await group.editor.input.evaluate((element, source) => {
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', source);
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	}, '{ "window.menuStyle": "custom", "sessions.activityBar.compact": true }');
	await group.editor.input.press('ControlOrMeta+S');
	await expect(group.tabs.filter({ hasText: 'User Settings (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	const sessionsPage = await workbench.openAgentsWindow(target.kind);
	if ('windows' in application) {
		await application.evaluate(({ clipboard }) => {
			const captured = globalThis as typeof globalThis & { sessionsCopyText: string; sessionsCopyCount: number; restoreSessionsCopy(): void; };
			const write = clipboard.writeText.bind(clipboard);
			captured.sessionsCopyText = '';
			captured.sessionsCopyCount = 0;
			clipboard.writeText = async text => { captured.sessionsCopyText = text; captured.sessionsCopyCount++; await write(text); };
			captured.restoreSessionsCopy = () => { clipboard.writeText = write; };
		});
	} else {
		await sessionsPage.evaluate(() => {
			const captured = globalThis as typeof globalThis & { sessionsCopyText: string; sessionsCopyCount: number; restoreSessionsCopy(): void; };
			const write = navigator.clipboard.writeText.bind(navigator.clipboard);
			captured.sessionsCopyText = '';
			captured.sessionsCopyCount = 0;
			navigator.clipboard.writeText = async text => { captured.sessionsCopyText = text; captured.sessionsCopyCount++; };
			captured.restoreSessionsCopy = () => { navigator.clipboard.writeText = write; };
		});
	}
	try {
		const settings = sessionsPage.getByRole('dialog', { name: 'Sessions Settings' });
		const openSettings = async (): Promise<void> => {
			const accounts = sessionsPage.locator('[data-part="activitybar"] .ash-sessions-activity-bottom button').last();
			// The saved custom menu style also applies to the Sessions account menu.
			await accounts.click();
			await sessionsPage.getByRole('menuitem', { name: 'Settings', exact: true }).click();
			await expect(settings).toHaveCount(1);
			await expect(settings.locator('.ash-context-view')).toHaveCount(1);
			await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
		};
		const row = settings.locator('[data-settings-item-id="sessions.activityBar.compact"]');
		const more = row.getByRole('button', { name: /^More actions/u });
		const copy = settings.getByRole('menuitem', { name: 'Copy Setting as JSON', exact: true });
		const openMenu = async (): Promise<void> => {
			await more.focus();
			await more.press('Enter');
			await sessionsPage.keyboard.press('End');
			await expect(copy).toBeFocused();
		};
		const read = 'windows' in application
			? () => application.evaluate(() => {
				const captured = globalThis as typeof globalThis & { sessionsCopyText: string; sessionsCopyCount: number; };
				return { text: captured.sessionsCopyText, count: captured.sessionsCopyCount };
			})
			: () => sessionsPage.evaluate(() => {
				const captured = globalThis as typeof globalThis & { sessionsCopyText: string; sessionsCopyCount: number; };
				return { text: captured.sessionsCopyText, count: captured.sessionsCopyCount };
			});
		await openSettings();
		await expect(row.getByRole('switch')).toBeChecked();
		await expect(row).toHaveClass(/is-configured/u);
		await expect(row).toHaveAccessibleDescription('Configured in local user settings.');
		const marker = row.locator('.ash-settings-configured-marker');
		await expect(marker).toBeVisible();
		await expect(marker).not.toHaveAttribute('tabindex');
		await marker.hover();
		await expect(settings.getByRole('tooltip')).toHaveText('Configured in local user settings.');
		await sessionsPage.keyboard.press('Escape');
		await expect(settings.getByRole('tooltip')).toHaveCount(0);
		await expect(settings).toBeVisible();
		await openMenu();
		await copy.press('Enter');
		await expect(copy).toHaveCount(0);
		await expect(more).toBeFocused();
		await expect.poll(read).toEqual({ text: '"sessions.activityBar.compact": true', count: 1 });
		await openMenu();
		await sessionsPage.keyboard.press('Escape');
		await expect(copy).toHaveCount(0);
		await expect(more).toBeFocused();
		await expect(settings).toBeVisible();
		await openMenu();
		// Request the platform cancel path while the dialog still owns an open menu.
		await settings.evaluate(element => (element as HTMLDialogElement).requestClose());
		await expect(settings).toHaveCount(0);
		await expect(sessionsPage.locator('.ash-context-view-menu')).toHaveCount(0);
		await expect.poll(read).toEqual({ text: '"sessions.activityBar.compact": true', count: 1 });
		await openSettings();
		await expect(row.getByRole('switch')).toBeChecked();
		await openMenu();
		await copy.press('Enter');
		await expect(more).toBeFocused();
		await expect.poll(read).toEqual({ text: '"sessions.activityBar.compact": true', count: 2 });
		await marker.hover();
		await expect(settings.getByRole('tooltip')).toBeVisible();
		await settings.evaluate(element => (element as HTMLDialogElement).requestClose());
		await expect(settings).toHaveCount(0);
		await expect(sessionsPage.locator('.ash-context-view-menu')).toHaveCount(0);
		await expect(sessionsPage.getByRole('tooltip').filter({ hasText: 'Configured in local user settings.' })).toHaveCount(0);
		await expect(sessionsPage.locator('[data-part="activitybar"] .ash-sessions-activity-bottom button').last()).toBeFocused();
	} finally {
		if ('windows' in application) {
			await application.evaluate(() => { (globalThis as typeof globalThis & { restoreSessionsCopy(): void; }).restoreSessionsCopy(); });
		} else {
			await sessionsPage.evaluate(() => { (globalThis as typeof globalThis & { restoreSessionsCopy(): void; }).restoreSessionsCopy(); });
		}
	}
});

test('Workbench and Sessions keep one settings document across edits and window restarts', async ({ application, target, workbench }) => {
	const source = JSON.stringify({
		'window.title': 'Shared settings test',
		'workbench.sideBar.location': 'right',
		'workbench.activityBar.compact': true,
		'workbench.layoutStyle': 'modern',
		'sessions.layoutStyle': 'flat',
		'sessions.activityBar.compact': false,
	}, null, '\t');
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	const group = workbench.editors.groupAt(0);
	await expect(group.editor.input).toBeFocused();
	await group.editor.input.press('ControlOrMeta+A');
	await group.editor.input.evaluate((element, text) => {
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', text);
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	}, source);
	await group.editor.waitForEditorContents(contents => JSON.stringify(JSON.parse(contents)) === JSON.stringify(JSON.parse(source)));
	await workbench.quickaccess.runCommand('workbench.action.files.save');
	await expect(group.tabs.filter({ hasText: 'User Settings (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	await expect(workbench.page.locator('[data-part="sidebar"]')).toHaveClass(/sidebar-right/u);
	await expect(workbench.element).toHaveAttribute('data-layout-style', 'modern');

	let sessionsPage = await workbench.openAgentsWindow(target.kind);
	await expect(sessionsPage.locator('.ash-sessions-window')).toHaveAttribute('data-layout-style', 'flat');
	await expect(sessionsPage.locator('[data-part="activitybar"]')).not.toHaveClass(/compact/u);
	await expect(sessionsPage.locator('[data-part="sidebar"]')).not.toHaveClass(/sidebar-right/u);
	const accounts = sessionsPage.locator('[data-part="activitybar"] .ash-sessions-activity-bottom button').last();
	if ('windows' in application && process.platform === 'darwin') {
		await captureElectronMenu(application, () => accounts.click(), { label: 'Settings' });
	} else {
		await accounts.click();
		await sessionsPage.getByRole('menuitem', { name: 'Settings', exact: true }).click();
	}
	const settings = sessionsPage.getByRole('dialog', { name: 'Sessions Settings' });
	await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
	await settings.locator('[data-configuration-key="sessions.layoutStyle"]').getByRole('combobox').click();
	await sessionsPage.getByRole('option', { name: 'Modern', exact: true }).click();
	await sessionsPage.keyboard.press('Escape');
	await expect(settings).toBeHidden();
	await expect(sessionsPage.locator('.ash-sessions-window')).toHaveAttribute('data-layout-style', 'modern');
	sessionsPage = await workbench.reopenAgentsWindow(application, sessionsPage);
	await expect(sessionsPage.locator('.ash-sessions-window')).toHaveAttribute('data-layout-style', 'modern');

	if (target.kind === 'browser') {
		await sessionsPage.locator('[data-part="activitybar"] .ash-sessions-activity-bottom button').last().click();
		await sessionsPage.getByRole('menuitem', { name: 'Return to Workbench', exact: true }).click();
		await workbench.waitForReady();
	}
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	await expect(group.editor.element).toBeVisible();
	await expect.poll(async () => {
		const contents = (await group.editor.lines.allTextContents()).join('\n').replace(/\u00a0/g, ' ');
		if (contents.trim().length === 0) return undefined;
		return JSON.parse(contents);
	}).toEqual({
		'window.title': 'Shared settings test',
		'workbench.sideBar.location': 'right',
		'workbench.activityBar.compact': true,
		'workbench.layoutStyle': 'modern',
		'sessions.activityBar.compact': false,
	});
	await expect(workbench.page.locator('[data-part="sidebar"]')).toHaveClass(/sidebar-right/u);
});
