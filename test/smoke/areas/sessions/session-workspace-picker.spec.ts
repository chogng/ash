import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';

const run = promisify(execFile);
test.use({ gitRepository: true, electronArgs: ['--agents-window'] });

test('Independent conversation workspace choices preserve drafts and defer worktree creation', { tag: ['@electron-app-server'] }, async ({ testWorkspace, workbench }, testInfo) => {
	test.setTimeout(120_000);
	const cwd = testWorkspace.directory;
	const checkout = join(cwd, '.git', 'picker-review');
	await run('git', ['worktree', 'add', '-b', 'picker-review', checkout, 'HEAD'], { cwd });
	const page = workbench.page;
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	const active = () => page.locator('.ash-sessions-chat-slot.active:visible .ash-chat:visible');
	const workspace = () => active().locator('.ash-sessions-workspace-picker');
	await expect(active()).toHaveAttribute('data-untitled-session-id', /.+/u);
	const id = (await active().getAttribute('data-untitled-session-id'))!;
	const editor = new Editor(active());
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('Keep this independent worktree draft');
	const worktree = page.getByRole('menuitemcheckbox', { name: 'New worktree', exact: true });
	await workspace().focus();
	await workspace().press('ArrowDown');
	await expect(worktree).toHaveAttribute('aria-checked', 'false');
	await worktree.click();
	await expect(worktree).toHaveAttribute('aria-checked', 'true');
	await page.keyboard.press('Escape');
	await expect(workspace()).toBeFocused();
	expect((await run('git', ['branch', '--list', 'ash/*'], { cwd })).stdout.trim()).toBe('');
	await page.locator('[data-action-id="sessions.newSession"] button').click();
	await expect(active()).not.toHaveAttribute('data-untitled-session-id', id);
	await workspace().click();
	await expect(worktree).toHaveAttribute('aria-checked', 'false');
	await page.getByRole('menuitem', { name: 'main', exact: true }).press('ArrowRight');
	await page.getByRole('menuitemradio', { name: 'picker-review', exact: true }).click();
	const trustDialog = page.getByRole('dialog', { name: 'Trust this workspace?', exact: true });
	const trustAndOpen = trustDialog.getByRole('button', { name: 'Trust and Open', exact: true });
	const cancel = trustDialog.getByRole('button', { name: 'Cancel', exact: true });
	await expect(cancel).toHaveCSS('border-radius', '8px');
	await expect(trustAndOpen).toHaveCSS('border-radius', '8px');
	const trustPath = trustDialog.locator('.ash-sessions-directory-permission-path');
	await expect(trustPath).toHaveText(checkout);
	await cancel.click();
	await expect(workspace()).toBeFocused();
	await expect(workspace()).toHaveText('Choose project');
	const retryTrust = page.locator('.ash-sessions-titlebar').getByRole('button', { name: `Retry trust for ${checkout}`, exact: true });
	await retryTrust.press('Enter');
	await expect(trustPath).toHaveText(checkout);
	await trustAndOpen.click();
	await expect(retryTrust).toHaveCount(0);
	await expect.poll(() => workspace().getAttribute('aria-label')).toContain(checkout);
	await page.locator(`.ash-sessions-list [data-item="untitled:${id}"] .ash-sessions-list-item`).click();
	await workspace().press('Enter');
	await expect(worktree).toHaveAttribute('aria-checked', 'true');
	await page.keyboard.press('Escape');
	await new Editor(active()).waitForEditorContents(text => text === 'Keep this independent worktree draft');
	await page.screenshot({ path: testInfo.outputPath('independent-worktree-draft.png') });
});

test('Clone Repository selects a real checkout for the initiating draft', { tag: ['@electron-app-server'] }, async ({ application, testWorkspace, workbench }, testInfo) => {
	if (!('windows' in application)) { throw new Error('Clone requires the desktop file dialog'); }
	const cwd = testWorkspace.directory;
	const remote = join(cwd, '.git', 'sessions-clone-source.git');
	const destination = join(cwd, '.git', 'sessions-clones');
	await mkdir(destination);
	await run('git', ['clone', '--bare', cwd, remote]);
	const original = await application.evaluateHandle(({ dialog }) => dialog.showOpenDialog);
	try {
		// Stub only the OS picker; the actual clone crosses the App Server boundary.
		await application.evaluate(({ dialog }, folder) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
		}, destination);
		const page = workbench.page;
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await page.locator('[data-action-id="sessions.newSession"] button').click();
		const active = page.locator('.ash-sessions-chat-slot.active:visible');
		const workspace = active.locator('.ash-sessions-workspace-picker');
		await new Editor(active).input.focus();
		await page.keyboard.press('ControlOrMeta+K');
		await page.keyboard.press('ControlOrMeta+F');
		await page.getByRole('menuitem').filter({ hasText: 'Clone Repository…' }).click();
		const input = page.getByRole('dialog', { name: 'Clone Repository…', exact: true }).getByRole('textbox');
		await input.fill(pathToFileURL(remote).href);
		await input.press('Enter');
		const checkout = join(destination, 'sessions-clone-source');
		const trustDialog = page.getByRole('dialog', { name: 'Trust this workspace?', exact: true });
		await expect(trustDialog.locator('.ash-sessions-directory-permission-path')).toHaveText(checkout);
		await trustDialog.getByRole('button', { name: 'Trust and Open', exact: true }).click();
		await expect(workspace).toHaveText('sessions-clone-source');
		expect((await run('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout).toBe((await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout);
		await page.screenshot({ path: testInfo.outputPath('sessions-cloned-workspace.png') });
		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect(workspace).toHaveText('sessions-clone-source');
		await page.locator('[data-action-id="sessions.newSession"] button').click();
		await expect(workspace).toHaveText('sessions-clone-source');
		await page.screenshot({ path: testInfo.outputPath('sessions-restored-workspace-new-draft.png') });
	} finally {
		await application.evaluate(({ dialog }, saved) => { dialog.showOpenDialog = saved; }, original);
		await original.dispose();
	}
});
