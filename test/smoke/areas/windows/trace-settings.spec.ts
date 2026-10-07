import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test('Execution trace Settings supports disconnected help, search and Chinese labels', async ({ target, workbench, restartWorkbench }) => {
	test.skip(target.appServerMode === 'required', 'Exercises the disconnected settings state.');
	let page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectGroup('agents');
	await workbench.settingsEditor.selectCategory('execution-trace');
	let settings = page.locator('.ash-settings-editor');
	await expect(settings.locator('.ash-settings-section').getByRole('heading', { name: 'Execution trace', exact: true })).toBeVisible();
	await expect(settings.getByRole('switch', { name: 'Record detailed requests and responses' })).toBeDisabled();
	await expect(settings.getByRole('status').filter({ hasText: 'Current recording state is unavailable.' })).toBeVisible();
	const refresh = settings.getByRole('button', { name: 'Refresh', exact: true });
	await refresh.focus();
	await refresh.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/restart the owning App Server/);
	await help.getByRole('textbox').press('Escape');
	await expect(refresh).toBeFocused();
	const search = settings.getByRole('searchbox', { name: 'Search settings', exact: true });
	await search.fill('requests');
	await expect(settings.getByRole('switch', { name: 'Record detailed requests and responses' })).toBeVisible();
	await search.fill('');
	await workbench.settingsEditor.selectCategory('general');
	await settings.getByRole('combobox', { name: 'Interface language', exact: true }).click();
	await page.getByRole('option', { name: '简体中文', exact: true }).click();
	({ workbench } = await restartWorkbench());
	page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectGroup('agents');
	await workbench.settingsEditor.selectCategory('execution-trace');
	settings = page.locator('.ash-settings-editor');
	await expect(settings.locator('.ash-settings-section').getByRole('heading', { name: '执行轨迹', exact: true })).toBeVisible();
	await expect(settings.getByRole('switch', { name: '记录详细请求与响应' })).toBeDisabled();
	await settings.getByRole('button', { name: '刷新', exact: true }).focus();
	await settings.getByRole('button', { name: '刷新', exact: true }).press('Alt+F1');
	await expect(page.getByRole('dialog', { name: '无障碍帮助' }).getByRole('textbox')).toHaveValue(/重启所属 App Server 后生效/);
});

test('Execution trace Settings persists backend intent and shares it with Agents Settings', async ({ target, workbench, testWorkspace, application }) => {
	test.skip(target.appServerMode !== 'required', 'Uses the real backend and isolated profile.');
	let page = workbench.page;
	// Use the same account menu in Electron and Web, including macOS.
	if (target.kind === 'electron') {
		await page.evaluate(async () => {
			const snapshot = await globalThis.ashTestMainProcess.call('configuration', 'read') as { revision: number; document: { version: 1; source: string; }; };
			const source = JSON.stringify({ ...JSON.parse(snapshot.document.source), 'window.menuStyle': 'custom' });
			await globalThis.ashTestMainProcess.call('configuration', 'update', { expectedRevision: snapshot.revision, document: { version: 1, source } });
		});
	}
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectGroup('agents');
	await workbench.settingsEditor.selectCategory('execution-trace');
	const settings = page.locator('.ash-settings-editor');
	const toggle = settings.getByRole('switch', { name: 'Record detailed requests and responses' });
	await expect(toggle).toBeEnabled();
	await expect(toggle).not.toBeChecked();
	await toggle.focus();
	await toggle.press('Space');
	const directory = join(testWorkspace.directory, 'trace-recordings');
	await settings.getByRole('textbox', { name: 'Save directory on the App Server host' }).fill(directory);
	await settings.getByRole('button', { name: 'Save trace settings' }).click();
	await expect(settings.getByRole('button', { name: 'Save trace settings' })).toBeDisabled();
	await expect(settings.getByRole('status').filter({ hasText: 'Saved settings require restarting' })).toBeVisible();
	await expect(settings.getByRole('status').filter({ hasText: 'Current backend: detailed recording is off.' })).toBeVisible();
	await page.locator('.ash-modal-editor-close').click();
	page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-bottom button').last().click();
	await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
	const agentsSettings = page.getByRole('dialog', { name: 'Sessions Settings' });
	await expect(agentsSettings).toBeVisible();
	await agentsSettings.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Execution trace', exact: true }).click();
	await expect(agentsSettings.getByRole('switch', { name: 'Record detailed requests and responses' })).toBeChecked();
	await expect(agentsSettings.getByRole('textbox', { name: 'Save directory on the App Server host' })).toHaveValue(directory);
	await expect(agentsSettings.getByRole('button', { name: 'Save trace settings' })).toBeDisabled();
	await expect(agentsSettings.getByRole('status').filter({ hasText: 'Current backend: detailed recording is off.' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(agentsSettings).toBeHidden();
	page = await workbench.reopenAgentsWindow(application, page);
	await page.locator('.ash-sessions-activity-bottom button').last().click();
	await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
	const restored = page.getByRole('dialog', { name: 'Sessions Settings' });
	await expect(restored).toBeVisible();
	await restored.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Execution trace', exact: true }).click();
	await expect(restored.getByRole('switch', { name: 'Record detailed requests and responses' })).toBeChecked();
	await expect(restored.getByRole('textbox', { name: 'Save directory on the App Server host' })).toHaveValue(directory);
	await expect(restored.getByRole('button', { name: 'Save trace settings' })).toBeDisabled();
});
