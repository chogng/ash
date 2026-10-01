import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchBrowser } from '../../../automation/playwrightBrowser.js';
import { expect, test } from '../../../automation/test.js';
import { Workbench } from '../../../automation/workbench.js';

const run = promisify(execFile);

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
	await page.getByRole('tab', { name: 'Git', exact: true }).click();
	const history = page.locator('[data-view-id="ash.gitGraph"]');
	await history.locator('.ash-pane-view-header').click();
	await expect(history.getByRole('treeitem', { name: /External baseline/ }).first()).toBeVisible();
	await run('git', ['branch', 'external-topic'], { cwd });
	await expect(history.getByText('external-topic', { exact: true })).toBeVisible();
	await run('git', ['tag', '-a', 'external-tag', '-m', 'External tag', '--'], { cwd, env: { ...process.env, GIT_COMMITTER_NAME: 'Ash Test', GIT_COMMITTER_EMAIL: 'ash@example.invalid' } });
	const tag = history.locator('.ash-scm-graph-label[title="external-tag"]');
	await expect(tag).toBeVisible();
	await expect(tag).toHaveAttribute('data-icon', 'tag');
	await run('git', ['pack-refs', '--all', '--prune'], { cwd });
	await run('git', ['branch', '-d', 'external-topic'], { cwd });
	await expect(history.getByText('external-topic', { exact: true })).toHaveCount(0);
	await run('git', ['tag', '-d', 'external-tag'], { cwd });
	await expect(tag).toHaveCount(0);
	expect((await run('git', ['status', '--porcelain'], { cwd })).stdout).toBe('');
	await rm(join(cwd, '.git'), { recursive: true });
	await expect(branch).toHaveCount(0);
});

test('External nested repository creation and deletion update the repository selector', async ({ testWorkspace, workbench }) => {
	const cwd = testWorkspace.directory;
	const page = workbench.page;
	await page.getByRole('tab', { name: 'Git', exact: true }).click();
	await expect(page.locator('[data-statusbar-item-id="ash.status.git.branch"]')).toHaveCount(0);
	await run('git', ['init', '-b', 'main'], { cwd });
	await expect(page.locator('[data-statusbar-item-id="ash.status.git.branch"]')).toContainText('main');
	const nested = join(cwd, 'external-nested');
	await mkdir(nested);
	await run('git', ['init', '-b', 'nested'], { cwd: nested });
	const selector = page.getByRole('combobox', { name: 'Active source control repository', exact: true });
	await expect(selector).toBeVisible();
	await expect(selector.locator('option')).toHaveCount(2);
	const nestedId = await selector.locator('option').filter({ hasText: 'external-nested' }).getAttribute('value');
	await selector.selectOption(nestedId!);
	await expect(page.locator('[data-statusbar-item-id="ash.status.git.branch"]')).toContainText('nested');
	await rm(nested, { recursive: true });
	await expect(selector).toBeHidden();
	await expect(page.locator('[data-statusbar-item-id="ash.status.git.branch"]')).toContainText('main');
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
		const launched = await launchBrowser(target);
		second = launched.driver.workbench.page;
		close = () => launched.application.close();
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
		const histories = [workbench.page, second].map(page => page.locator('[data-view-id="ash.gitGraph"]'));
		for (const [index, page] of [workbench.page, second].entries()) {
			await page.getByRole('tab', { name: 'Git', exact: true }).click();
			await histories[index]!.locator('.ash-pane-view-header').click();
			await expect(histories[index]!.getByRole('treeitem', { name: /Shared baseline/ }).first()).toBeVisible();
		}
		await run('git', ['branch', 'shared-topic'], { cwd });
		for (const history of histories) await expect(history.getByText('shared-topic', { exact: true })).toBeVisible();
		await run('git', ['branch', '-d', 'shared-topic'], { cwd });
		for (const history of histories) await expect(history.getByText('shared-topic', { exact: true })).toHaveCount(0);
	} finally {
		await close();
	}
});
