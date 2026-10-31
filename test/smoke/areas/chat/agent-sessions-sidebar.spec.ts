import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';

test('Chat session tabs share one title row and retain drafts across navigation and closing', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ driver, workbench }, testInfo) => {
	const page = workbench.page;
	await driver.setWindowSize({ width: 1440, height: 900 });
	await workbench.openExplorer();
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const auxiliary = page.locator('[data-part="auxiliarybar"]');
	const tabs = auxiliary.locator('.ash-chat-view-tabs [role="tab"]');
	await expect(tabs).toHaveCount(1);
	await expect(auxiliary.locator('.ash-auxiliarybar-view-selector')).toBeHidden();
	await expect(auxiliary.locator('.ash-composite-bar')).toBeHidden();
	const header = (await auxiliary.locator('.ash-pane-composite-title').boundingBox())!;
	expect(Math.abs(header.y - (await auxiliary.boundingBox())!.y)).toBeLessThanOrEqual(1);
	const input = new Editor(auxiliary.locator('.ash-chat:visible'));
	await input.waitForEditorFocus();
	await input.waitForTypeInEditor('Draft A');
	await auxiliary.locator('.ash-split-action-primary button').click();
	await expect(tabs).toHaveCount(2);
	await input.waitForEditorFocus();
	await input.waitForTypeInEditor('Draft B');
	await tabs.first().click();
	await input.waitForEditorContents(text => text === 'Draft A');
	await tabs.last().focus();
	await page.keyboard.press('Enter');
	await input.waitForEditorContents(text => text === 'Draft B');
	await page.keyboard.press('Delete');
	await expect(tabs).toHaveCount(1);
	await input.waitForEditorContents(text => text === 'Draft A');
	const toggle = auxiliary.locator('[data-action-id="agentSessions.toggleAgentSessionsSidebar"] button');
	const sidebar = auxiliary.locator('.ash-chat-sessions-sidebar');
	await toggle.click();
	await expect(sidebar.locator('.ash-agent-session-row')).toHaveCount(2);
	await sidebar.locator('.ash-agent-session-row').first().click();
	await expect(sidebar).toBeHidden();
	await expect(tabs).toHaveCount(2);
	await input.waitForEditorContents(text => text === 'Draft B');
	await page.screenshot({ path: testInfo.outputPath('chat-session-tabs.png') });
});

test('Chat More switches Tabs and List while preserving drafts and the saved preference', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, workbench, reloadWorkbench }) => {
	let page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const input = new Editor(page.locator('.ash-chat-view-pane .ash-chat:visible'));
	await input.waitForEditorFocus();
	await input.waitForTypeInEditor('Saved draft');
	const more = page.locator('.ash-chat-title-actions .ash-toolbar-more-actions button');
	const choices = await workbench.menus.inspect(application, () => more.click(), ['Session display']);
	expect(choices.map(({ label, checked }) => [label, checked])).toEqual([['Tabs', true], ['List', false]]);
	await workbench.menus.select(application, () => more.click(), ['Session display', 'List']);
	await expect(page.locator('.ash-chat-view-tabs')).toBeHidden();
	await expect(page.locator('.ash-chat-view-title-button')).toBeVisible();
	await page.locator('[data-action-id="agentSessions.toggleAgentSessionsSidebar"] button').click();
	const sidebar = page.locator('.ash-chat-sessions-sidebar');
	await expect(sidebar).toBeVisible();
	await expect(input.element).toBeInViewport();
	await page.keyboard.press('Escape');
	await expect(sidebar).toBeHidden();
	await expect(page.locator('[data-action-id="agentSessions.toggleAgentSessionsSidebar"] button')).toBeFocused();
	await input.waitForEditorContents(text => text === 'Saved draft');
	const restored = await reloadWorkbench();
	page = restored.workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	await expect(page.locator('.ash-chat-view-title-button')).toBeVisible();
	await new Editor(page.locator('.ash-chat-view-pane .ash-chat:visible')).waitForEditorContents(text => text === 'Saved draft');
	const restoredMore = page.locator('.ash-chat-title-actions .ash-toolbar-more-actions button');
	await restored.workbench.menus.select(restored.application, () => restoredMore.click(), ['Session display', 'Tabs']);
	await expect(page.locator('.ash-chat-view-tabs [role="tab"]')).toHaveCount(1);
});

test('Session display and tab actions use the Chinese display language', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, workbench, restartWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ application, workbench } = await restartWorkbench());
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: '显示辅助侧栏', exact: true }).click();
	}
	await expect(page.getByRole('tablist', { name: '已打开的会话', exact: true })).toBeVisible();
	const more = page.locator('.ash-chat-title-actions .ash-toolbar-more-actions button');
	const choices = await workbench.menus.inspect(application, () => more.click(), ['会话显示方式']);
	expect(choices.map(({ label, checked }) => [label, checked])).toEqual([['标签页', true], ['列表', false]]);
	await workbench.menus.select(application, () => more.click(), ['会话显示方式', '列表']);
	await expect(page.locator('.ash-chat-view-tabs')).toBeHidden();
	await expect(page.locator('.ash-chat-view-title-button')).toBeVisible();
});
