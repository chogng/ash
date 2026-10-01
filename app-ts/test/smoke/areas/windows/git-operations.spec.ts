import type { ElectronApplication, Page } from '@playwright/test';
import type { BrowserWindow, MessageBoxOptions } from 'electron';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';

const run = promisify(execFile);

test.describe('Git repository operations', () => {
	test.use({ gitRepository: false });
	test.beforeEach(async ({ target, testWorkspace }) => {
		test.skip(target.appServerMode !== 'required', 'Requires the Rust Git backend.');
		test.skip(target.kind === 'browser' && process.env.ASH_PLAYWRIGHT_GIT_REPOSITORY !== '1', 'Requires a Web Git workspace before startup.');
		const cwd = testWorkspace.directory;
		await run('git', ['init', '-b', 'main'], { cwd });
		await run('git', ['config', 'user.name', 'Ash Test'], { cwd });
		await run('git', ['config', 'user.email', 'ash-test@example.invalid'], { cwd });
		await run('git', ['config', 'commit.gpgsign', 'false'], { cwd });
		await run('git', ['add', '.'], { cwd });
		await run('git', ['commit', '--allow-empty', '-m', 'Git operations baseline'], { cwd });
	});

	test('Git repository operations rename branches, manage tags and remotes, stash, amend and undo', async ({ application, target, testWorkspace, workbench }) => {
		const cwd = testWorkspace.directory;
		const page = workbench.page;
		const git = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
		const electron = target.kind === 'electron' ? application as ElectronApplication : undefined;
		await installConfirmation(electron);
		try {
			await git('branch', 'ui-rename');
			await workbench.quickaccess.runCommand('git.renameBranch');
			await choose(page, 'ui-rename');
			await enter(page, 'ui-renamed');
			await expect.poll(() => git('branch', '--list', 'ui-renamed')).toBe('ui-renamed');

			await workbench.quickaccess.runCommand('git.createTag');
			await enter(page, 'ui-tag');
			await enter(page, 'HEAD');
			await expect.poll(() => git('tag', '--list', 'ui-tag')).toBe('ui-tag');
			await workbench.quickaccess.runCommand('git.deleteTag');
			await choose(page, 'ui-tag');
			await confirm(page, electron);
			await expect.poll(() => git('tag', '--list', 'ui-tag')).toBe('');

			await workbench.quickaccess.runCommand('git.addRemote');
			await enter(page, 'ui-backup');
			await enter(page, cwd);
			await expect.poll(() => git('remote')).toContain('ui-backup');
			await workbench.quickaccess.runCommand('git.removeRemote');
			await choose(page, 'ui-backup');
			await confirm(page, electron);
			await expect.poll(() => git('remote')).not.toContain('ui-backup');

			await writeFile(testWorkspace.file, 'const value = 7;\n');
			await workbench.quickaccess.runCommand('git.stash');
			await enter(page, 'ui-stash');
			await choose(page, 'Tracked changes');
			await expect.poll(() => git('stash', 'list')).toContain('ui-stash');
			expect(await readFile(testWorkspace.file, 'utf8')).toBe('const value = 1;\n');
			await workbench.quickaccess.runCommand('git.stashPop');
			await choose(page, 'ui-stash');
			await expect.poll(() => git('stash', 'list')).toBe('');
			expect(await readFile(testWorkspace.file, 'utf8')).toBe('const value = 7;\n');

			await git('add', 'main.ts');
			await git('commit', '-m', 'Commit to amend');
			const parent = await git('rev-parse', 'HEAD^');
			await workbench.quickaccess.runCommand('git.commitAmend');
			await enter(page, 'UI amended commit');
			await confirm(page, electron);
			await expect.poll(() => git('log', '-1', '--format=%s')).toBe('UI amended commit');
			await workbench.quickaccess.runCommand('git.undoCommit');
			await confirm(page, electron);
			await expect.poll(() => git('rev-parse', 'HEAD')).toBe(parent);
			expect(await git('show', ':main.ts')).toBe('const value = 7;');
			expect(await readFile(testWorkspace.file, 'utf8')).toBe('const value = 7;\n');
		} finally {
			await restoreConfirmation(electron);
		}
	});

	test('Git partial staging changes only the chosen block and selected editor line', async ({ testWorkspace, workbench }) => {
		const cwd = testWorkspace.directory;
		const page = workbench.page;
		const original = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
		const changed = original.replace('line 2\n', 'changed 2\n').replace('line 18\n', 'changed 18\n');
		await writeFile(testWorkspace.file, original);
		await run('git', ['add', 'main.ts'], { cwd });
		await run('git', ['commit', '-m', 'Partial staging baseline'], { cwd });
		await writeFile(testWorkspace.file, changed);
		const index = async () => (await run('git', ['show', ':main.ts'], { cwd })).stdout;

		await workbench.quickaccess.runCommand('git.stageHunk');
		await choose(page, 'main.ts');
		await page.locator('.ash-quick-pick').getByRole('option').first().click();
		await expect.poll(index).toBe(original.replace('line 2\n', 'changed 2\n'));
		expect(await readFile(testWorkspace.file, 'utf8')).toBe(changed);
		await workbench.quickaccess.runCommand('git.unstageHunk');
		await choose(page, 'main.ts');
		await page.locator('.ash-quick-pick').getByRole('option').first().click();
		await expect.poll(index).toBe(original);

		await page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
		const editor = workbench.editors.groupAt(0).editor;
		await editor.waitForEditorFocus();
		await editor.input.press('ControlOrMeta+Home');
		await editor.input.press('ArrowDown');
		await editor.input.press('Home');
		await editor.input.press('Shift+End');
		await workbench.quickaccess.runCommand('git.stageSelectedRanges');
		await expect.poll(index).toBe(original.replace('line 2\n', 'changed 2\n'));
		expect(await readFile(testWorkspace.file, 'utf8')).toBe(changed);
	});

	test('Git integration starts a merge, publishes conflicts and continues after resolution', async ({ application, target, testWorkspace, workbench }) => {
		const cwd = testWorkspace.directory;
		const page = workbench.page;
		await run('git', ['switch', '-c', 'ui-merge'], { cwd });
		await writeFile(testWorkspace.file, 'const value = 2;\n');
		await run('git', ['commit', '-am', 'Topic change'], { cwd });
		await run('git', ['switch', 'main'], { cwd });
		await writeFile(testWorkspace.file, 'const value = 3;\n');
		await run('git', ['commit', '-am', 'Main change'], { cwd });
		await workbench.quickaccess.runCommand('git.merge');
		await choose(page, 'ui-merge');
		await expect(page.getByRole('region', { name: 'Notifications' })).toContainText('Git stopped on conflicts.');
		await expect.poll(async () => (await run('git', ['ls-files', '--unmerged', 'main.ts'], { cwd })).stdout).not.toBe('');
		await writeFile(testWorkspace.file, 'const value = 4;\n');
		await run('git', ['add', 'main.ts'], { cwd });
		await workbench.quickaccess.runCommand('git.continue');
		await expect.poll(async () => (await run('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], { cwd })).stdout.trim().split(/\s+/).length).toBe(3);
		expect(await readFile(testWorkspace.file, 'utf8')).toBe('const value = 4;\n');

		await run('git', ['switch', '-c', 'ui-rebase'], { cwd });
		await writeFile(testWorkspace.file, 'const value = 5;\n');
		await run('git', ['commit', '-am', 'Rebase topic'], { cwd });
		await run('git', ['switch', 'main'], { cwd });
		await writeFile(testWorkspace.file, 'const value = 6;\n');
		await run('git', ['commit', '-am', 'Rebase main'], { cwd });
		await workbench.quickaccess.runCommand('git.rebase');
		await choose(page, 'ui-rebase');
		await expect.poll(async () => (await run('git', ['ls-files', '--unmerged', 'main.ts'], { cwd })).stdout).not.toBe('');
		const electron = target.kind === 'electron' ? application as ElectronApplication : undefined;
		await installConfirmation(electron);
		try {
			await workbench.quickaccess.runCommand('git.abort');
			await confirm(page, electron);
			await expect.poll(async () => (await run('git', ['ls-files', '--unmerged', 'main.ts'], { cwd })).stdout).toBe('');
			expect(await readFile(testWorkspace.file, 'utf8')).toBe('const value = 6;\n');
		} finally {
			await restoreConfirmation(electron);
		}
	});
});

test('Git initialization creates the authorized workspace repository and stages before the first commit', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires the Rust Git backend.');
	test.skip(target.kind === 'browser' && process.env.ASH_PLAYWRIGHT_GIT_REPOSITORY === '1', 'Initialization needs a workspace without Git.');
	const page = workbench.page;
	await workbench.quickaccess.runCommand('git.init');
	await page.locator('.ash-quick-pick').getByRole('option').first().click();
	await enter(page, 'review-main');
	await expect(page.getByRole('region', { name: 'Notifications' })).toContainText('Git repository initialized.');
	await expect.poll(async () => (await run('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: testWorkspace.directory })).stdout.trim()).toBe('review-main');
	const original = await readFile(testWorkspace.file, 'utf8');
	await workbench.quickaccess.runCommand('git.stageHunk');
	await choose(page, 'main.ts');
	await page.locator('.ash-quick-pick').getByRole('option').first().click();
	await expect(page.getByRole('region', { name: 'Notifications' })).toContainText('Selected changes updated in the index.');
	await expect.poll(async () => (await run('git', ['show', ':main.ts'], { cwd: testWorkspace.directory })).stdout).toBe(original);
	await workbench.quickaccess.runCommand('git.unstageHunk');
	await choose(page, 'main.ts');
	await page.locator('.ash-quick-pick').getByRole('option').first().click();
	await expect.poll(async () => (await run('git', ['ls-files', 'main.ts'], { cwd: testWorkspace.directory })).stdout).toBe('');
	expect(await readFile(testWorkspace.file, 'utf8')).toBe(original);
});

async function enter(page: Page, value: string): Promise<void> {
	const input = page.getByRole('dialog', { name: 'Quick Input', exact: true }).getByRole('textbox');
	await expect(input).toBeVisible();
	await input.fill(value);
	await input.press('Enter');
}
async function choose(page: Page, label: string): Promise<void> {
	const picker = page.locator('.ash-quick-pick');
	await expect(picker.getByRole('combobox')).toBeVisible();
	await picker.getByRole('combobox').fill(label);
	await picker.getByRole('option').filter({ hasText: label }).first().click();
}
async function confirm(page: Page, electron: ElectronApplication | undefined): Promise<void> {
	if (!electron) {
		await page.getByRole('dialog', { name: 'Confirm Git Operation', exact: true }).getByRole('button', { name: 'Continue', exact: true }).click();
	}
}
async function installConfirmation(electron: ElectronApplication | undefined): Promise<void> {
	if (!electron) { return; }
	await electron.evaluate(({ dialog }) => {
		const original = dialog.showMessageBox.bind(dialog);
		const state = globalThis as typeof globalThis & { ashGitOperationsRestore?: () => void };
		state.ashGitOperationsRestore = () => { dialog.showMessageBox = original; };
		dialog.showMessageBox = (async (...args: [MessageBoxOptions] | [BrowserWindow, MessageBoxOptions]) => {
			const options = args.length === 1 ? args[0] : args[1];
			return { response: options.buttons!.indexOf('Continue'), checkboxChecked: false };
		}) as typeof dialog.showMessageBox;
	});
}
async function restoreConfirmation(electron: ElectronApplication | undefined): Promise<void> {
	if (electron) { await electron.evaluate(() => (globalThis as typeof globalThis & { ashGitOperationsRestore?: () => void }).ashGitOperationsRestore?.()); }
}
