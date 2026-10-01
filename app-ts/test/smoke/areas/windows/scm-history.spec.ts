import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';

const run = promisify(execFile);

test.use({ gitRepository: true });

test('SCM history shows Git commits and opens a changed file', async ({ target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires a desktop App Server workspace.');

	const page = workbench.page;
	await page.getByRole('tab', { name: 'Git', exact: true }).click();
	const history = page.locator('[data-view-id="ash.gitGraph"]');
	await expect(history).toBeVisible();
	await history.locator('.ash-pane-view-header').click();
	const commit = history.getByRole('treeitem', { name: /Initial/ });
	await expect(commit).toBeVisible();
	await expect(commit).toHaveAttribute('aria-current', 'true');
	await commit.click();
	const changedFile = commit.getByRole('button', { name: /main\.ts/ });
	await expect(changedFile).toBeVisible();
	await changedFile.click();
	await expect(workbench.editors.groupAt(0).tabs.first()).toContainText('main.ts');
});

test('SCM history pane opens without a connected repository', async ({ target, workbench }) => {
	test.skip(target.kind === 'electron' && target.appServerMode === 'required', 'Checks disconnected Workbench hosts.');

	const page = workbench.page;
	await page.getByRole('tab', { name: 'Git', exact: true }).click();
	const changes = page.locator('[data-view-id="ash.gitView"]');
	await expect(changes.locator('.ash-scm-status')).toContainText('source control');
	await expect(changes.getByRole('tree', { name: 'Source control changes' })).toHaveCount(1);
	const history = page.locator('[data-view-id="ash.gitGraph"]');
	await expect(history).toBeVisible();
	await history.locator('.ash-pane-view-header').click();
	await expect(history.locator('.ash-scm-empty')).toContainText('No commits yet.');
});

test.describe('SCM folding', () => {
	test.use({ gitRepository: false });
	test.beforeEach(async ({ target, testWorkspace }) => {
		if (target.appServerMode !== 'required') { return; }
		test.skip(target.kind === 'browser' && process.env.ASH_PLAYWRIGHT_GIT_REPOSITORY !== '1', 'Requires Web Git setup before server startup (ASH_PLAYWRIGHT_GIT_REPOSITORY=1).');
		const cwd = testWorkspace.directory;
		await run('git', ['init', '-b', 'main'], { cwd });
		await run('git', ['add', 'main.ts'], { cwd });
		await run('git', ['-c', 'user.name=Ash Test', '-c', 'user.email=ash-test@example.invalid', 'commit', '-m', 'Initial'], { cwd });
		await writeFile(join(cwd, 'main.ts'), 'const value = 2;\n');
		await run('git', ['add', 'main.ts'], { cwd });
		await writeFile(join(cwd, 'main.ts'), 'const value = 3;\n');
	});

	test('SCM groups fold with pointer and keyboard input and retain state after Git refresh', async ({ target, testWorkspace, workbench }) => {
		test.skip(target.appServerMode !== 'required', 'Requires a connected Git workspace.');
		const page = workbench.page;
		const cwd = testWorkspace.directory;
		await page.getByRole('tab', { name: 'Git', exact: true }).click();
		const tree = page.getByRole('tree', { name: 'Source control changes' });
		const working = tree.getByRole('treeitem').filter({ has: page.locator('.ash-scm-section-label', { hasText: /^Changes$/ }) });
		const staged = tree.getByRole('treeitem').filter({ has: page.locator('.ash-scm-section-label', { hasText: /^Staged Changes$/ }) });
		const workingFile = tree.getByRole('button', { name: 'Open changes for main.ts', exact: true });
		const stagedFile = tree.getByRole('button', { name: 'Open staged changes for main.ts', exact: true });
		await expect(workingFile).toBeVisible();
		await expect(stagedFile).toBeVisible();
		await expect(working).toHaveAttribute('aria-expanded', 'true');
		await working.locator('.ash-scm-section-label').click();
		await expect(working).toHaveAttribute('aria-expanded', 'false');
		await expect(workingFile).toHaveCount(0);
		await expect(stagedFile).toBeVisible();
		const previousCount = Number(await working.locator('.ash-scm-section-count').textContent());
		await writeFile(join(cwd, 'refreshed.ts'), 'export const refreshed = true;\n');
		await expect(working.locator('.ash-scm-section-count')).toHaveText(String(previousCount + 1));
		await expect(working).toHaveAttribute('aria-expanded', 'false');
		await expect(workingFile).toHaveCount(0);
		await tree.focus();
		await page.keyboard.press('ArrowRight');
		await expect(working).toHaveAttribute('aria-expanded', 'true');
		await expect(workingFile).toBeVisible();
		await page.keyboard.press('ArrowLeft');
		await expect(working).toHaveAttribute('aria-expanded', 'false');
		await page.keyboard.press('Enter');
		await expect(working).toHaveAttribute('aria-expanded', 'true');
		await workingFile.click();
		await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'main.ts' })).toHaveCount(1);
		const fileRow = tree.getByRole('treeitem').filter({ has: page.getByRole('button', { name: 'Open changes for main.ts', exact: true }) });
		await fileRow.hover();
		await fileRow.getByRole('button', { name: 'Stage main.ts', exact: true }).click();
		await expect(workingFile).toHaveCount(0);
		await expect(working).toHaveAttribute('aria-expanded', 'true');
		await expect(staged).toHaveAttribute('aria-expanded', 'true');
		await staged.locator('.ash-tree-twistie').click();
		await expect(staged).toHaveAttribute('aria-expanded', 'false');
		await expect(stagedFile).toHaveCount(0);
		await expect(tree.getByRole('button', { name: 'Open changes for refreshed.ts', exact: true })).toBeVisible();
		for (const theme of ['Ash Light', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
			await workbench.quickaccess.runCommand('workbench.action.selectTheme');
			await page.locator('.ash-quick-pick').getByRole('combobox').fill(theme);
			await page.keyboard.press('Enter');
			await expect(page.locator('.ash-quick-pick')).toHaveCount(0);
			await staged.locator('.ash-scm-section-label').click();
			await expect(staged).toHaveAttribute('aria-expanded', 'true');
			await expect(stagedFile).toBeVisible();
			await expect(tree).toBeFocused();
			await page.keyboard.press('ArrowLeft');
			await page.keyboard.press('ArrowRight');
			await expect(staged).toHaveCSS('outline-style', 'solid');
			const bounds = await stagedFile.boundingBox();
			expect(bounds?.width).toBeGreaterThan(0);
			await staged.locator('.ash-tree-twistie').click();
			await expect(staged).toHaveAttribute('aria-expanded', 'false');
		}
	});
});
