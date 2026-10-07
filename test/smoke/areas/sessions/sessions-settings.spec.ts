import { expect, test } from '../../../automation/test.js';
import { captureElectronMenu } from '../../../automation/menus.js';

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
