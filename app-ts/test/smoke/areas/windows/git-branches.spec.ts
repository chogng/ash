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
