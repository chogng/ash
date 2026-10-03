import { expect, test } from '../../../automation/test.js';
import type { Locator, Page } from '@playwright/test';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';

async function useCustomMenus(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
		const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number; document: { version: 1; source: string } };
		const settings = JSON.parse(snapshot.document.source) as Record<string, unknown>;
		settings['window.menuStyle'] = 'custom';
		await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(settings) } });
	});
}

async function openSettings(page: Page, label = 'Settings'): Promise<Locator> {
	await page.locator('.ash-sessions-activity-bottom button').last().click();
	await page.getByRole('menuitem', { name: label, exact: true }).click();
	const settings = page.locator('.ash-sessions-settings-dialog');
	await expect(settings).toBeVisible();
	return settings;
}

test('Settings place Advisor in Agents and retain Customize controls across tabs', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	if (target.kind === 'electron' && process.platform === 'darwin') await useCustomMenus(workbench.page);
	let page = workbench.page;
	await page.keyboard.press('ControlOrMeta+,');
	const workbenchSettings = page.locator('.ash-settings-editor');
	const chatGroup = workbenchSettings.locator('[data-settings-group-id="agents"]');
	await expect(chatGroup).toHaveText('Chat');
	await chatGroup.click();
	const agentsCategory = workbenchSettings.locator('[data-settings-category-id="agents"]');
	await expect(agentsCategory).toHaveText('Agents');
	await agentsCategory.click();
	await expect(workbenchSettings.getByRole('button', { name: 'Advisor model', exact: true })).toBeVisible();
	const workbenchEnable = workbenchSettings.getByRole('switch', { name: 'Enable Advisor' });
	await expect(workbenchEnable).toBeVisible();
	const advisorCard = workbenchSettings.locator('.ash-advisor-settings.ash-settings-card');
	await expect(advisorCard).toBeVisible();
	await expect(advisorCard.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);
	if (target.appServerMode === 'required') {
		const advisorModel = workbenchSettings.getByRole('button', { name: 'Advisor model', exact: true });
		await expect(advisorModel).toBeEnabled();
		await advisorModel.focus();
		await advisorModel.press('Alt+F1');
		const advisorHelp = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
		await expect(advisorHelp.getByRole('textbox')).toHaveValue(/Advisor settings[\s\S]*Changes are saved immediately/u);
		await advisorHelp.getByRole('textbox').press('Escape');
		await expect(advisorModel).toBeFocused();
		await advisorModel.click();
		await expect(page.getByRole('menuitemradio', { name: 'Default', exact: true })).toHaveCount(0);
		await expect(page.getByRole('menuitemradio', { name: 'Inherit from the parent', exact: true })).toHaveCount(0);
		await expect(page.getByRole('menuitemradio', { name: 'GPT-5.6 Sol', exact: true })).toHaveCount(0);
		await expect(page.getByRole('menuitemradio', { name: 'Muse Spark 1.3', exact: true })).toBeVisible();
		await page.getByRole('menuitemradio', { name: 'GPT-6.1 Sol', exact: true }).click();
		await expect(workbenchSettings.locator('.ash-advisor-settings [role="status"]')).toHaveText('Advisor settings saved.');
		if (!await workbenchEnable.isChecked()) { await workbenchEnable.press('Space'); }
		await expect(workbenchEnable).toBeEnabled();
	}
	await page.locator('.ash-modal-editor-close').click();
	if (target.kind === 'browser') {
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	} else {
		if (!('windows' in application)) throw new Error('Expected Electron windows');
		const opened = application.waitForEvent('window');
		await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
		page = await opened;
	}
	const failures: string[] = [];
	page.on('pageerror', error => failures.push(error.message));
	const settings = await openSettings(page);
	const navigation = settings.getByRole('navigation', { name: 'Settings categories' });
	await expect(navigation.getByRole('button', { name: 'Personalization', exact: true })).toHaveCount(0);
	await expect(navigation.getByRole('button', { name: 'Plugins', exact: true })).toHaveCount(0);
	for (const name of ['General', 'Appearance', 'Models']) await expect(navigation.getByRole('button', { name, exact: true })).toBeVisible();
	await navigation.getByRole('button', { name: 'Agents', exact: true }).click();
	const advisorModel = settings.getByRole('button', { name: 'Advisor model', exact: true });
	const advisorEnable = settings.getByRole('switch', { name: 'Enable Advisor' });
	await expect(advisorModel).toBeVisible();
	await expect(advisorEnable).toBeVisible();
	if (target.appServerMode === 'required') {
		await expect(advisorModel).toHaveText('GPT-6.1 Sol');
		await expect(advisorEnable).toBeChecked();
		await navigation.getByRole('button', { name: 'Models', exact: true }).click();
		const visibility = settings.getByRole('switch', { name: 'Show GPT-6.1 Sol in model picker', exact: true });
		await expect(visibility).toBeChecked();
		await expect(settings.locator('.ash-models-settings-api-row').filter({ has: page.getByRole('heading', { name: 'Meta', exact: true }) })).toBeVisible();
		await visibility.press('Space');
		await expect(visibility).not.toBeChecked();
		await expect(visibility).toBeEnabled();
		await navigation.getByRole('button', { name: 'Agents', exact: true }).click();
		await expect(advisorModel).toHaveText('GPT-6.1 Sol');
		await advisorModel.click();
		await expect(page.getByRole('menuitemradio', { name: 'GPT-6.1 Sol', exact: true })).toHaveCount(0);
		await page.keyboard.press('Escape');
		await navigation.getByRole('button', { name: 'Models', exact: true }).click();
		await visibility.press('Space');
		await expect(visibility).toBeChecked();
		await expect(visibility).toBeEnabled();
		await navigation.getByRole('button', { name: 'Agents', exact: true }).click();
		await settings.locator('.ash-advisor-settings .ash-toggle').click();
		await expect(settings.locator('.ash-advisor-settings [role="status"]')).toHaveText('Advisor settings saved.');
		await page.keyboard.press('Escape');
		await openSettings(page);
		await settings.getByRole('button', { name: 'Agents', exact: true }).click();
		await expect(advisorModel).toHaveText('Disable');
		await expect(advisorEnable).not.toBeChecked();
		await advisorEnable.press('Space');
		await expect(advisorEnable).toBeEnabled();
		await expect(advisorEnable).toBeChecked();
		await advisorModel.click();
		await page.getByRole('menuitemradio', { name: 'Disable', exact: true }).click();
		await expect(advisorModel).toBeEnabled();
		await expect(advisorModel).toHaveText('Disable');
		await expect(advisorEnable).toBeEnabled();
		await expect(advisorEnable).not.toBeChecked();
		await advisorEnable.press('Space');
		await expect(advisorModel).toHaveText('GPT-6.1 Sol');
	}
	await navigation.getByRole('button', { name: 'Customize', exact: true }).click();
	const tabs = settings.getByRole('tablist', { name: 'Customize tabs' });
	await expect(tabs.getByRole('tab')).toHaveText(['Settings', 'Plugins', 'Skills', 'Hooks']);
	const settingsTab = tabs.getByRole('tab', { name: 'Settings', exact: true });
	await expect(settingsTab).toHaveAttribute('aria-selected', 'true');
	await expect(settings.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', await settingsTab.getAttribute('id') ?? '');
	await expect(settings.locator('.ash-advisor-settings')).toHaveCount(0);
	await settingsTab.focus();
	await settingsTab.press('Alt+F1');
	await expect(page.getByRole('dialog', { name: 'Accessibility Help', exact: true })).toBeVisible();
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Customize has Settings, Plugins, Skills, and Hooks tabs/u);
	await page.keyboard.press('Escape');
	await expect(settingsTab).toBeFocused();
	await settingsTab.press('ArrowRight');
	const pluginsTab = tabs.getByRole('tab', { name: 'Plugins', exact: true });
	await expect(pluginsTab).toBeFocused();
	await expect(settingsTab).toHaveAttribute('aria-selected', 'true');
	await pluginsTab.press('Enter');
	const plugins = settings.locator('.ash-marketplace');
	await expect(plugins.getByLabel('Package list', { exact: true })).toHaveValue('installed');
	const pluginQuery = plugins.getByLabel('Search packages', { exact: true });
	await pluginQuery.fill('retained query');
	const queryElement = await pluginQuery.elementHandle();
	await tabs.getByRole('tab', { name: 'Skills', exact: true }).click();
	const skills = settings.locator('.ash-skills');
	await expect(skills.getByLabel('Skills', { exact: true })).toBeVisible();
	await expect(plugins).toHaveCount(0);
	const skillList = await skills.getByLabel('Skills', { exact: true }).elementHandle();
	await tabs.getByRole('tab', { name: 'Hooks', exact: true }).click();
	await expect(settings.locator('.ash-hooks-event')).not.toHaveCount(0);
	await expect(settings.getByRole('combobox', { name: 'Configuration scope' })).toBeVisible();
	await pluginsTab.click();
	await expect(pluginQuery).toHaveValue('retained query');
	expect(await pluginQuery.evaluate((element, original) => element === original, queryElement)).toBe(true);
	await tabs.getByRole('tab', { name: 'Skills', exact: true }).click();
	expect(await skills.getByLabel('Skills', { exact: true }).evaluate((element, original) => element === original, skillList)).toBe(true);
	await queryElement?.dispose();
	await skillList?.dispose();
	await tabs.getByRole('tab', { name: 'Hooks', exact: true }).click();
	if (target.kind === 'electron' || target.appServerMode === 'required') {
		const scope = settings.getByRole('combobox', { name: 'Configuration scope' });
		await scope.click();
		await page.keyboard.press('End');
		await page.keyboard.press('Enter');
		if (target.appServerMode === 'required') {
			const edit = settings.locator('[data-hook-action="edit-scope"]');
			await expect(edit).toBeEnabled();
			await edit.click();
			await expect(settings).toHaveCount(0);
			await expect(page.getByRole('tab', { name: 'config.toml', exact: true })).toBeVisible();
			await expect(page.locator('[data-part="editor"] .stanza-editor-input')).toBeFocused();
			await openSettings(page);
			await settings.getByRole('button', { name: 'Customize', exact: true }).click();
			await tabs.getByRole('tab', { name: 'Hooks', exact: true }).click();
			await scope.click();
			await page.keyboard.press('End');
			await page.keyboard.press('Enter');
		}
		const ask = settings.locator('[data-hook-action="ask-scope"]');
		await expect(ask).toBeEnabled();
		await ask.click();
		await expect(settings).toHaveCount(0);
		const draft = new Editor(page.locator('.ash-sessions-chat-slot .ash-chat:visible').first());
		await expect(draft.input).toBeFocused();
		await draft.waitForEditorContents(text => text.includes('Help me configure'));
		await expect(page.locator('.ash-chat-item-userMessage')).toHaveCount(0);
	} else {
		await expect(settings.locator('[data-hook-action="ask-scope"]')).toBeDisabled();
		await page.keyboard.press('Escape');
	}
	await new QuickAccess(page).runCommand('ash.skills.open');
	await expect(settings).toBeVisible();
	await expect(settings.getByRole('tab', { name: 'Skills', exact: true })).toHaveAttribute('aria-selected', 'true');
	await skills.getByRole('button', { name: 'Get skills from Marketplace', exact: true }).click();
	await expect(pluginsTab).toHaveAttribute('aria-selected', 'true');
	await expect(plugins.getByLabel('Package list', { exact: true })).toHaveValue('browse');
	await expect(plugins.getByLabel('Capability', { exact: true })).toHaveValue('skill');
	await page.keyboard.press('Escape');
	expect(failures).toEqual([]);
});

test('Sessions Customize uses Chinese labels and localized Skills controls', async ({ application, target, workbench, restartWorkbench }) => {
	test.skip(target.workbenchMode !== 'code');
	if (target.kind === 'electron' && process.platform === 'darwin') await useCustomMenus(workbench.page);
	let originalPage = workbench.page;
	await originalPage.keyboard.press('ControlOrMeta+,');
	let editor = originalPage.locator('.ash-settings-editor');
	await editor.locator('[data-settings-category-id="general"]').click();
	const language = editor.locator('[data-settings-item-id="workbench.locale"]').getByRole('combobox');
	await language.click();
	await originalPage.keyboard.press('End');
	await originalPage.keyboard.press('Enter');
	await expect(language).toHaveText('简体中文');
	({ workbench, application } = await restartWorkbench());
	originalPage = workbench.page;
	await originalPage.keyboard.press('ControlOrMeta+,');
	editor = originalPage.locator('.ash-settings-editor');
	const chatGroup = editor.locator('[data-settings-group-id="agents"]');
	await expect(chatGroup).toHaveText('聊天');
	await chatGroup.click();
	await expect(editor.locator('[data-settings-category-id="agents"]')).toHaveText('智能体');
	await editor.locator('[data-settings-category-id="agents"]').click();
	await expect(editor.getByRole('button', { name: '顾问模型', exact: true })).toBeVisible();
	await expect(editor.getByRole('switch', { name: '启用顾问' })).toBeVisible();
	await originalPage.locator('.ash-modal-editor-close').click();
	let page = originalPage;
	if (target.kind === 'browser') {
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	} else {
		if (!('windows' in application)) throw new Error('Expected Electron windows');
		const opened = application.waitForEvent('window');
		await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
		page = await opened;
	}
	await page.waitForFunction(() => document.querySelector('.ash-sessions-activity-content') || document.querySelector('#app > section > textarea[readonly]'));
	if (await page.locator('#app > section > textarea[readonly]').count()) throw new Error(await page.locator('#app > section > textarea[readonly]').inputValue());

	const settings = await openSettings(page, '设置');
	await settings.getByRole('button', { name: '智能体', exact: true }).click();
	await expect(settings.getByRole('button', { name: '顾问模型', exact: true })).toBeVisible();
	await expect(settings.getByRole('switch', { name: '启用顾问' })).toBeVisible();
	await settings.getByRole('button', { name: '自定义', exact: true }).click();
	const tabs = settings.getByRole('tablist', { name: '自定义标签页' });
	await expect(tabs.getByRole('tab')).toHaveText(['设置', '插件', '技能', 'Hooks']);
	await tabs.getByRole('tab', { name: '技能', exact: true }).click();
	await expect(settings.locator('.ash-skills').getByLabel('技能', { exact: true })).toBeVisible();
	await expect(settings.getByRole('button', { name: '从市场获取技能', exact: true })).toBeVisible();
	await expect(settings.getByRole('button', { name: '刷新', exact: true })).toBeVisible();
});
