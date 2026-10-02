import type { ElectronApplication } from '@playwright/test';
import type { BrowserWindow, MessageBoxOptions } from 'electron';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';

const run = promisify(execFile);

test.use({ gitRepository: true });

test('Git branch command switches branches and the status bar opens the branch picker', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires a desktop App Server workspace.');

	const cwd = testWorkspace.directory;
	await run('git', ['branch', 'topic'], { cwd });

	const page = workbench.page;
	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('Git: Switch Branch');
	await page.keyboard.press('Enter');
	const picker = page.locator('.ash-quick-pick');
	await expect(picker.locator('.ash-quick-pick-row-label', { hasText: /^topic$/ })).toBeVisible();
	await picker.locator('.ash-quick-pick-row-label', { hasText: /^topic$/ }).click();
	await expect(page.locator('[data-statusbar-item-id="ash.status.git.branch"]')).toContainText('topic');
	expect((await run('git', ['branch', '--show-current'], { cwd })).stdout.trim()).toBe('topic');

	await page.locator('[data-statusbar-item-id="ash.status.git.branch"]').click();
	await expect(picker.locator('.ash-quick-pick-row-label', { hasText: /^main$/ })).toBeVisible();
});

test('Git branch command preserves local edits when Git rejects the switch', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires a desktop App Server workspace.');
	const cwd = testWorkspace.directory;
	await run('git', ['switch', '-c', 'topic'], { cwd });
	await writeFile(testWorkspace.file, 'const value = 2;\n');
	await run('git', ['add', 'main.ts'], { cwd });
	await run('git', ['-c', 'user.name=Ash Test', '-c', 'user.email=ash-test@example.invalid', 'commit', '-m', 'Topic'], { cwd });
	await run('git', ['switch', 'main'], { cwd });
	await writeFile(testWorkspace.file, 'const value = 3;\n');

	const page = workbench.page;
	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('Git: Switch Branch');
	await page.keyboard.press('Enter');
	const picker = page.locator('.ash-quick-pick');
	await expect(picker.locator('.ash-quick-pick-row-label', { hasText: /^topic$/ })).toBeVisible();
	await picker.locator('.ash-quick-pick-row-label', { hasText: /^topic$/ }).click();
	await expect(page.getByRole('region', { name: 'Notifications' }).getByRole('alert')).toContainText('Git rejected the switch. Check local changes and worktrees.');
	expect((await run('git', ['branch', '--show-current'], { cwd })).stdout.trim()).toBe('main');
	expect(await readFile(testWorkspace.file, 'utf8')).toBe('const value = 3;\n');
});

test.describe('Git branch lifecycle', () => {
	test.use({ gitRepository: false });
	test.beforeEach(async ({ target, testWorkspace }) => {
		test.skip(target.appServerMode !== 'required', 'Requires a connected Git workspace.');
		test.skip(target.kind === 'browser' && process.env.ASH_PLAYWRIGHT_GIT_REPOSITORY !== '1', 'Requires Web Git setup before startup.');
		const cwd = testWorkspace.directory;
		await run('git', ['init', '-b', 'main'], { cwd });
		await run('git', ['add', '.'], { cwd });
		await run('git', ['-c', 'user.name=Ash Test', '-c', 'user.email=ash-test@example.invalid', 'commit', '--allow-empty', '-m', 'Initial'], { cwd });
	});

	test('Git branch lifecycle creates at HEAD, updates history references and deletes through confirmation', async ({ application, target, testWorkspace, workbench }) => {
		const cwd = testWorkspace.directory;
		const page = workbench.page;
		await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
		const history = page.locator('[data-view-id="ash.gitGraph"]');
		await history.locator('.ash-pane-view-header').click();
		await expect(history.getByRole('treeitem', { name: /Initial/ }).first()).toBeVisible();

		await workbench.quickaccess.runCommand('git.branch');
		const input = page.getByRole('textbox', { name: 'Git: Create Branch', exact: true });
		await input.fill('ui-topic');
		await input.press('Enter');
		await expect.poll(async () => (await run('git', ['branch', '--list', 'ui-topic'], { cwd })).stdout.trim()).toBe('ui-topic');
		expect((await run('git', ['branch', '--show-current'], { cwd })).stdout.trim()).toBe('main');
		await expect(history.getByText('ui-topic', { exact: true })).toBeVisible();

		const electron = target.kind === 'electron' ? application as ElectronApplication : undefined;
		if (electron) {
			await electron.evaluate(({ dialog }) => {
				const original = dialog.showMessageBox.bind(dialog);
				const state = globalThis as typeof globalThis & { ashGitBranchDialogs?: { messages: MessageBoxOptions[]; restore: () => void } };
				state.ashGitBranchDialogs = { messages: [], restore: () => { dialog.showMessageBox = original; } };
				dialog.showMessageBox = (async (...args: [MessageBoxOptions] | [BrowserWindow, MessageBoxOptions]) => {
					const options = args.length === 1 ? args[0] : args[1];
					state.ashGitBranchDialogs!.messages.push(options);
					return { response: options.buttons!.indexOf('Delete Branch'), checkboxChecked: false };
				}) as typeof dialog.showMessageBox;
			});
		}
		try {
			await workbench.quickaccess.runCommand('git.deleteBranch');
			const picker = page.locator('.ash-quick-pick');
			await picker.getByRole('combobox').fill('ui-topic');
			await picker.getByRole('combobox').press('Enter');
			if (electron) {
				await expect.poll(() => electron.evaluate(() => (globalThis as typeof globalThis & { ashGitBranchDialogs?: { messages: MessageBoxOptions[] } }).ashGitBranchDialogs?.messages.map(message => message.title))).toEqual(['Git: Delete Branch']);
			} else {
				await page.getByRole('dialog', { name: 'Git: Delete Branch', exact: true }).getByRole('button', { name: 'Delete Branch', exact: true }).click();
			}
			await expect.poll(async () => (await run('git', ['branch', '--list', 'ui-topic'], { cwd })).stdout.trim()).toBe('');
			await expect(history.getByText('ui-topic', { exact: true })).toHaveCount(0);
		} finally {
			if (electron) { await electron.evaluate(() => (globalThis as typeof globalThis & { ashGitBranchDialogs?: { restore: () => void } }).ashGitBranchDialogs?.restore()); }
		}
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
