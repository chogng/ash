import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';

const run = promisify(execFile);

test.use({ gitRepository: true });

test('Git branch picker explains occupancy and switches after the other worktree is removed', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires a connected Git workspace.');
	const cwd = testWorkspace.directory;
	const linked = await mkdtemp(join(tmpdir(), 'ash-branch-worktree-'));
	try {
		await run('git', ['worktree', 'add', '-b', 'occupied', linked], { cwd });
		const page = workbench.page;
		const picker = page.locator('.ash-quick-pick');
		for (const command of ['git.switchBranch', 'git.deleteBranch']) {
			await workbench.quickaccess.runCommand(command);
			await picker.getByRole('combobox').fill('occupied');
			await expect(picker.getByRole('option', { name: 'occupied Checked out in another worktree', exact: true })).toBeVisible();
			await picker.getByRole('combobox').press('Enter');
			await expect(page.getByRole('region', { name: 'Notifications' }).getByRole('status').filter({ hasText: 'Branch occupied is checked out in another worktree.' }).last()).toBeVisible();
			await expect(picker).toHaveCount(0);
		}
		expect((await run('git', ['branch', '--show-current'], { cwd })).stdout.trim()).toBe('main');
		expect((await run('git', ['branch', '--format=%(refname:short)', '--list', 'occupied'], { cwd })).stdout.trim()).toBe('occupied');

		await run('git', ['worktree', 'remove', linked], { cwd });
		await workbench.quickaccess.runCommand('git.switchBranch');
		await picker.getByRole('combobox').fill('occupied');
		await expect(picker.getByRole('option', { name: 'occupied', exact: true })).toBeVisible();
		await picker.getByRole('combobox').press('Enter');
		await expect(page.locator('[data-statusbar-item-id="ash.status.git.branch"]')).toContainText('occupied');
		expect((await run('git', ['branch', '--show-current'], { cwd })).stdout.trim()).toBe('occupied');
	} finally {
		await rm(linked, { recursive: true, force: true });
		await run('git', ['worktree', 'prune'], { cwd });
	}
});

test('Git branch menu switches branches and the status bar opens the branch picker', async ({ application, target, testWorkspace, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires a connected Git workspace.');

	const cwd = testWorkspace.directory;
	await run('git', ['branch', 'topic'], { cwd });

	const page = workbench.page;
	await workbench.git.selectTitleMenu(application, ['Checkout to…']);
	const picker = page.locator('.ash-quick-pick');
	await expect(picker.locator('.ash-quick-pick-row-label', { hasText: /^topic$/ })).toBeVisible();
	await picker.locator('.ash-quick-pick-row-label', { hasText: /^topic$/ }).click();
	await expect(page.locator('[data-statusbar-item-id="ash.status.git.branch"]')).toContainText('topic');
	expect((await run('git', ['branch', '--show-current'], { cwd })).stdout.trim()).toBe('topic');

	await page.locator('[data-statusbar-item-id="ash.status.git.branch"]').click();
	await expect(picker.locator('.ash-quick-pick-row-label', { hasText: /^main$/ })).toBeVisible();
	await page.keyboard.press('Escape');
	await workbench.git.selectTitleMenu(application, ['Branch', 'Checkout to…']);
	await picker.locator('.ash-quick-pick-row-label', { hasText: /^main$/ }).click();
	await expect.poll(async () => (await run('git', ['branch', '--show-current'], { cwd })).stdout.trim()).toBe('main');
});

test('Git branch menu preserves local edits when Git rejects the switch', async ({ application, target, testWorkspace, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires a connected Git workspace.');
	const cwd = testWorkspace.directory;
	await run('git', ['switch', '-c', 'topic'], { cwd });
	await writeFile(testWorkspace.file, 'const value = 2;\n');
	await run('git', ['add', 'main.ts'], { cwd });
	await run('git', ['commit', '-m', 'Topic'], { cwd });
	await run('git', ['switch', 'main'], { cwd });
	await writeFile(testWorkspace.file, 'const value = 3;\n');

	const page = workbench.page;
	await workbench.git.selectTitleMenu(application, ['Branch', 'Checkout to…']);
	const picker = page.locator('.ash-quick-pick');
	await expect(picker.locator('.ash-quick-pick-row-label', { hasText: /^topic$/ })).toBeVisible();
	await picker.locator('.ash-quick-pick-row-label', { hasText: /^topic$/ }).click();
	await expect(page.getByRole('region', { name: 'Notifications' }).getByRole('alert')).toContainText('Git rejected the switch. Check local changes and worktrees.');
	expect((await run('git', ['branch', '--show-current'], { cwd })).stdout.trim()).toBe('main');
	expect(await readFile(testWorkspace.file, 'utf8')).toBe('const value = 3;\n');
});

test.describe('Git branch lifecycle', () => {
	test.beforeEach(async ({ target }) => {
		test.skip(target.appServerMode !== 'required', 'Requires a connected Git workspace.');
	});

	test('Changes title branch menu creates at HEAD, updates history references and deletes through confirmation', async ({ application, testWorkspace, workbench }) => {
		const cwd = testWorkspace.directory;
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const history = page.locator('[data-view-id="ash.gitGraph"]');
		await history.locator('.ash-pane-view-header').click();
		await expect(history.getByRole('treeitem', { name: /Initial/ }).first()).toBeVisible();

		await workbench.git.selectTitleMenu(application, ['Branch', 'Create Branch…']);
		const input = page.getByRole('textbox', { name: 'Git: Create Branch', exact: true });
		await input.fill('ui-topic');
		await input.press('Enter');
		await expect.poll(async () => (await run('git', ['branch', '--list', 'ui-topic'], { cwd })).stdout.trim()).toBe('ui-topic');
		expect((await run('git', ['branch', '--show-current'], { cwd })).stdout.trim()).toBe('main');
		await expect(history.getByRole('button', { name: /(?:^|, )ui-topic(?:, |$)/u })).toBeVisible();

		await workbench.git.selectTitleMenu(application, ['Branch', 'Delete Branch…']);
		const picker = page.locator('.ash-quick-pick');
		await picker.getByRole('combobox').fill('ui-topic');
		await workbench.dialogs.confirm(application, 'Git: Delete Branch', 'Delete Branch', () => picker.getByRole('combobox').press('Enter'));
		await expect.poll(async () => (await run('git', ['branch', '--list', 'ui-topic'], { cwd })).stdout.trim()).toBe('');
		await expect(history.getByRole('button', { name: /(?:^|, )ui-topic(?:, |$)/u })).toHaveCount(0);
	});
});


test('Git commands report an unavailable repository without opening an input when disconnected', async ({ target, workbench }) => {
	test.skip(target.appServerMode === 'required', 'Checks disconnected Workbench hosts.');
	const page = workbench.page;
	for (const [command, message] of [
		['git.stash', 'Git operation failed:'],
		['git.continue', 'Git operation failed:'],
		['git.stageHunk', 'Git operation failed:'],
		['git.init', 'Git operation failed:'],
		['git.branch', 'Could not create branch:'],
		['git.deleteBranch', 'Could not delete branch:'],
		['git.createWorktree', 'Could not create or open worktree:'],
		['git.openWorktree', 'Could not open worktree:'],
		['git.deleteWorktree', 'Could not delete worktree:'],
	]) {
		await workbench.quickaccess.runCommand(command!);
		await expect(page.getByRole('region', { name: 'Notifications' }).getByRole('alert').filter({ hasText: message! }).last()).toBeVisible();
		await expect(page.locator('.ash-quick-pick')).toHaveCount(0);
		await expect(page.getByRole('dialog', { name: 'Quick Input', exact: true })).toHaveCount(0);
	}
});
