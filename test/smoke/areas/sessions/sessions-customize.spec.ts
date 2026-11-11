import { readUserSettings, writeUserSettings } from '../../../automation/settings.js';
import { expect, test } from '../../../automation/test.js';
import type { Locator, Page } from '@playwright/test';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';

async function useCustomMenus(page: Page): Promise<void> {
	await (async () => {
		const snapshot = await readUserSettings(page);
		const settings = JSON.parse(snapshot.content) as Record<string, unknown>;
		settings['window.menuStyle'] = 'custom';
		await writeUserSettings(page, JSON.stringify(settings), snapshot.revision);
	})();
}

async function openSettings(page: Page, label = 'Settings'): Promise<Locator> {
	await page.locator('.ash-sessions-activity-bottom button').last().click();
	await page.getByRole('menuitem', { name: label, exact: true }).click();
	const settings = page.locator('.ash-sessions-settings-dialog');
	await expect(settings).toBeVisible();
	return settings;
}

const advisorModelLabel = /^Advisor model:/u;
const solAdvisorOption = /^Sol 6\.1(?: |$)/u;

async function selectSolAdvisor(page: Page, control: Locator): Promise<void> {
	await control.click();
	await page.getByRole('menuitem', { name: solAdvisorOption }).press('ArrowRight');
	await page.getByRole('menuitemradio', { name: 'High', exact: true }).press('Enter');
	await expect(control).toHaveAccessibleName('Advisor model: Sol 6.1 High');
}

test('Settings place Advisor in Agents and retain Customize controls across tabs', async ({ target, workbench }) => {
	if (target.kind === 'electron' && process.platform === 'darwin') await useCustomMenus(workbench.page);
	const workbenchPage = workbench.page;
	await workbenchPage.keyboard.press('ControlOrMeta+,');
	const workbenchSettings = workbenchPage.locator('.ash-settings-editor');
	const chatGroup = workbenchSettings.locator('[data-settings-group-id="agents"]');
	await expect(chatGroup).toHaveText('Chat');
	await chatGroup.click();
	const agentsCategory = workbenchSettings.locator('[data-settings-category-id="agents"]');
	await expect(agentsCategory).toHaveText('Agents');
	await agentsCategory.click();
	const workbenchAdvisor = workbenchSettings.getByRole('group', { name: 'Advisor', exact: true });
	const workbenchModel = workbenchAdvisor.getByRole('button', { name: advisorModelLabel });
	await expect(workbenchModel).toBeVisible();
	if (target.appServerMode === 'required') {
		await expect(workbenchModel).toBeEnabled();
		await workbenchModel.focus();
		await workbenchModel.press('Alt+F1');
		const advisorHelp = workbenchPage.getByRole('dialog', { name: 'Accessibility Help', exact: true });
		await expect(advisorHelp.getByRole('textbox')).toHaveValue(/Advisor settings[\s\S]*Inherit from chat[\s\S]*Disable/u);
		await advisorHelp.getByRole('textbox').press('Escape');
		await expect(workbenchModel).toBeFocused();
		await selectSolAdvisor(workbenchPage, workbenchModel);
	}
	await workbenchPage.locator('.ash-modal-editor-close').click();
	const page = await workbench.openAgentsWindow(target.kind);
	const failures: string[] = [];
	page.on('pageerror', error => failures.push(error.message));
	const settings = await openSettings(page);
	const navigation = settings.getByRole('navigation', { name: 'Settings categories' });
	await expect(navigation.getByRole('button', { name: 'Personalization', exact: true })).toHaveCount(0);
	await expect(navigation.getByRole('button', { name: 'Extensions', exact: true })).toHaveCount(0);
	for (const name of ['General', 'Appearance', 'Models']) await expect(navigation.getByRole('button', { name, exact: true })).toBeVisible();
	await navigation.getByRole('button', { name: 'Agents', exact: true }).click();
	const advisor = settings.getByRole('group', { name: 'Advisor', exact: true });
	const advisorModel = advisor.getByRole('button', { name: advisorModelLabel });
	await expect(advisorModel).toBeVisible();
	if (target.appServerMode === 'required') {
		await expect(advisorModel).toHaveAccessibleName('Advisor model: Sol 6.1 High');
		await navigation.getByRole('button', { name: 'Models', exact: true }).click();
		const visibility = settings.getByRole('switch', { name: 'Show Sol 6.1 in model picker', exact: true });
		const modelSearch = settings.getByRole('combobox', { name: 'Search models', exact: true });
		await expect(visibility).toBeChecked();
		await expect(settings.locator('.ash-models-settings-api-row').filter({ has: page.getByRole('heading', { name: 'Meta', exact: true }) })).toBeVisible();
		await visibility.press('Space');
		await expect(visibility).not.toBeChecked();
		await expect(visibility).toBeEnabled();
		await navigation.getByRole('button', { name: 'Agents', exact: true }).click();
		await expect(advisorModel).toHaveAccessibleName('Advisor model: Sol 6.1 High');
		await advisorModel.click();
		await expect(page.getByRole('menuitem', { name: 'Sol 6.1 High', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await navigation.getByRole('button', { name: 'Models', exact: true }).click();
		await modelSearch.fill('Sol 6.1');
		await expect(visibility).not.toBeChecked();
		await visibility.press('Space');
		await expect(visibility).toBeChecked();
		await expect(visibility).toBeEnabled();
		await navigation.getByRole('button', { name: 'Agents', exact: true }).click();
		await advisorModel.click();
		await page.getByRole('menuitemradio', { name: 'Disable', exact: true }).click();
		await expect(advisorModel).toHaveAccessibleName('Advisor model: Disable');
		await page.keyboard.press('Escape');
		await expect(settings).toHaveCount(0);
		await openSettings(page);
		await settings.getByRole('button', { name: 'Agents', exact: true }).click();
		await expect(advisorModel).toBeEnabled();
		await expect(advisorModel).toHaveAccessibleName('Advisor model: Disable');
		await advisorModel.click();
		await expect(page.getByRole('menuitemradio', { name: 'Disable', exact: true })).toHaveAttribute('aria-checked', 'true');
		await page.getByRole('menuitemradio', { name: 'Inherit from chat', exact: true }).click();
		await expect(advisorModel).toHaveAccessibleName('Advisor model: Inherit from chat');
		await selectSolAdvisor(page, advisorModel);
	}
	await navigation.getByRole('button', { name: 'Customize', exact: true }).click();
	const tabs = settings.getByRole('tablist', { name: 'Customize tabs' });
	await expect(tabs.getByRole('tab')).toHaveText(['Settings', 'Hooks']);
	const settingsTab = tabs.getByRole('tab', { name: 'Settings', exact: true });
	await expect(settingsTab).toHaveAttribute('aria-selected', 'true');
	await expect(settings.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', await settingsTab.getAttribute('id') ?? '');
	await expect(advisor).toHaveCount(0);
	await settingsTab.focus();
	await settingsTab.press('Alt+F1');
	await expect(page.getByRole('dialog', { name: 'Accessibility Help', exact: true })).toBeVisible();
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Customize has Settings and Hooks tabs/u);
	await page.keyboard.press('Escape');
	await expect(settingsTab).toBeFocused();
	await settingsTab.press('ArrowRight');
	const hooksTab = tabs.getByRole('tab', { name: 'Hooks', exact: true });
	await expect(hooksTab).toBeFocused();
	await expect(settingsTab).toHaveAttribute('aria-selected', 'true');
	await hooksTab.press('Enter');
	await expect(settings.getByRole('button', { name: 'Manage Hooks', exact: true })).toBeVisible();
	await expect(settings.locator('[data-hook-event]')).toHaveCount(0);
	await settings.getByRole('button', { name: 'Manage Hooks', exact: true }).click();
	await expect(settings).toHaveCount(0);
	const hooks = page.locator('.ash-ai-customization-management');
	await expect(hooks).toBeVisible();
	await expect(hooks.getByRole('searchbox')).toBeFocused();
	await expect(hooks.locator('.ash-hooks-event')).toHaveCount(33);
	const ask = hooks.locator('[data-hook-action="ask-scope"]');
	if (target.appServerMode === 'required') {
		const scope = hooks.getByRole('combobox', { name: 'Configuration scope' });
		const selectLastScope = async () => {
			await scope.click();
			await page.keyboard.press('End');
			await page.keyboard.press('Enter');
		};
		await selectLastScope();
		const edit = hooks.locator('[data-hook-action="edit-scope"]');
		await expect(edit).toBeEnabled();
		await edit.click();
		await expect(page.getByRole('tab', { name: 'config.toml', exact: true })).toBeVisible();
		await expect(page.getByRole('textbox', { name: 'config.toml', exact: true })).toBeFocused();
		await openSettings(page);
		await settings.getByRole('button', { name: 'Customize', exact: true }).click();
		await tabs.getByRole('tab', { name: 'Hooks', exact: true }).click();
		await settings.getByRole('button', { name: 'Manage Hooks', exact: true }).click();
		await selectLastScope();
		await expect(ask).toBeEnabled();
		await ask.click();
		const draft = new Editor(page.locator('.ash-sessions-chat-slot :is(.ash-chat,.ash-native-chat):visible').first());
		await expect(draft.input).toBeFocused();
		await draft.waitForEditorContents(text => text.includes('Help me configure'));
		await expect(page.locator(':is(.ash-chat-item-userMessage,.ash-native-chat-item-userMessage)')).toHaveCount(0);
	} else {
		await expect(hooks.getByRole('status')).toContainText('Could not load Hooks:');
		await expect(ask).toBeDisabled();
	}
	await new QuickAccess(page).runCommand('workbench.action.chat.configure.skills');
	await expect(settings).toHaveCount(0);
	const skills = page.locator('[data-view-id="ash.extensions.skills"]');
	await expect(skills.getByRole('button', { name: 'Skills', exact: true })).toHaveAttribute('aria-expanded', 'true');
	await expect(page.locator('[data-view-id="ash.extensions.plugins"]')).toBeVisible();
	await expect(page.locator('[data-view-id="ash.extensions.mcp"]')).toBeVisible();
	expect(failures).toEqual([]);
});

test('Sessions Customize uses Chinese labels and localized Hooks controls', async ({ target, workbench, restartWorkbench }) => {
	if (target.kind === 'electron' && process.platform === 'darwin') await useCustomMenus(workbench.page);
	let originalPage = workbench.page;
	await originalPage.keyboard.press('ControlOrMeta+,');
	let editor = originalPage.locator('.ash-settings-editor');
	await editor.locator('[data-settings-category-id="display-language"]').click();
	const language = editor.locator('[data-settings-item-id="workbench.locale"]').getByRole('combobox');
	await language.click();
	await originalPage.keyboard.press('End');
	await originalPage.keyboard.press('Enter');
	await expect(language).toHaveText('简体中文');
	({ workbench } = await restartWorkbench());
	originalPage = workbench.page;
	await originalPage.keyboard.press('ControlOrMeta+,');
	editor = originalPage.locator('.ash-settings-editor');
	const chatGroup = editor.locator('[data-settings-group-id="agents"]');
	await expect(chatGroup).toHaveText('聊天');
	await chatGroup.click();
	await expect(editor.locator('[data-settings-category-id="agents"]')).toHaveText('智能体');
	await editor.locator('[data-settings-category-id="agents"]').click();
	await expect(editor.getByRole('button', { name: /^顾问模型：/u })).toBeVisible();
	await originalPage.locator('.ash-modal-editor-close').click();
	const page = await workbench.openAgentsWindow(target.kind);
	const settings = await openSettings(page, '设置');
	await settings.getByRole('button', { name: '智能体', exact: true }).click();
	await expect(settings.getByRole('button', { name: /^顾问模型：/u })).toBeVisible();
	await settings.getByRole('button', { name: '快捷键', exact: true }).click();
	await expect(settings.locator('.ash-sessions-settings-page')).toContainText('按分类浏览 Agent 窗口中可用的快捷键。');
	await settings.getByRole('button', { name: '自定义', exact: true }).click();
	await expect(settings.getByRole('button', { name: '打开工作台设置', exact: true })).toBeVisible();
	const tabs = settings.getByRole('tablist', { name: '自定义标签页' });
	await expect(tabs.getByRole('tab')).toHaveText(['设置', 'Hooks']);
	await tabs.getByRole('tab', { name: 'Hooks', exact: true }).click();
	await settings.getByRole('button', { name: '管理 Hooks', exact: true }).click();
	const hooks = page.locator('.ash-ai-customization-management');
	await expect(hooks.getByRole('heading', { name: 'Agent 自定义：Hooks' })).toBeVisible();
	await expect(hooks.getByRole('searchbox', { name: '搜索事件、Hook、命令或路径' })).toBeFocused();
	await hooks.getByRole('searchbox').press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/配置 Hooks[\s\S]*不会发送/u);
});


test('Sessions Customize settings hands off to the same Workbench settings and JSON resources', async ({ target, workbench, runningApplication }) => {
	if (target.kind === 'electron' && process.platform === 'darwin') await useCustomMenus(workbench.page);
	const page = await workbench.openAgentsWindow(target.kind);
	let settings = await openSettings(page);
	await settings.locator('[data-settings-category-id="customize"]').click();
	await settings.getByRole('button', { name: 'Open Workbench Settings', exact: true }).click();
	await expect(settings).toHaveCount(0);
	const sharedSettings = page.locator('.ash-settings-editor');
	await expect(sharedSettings).toBeVisible();
	await expect(sharedSettings.getByRole('searchbox')).toBeFocused();
	await sharedSettings.getByRole('searchbox').fill('workbench.activityBar.badges');
	const badges = sharedSettings.locator('[data-settings-item-id="workbench.activityBar.badges"]').getByRole('switch');
	await expect(badges).toBeChecked();
	await badges.press('Space');
	await expect(badges).not.toBeChecked();
	await expect(badges).toBeEnabled();
	await page.getByRole('toolbar', { name: 'Close Ash Settings', exact: true }).getByRole('button').click();
	await expect(sharedSettings).toHaveCount(0);
	settings = await openSettings(page);
	await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
	const followReplies = settings.locator('[data-settings-item-id="chat.autoFollowReplies"]').getByRole('switch');
	await expect(followReplies).toBeChecked();
	await followReplies.press('Space');
	await expect(followReplies).not.toBeChecked();
	await expect(followReplies).toBeEnabled();
	await settings.locator('[data-settings-category-id="customize"]').click();
	await settings.getByRole('button', { name: 'Preferences: Open User Settings (JSON)', exact: true }).click();
	await expect(settings).toHaveCount(0);
	const settingsJson = page.getByRole('tabpanel', { name: 'User Settings (JSON)', exact: true });
	await new Editor(settingsJson).waitForEditorContents(source => source.includes('"workbench.activityBar.badges": false') && source.includes('"chat.autoFollowReplies": false'));
	expect(runningApplication.diagnostics.consoleErrors.filter(message => message.startsWith('Code editor contribution failed'))).toEqual([]);
	expect(runningApplication.diagnostics.errors).toEqual([]);
});
