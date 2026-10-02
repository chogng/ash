import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';

const run = promisify(execFile);

test.describe('SCM editor groups', () => {
	test.beforeEach(async ({ target, testWorkspace }) => {
		test.skip(target.appServerMode !== 'required', 'Requires a connected Git workspace.');
		test.skip(target.kind === 'browser' && process.env.ASH_PLAYWRIGHT_GIT_REPOSITORY !== '1', 'Requires a Web Git workspace before startup.');
		const cwd = testWorkspace.directory;
		await run('git', ['init', '-b', 'main'], { cwd });
		await run('git', ['add', '.'], { cwd });
		await run('git', ['-c', 'user.name=Ash Test', '-c', 'user.email=ash-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'SCM group baseline'], { cwd });
		await writeFile(testWorkspace.file, 'const value = 2;\n');
	});

	test('SCM side previews retain focus and reuse the side group for keyboard opens', async ({ testWorkspace, workbench }) => {
		const page = workbench.page;
		await page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
		const original = workbench.editors.groupAt(0);
		await expect(original.tabs.filter({ hasText: 'main.ts' })).toHaveCount(1);
		await original.editor.waitForEditorFocus();
		await page.getByRole('tab', { name: 'Git', exact: true }).click();
		const open = page.getByRole('button', { name: 'Open changes for main.ts', exact: true });
		await expect(open).toBeEnabled();
		await open.click({ modifiers: ['Alt'] });
		await expect(workbench.editors.groups).toHaveCount(2);
		const side = workbench.editors.groupAt(1);
		await expect(side.content.locator('.stanza-diff-editor')).toBeVisible();
		await expect(side.content).toContainText('const value = 2;');
		await expect(page.getByRole('tree', { name: 'Source control changes' })).toBeFocused();
		await writeFile(join(testWorkspace.directory, 'refresh.ts'), 'export const refreshed = true;\n');
		await expect(page.getByRole('button', { name: 'Open changes for refresh.ts', exact: true })).toBeVisible();
		await expect(page.getByRole('tree', { name: 'Source control changes' })).toBeFocused();
		await expect(original.content.locator('.stanza-diff-editor')).toHaveCount(0);
		await expect(original.tabs.filter({ hasText: 'main.ts' })).toHaveCount(1);

		await page.getByRole('tree', { name: 'Source control changes' }).press('Control+Enter');
		await expect(workbench.editors.groups).toHaveCount(2);
		await expect(side.tabs).toHaveCount(1);
		await expect.poll(() => side.content.evaluate(node => node.contains(document.activeElement))).toBe(true);
		await expect(original.content.locator('.stanza-diff-editor')).toHaveCount(0);
		await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
		await expect(original.tabs.filter({ hasText: 'main.ts' })).toHaveCount(1);
		await expect(original.content.locator('.stanza-diff-editor')).toHaveCount(0);
	});

	test('SCM Multi Diff splits keep collapse state and closing independent', async ({ workbench }) => {
		const page = workbench.page;
		await page.getByRole('tab', { name: 'Git', exact: true }).click();
		await page.getByRole('button', { name: 'View All Changes', exact: true }).click();
		const original = workbench.editors.groupAt(0);
		await expect(original.content.locator('.stanza-multi-diff-editor-section')).toHaveCount(1);
		await workbench.quickaccess.runCommand('workbench.action.splitEditorHorizontal');
		await expect(workbench.editors.groups).toHaveCount(2);
		const side = workbench.editors.groupAt(1);
		await expect(side.content.locator('.stanza-multi-diff-editor-section')).toHaveCount(1);
		await workbench.quickaccess.runCommand('multiDiffEditor.collapseAll');
		await expect(side.content.locator('.stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-expanded', 'false');
		await expect(original.content.locator('.stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-expanded', 'true');
		await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
		await expect(original.tabs.filter({ hasText: 'Changes' })).toHaveCount(1);
		await expect(original.content.locator('.stanza-multi-diff-editor-header-toggle')).toHaveAttribute('aria-expanded', 'true');
	});
});

test.describe('SCM merge editor groups', () => {
	test.use({ gitRepository: true, gitMergeConflict: true });

	test('SCM opens a merge editor to the side and preserves the original file', async ({ target, workbench }) => {
		test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires a desktop merge-conflict workspace.');
		const page = workbench.page;
		await page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
		const original = workbench.editors.groupAt(0);
		await expect(original.tabs.filter({ hasText: 'main.ts' })).toHaveCount(1);
		await original.editor.waitForEditorFocus();
		await page.getByRole('tab', { name: 'Git', exact: true }).click();
		const open = page.getByRole('button', { name: 'Open merge conflict in main.ts', exact: true });
		await expect(open).toBeEnabled();
		await open.focus();
		await open.press('Control+Enter');
		await expect(workbench.editors.groups).toHaveCount(2);
		const side = workbench.editors.groupAt(1);
		await expect(side.content.locator('.ash-merge-inputs')).toBeVisible();
		await expect(original.content.locator('.ash-merge-inputs')).toHaveCount(0);
		await expect(original.tabs.filter({ hasText: 'main.ts' })).toHaveCount(1);
		await expect.poll(() => side.content.evaluate(node => node.contains(document.activeElement))).toBe(true);
		await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
		await expect(original.tabs.filter({ hasText: 'main.ts' })).toHaveCount(1);
		await expect(original.content.locator('.ash-merge-inputs')).toHaveCount(0);
	});
});
