import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';

const run = promisify(execFile);
test.use({ gitRepository: true });
test.beforeEach(async ({ target, testWorkspace }) => {
	await writeFile(testWorkspace.file, 'const value = 2;\n');
});

test(
	'Changes title menus switch and retain view and sort choices through registered commands',
	{ tag: ['@browser-app-server', '@electron-app-server'] },
	async ({ application, workbench, testWorkspace }) => {
		await mkdir(join(testWorkspace.directory, 'a'), { recursive: true });
		await mkdir(join(testWorkspace.directory, 'b'), { recursive: true });
		await writeFile(join(testWorkspace.directory, 'a/z.ts'), 'export const z = 1;\n');
		await writeFile(join(testWorkspace.directory, 'b/a.ts'), 'export const a = 1;\n');
		const page = workbench.page;
		await workbench.git.open();
		const changes = page.locator('[data-view-id="ash.gitView"]');
		const toolbar = page.getByRole('toolbar', { name: 'Source control actions', exact: true });
		const open = async () => {
			await page.locator('[data-view-id="ash.gitView"] .ash-pane-view-header').hover();
			await expect(toolbar.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
			await page.locator('[data-view-id="ash.gitView"] .ash-pane-view-header').hover();
			await toolbar.getByRole('button', { name: 'More Actions', exact: true }).click();
		};
		await expect(changes.locator('.ash-scm-change')).toHaveCount(3);
		await expect(toolbar.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
		const sortTree = await workbench.menus.inspect(application, open, ['View & Sort']);
		expect(sortTree).toEqual(
			expect.arrayContaining([expect.objectContaining({ label: 'View as Tree', checked: true }), expect.objectContaining({ label: 'Sort Changes by Name', enabled: false })]),
		);
		await workbench.menus.select(application, open, ['View as List']);
		await expect(changes.locator('.ash-scm-folder')).toHaveCount(0);
		await workbench.menus.select(application, open, ['View & Sort', 'Sort Changes by Path']);
		await expect
			.poll(() => changes.locator('.ash-scm-change-open').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label'))))
			.toEqual(['Open a/z.ts for Changes', 'Open b/a.ts for Changes', 'Open main.ts for Changes']);
		await workbench.menus.select(application, open, ['View & Sort', 'Sort Changes by Status']);
		await expect
			.poll(() => changes.locator('.ash-scm-change-open').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label'))))
			.toEqual(['Open main.ts for Changes', 'Open a/z.ts for Changes', 'Open b/a.ts for Changes']);
		await workbench.menus.select(application, open, ['View & Sort', 'Sort Changes by Name']);
		await expect
			.poll(() => changes.locator('.ash-scm-change-open').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label'))))
			.toEqual(['Open b/a.ts for Changes', 'Open main.ts for Changes', 'Open a/z.ts for Changes']);
		expect(await workbench.menus.inspect(application, open, ['View & Sort'])).toEqual(
			expect.arrayContaining([expect.objectContaining({ label: 'View as List', checked: true }), expect.objectContaining({ label: 'Sort Changes by Name', checked: true, enabled: true })]),
		);
		await page.reload();
		await workbench.waitForReady();
		await workbench.git.open();
		await expect(changes.locator('.ash-scm-change')).toHaveCount(3);
		await expect(changes.locator('.ash-scm-folder')).toHaveCount(0);
		expect(await workbench.menus.inspect(application, open, ['View & Sort'])).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Sort Changes by Name', checked: true })]));
		await workbench.menus.select(application, open, ['View as Tree']);
		await expect(changes.locator('.ash-scm-folder')).toHaveCount(2);
		await changes.locator('.ash-pane-view-header').hover();
		await toolbar.getByRole('button', { name: 'Refresh', exact: true }).click();
		await workbench.menus.select(application, open, ['Branch', 'Create Branch…']);
		const input = page.getByRole('textbox', { name: 'Git: Create Branch', exact: true });
		await input.fill('title-menu-branch');
		await input.press('Enter');
		await expect.poll(async () => (await run('git', ['branch', '--list', 'title-menu-branch'], { cwd: testWorkspace.directory })).stdout.trim()).toBe('title-menu-branch');
	},
);

test('Changes title stages and unstages all changes and commits through the toolbar', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, workbench, testWorkspace }) => {
	const page = workbench.page;
	await workbench.git.open();
	const toolbar = page.getByRole('toolbar', { name: 'Source control actions', exact: true });
	const open = async () => {
		await page.locator('[data-view-id="ash.gitView"] .ash-pane-view-header').hover();
		await expect(toolbar.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
		await page.locator('[data-view-id="ash.gitView"] .ash-pane-view-header').hover();
		await toolbar.getByRole('button', { name: 'More Actions', exact: true }).click();
	};
	const commit = toolbar.getByRole('button', { name: 'Commit Staged', exact: true });
	await workbench.menus.select(application, open, ['Changes', 'Stage All Changes']);
	await expect.poll(async () => (await run('git', ['diff', '--cached', '--name-only'], { cwd: testWorkspace.directory })).stdout.trim()).toBe('main.ts');
	await expect(page.getByRole('button', { name: 'Open main.ts for Staged Changes', exact: true })).toBeVisible();
	await workbench.menus.select(application, open, ['Changes', 'Unstage All Changes']);
	await expect.poll(async () => (await run('git', ['diff', '--cached', '--name-only'], { cwd: testWorkspace.directory })).stdout.trim()).toBe('');
	await expect(page.getByRole('button', { name: 'Open main.ts for Changes', exact: true })).toBeVisible();
	await workbench.menus.select(application, open, ['Changes', 'Stage All Changes']);
	await expect(page.getByRole('button', { name: 'Open main.ts for Staged Changes', exact: true })).toBeVisible();
	const editor = page.locator('.ash-scm-input').getByRole('textbox', { name: /^Commit message/u });
	await editor.focus();
	await page.keyboard.insertText('Commit through Changes title');
	await page.locator('[data-view-id="ash.gitView"] .ash-pane-view-header').hover();
	await commit.click();
	await expect.poll(async () => (await run('git', ['log', '-1', '--format=%B'], { cwd: testWorkspace.directory })).stdout.trim()).toBe('Commit through Changes title');
	await expect(page.locator('.ash-scm-input .stanza-editor-placeholder-text')).toBeVisible();
});

test('Changes title registers Chinese menus and dispatches their actions', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, workbench, restartWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	({ application, workbench } = await restartWorkbench());
	const page = workbench.page;
	await workbench.git.open();
	const toolbar = page.getByRole('toolbar', { name: '源代码管理操作', exact: true });
	const open = async () => {
		await page.locator('[data-view-id="ash.gitView"] .ash-pane-view-header').hover();
		await expect(toolbar.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
		await page.locator('[data-view-id="ash.gitView"] .ash-pane-view-header').hover();
		await toolbar.getByRole('button', { name: '更多操作', exact: true }).click();
	};
	await workbench.menus.select(application, open, ['更改', '暂存所有更改']);
	await expect(page.getByRole('button', { name: '打开 暂存的更改 的main.ts', exact: true })).toBeVisible();
	await workbench.menus.select(application, open, ['以列表形式查看']);
	expect(await workbench.menus.inspect(application, open, ['视图和排序'])).toEqual(expect.arrayContaining([expect.objectContaining({ label: '以列表形式查看', checked: true })]));
});
