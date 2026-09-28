import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';

const run = promisify(execFile);

test.use({ gitRepository: true, gitMergeConflict: true });

test('SCM opens a conflicted file for editing and stages the saved resolution', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires a desktop App Server workspace.');
	const page = workbench.page;
	await page.getByRole('tab', { name: 'Git', exact: true }).click();
	const open = page.getByRole('button', { name: 'Open merge conflict in main.ts' });
	await expect(open).toBeEnabled();
	await open.click();

	const group = workbench.editors.groupAt(0);
	await expect(group.tabs.first()).toContainText('main.ts');
	const input = group.content.locator('.stanza-editor-input');
	await expect(input).toBeAttached();
	await input.focus();
	await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
	await input.type('const resolved = true;\n');
	const stage = page.getByRole('button', { name: 'Stage main.ts' });
	await stage.click();
	await expect(page.locator('.ash-scm-status')).toHaveText('Save main.ts before staging its conflict resolution.');
	expect((await run('git', ['ls-files', '--unmerged', 'main.ts'], { cwd: testWorkspace.directory })).stdout.trim()).not.toBe('');
	await input.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
	await expect.poll(() => readFile(testWorkspace.file, 'utf8')).toBe('const resolved = true;\n');

	await stage.click();
	await expect.poll(async () => (await run('git', ['ls-files', '--unmerged', 'main.ts'], { cwd: testWorkspace.directory })).stdout).toBe('');
	await expect(page.getByRole('button', { name: 'Open merge conflict in main.ts' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Open staged changes for main.ts' })).toBeVisible();
	expect((await run('git', ['show', ':main.ts'], { cwd: testWorkspace.directory })).stdout).toBe('const resolved = true;\n');
});
