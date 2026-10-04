import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import { Workbench } from '../../../automation/workbench.js';

const run = promisify(execFile);

async function openHistoryGraph(page: Page): Promise<Locator> {
	const history = page.locator('[data-view-id="ash.gitGraph"]');
	if (!await history.isVisible()) await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
	const toggle = history.getByRole('button', { name: 'Graph', exact: true });
	// Windows in one browser profile share saved pane expansion state.
	if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	return history;
}

test.use({ gitRepository: false });
test.beforeEach(async ({ target, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Requires the connected Rust Git backend.');
	await rm(join(testWorkspace.directory, '.git'), { recursive: true, force: true });
});

test('External Git init and ref changes update status and history without a manual refresh', async ({ testWorkspace, workbench }) => {
	const cwd = testWorkspace.directory;
	const page = workbench.page;
	const branch = page.locator('[data-statusbar-item-id="ash.status.git.branch"]');
	await expect(branch).toHaveCount(0);
	await run('git', ['init', '-b', 'main'], { cwd });
	await expect(branch).toContainText('main');
	await run('git', ['add', '.'], { cwd });
	await run('git', ['-c', 'user.name=Ash Test', '-c', 'user.email=ash@example.invalid', 'commit', '-m', 'External baseline'], { cwd });
	const history = await openHistoryGraph(page);
	await expect(history.getByRole('treeitem', { name: /External baseline/ }).first()).toBeVisible();
	await run('git', ['branch', 'external-topic'], { cwd });
	await expect(history.getByRole('button', { name: 'external-topic', exact: true })).toBeVisible();
	await run('git', ['tag', '-a', 'external-tag', '-m', 'External tag', '--'], { cwd, env: { ...process.env, GIT_COMMITTER_NAME: 'Ash Test', GIT_COMMITTER_EMAIL: 'ash@example.invalid' } });
	const tag = history.getByRole('button', { name: 'external-tag', exact: true });
	await expect(tag).toBeVisible();
	await expect(tag).toHaveAttribute('data-icon', 'tag');
	await run('git', ['pack-refs', '--all', '--prune'], { cwd });
	await run('git', ['branch', '-d', 'external-topic'], { cwd });
	await expect(history.getByRole('button', { name: 'external-topic', exact: true })).toHaveCount(0);
	await run('git', ['tag', '-d', 'external-tag'], { cwd });
	await expect(tag).toHaveCount(0);
	expect((await run('git', ['status', '--porcelain'], { cwd })).stdout).toBe('');
	await rm(join(cwd, '.git'), { recursive: true });
	await expect(branch).toHaveCount(0);
});

test('External nested repository creation and deletion update Repositories, Changes, Graph and status', async ({ testWorkspace, workbench }) => {
	const cwd = testWorkspace.directory;
	const page = workbench.page;
	await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
	await expect(page.locator('[data-statusbar-item-id="ash.status.git.branch"]')).toHaveCount(0);
	await run('git', ['init', '-b', 'main'], { cwd });
	await expect(page.locator('[data-statusbar-item-id="ash.status.git.branch"]')).toContainText('main');
	await run('git', ['add', '.'], { cwd });
	const commit = ['-c', 'user.name=Ash Test', '-c', 'user.email=ash@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m'];
	await run('git', [...commit, 'Primary repository baseline'], { cwd });
	await expect(page.locator('[data-view-id="workbench.scm.repositories"]')).toBeHidden();
	const nested = join(cwd, 'external-nested');
	await mkdir(nested);
	await run('git', ['init', '-b', 'nested'], { cwd: nested });
	await writeFile(join(nested, 'nested-change.ts'), 'export const value = 1;\n');
	await run('git', ['add', '.'], { cwd: nested });
	await run('git', [...commit, 'Nested repository baseline'], { cwd: nested });
	await writeFile(join(nested, 'nested-change.ts'), 'export const value = 2;\n');
	const repositories = page.locator('[data-view-id="workbench.scm.repositories"]');
	const list = repositories.getByRole('listbox', { name: 'Source control repositories', exact: true });
	await expect(list).toBeVisible();
	await expect(list.getByRole('option')).toHaveCount(2);
	await expect(page.locator('.ash-scm').getByRole('combobox')).toHaveCount(0);
	await list.focus();
	await list.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/Selection updates Changes, Graph and the status bar/u);
	await page.keyboard.press('Escape');
	await expect(list).toBeFocused();
	await list.press('Alt+F2');
	const accessible = page.getByRole('dialog', { name: 'Accessible View', exact: true });
	await expect(accessible.getByRole('textbox')).toHaveValue(/external-nested/u);
	await page.keyboard.press('Escape');
	await expect(list).toBeFocused();
	await list.press('End');
	await expect(page.locator('[data-statusbar-item-id="ash.status.git.branch"]')).toContainText('main');
	await list.press('Enter');
	await expect(page.locator('[data-statusbar-item-id="ash.status.git.branch"]')).toContainText('nested');
	await expect(list.getByRole('option', { name: /external-nested, nested,/u })).toHaveAttribute('aria-selected', 'true');
	await expect(page.locator('.ash-scm').getByRole('button', { name: 'Open changes for nested-change.ts', exact: true })).toBeVisible();
	const history = await openHistoryGraph(page);
	await expect(history.getByRole('treeitem', { name: /Nested repository baseline/u })).toBeVisible();
	await expect(history.getByRole('treeitem', { name: /Primary repository baseline/u })).toHaveCount(0);
	await page.locator('[data-statusbar-item-id="ash.status.git.branch"]').click();
	await expect(page.locator('.ash-quick-pick').getByRole('combobox')).toBeVisible();
	await page.locator('.ash-quick-pick').getByRole('combobox').press('Escape');
	await rm(nested, { recursive: true });
	await expect(repositories).toBeHidden();
	await expect(page.locator('[data-statusbar-item-id="ash.status.git.branch"]')).toContainText('main');
	await expect(history.getByRole('treeitem', { name: /Primary repository baseline/u })).toBeVisible();
	await expect(page.locator('.ash-scm').getByRole('button', { name: 'Open changes for nested-change.ts', exact: true })).toHaveCount(0);
});

test('External Git refs refresh two Workbench windows sharing the backend', async ({ application, target, testWorkspace, workbench }) => {
	const cwd = testWorkspace.directory;
	await run('git', ['init', '-b', 'main'], { cwd });
	await run('git', ['add', '.'], { cwd });
	await run('git', ['-c', 'user.name=Ash Test', '-c', 'user.email=ash@example.invalid', 'commit', '-m', 'Shared baseline'], { cwd });
	await expect(workbench.page.locator('[data-statusbar-item-id="ash.status.git.branch"]')).toContainText('main');
	let second: Page;
	let close: () => Promise<void>;
	if (target.kind === 'browser') {
		// One application owns both windows, their authentication, and diagnostics.
		second = await workbench.page.context().newPage();
		close = () => second.close();
		await second.goto(workbench.page.url(), { waitUntil: 'domcontentloaded' });
	} else {
		const electron = application as ElectronApplication;
		const opened = electron.waitForEvent('window');
		await electron.evaluate(({ app }, folder) => {
			app.emit('second-instance', {}, [process.execPath, app.getAppPath(), '--new-window', '--folder', folder], process.cwd(), {});
		}, cwd);
		second = await opened;
		close = () => second.close();
	}
	try {
		await new Workbench(second).waitForReady();
		const histories: Locator[] = [];
		for (const page of [workbench.page, second]) {
			const history = await openHistoryGraph(page);
			histories.push(history);
			await expect(history.getByRole('treeitem', { name: /Shared baseline/ }).first()).toBeVisible();
		}
		await run('git', ['branch', 'shared-topic'], { cwd });
		for (const history of histories) await expect(history.getByRole('button', { name: 'shared-topic', exact: true })).toBeVisible();
		await run('git', ['branch', '-d', 'shared-topic'], { cwd });
		for (const history of histories) await expect(history.getByRole('button', { name: 'shared-topic', exact: true })).toHaveCount(0);
	} finally {
		await close();
	}
});
