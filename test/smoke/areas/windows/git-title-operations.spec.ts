import type { Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';

const run = promisify(execFile);
test.use({ gitRepository: true });
test.beforeEach(async ({ target }) => {
	test.skip(target.appServerMode !== 'required', 'Requires a connected Git workspace.');
});

test('Changes title commit submenu commits staged content and discard preserves untracked files and cancellation', async ({ application, workbench, testWorkspace }) => {
	const cwd = testWorkspace.directory;
	const git = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
	const page = workbench.page;
	await writeFile(testWorkspace.file, 'const value = 8;\n');
	await workbench.git.open();
	await expect(page.locator('.ash-scm-change')).toHaveCount(1);
	await workbench.git.selectTitleMenu(application, ['Changes', 'Stage All Changes']);
	await expect.poll(() => git('show', ':main.ts')).toBe('const value = 8;');
	// The backend index is updated before the response unlocks the commit input.
	await expect(page.getByRole('toolbar', { name: 'Source control actions', exact: true }).getByRole('button', { name: 'Commit Staged', exact: true })).toBeEnabled();
	const editor = page.locator('.ash-scm-input').getByRole('textbox', { name: /^Commit message/u });
	await editor.focus();
	await page.keyboard.insertText('Commit from submenu');
	await expect(page.locator('.ash-scm-input')).toContainText('Commit from submenu');
	await workbench.git.selectTitleMenu(application, ['Commit', 'Commit Staged']);
	await expect.poll(() => git('log', '-1', '--format=%s')).toBe('Commit from submenu');

	await writeFile(testWorkspace.file, 'const value = 9;\n');
	const untracked = join(cwd, 'keep-untracked.txt');
	await writeFile(untracked, 'keep this file\n');
	await expect(page.locator('.ash-scm-change')).toHaveCount(2);
	const cancelled = await workbench.dialogs.expectMessage(application, 'Confirm', () => workbench.git.selectTitleMenu(application, ['Changes', 'Discard All Changes…']));
	expect(cancelled.message).toContain('Discard changes in main.ts?');
	expect(await readFile(testWorkspace.file, 'utf8')).toBe('const value = 9;\n');
	await workbench.dialogs.confirm(application, 'Confirm', 'Confirm', () => workbench.git.selectTitleMenu(application, ['Changes', 'Discard All Changes…']));
	await expect.poll(() => readFile(testWorkspace.file, 'utf8')).toBe('const value = 8;\n');
	expect(await readFile(untracked, 'utf8')).toBe('keep this file\n');
	expect(await git('status', '--porcelain')).toBe('?? keep-untracked.txt');
});

test('Changes title stash menu includes untracked files, applies without dropping and deletes through confirmation', async ({ application, workbench, testWorkspace }) => {
	const cwd = testWorkspace.directory;
	const git = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
	const page = workbench.page;
	const untracked = join(cwd, 'stash-untracked.txt');
	await writeFile(testWorkspace.file, 'const value = 11;\n');
	await writeFile(untracked, 'stash this file\n');
	await workbench.git.selectTitleMenu(application, ['Stash', 'Stash Changes…']);
	await enter(page, 'title-stash-all');
	await choose(page, 'Tracked and untracked changes');
	await expect.poll(() => git('stash', 'list')).toContain('title-stash-all');
	expect(await git('status', '--porcelain')).toBe('');
	await workbench.git.selectTitleMenu(application, ['Stash', 'Apply Stash…']);
	await choose(page, 'title-stash-all');
	await expect.poll(() => readFile(testWorkspace.file, 'utf8')).toBe('const value = 11;\n');
	expect(await readFile(untracked, 'utf8')).toBe('stash this file\n');
	expect(await git('stash', 'list')).toContain('title-stash-all');
	await workbench.git.selectTitleMenu(application, ['Stash', 'Delete Stash…']);
	await workbench.dialogs.expectMessage(application, 'Confirm Git Operation', () => choose(page, 'title-stash-all'));
	expect(await git('stash', 'list')).toContain('title-stash-all');
	await workbench.git.selectTitleMenu(application, ['Stash', 'Delete Stash…']);
	await workbench.dialogs.confirm(application, 'Confirm Git Operation', 'Continue', () => choose(page, 'title-stash-all'));
	await expect.poll(() => git('stash', 'list')).toBe('');
	expect(await readFile(testWorkspace.file, 'utf8')).toBe('const value = 11;\n');
	expect(await readFile(untracked, 'utf8')).toBe('stash this file\n');
});

test('Changes title cherry-pick menu copies the selected commit onto the current branch', async ({ application, workbench, testWorkspace }) => {
	const cwd = testWorkspace.directory;
	const git = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
	const base = await git('rev-parse', 'HEAD');
	await git('switch', '-c', 'title-cherry');
	await writeFile(join(cwd, 'cherry.txt'), 'selected change\n');
	await git('add', 'cherry.txt');
	await git('commit', '-m', 'Title cherry-pick source');
	const sourceTree = await git('rev-parse', 'HEAD^{tree}');
	await git('switch', 'main');
	await workbench.git.selectTitleMenu(application, ['Branch', 'Cherry-Pick Commit…']);
	await choose(workbench.page, 'Title cherry-pick source');
	await expect.poll(() => git('log', '-1', '--format=%s')).toBe('Title cherry-pick source');
	expect(await git('rev-parse', 'HEAD^')).toBe(base);
	expect(await git('rev-parse', 'HEAD^{tree}')).toBe(sourceTree);
	expect(await git('branch', '--show-current')).toBe('main');
	expect(await readFile(join(cwd, 'cherry.txt'), 'utf8')).toBe('selected change\n');
});

test('Changes title remote menus fetch, pull, push and delete an actual remote branch', async ({ application, workbench, testWorkspace }) => {
	const cwd = testWorkspace.directory;
	const git = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
	// Local remotes live under .git so they stay inside the authorized workspace
	// and never become untracked changes or contact an external repository.
	const remote = join(cwd, '.git', 'title-remote.git');
	const writer = join(cwd, '.git', 'title-writer');
	await run('git', ['init', '--bare', '--initial-branch=main', remote]);
	await workbench.git.selectTitleMenu(application, ['Remote', 'Add Remote…']);
	await enter(workbench.page, 'origin');
	await enter(workbench.page, remote);
	await expect.poll(() => git('remote')).toContain('origin');
	expect(await git('remote', 'get-url', 'origin')).toBe(remote);
	await git('push', '-u', 'origin', 'main');
	await git('push', 'origin', 'HEAD:refs/heads/title-delete');
	await run('git', ['clone', remote, writer]);
	const remoteGit = async (...args: string[]) => (await run('git', args, { cwd: writer })).stdout.trim();
	await remoteGit('config', 'user.name', 'Ash Remote Test');
	await remoteGit('config', 'user.email', 'ash-remote@example.invalid');
	await remoteGit('config', 'commit.gpgsign', 'false');
	await writeFile(join(writer, 'remote.txt'), 'pulled from remote\n');
	await remoteGit('add', 'remote.txt');
	await remoteGit('commit', '-m', 'Remote title commit');
	await remoteGit('push', 'origin', 'main');
	const remoteHead = await remoteGit('rev-parse', 'HEAD');
	const previousHead = await git('rev-parse', 'HEAD');
	await workbench.git.selectTitleMenu(application, ['Fetch']);
	await expect.poll(() => git('rev-parse', 'refs/remotes/origin/main')).toBe(remoteHead);
	expect(await git('rev-parse', 'HEAD')).toBe(previousHead);
	await workbench.git.selectTitleMenu(application, ['Pull, Push', 'Pull']);
	await expect.poll(() => git('rev-parse', 'HEAD')).toBe(remoteHead);
	expect(await readFile(join(cwd, 'remote.txt'), 'utf8')).toBe('pulled from remote\n');
	await workbench.git.selectTitleMenu(application, ['Pull']);
	await workbench.git.selectTitleMenu(application, ['Pull, Push', 'Fetch']);

	await writeFile(testWorkspace.file, 'const value = 13;\n');
	await git('commit', '-am', 'Local title push');
	const localHead = await git('rev-parse', 'HEAD');
	await workbench.git.selectTitleMenu(application, ['Push']);
	const bareGit = async (...args: string[]) => (await run('git', args, { cwd: remote })).stdout.trim();
	await expect.poll(() => bareGit('rev-parse', 'refs/heads/main')).toBe(localHead);
	await workbench.git.selectTitleMenu(application, ['Pull, Push', 'Push']);
	await workbench.git.selectTitleMenu(application, ['Branch', 'Delete Remote Branch…']);
	await workbench.dialogs.confirm(application, 'Confirm Git Operation', 'Continue', () => choose(workbench.page, 'origin/title-delete'));
	await expect.poll(() => bareGit('branch', '--list', 'title-delete')).toBe('');
	expect(await git('branch', '--list', 'main')).toBe('* main');
});

test('Changes title clone menu creates a real desktop checkout and is disabled in the browser', async ({ application, target, workbench, testWorkspace }) => {
	await workbench.git.open();
	const toolbar = workbench.page.getByRole('toolbar', { name: 'Source control actions', exact: true });
	const menu = await workbench.menus.inspect(application, () => toolbar.getByRole('button', { name: 'More Actions', exact: true }).click());
	expect(menu.find(item => item.label === 'Clone')?.enabled).toBe(target.kind === 'electron');
	if (!('windows' in application)) return;
	const cwd = testWorkspace.directory;
	const remote = join(cwd, '.git', 'title-clone-source.git');
	const destination = join(cwd, '.git', 'title-clones');
	await mkdir(destination);
	await run('git', ['clone', '--bare', cwd, remote]);
	const original = await application.evaluateHandle(({ dialog }) => dialog.showOpenDialog);
	try {
		// OS folder selection is the only substituted boundary; clone and IPC stay real.
		await application.evaluate(({ dialog }, folder) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
		}, destination);
		await workbench.git.selectTitleMenu(application, ['Clone']);
		const input = workbench.page.getByRole('textbox', { name: 'Clone Repository', exact: true });
		await input.fill(remote);
		const result = await workbench.dialogs.expectMessage(application, 'Repository cloned', () => input.press('Enter'));
		const checkout = join(destination, 'title-clone-source');
		expect(result.message).toContain(await realpath(checkout));
		expect((await run('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout).toBe((await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout);
		expect(await readFile(join(checkout, 'main.ts'), 'utf8')).toBe('const value = 1;\n');
	} finally {
		await application.evaluate(({ dialog }, original) => { dialog.showOpenDialog = original; }, original);
		await original.dispose();
	}
});

async function enter(page: Page, value: string): Promise<void> {
	const input = page.getByRole('dialog', { name: 'Quick Input', exact: true }).getByRole('textbox');
	await input.fill(value);
	await input.press('Enter');
}
async function choose(page: Page, label: string): Promise<void> {
	const picker = page.locator('.ash-quick-pick');
	await picker.getByRole('combobox').fill(label);
	await picker.getByRole('option').filter({ hasText: label }).first().click();
}
