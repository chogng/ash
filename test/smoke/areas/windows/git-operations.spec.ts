import type { Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';

const run = promisify(execFile);

test.describe('Git repository operations', () => {
	test.use({ gitRepository: true });
	test.beforeEach(async ({ target }) => {
		test.skip(target.appServerMode !== 'required', 'Requires the Rust Git backend.');
	});

	test('Changes title menus rename branches, manage tags and remotes, stash, amend and undo', async ({ application, testWorkspace, workbench }) => {
		const cwd = testWorkspace.directory;
		const page = workbench.page;
		const git = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
		await git('branch', 'ui-rename');
		await workbench.git.selectTitleMenu(application, ['Branch', 'Rename Branch…']);
		await choose(page, 'ui-rename');
		await enter(page, 'ui-renamed');
		await expect.poll(() => git('branch', '--list', 'ui-renamed')).toBe('ui-renamed');

		await workbench.git.selectTitleMenu(application, ['Tags', 'Create Tag…']);
		await enter(page, 'ui-tag');
		await enter(page, 'HEAD');
		await expect.poll(() => git('tag', '--list', 'ui-tag')).toBe('ui-tag');
		await workbench.git.selectTitleMenu(application, ['Tags', 'Delete Tag…']);
		await workbench.dialogs.confirm(application, 'Confirm Git Operation', 'Continue', () => choose(page, 'ui-tag'));
		await expect.poll(() => git('tag', '--list', 'ui-tag')).toBe('');

		await workbench.git.selectTitleMenu(application, ['Remote', 'Add Remote…']);
		await enter(page, 'ui-backup');
		await enter(page, cwd);
		await expect.poll(() => git('remote')).toContain('ui-backup');
		await workbench.git.selectTitleMenu(application, ['Remote', 'Remove Remote…']);
		await workbench.dialogs.confirm(application, 'Confirm Git Operation', 'Continue', () => choose(page, 'ui-backup'));
		await expect.poll(() => git('remote')).not.toContain('ui-backup');

		await writeFile(testWorkspace.file, 'const value = 7;\n');
		await workbench.git.selectTitleMenu(application, ['Stash', 'Stash Changes…']);
		await enter(page, 'ui-stash');
		await choose(page, 'Tracked changes');
		await expect.poll(() => git('stash', 'list')).toContain('ui-stash');
		expect(await readFile(testWorkspace.file, 'utf8')).toBe('const value = 1;\n');
		await workbench.git.selectTitleMenu(application, ['Stash', 'Pop Stash…']);
		await choose(page, 'ui-stash');
		await expect.poll(() => git('stash', 'list')).toBe('');
		expect(await readFile(testWorkspace.file, 'utf8')).toBe('const value = 7;\n');

		await git('add', 'main.ts');
		await git('commit', '-m', 'Commit to amend');
		const parent = await git('rev-parse', 'HEAD^');
		await workbench.git.open();
		const input = page.locator('.ash-scm-input');
		const editor = input.getByRole('textbox', { name: /^Commit message/u });
		await editor.focus();
		await page.keyboard.insertText('UI amended commit\n\nComplete amended body.');
		await workbench.dialogs.confirm(application, 'Confirm Git Operation', 'Continue', () => workbench.git.selectTitleMenu(application, ['Commit', 'Amend Last Commit…']));
		await expect.poll(() => git('log', '-1', '--format=%s')).toBe('UI amended commit');
		await expect(input.locator('.stanza-editor-placeholder-text')).toBeVisible();
		await workbench.dialogs.confirm(application, 'Confirm Git Operation', 'Continue', () => workbench.git.selectTitleMenu(application, ['Commit', 'Undo Last Commit']));
		await expect.poll(() => git('rev-parse', 'HEAD')).toBe(parent);
		await expect(input.locator('.view-lines')).toContainText('UI amended commit');
		await expect(input.locator('.view-lines')).toContainText('Complete amended body.');
		expect(await git('show', ':main.ts')).toBe('const value = 7;');
		expect(await readFile(testWorkspace.file, 'utf8')).toBe('const value = 7;\n');
	});

	test('SCM commit scopes preserve partial staging, cancel without mutation and require untracked opt-in', async ({ application, testWorkspace, workbench }) => {
		const cwd = testWorkspace.directory;
		const page = workbench.page;
		const git = async (...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
		const initialHead = await git('rev-parse', 'HEAD');
		await writeFile(testWorkspace.file, 'const value = 2;\n');
		await git('add', 'main.ts');
		await writeFile(testWorkspace.file, 'const value = 3;\n');
		await writeFile(join(cwd, 'new.ts'), 'new file\n');
		await writeFile(join(cwd, '.git/info/exclude'), '*.ignored\n');
		await writeFile(join(cwd, 'secret.ignored'), 'ignored file\n');
		const initialIndex = await git('ls-files', '--stage');
		await workbench.git.open();
		const input = page.locator('.ash-scm-input');
		const editor = input.getByRole('textbox', { name: /^Commit message/u });
		const writeDraft = async (message: string) => {
			await editor.focus();
			await editor.press('ControlOrMeta+a');
			await page.keyboard.insertText(message);
		};
		await writeDraft('Staged subject');
		await workbench.git.selectTitleMenu(application, ['Commit', 'Commit All…']);
		await expect(page.locator('.ash-quick-pick').getByRole('option', { name: /^Tracked changes only/u })).toBeVisible();
		await expect(page.getByRole('toolbar', { name: 'Source control actions', exact: true }).getByRole('button', { name: 'Refresh', exact: true })).toBeDisabled();
		await page.keyboard.press('Escape');
		await expect(page.locator('.ash-quick-pick')).toBeHidden();
		expect(await git('rev-parse', 'HEAD')).toBe(initialHead);
		expect(await git('ls-files', '--stage')).toBe(initialIndex);
		await expect(input.locator('.view-lines')).toContainText('Staged subject');
		await workbench.git.selectTitleMenu(application, ['Commit', 'Commit Staged']);
		await expect.poll(() => git('log', '-1', '--format=%s')).toBe('Staged subject');
		expect(await git('show', 'HEAD:main.ts')).toBe('const value = 2;');
		expect(await readFile(testWorkspace.file, 'utf8')).toBe('const value = 3;\n');
		expect(await git('ls-files', 'new.ts')).toBe('');
		await expect(input.locator('.stanza-editor-placeholder-text')).toBeVisible();
		await writeDraft('Tracked signed subject');
		await workbench.git.selectTitleMenu(application, ['Commit', 'Commit All with Sign-off…']);
		await choose(page, 'Tracked changes only');
		await expect.poll(() => git('log', '-1', '--format=%s')).toBe('Tracked signed subject');
		expect(await git('show', 'HEAD:main.ts')).toBe('const value = 3;');
		expect(await git('log', '-1', '--format=%B')).toContain(`Signed-off-by: ${await git('config', 'user.name')} <${await git('config', 'user.email')}>`);
		expect(await git('ls-files', 'new.ts')).toBe('');
		await writeDraft('Include untracked subject');
		await workbench.git.selectTitleMenu(application, ['Commit', 'Commit All…']);
		await choose(page, 'Tracked and untracked changes');
		await expect.poll(() => git('log', '-1', '--format=%s')).toBe('Include untracked subject');
		expect(await git('show', 'HEAD:new.ts')).toBe('new file');
		expect(await git('ls-files', 'secret.ignored')).toBe('');
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

		await workbench.openExplorer();
		await page.locator('.ash-explorer').getByRole('treeitem', { name: /^main\.ts(?:,|$)/u }).dblclick();
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

	test('Changes title menu starts a merge, publishes conflicts and continues after resolution', async ({ application, testWorkspace, workbench }) => {
		const cwd = testWorkspace.directory;
		const page = workbench.page;
		await run('git', ['switch', '-c', 'ui-merge'], { cwd });
		await writeFile(testWorkspace.file, 'const value = 2;\n');
		await run('git', ['commit', '-am', 'Topic change'], { cwd });
		await run('git', ['switch', 'main'], { cwd });
		await writeFile(testWorkspace.file, 'const value = 3;\n');
		await run('git', ['commit', '-am', 'Main change'], { cwd });
		await workbench.git.selectTitleMenu(application, ['Branch', 'Merge Branch…']);
		await choose(page, 'ui-merge');
		await expect(page.getByRole('region', { name: 'Notifications' })).toContainText('Git stopped on conflicts.');
		await expect.poll(async () => (await run('git', ['ls-files', '--unmerged', 'main.ts'], { cwd })).stdout).not.toBe('');
		await writeFile(testWorkspace.file, 'const value = 4;\n');
		await run('git', ['add', 'main.ts'], { cwd });
		await workbench.git.selectTitleMenu(application, ['Branch', 'Continue Merge, Rebase or Cherry-Pick']);
		await expect.poll(async () => (await run('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], { cwd })).stdout.trim().split(/\s+/).length).toBe(3);
		expect(await readFile(testWorkspace.file, 'utf8')).toBe('const value = 4;\n');

		await run('git', ['switch', '-c', 'ui-rebase'], { cwd });
		await writeFile(testWorkspace.file, 'const value = 5;\n');
		await run('git', ['commit', '-am', 'Rebase topic'], { cwd });
		await run('git', ['switch', 'main'], { cwd });
		await writeFile(testWorkspace.file, 'const value = 6;\n');
		await run('git', ['commit', '-am', 'Rebase main'], { cwd });
		await workbench.git.selectTitleMenu(application, ['Branch', 'Rebase Branch…']);
		await choose(page, 'ui-rebase');
		await expect.poll(async () => (await run('git', ['ls-files', '--unmerged', 'main.ts'], { cwd })).stdout).not.toBe('');
		await workbench.dialogs.confirm(application, 'Confirm Git Operation', 'Continue', () => workbench.git.selectTitleMenu(application, ['Branch', 'Abort Merge, Rebase or Cherry-Pick']));
		await expect.poll(async () => (await run('git', ['ls-files', '--unmerged', 'main.ts'], { cwd })).stdout).toBe('');
		expect(await readFile(testWorkspace.file, 'utf8')).toBe('const value = 6;\n');
	});
});

test('Git initialization creates the authorized workspace repository and stages before the first commit', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires the Rust Git backend.');
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
