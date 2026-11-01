import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { Editor } from '../../../automation/editor.js';

test('Agent settings share role management and Teams and restore the selected view', { tag: ['@electron-app-server', '@browser-app-server'] }, async ({ application, target, workbench, testWorkspace }, testInfo) => {
	const definitions = join(testWorkspace.directory, '.ash', 'agents');
	await mkdir(definitions, { recursive: true });
	await writeFile(join(definitions, 'team-checker.md'), '---\nname: team-checker\ndescription: Review synthetic changes\n---\n\nInspect the synthetic result.\n');
	let page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await expect(page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Agents', exact: true })).toHaveCount(0);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'New', exact: true }).click();
	const draft = 'Keep the draft while managing roles and teams';
	await new Editor(page.locator('.ash-sessions-chat-slot.active:visible')).waitForEditorFocus();
	await page.keyboard.insertText(draft);
	const openSettings = async () => {
		await new QuickAccess(page).runCommand('workbench.action.openSettings');
		const settings = page.getByRole('dialog', { name: 'Sessions Settings', exact: true });
		await settings.getByRole('button', { name: 'Agents', exact: true }).click();
		return settings.locator('.ash-sessions-agents');
	};
	let panel = await openSettings();
	await expect(panel.getByRole('tab')).toHaveText(['Roles', 'Teams']);
	await expect(panel.getByRole('heading', { name: 'Advisor', exact: true })).toHaveCount(1);
	const search = page.locator('.ash-sessions-settings-dialog').getByRole('searchbox');
	await search.fill('@id:chat.advisor');
	await expect(page.locator('.ash-sessions-settings-dialog [data-settings-item-id="chat.advisor"]')).toBeVisible();
	await search.fill('');
	await expect(panel.getByRole('tab', { name: 'Roles', exact: true })).toHaveAttribute('aria-selected', 'true');
	let role = panel.locator('.ash-agent-role').filter({ hasText: 'team-checker' });
	await role.locator('summary').click();
	await expect(role.getByText('Inspect the synthetic result.', { exact: true })).toBeVisible();
	const retainedRole = await role.elementHandle();
	await panel.getByRole('tab', { name: 'Roles', exact: true }).focus();
	await page.keyboard.press('ArrowRight');
	await expect(panel.getByRole('tab', { name: 'Teams', exact: true })).toBeFocused();
	await expect(panel.getByRole('tab', { name: 'Roles', exact: true })).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('Enter');
	await expect(panel.locator('.ash-agents-roles')).toBeHidden();
	await panel.getByRole('button', { name: 'New Team', exact: true }).click();
	for (const [name, value] of [
		['Team name', 'Synthetic review team'],
		['Team description', 'Review synthetic changes'],
		['Lead name', 'Casey'],
		['Lead responsibility', 'Check the result'],
	] as const) {
		const input = page.getByRole('dialog', { name, exact: true }).getByRole('textbox');
		await input.fill(value);
		await input.press('Enter');
	}
	await page.getByRole('option').filter({ has: page.getByText('team-checker', { exact: true }) }).click();
	await expect(panel.getByRole('heading', { name: 'Synthetic review team', exact: true })).toBeVisible();
	await expect(panel.locator('.ash-teams-member')).toContainText('Casey');
	await panel.getByRole('button', { name: 'View role', exact: true }).click();
	await expect(panel.getByRole('tab', { name: 'Roles', exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(role.locator('summary')).toBeFocused();
	expect(await role.evaluate((element, previous) => element === previous, retainedRole)).toBe(true);
	await page.locator('.ash-sessions-settings-dialog').screenshot({ path: testInfo.outputPath('agents-roles.png') });
	await panel.getByRole('tab', { name: 'Teams', exact: true }).click();
	await expect(panel.getByRole('heading', { name: 'Synthetic review team', exact: true })).toBeVisible();
	const post = panel.getByRole('button', { name: 'Post message', exact: true });
	await post.click();
	const message = page.getByRole('dialog', { name: 'Team message', exact: true }).getByRole('textbox');
	await message.fill('Keep this synthetic decision');
	await message.press('Enter');
	await expect(panel.getByText('Casey: Keep this synthetic decision', { exact: true })).toBeVisible();
	await post.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Roles and Teams share this Settings page/);
	await page.keyboard.press('Escape');
	await expect(post).toBeFocused();
	await page.keyboard.press('Alt+F2');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Keep this synthetic decision/);
	await page.keyboard.press('Escape');
	await page.locator('.ash-sessions-settings-dialog').screenshot({ path: testInfo.outputPath('agents-teams.png') });
	await page.keyboard.press('Escape');
	await expect(page.locator('.ash-sessions-settings-dialog')).toHaveCount(0);
	page = await workbench.reopenAgentsWindow(application, page);
	await new Editor(page.locator('.ash-sessions-chat-slot.active:visible')).waitForEditorContents(text => text === draft);
	panel = await openSettings();
	await expect(panel.getByRole('tab', { name: 'Teams', exact: true })).toHaveAttribute('aria-selected', 'true');
	await panel.getByRole('button', { name: 'Synthetic review team · 1', exact: true }).click();
	await expect(panel.getByText('Casey: Keep this synthetic decision', { exact: true })).toBeVisible();
	await panel.getByRole('button', { name: 'View role', exact: true }).click();
	role = panel.locator('.ash-agent-role').filter({ hasText: 'team-checker' });
	await expect(role.locator('summary')).toBeFocused();
	await new Editor(page.locator('.ash-sessions-chat-slot.active:visible')).waitForEditorContents(text => text === draft);
	await role.getByRole('button', { name: 'Edit definition', exact: true }).click();
	await expect(page.locator('[data-part="editor"]').getByRole('tab', { name: 'team-checker.md', exact: true })).toBeVisible();
});

test.describe('Agents Chinese interface', () => {
	test.use({ electronUserSettings: { 'workbench.locale': 'zh-CN' } });
	test('Agent settings localize both views in the Desktop window', { tag: ['@electron-app-server'] }, async ({ target, workbench }, testInfo) => {
		const page = await workbench.openAgentsWindow(target.kind);
		await new QuickAccess(page).runCommand('workbench.action.openSettings');
		const settings = page.getByRole('dialog', { name: '会话设置', exact: true });
		await settings.getByRole('button', { name: '智能体', exact: true }).click();
		const panel = settings.locator('.ash-sessions-agents');
		await expect(panel.getByRole('tab')).toHaveText(['角色', '团队']);
		await expect(panel.getByRole('button', { name: '刷新定义', exact: true })).toBeEnabled();
		await expect(panel.getByRole('heading', { name: '内置 Agent', exact: true })).toBeVisible();
		await panel.getByRole('tab', { name: '团队', exact: true }).click();
		await expect(panel.getByRole('button', { name: '新建团队', exact: true })).toBeVisible();
		await panel.getByRole('tab', { name: '团队', exact: true }).focus();
		await page.keyboard.press('Alt+F1');
		await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/“角色”和“团队”共用此设置页面/);
		await page.keyboard.press('Escape');
		await expect(panel.getByRole('tab', { name: '团队', exact: true })).toBeFocused();
		await page.locator('.ash-sessions-settings-dialog').screenshot({ path: testInfo.outputPath('agents-zh-CN.png') });
		await panel.getByRole('tab', { name: '角色', exact: true }).click();
		const quickAccess = workbench.quickaccess;
		for (const [label, id] of [['Ash Light', 'ash-light'], ['Ash Dark', 'ash-dark'], ['Ash High Contrast Dark', 'ash-high-contrast-dark'], ['Ash High Contrast Light', 'ash-high-contrast-light']] as const) {
			await quickAccess.runCommand('workbench.action.selectTheme');
			await quickAccess.select(label);
			await expect(page.locator('#app')).toHaveAttribute('data-color-theme', id);
			await expect(panel.getByRole('tab', { name: '角色', exact: true })).toHaveAttribute('aria-selected', 'true');
			await expect.poll(() => panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
			await page.locator('.ash-sessions-settings-dialog').screenshot({ path: testInfo.outputPath(`agents-${id}-zh-CN.png`) });
		}
		await page.setViewportSize({ width: 620, height: 860 });
		await expect.poll(() => panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
		await expect(panel.getByRole('tab', { name: '团队', exact: true })).toBeVisible();
		await page.locator('.ash-sessions-settings-dialog').screenshot({ path: testInfo.outputPath('agents-narrow-zh-CN.png') });
	});
});
