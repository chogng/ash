import type { ElectronApplication } from '@playwright/test';
import type { BrowserWindow, MessageBoxOptions } from 'electron';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';
import { parseWorkspace } from '../../../../src/ash/platform/workspace/common/workspace.js';

const run = promisify(execFile);

test.beforeEach(async ({ target, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Requires a connected Git workspace.');
	test.skip(target.kind === 'browser' && process.env.ASH_PLAYWRIGHT_GIT_REPOSITORY !== '1', 'Requires Web Git setup before startup.');
	const cwd = testWorkspace.directory;
	await run('git', ['init', '-b', 'main'], { cwd });
	await run('git', ['add', '.'], { cwd });
	await run('git', ['-c', 'user.name=Ash Test', '-c', 'user.email=ash-test@example.invalid', 'commit', '--allow-empty', '-m', 'Initial'], { cwd });
});

test('Git worktree lifecycle creates a detached checkout and protects local changes before deletion', async ({ application, target, testWorkspace, workbench }) => {
	const cwd = testWorkspace.directory;
	const page = workbench.page;
	const electron = target.kind === 'electron' ? application as ElectronApplication : undefined;
	if (electron) {
		await electron.evaluate(({ dialog }) => {
			const original = dialog.showMessageBox.bind(dialog);
			const state = globalThis as typeof globalThis & { ashGitWorktreeDialogs?: { messages: MessageBoxOptions[]; restore: () => void } };
			state.ashGitWorktreeDialogs = { messages: [], restore: () => { dialog.showMessageBox = original; } };
			dialog.showMessageBox = (async (...args: [MessageBoxOptions] | [BrowserWindow, MessageBoxOptions]) => {
				const options = args.length === 1 ? args[0] : args[1];
				state.ashGitWorktreeDialogs!.messages.push(options);
				return { response: options.buttons!.indexOf(options.title === 'Git: Open Worktree' ? 'Cancel' : 'Delete Worktree'), checkboxChecked: false };
			}) as typeof dialog.showMessageBox;
		});
	}
	let checkout: string | undefined;
	try {
		await workbench.quickaccess.runCommand('git.createWorktree');
		const input = page.getByRole('textbox', { name: 'Git: Create Worktree', exact: true });
		await input.fill('../escape');
		await input.press('Enter');
		await expect(page.getByText('Use 1–64 letters, numbers, hyphens or underscores.', { exact: true })).toBeVisible();
		await input.fill('ui-review');
		await input.press('Enter');
		if (electron) {
			await expect.poll(() => electron.evaluate(() => (globalThis as typeof globalThis & { ashGitWorktreeDialogs?: { messages: MessageBoxOptions[] } }).ashGitWorktreeDialogs?.messages.map(message => message.title))).toEqual(['Git: Open Worktree']);
		} else {
			const openDialog = page.getByRole('dialog', { name: 'Git: Open Worktree', exact: true });
			await expect(openDialog).toBeVisible();
			await openDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
		}
		const primary = await realpath(cwd);
		const paths = (await run('git', ['worktree', 'list', '--porcelain'], { cwd })).stdout.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length));
		checkout = paths.find(path => path !== primary)!;
		expect(checkout).toBeTruthy();
		expect((await run('git', ['branch', '--show-current'], { cwd: checkout })).stdout.trim()).toBe('');

		await writeFile(join(checkout, 'main.ts'), 'local edits\n');
		await workbench.quickaccess.runCommand('git.deleteWorktree');
		const picker = page.locator('.ash-quick-pick');
		await picker.getByRole('combobox').fill(checkout);
		await picker.getByRole('combobox').press('Enter');
		if (!electron) {
			await page.getByRole('dialog', { name: 'Git: Delete Worktree', exact: true }).getByRole('button', { name: 'Delete Worktree', exact: true }).click();
		}
		await expect(page.getByRole('region', { name: 'Notifications' }).getByRole('alert').filter({ hasText: 'Could not delete worktree' })).toContainText('Check local changes, locks and session ownership.');
		expect(await readFile(join(checkout, 'main.ts'), 'utf8')).toBe('local edits\n');

		await run('git', ['restore', '--worktree', 'main.ts'], { cwd: checkout });
		await workbench.quickaccess.runCommand('git.deleteWorktree');
		await picker.getByRole('combobox').fill(checkout);
		await picker.getByRole('combobox').press('Enter');
		if (!electron) {
			await page.getByRole('dialog', { name: 'Git: Delete Worktree', exact: true }).getByRole('button', { name: 'Delete Worktree', exact: true }).click();
		}
		await expect.poll(async () => (await run('git', ['worktree', 'list', '--porcelain'], { cwd })).stdout).not.toContain(checkout);
	} finally {
		if (electron) { await electron.evaluate(() => (globalThis as typeof globalThis & { ashGitWorktreeDialogs?: { restore: () => void } }).ashGitWorktreeDialogs?.restore()); }
		const inventory = (await run('git', ['worktree', 'list', '--porcelain'], { cwd })).stdout;
		if (checkout && inventory.includes(`worktree ${checkout}\n`)) { await run('git', ['worktree', 'remove', '--force', checkout], { cwd }); }
	}
});


test('Git open worktree uses the resolved folder for the desktop workspace', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron', 'Checks desktop workspace switching.');
	const cwd = testWorkspace.directory;
	const directory = await mkdtemp(join(tmpdir(), 'ash-git-open-'));
	const checkout = join(directory, 'checkout');
	await run('git', ['worktree', 'add', '--detach', checkout, 'HEAD'], { cwd });
	try {
		const page = workbench.page;
		await workbench.quickaccess.runCommand('git.openWorktree');
		const picker = page.locator('.ash-quick-pick');
		await picker.getByRole('combobox').fill(checkout);
		await picker.getByRole('combobox').press('Enter');
		const permission = page.getByRole('dialog', { name: 'Ash', exact: true });
		await expect(permission).toBeVisible();
		await permission.getByRole('button', { name: 'Open Read Only', exact: true }).click();
		await expect.poll(async () => {
			const workspace = await page.evaluate(() => {
				const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
				return ipc.invoke('ash:workspace:context:read');
			});
			return parseWorkspace(workspace).folders[0]?.uri.fsPath;
		}).toBe(await realpath(checkout));
		await expect(page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true })).toBeVisible();
	} finally {
		await run('git', ['worktree', 'remove', '--force', checkout], { cwd });
		await rm(directory, { recursive: true, force: true });
	}
});
