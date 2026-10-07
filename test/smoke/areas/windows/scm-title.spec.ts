import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Workbench } from '../../../automation/workbench.js';
import { expect, test } from '../../../automation/test.js';

const run = promisify(execFile);
async function openGit(workbench: Workbench): Promise<void> {
	const page = workbench.page;
	const tab = page.getByRole('tab', { name: /^Git(?:,|$)/u });
	if (await tab.getAttribute('aria-selected') !== 'true' || !await page.locator('[data-part="sidebar"]').isVisible()) await tab.click();
	await expect(page.locator('[data-view-id="ash.gitView"]')).toBeVisible();
}
test.use({ gitRepository: true });
test.beforeEach(async ({ target, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Requires a connected Git workspace.');
	await writeFile(testWorkspace.file, 'const value = 2;\n');
});

test('Changes title menus switch and retain view and sort choices through registered commands', async ({ application, workbench, testWorkspace }) => {
	await mkdir(join(testWorkspace.directory, 'a'), { recursive: true });
	await mkdir(join(testWorkspace.directory, 'b'), { recursive: true });
	await writeFile(join(testWorkspace.directory, 'a/z.ts'), 'export const z = 1;\n');
	await writeFile(join(testWorkspace.directory, 'b/a.ts'), 'export const a = 1;\n');
	const page = workbench.page;
	await openGit(workbench);
	const changes = page.locator('[data-view-id="ash.gitView"]');
	const toolbar = page.getByRole('toolbar', { name: 'Source control actions', exact: true });
	const open = () => toolbar.getByRole('button', { name: 'More Actions', exact: true }).click();
	await expect(changes.locator('.ash-scm-change')).toHaveCount(3);
	await expect(toolbar.getByRole('button', { name: 'Commit Staged', exact: true })).toBeDisabled();
	await expect(toolbar.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
	const items = await workbench.menus.inspect(application, open);
	expect(items.map(item => item.label)).toEqual(['View as List', 'View & Sort', 'Pull', 'Push', 'Clone', 'Checkout to…', 'Fetch', 'Commit', 'Changes', 'Pull, Push', 'Branch', 'Remote', 'Stash', 'Tags', 'Worktrees', 'Show Git Output']);
	const sortTree = await workbench.menus.inspect(application, open, ['View & Sort']);
	expect(sortTree).toEqual(expect.arrayContaining([
		expect.objectContaining({ label: 'View as Tree', checked: true }),
		expect.objectContaining({ label: 'Sort Changes by Name', enabled: false }),
	]));
	await workbench.menus.select(application, open, ['View as List']);
	await expect(changes.locator('.ash-scm-folder')).toHaveCount(0);
	await workbench.menus.select(application, open, ['View & Sort', 'Sort Changes by Path']);
	await expect.poll(() => changes.locator('.ash-scm-change-open').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))).toEqual(['Open changes for a/z.ts', 'Open changes for b/a.ts', 'Open changes for main.ts']);
	await workbench.menus.select(application, open, ['View & Sort', 'Sort Changes by Status']);
	await expect.poll(() => changes.locator('.ash-scm-change-open').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))).toEqual(['Open changes for main.ts', 'Open changes for a/z.ts', 'Open changes for b/a.ts']);
	await workbench.menus.select(application, open, ['View & Sort', 'Sort Changes by Name']);
	await expect.poll(() => changes.locator('.ash-scm-change-open').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))).toEqual(['Open changes for b/a.ts', 'Open changes for main.ts', 'Open changes for a/z.ts']);
	expect(await workbench.menus.inspect(application, open, ['View & Sort'])).toEqual(expect.arrayContaining([
		expect.objectContaining({ label: 'View as List', checked: true }),
		expect.objectContaining({ label: 'Sort Changes by Name', checked: true, enabled: true }),
	]));
	await page.reload();
	await workbench.waitForReady();
	await openGit(workbench);
	await expect(changes.locator('.ash-scm-change')).toHaveCount(3);
	await expect(changes.locator('.ash-scm-folder')).toHaveCount(0);
	expect(await workbench.menus.inspect(application, open, ['View & Sort'])).toEqual(expect.arrayContaining([
		expect.objectContaining({ label: 'Sort Changes by Name', checked: true }),
	]));
	await workbench.menus.select(application, open, ['View as Tree']);
	await expect(changes.locator('.ash-scm-folder')).toHaveCount(2);
	await toolbar.getByRole('button', { name: 'Refresh', exact: true }).click();
	await workbench.menus.select(application, open, ['Branch', 'Create Branch…']);
	const input = page.getByRole('textbox', { name: 'Git: Create Branch', exact: true });
	await input.fill('title-menu-branch');
	await input.press('Enter');
	await expect.poll(async () => (await run('git', ['branch', '--list', 'title-menu-branch'], { cwd: testWorkspace.directory })).stdout.trim()).toBe('title-menu-branch');
	await workbench.menus.select(application, open, ['Show Git Output']);
	await expect(page.locator('.ash-output')).toBeVisible();
	await expect(page.locator('.ash-output-title-actions')).toContainText('Git');
	await expect(page.locator('.ash-output')).toContainText('3 changed files');
});

test('Changes title stages and unstages all changes and commits through the toolbar', async ({ application, workbench, testWorkspace }) => {
	const page = workbench.page;
	await openGit(workbench);
	const toolbar = page.getByRole('toolbar', { name: 'Source control actions', exact: true });
	const open = () => toolbar.getByRole('button', { name: 'More Actions', exact: true }).click();
	const commit = toolbar.getByRole('button', { name: 'Commit Staged', exact: true });
	await expect(commit).toBeDisabled();
	await workbench.menus.select(application, open, ['Changes', 'Stage All Changes']);
	await expect.poll(async () => (await run('git', ['diff', '--cached', '--name-only'], { cwd: testWorkspace.directory })).stdout.trim()).toBe('main.ts');
	await expect(commit).toBeEnabled();
	await workbench.menus.select(application, open, ['Changes', 'Unstage All Changes']);
	await expect.poll(async () => (await run('git', ['diff', '--cached', '--name-only'], { cwd: testWorkspace.directory })).stdout.trim()).toBe('');
	await expect(commit).toBeDisabled();
	await workbench.menus.select(application, open, ['Changes', 'Stage All Changes']);
	await expect(commit).toBeEnabled();
	const editor = page.locator('.ash-scm-input').getByRole('textbox', { name: /^Commit message/u });
	await editor.focus();
	await page.keyboard.insertText('Commit through Changes title');
	await commit.click();
	await expect.poll(async () => (await run('git', ['log', '-1', '--format=%B'], { cwd: testWorkspace.directory })).stdout.trim()).toBe('Commit through Changes title');
	await expect(commit).toBeDisabled();
	await expect(page.locator('.ash-scm-input .stanza-editor-placeholder-text')).toBeVisible();
});

test('Changes title registers Chinese menus and dispatches their actions', async ({ application, workbench, restartWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	({ application, workbench } = await restartWorkbench());
	const page = workbench.page;
	await openGit(workbench);
	const toolbar = page.getByRole('toolbar', { name: '源代码管理操作', exact: true });
	const open = () => toolbar.getByRole('button', { name: '更多操作', exact: true }).click();
	expect((await workbench.menus.inspect(application, open)).map(item => item.label)).toEqual(['以列表形式查看', '视图和排序', '拉取', '推送', '克隆', '签出到…', '提取', '提交', '更改', '拉取、推送', '分支', '远端', '储藏', '标签', '工作树', '显示 Git 输出']);
	await workbench.menus.select(application, open, ['更改', '暂存所有更改']);
	await expect(toolbar.getByRole('button', { name: '提交暂存的更改', exact: true })).toBeEnabled();
	await workbench.menus.select(application, open, ['以列表形式查看']);
	expect(await workbench.menus.inspect(application, open, ['视图和排序'])).toEqual(expect.arrayContaining([
		expect.objectContaining({ label: '以列表形式查看', checked: true }),
	]));
});
