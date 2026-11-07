import { basename } from 'node:path';
import { expect, test } from '../../../automation/test.js';

for (const locale of ['en', 'zh-CN']) {
	test.describe(`Editor grid restoration in ${locale}`, () => {
		test.use({ electronWindowMode: 'active', electronUserSettings: { 'workbench.locale': locale } });

		test('Files split groups survive closing and reopening the window without layout errors', { tag: ['@electron-app-server'] }, async ({ application, target, workbench, driver, testWorkspace }, testInfo) => {
			let page = await workbench.openAgentsWindow(target.kind);
			// This regression closes a settled Code layout after the initial Chat entry finishes loading.
			await expect(page.locator('.ash-chat-navigation-list')).toHaveAttribute('aria-busy', 'false');
			await page.locator('.ash-window-mode-control').getByRole('button').nth(1).click();
			const files = () => page.locator('[data-editor-tool="files"]');
			const groups = () => files().locator('.ash-editor-group:not(.ash-code-page-group):visible');
			const details = () => files().locator('.ash-desktop-auxiliarybar');
			const titleAction = (id: string) => page.locator(`[data-part="titlebar"] [data-action-id="${id}"] button`);
			const filesButton = titleAction('ash.sessions.toggleFiles');
			const terminalButton = titleAction('ash.sessions.togglePanel');
			const projectPicker = page.locator('.ash-sessions-chat-slot.active .ash-sessions-workspace-picker');
			await expect(projectPicker).toHaveText(locale === 'en' ? 'Choose project' : '选择项目');
			await expect(filesButton).toHaveCount(0);
			await expect(terminalButton).toHaveCount(0);
			await projectPicker.click();
			await page.getByRole('menuitemradio', { name: basename(testWorkspace.directory), exact: true }).click();
			await expect(terminalButton).toBeVisible();
			await filesButton.click();
			await expect(details()).toBeVisible();
			await details().getByText('main.ts', { exact: true }).dblclick();
			await groups().getByRole('textbox', { name: 'main.ts', exact: true }).press('ControlOrMeta+Backslash');
			await expect(groups()).toHaveCount(2);
			await expect(files().getByRole('tab', { name: 'main.ts', exact: true })).toHaveCount(2);
			for (let reopen = 0; reopen < 2; reopen++) {
				page = await workbench.reopenAgentsWindow(application, page);
				await expect(groups()).toHaveCount(2);
				await expect(files().getByRole('tab', { name: 'main.ts', exact: true })).toHaveCount(2);
				await expect(details()).toBeVisible();
				await expect(files().locator('.stanza-editor-document:visible')).toHaveCount(2);
				for (const group of await groups().all()) {
					await expect(group.locator('.stanza-editor-document')).toContainText('const value = 1;');
				}
				expect(driver.diagnostics.errors).toEqual([]);
			}
			await testInfo.attach('restored-editor-grid', { body: await page.screenshot(), contentType: 'image/png' });
		});
	});
}
