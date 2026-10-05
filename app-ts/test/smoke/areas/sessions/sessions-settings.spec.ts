import { expect, test } from '../../../automation/test.js';
import { captureElectronMenu } from '../../../automation/menus.js';

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
	await expect.poll(async () => {
		const contents = (await group.editor.lines.allTextContents()).join('\n').replace(/\u00a0/g, ' ');
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
