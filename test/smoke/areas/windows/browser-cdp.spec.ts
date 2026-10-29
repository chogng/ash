import { expect, test } from '../../../automation/test.js';
import { readUserSettings } from '../../../automation/settings.js';

test('browser Agent and CDP settings are keyboard accessible and persist in English and Chinese', { tag: ['@electron-ui'] }, async ({ workbench, reloadWorkbench, restartWorkbench }, testInfo) => {
	test.setTimeout(120_000);
	for (const locale of ['en', 'zh-CN']) {
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('workbench');
		await workbench.settingsEditor.selectCategory('browser');
		const settings = workbench.settingsEditor.element;
		const tools = settings.getByRole('switch', {
			name: locale === 'en' ? 'Allow Agent browser tools' : '允许 Agent 使用浏览器工具',
			exact: true,
		});
		const cdp = settings.getByRole('switch', {
			name: locale === 'en' ? 'Allow advanced browser control (CDP)' : '允许高级浏览器控制（CDP）',
			exact: true,
		});
		await expect(tools).toBeChecked();
		await expect(cdp).not.toBeChecked();
		await cdp.focus();
		await cdp.press('Space');
		await expect(cdp).toBeChecked();
		await expect.poll(async () => JSON.parse((await readUserSettings(workbench.page)).content)['workbench.browser.enableCDP']).toBe(true);
		await tools.focus();
		await tools.press('Space');
		await expect(tools).not.toBeChecked();
		await expect.poll(async () => JSON.parse((await readUserSettings(workbench.page)).content)['workbench.browser.enableChatTools']).toBe(false);
		await testInfo.attach(`browser-control-${locale}`, {
			body: await workbench.page.screenshot(),
			contentType: 'image/png',
		});
		await settings.locator('.ash-modal-editor-close').click();
		({ workbench } = await reloadWorkbench());
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('workbench');
		await workbench.settingsEditor.selectCategory('browser');
		const reopened = workbench.settingsEditor.element;
		await expect(
			reopened.getByRole('switch', {
				name: locale === 'en' ? 'Allow Agent browser tools' : '允许 Agent 使用浏览器工具',
				exact: true,
			}),
		).not.toBeChecked();
		await expect(
			reopened.getByRole('switch', {
				name: locale === 'en' ? 'Allow advanced browser control (CDP)' : '允许高级浏览器控制（CDP）',
				exact: true,
			}),
		).toBeChecked();
		// Restore defaults through the same controls before the next language pass.
		await reopened.locator('[data-configuration-key="workbench.browser.enableChatTools"]').press('Space');
		await reopened.locator('[data-configuration-key="workbench.browser.enableCDP"]').press('Space');
		await expect
			.poll(async () => {
				const values = JSON.parse((await readUserSettings(workbench.page)).content);
				return [values['workbench.browser.enableChatTools'] ?? true, values['workbench.browser.enableCDP'] ?? false];
			})
			.toEqual([true, false]);
		await reopened.locator('.ash-modal-editor-close').click();
		if (locale === 'en') {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
			await language.fill('简体中文');
			await language.press('Enter');
			({ workbench } = await restartWorkbench());
		}
	}
});
