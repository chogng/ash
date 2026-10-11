import { readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '../../../automation/test.js';
import type { Workbench } from '../../../automation/workbench.js';

async function toggleGit(workbench: Workbench, state: 'Enabled' | 'Disabled'): Promise<void> {
	await workbench.quickaccess.runCommand('ash.extensions.manageBuiltIn');
	const option = workbench.quickaccess.items.filter({ has: workbench.page.locator('.ash-quick-pick-row-label').getByText('ash.git', { exact: true }) });
	await expect(option).toContainText(state);
	await option.click();
	await expect(workbench.quickaccess.element).toBeHidden();
}

test.describe('Git extension enablement in the full product', () => {
	test.use({ gitRepository: true });

	for (const reloadMode of ['restart', 'renderer reload'] as const) {
		test(`disabled Git preserves independent SCM, editable diff, undo and saving through enablement and ${reloadMode}`, async ({ target, testWorkspace, workbench, reloadWorkbench }, testInfo) => {
			test.skip(target.appServerMode !== 'required', 'Requires the real Git backend.');
			test.skip(!process.env.ASH_WEB_EXTENSION_PATHS?.includes('scm-extension'), 'Requires the independent SCM extension fixture.');
			const reload = async (): Promise<void> => {
				if (reloadMode === 'restart') {
					({ workbench } = await reloadWorkbench());
				} else {
					await workbench.reloadWindow();
					await workbench.waitForReady();
				}
			};
			await writeFile(testWorkspace.file, 'const value = 2;\n');
			await workbench.git.open();
			try { await expect(workbench.page.locator('.ash-scm-input')).toBeVisible(); }
			catch (error) {
				await workbench.quickaccess.runCommand('workbench.action.output.showChannels');
				await workbench.quickaccess.select('ash.git (Extension Host)');
				const log = await workbench.page.locator('[data-view-id="ash.output"] .view-lines').innerText();
				await testInfo.attach('Git activation log', { body: log, contentType: 'text/plain' });
				throw new Error(log, { cause: error });
			}
			await expect(workbench.page.getByRole('button', { name: 'Open Changes for main.ts', exact: true })).toBeVisible();
			await workbench.quickaccess.runCommand('ash.scm.fixture.activate');
			const changes = workbench.page.locator('[data-view-id="ash.gitView"]');
			await expect(changes.locator('.stanza-editor-placeholder-text')).toHaveText('Independent message');
			await changes.getByRole('button', { name: 'Open independent diff', exact: true }).click();
			const group = workbench.editors.groupAt(0);
			const diff = group.content.locator('.stanza-diff-editor:visible');
			const modified = diff.locator('.modified .stanza-editor-input');
			const lines = diff.locator('.modified .stanza-editor-line-text');
			await expect(diff.locator('.original .stanza-editor-line-text')).toContainText(['const value = 1;']);
			await expect(lines).toContainText(['const value = 2;']);
			await modified.focus();
			await modified.press('ControlOrMeta+a');
			await workbench.page.keyboard.insertText('const value = 3;\n');
			await expect(group.tabs.filter({ hasText: 'Independent comparison' })).toHaveAttribute('aria-label', /unsaved/u);
			await toggleGit(workbench, 'Enabled');
			await expect(workbench.page.getByRole('button', { name: 'Open Changes for main.ts', exact: true })).toHaveCount(0);
			await expect(workbench.page.getByRole('button', { name: 'Open independent diff', exact: true })).toBeVisible();
			await expect(changes.locator('.stanza-editor-placeholder-text')).toHaveText('Independent message');
			await expect(diff).toBeVisible();
			await modified.focus();
			await modified.press('ControlOrMeta+z');
			await expect(lines).toContainText(['const value = 2;']);
			await modified.press('ControlOrMeta+Shift+z');
			await expect(lines).toContainText(['const value = 3;']);
			await modified.press('ControlOrMeta+s');
			await expect.poll(() => readFile(testWorkspace.file, 'utf8')).toBe('const value = 3;\n');
			await expect(group.tabs.filter({ hasText: 'Independent comparison' })).not.toHaveAttribute('aria-label', /unsaved/u);
			await workbench.quickaccess.runCommand('ash.scm.fixture.refresh');
			await expect(changes).toContainText('Independent refresh 1');
			const message = changes.locator('.ash-scm-input .stanza-editor-input');
			await message.focus();
			await workbench.page.keyboard.insertText('kept without Git');
			await changes.getByRole('button', { name: 'Record', exact: true }).click();
			await expect(changes).toContainText('Recorded: kept without Git');
			await workbench.page.screenshot({ path: testInfo.outputPath('git-disabled-independent-scm.png') });
			await reload();
			await workbench.git.open();
			await expect(workbench.page.locator('.ash-scm-commit-form')).toBeHidden();
			await expect(workbench.page.getByRole('button', { name: 'Clone Repository', exact: true })).toHaveCount(0);
			await expect(workbench.editors.groupAt(0).content.locator('.stanza-diff-editor:visible .modified .stanza-editor-line-text')).toContainText(['const value = 3;']);
			await workbench.quickaccess.runCommand('ash.scm.fixture.activate');
			await expect(workbench.page.getByRole('button', { name: 'Open Changes for main.ts', exact: true })).toHaveCount(0);
			await expect(workbench.page.getByRole('button', { name: 'Open independent diff', exact: true })).toBeVisible();
			await toggleGit(workbench, 'Disabled');
			await expect(workbench.page.locator('.ash-scm-repository-name')).toHaveCount(2);
			await reload();
			await workbench.git.open();
			await expect(workbench.page.getByRole('button', { name: 'Open Changes for main.ts', exact: true })).toBeVisible();
			await expect(workbench.page.locator('.ash-scm-input')).toBeVisible();
			await expect.poll(() => readFile(testWorkspace.file, 'utf8')).toBe('const value = 3;\n');
			await workbench.page.screenshot({ path: testInfo.outputPath('git-reenabled-after-reload.png') });
		});
	}
});
