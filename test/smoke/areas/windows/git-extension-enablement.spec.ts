import { appendFile, cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import type { Workbench } from '../../../automation/workbench.js';

async function openGitDetails(workbench: Workbench) {
	await workbench.quickaccess.runCommand('ash.extensions.manageBuiltIn');
	await workbench.page.getByRole('searchbox', { name: 'Search Extensions', exact: true }).fill('ash.git');
	const extension = workbench.page.getByRole('listbox', { name: 'Extensions', exact: true }).locator('[data-package-id="ash.git"]');
	await extension.getByText('ash.git', { exact: true }).first().click();
	return workbench.page.locator('.ash-extension-editor:visible').filter({ hasText: 'ash.git' });
}

async function expectReadOnlyGit(workbench: Workbench, screenshotPath: string): Promise<void> {
	const details = await openGitDetails(workbench);
	await expect(details.getByRole('status')).toContainText('Enabled');
	await expect(details.getByRole('status')).toContainText('This connection cannot enable or disable backend providers.');
	await expect(details.getByRole('button', { name: 'Disable', exact: true })).toBeDisabled();
	const row = workbench.page.getByRole('listbox', { name: 'Extensions', exact: true }).locator('[data-package-id="ash.git"]');
	await expect(row.getByRole('button')).toHaveCount(0);
	await workbench.page.screenshot({ path: screenshotPath });
	await workbench.editors.groupAt(0).tabs.filter({ hasText: 'Independent comparison' }).click();
	await workbench.git.open();
}

async function toggleGit(workbench: Workbench, state: 'Enabled' | 'Disabled'): Promise<void> {
	const details = await openGitDetails(workbench);
	await expect(details).toContainText(state);
	await details.getByRole('switch').press('Space');
	await expect(details).toContainText(state === 'Enabled' ? 'Disabled' : 'Enabled');
	await workbench.editors.groupAt(0).tabs.filter({ hasText: 'Independent comparison' }).click();
	await workbench.git.open();
}

test.describe('Git extension enablement in the full product', () => {
	test.use({ gitRepository: true });

	for (const { reloadMode, canManageGit, tag } of [
		{ reloadMode: 'restart', canManageGit: true, tag: '@electron-app-server' },
		{ reloadMode: 'renderer reload', canManageGit: true, tag: '@electron-app-server' },
		{ reloadMode: 'restart', canManageGit: false, tag: '@browser-app-server' },
		{ reloadMode: 'renderer reload', canManageGit: false, tag: '@browser-app-server' },
	] as const) {
		const title = `${canManageGit ? 'disabled Git' : 'read-only Git management'} preserves independent SCM, editable diff, undo and saving through ${reloadMode}`;
		test(title, { tag: [tag] }, async ({ application, testWorkspace, workbench, reloadWorkbench }, testInfo) => {
			test.slow(); // Installs a provider, exercises editing, and restores two windows.
			// Exercise an admitted package through the public install flow. Merely exposing a
			// package in ASH_WEB_EXTENSION_PATHS does not authorize its scripts to execute.
			await cp(resolve(import.meta.dirname, '../../../fixtures/scm-extension'), join(testWorkspace.directory, 'scm-fixture'), { recursive: true });
			await appendFile(join(testWorkspace.directory, '.git/info/exclude'), '\n/scm-fixture/\n');
			await workbench.quickaccess.runCommand('ash.extensions.installLocal');
			const install = workbench.page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
			await install.getByRole('textbox').fill('scm-fixture');
			await workbench.dialogs.expectMessage(application, 'Information', () => install.getByRole('button', { name: 'Install', exact: true }).click());
			await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
			await workbench.page.getByRole('listbox', { name: 'Installed Extensions', exact: true }).locator('[data-package-id="ash-test/scm-fixture"]').click();
			const details = workbench.page.locator('.ash-extension-editor:visible').filter({ hasText: 'ash-test/scm-fixture' });
			await details.getByRole('switch').press('Space');
			await expect(details).toHaveAttribute('aria-busy', 'false');
			await expect(details.getByRole('switch')).toBeChecked();
			await workbench.dialogs.confirm(application, 'Independent SCM fixture', 'Grant permissions', () => details.getByRole('button', { name: 'Grant permissions', exact: true }).click());
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
			await expect(workbench.page.getByRole('button', { name: 'Open main.ts for Changes', exact: true })).toBeVisible();
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
			if (canManageGit) { await toggleGit(workbench, 'Enabled'); }
			else { await expectReadOnlyGit(workbench, testInfo.outputPath('git-read-only-details.png')); }
			if (canManageGit) { await expect(workbench.page.getByRole('button', { name: 'Open main.ts for Changes', exact: true })).toHaveCount(0); }
			else { await expect(workbench.page.locator('.ash-scm-repository-name')).toHaveCount(2); }
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
			await workbench.quickaccess.runCommand('ash.scm.fixture.openBinaryChanges');
			await expect(group.content).toContainText('Binary file changed. Text comparison is unavailable.');
			await expect(group.content.locator('.stanza-diff-editor:visible')).toHaveCount(0);
			await workbench.quickaccess.runCommand('ash.scm.fixture.openBinaryDiff');
			const binary = group.content.locator('.ash-binary-editor-content:visible');
			await expect(binary).toHaveCount(2);
			await expect(binary.nth(0)).toContainText('00 ff 01');
			await expect(binary.nth(1)).toContainText('00 fe 02');
			await expect.poll(() => readFile(testWorkspace.file, 'utf8')).toBe('const value = 3;\n');
			await group.tabs.filter({ hasText: 'Independent comparison' }).click();
			await workbench.page.screenshot({ path: testInfo.outputPath(canManageGit ? 'git-disabled-independent-scm.png' : 'git-read-only-independent-scm.png') });
			await reload();
			await workbench.git.open();
			if (canManageGit) {
				await expect(workbench.page.locator('.ash-scm-commit-form')).toBeHidden();
				await expect(workbench.page.getByRole('button', { name: 'Clone Repository', exact: true })).toHaveCount(0);
			}
			if (reloadMode === 'restart') {
				await expect(workbench.editors.groupAt(0).content.locator('.stanza-diff-editor:visible .modified .stanza-editor-line-text')).toContainText(['const value = 3;']);
			}
			await workbench.quickaccess.runCommand('ash.scm.fixture.activate');
			if (canManageGit) { await expect(workbench.page.getByRole('button', { name: 'Open main.ts for Changes', exact: true })).toHaveCount(0); }
			else { await expect(workbench.page.locator('.ash-scm-repository-name')).toHaveCount(2); }
			await expect(workbench.page.getByRole('button', { name: 'Open independent diff', exact: true })).toBeVisible();
			if (reloadMode === 'renderer reload') {
				// CDP reload bypasses the Desktop shutdown handshake; exercise editors again in the new realm.
				await workbench.page.getByRole('button', { name: 'Open independent diff', exact: true }).click();
				await expect(workbench.editors.groupAt(0).content.locator('.stanza-diff-editor:visible .modified .stanza-editor-line-text')).toContainText(['const value = 3;']);
			}
			if (canManageGit) { await toggleGit(workbench, 'Disabled'); }
			else { await expectReadOnlyGit(workbench, testInfo.outputPath('git-read-only-details-restored.png')); }
			await expect(workbench.page.locator('.ash-scm-repository-name')).toHaveCount(2);
			await reload();
			await workbench.git.open();
			await expect(workbench.page.getByRole('button', { name: 'Open main.ts for Changes', exact: true })).toBeVisible();
			await expect(workbench.page.locator('.ash-scm-input')).toBeVisible();
			await expect.poll(() => readFile(testWorkspace.file, 'utf8')).toBe('const value = 3;\n');
			await workbench.page.screenshot({ path: testInfo.outputPath('git-reenabled-after-reload.png') });
		});
	}
});
