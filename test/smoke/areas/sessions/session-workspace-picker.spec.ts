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
	await page.locator('[data-action-id="sessions.newSession"] button').click();
	const active = () => page.locator('.ash-sessions-chat-slot.active:visible .ash-chat:visible');
	const workspace = () => active().locator('.ash-sessions-workspace-picker');
	const id = await active().getAttribute('data-untitled-session-id');
	expect(id).toBeTruthy();
	const editor = new Editor(active());
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('Keep this independent worktree draft');
	await workspace().focus();
	await workspace().press('ArrowDown');
	await page.getByRole('menuitem', { name: 'New worktree…', exact: true }).click();
	const branch = page.getByRole('dialog', { name: 'New worktree…', exact: true }).getByRole('textbox');
	await branch.fill('review/independent');
	await branch.press('Enter');
	await expect(workspace()).toHaveText('Worktree · review/independent');
	await expect(workspace()).toBeFocused();
	expect((await run('git', ['branch', '--list', 'review/independent'], { cwd })).stdout.trim()).toBe('');
	await workspace().press('Enter');
	await page.getByRole('menuitem', { name: 'New worktree…', exact: true }).click();
	await branch.fill('discarded');
	await branch.press('Escape');
	await expect(workspace()).toHaveText('Worktree · review/independent');
	await expect(workspace()).toBeFocused();
	await page.locator('[data-action-id="sessions.newSession"] button').click();
	await expect(workspace()).not.toContainText('review/independent');
	await workspace().click();
	await page.getByRole('menuitemradio', { name: 'Worktree · picker-review', exact: true }).click({ timeout: 10_000 });
	await expect(workspace()).toHaveText('picker-review');
	await page.locator(`.ash-sessions-list [data-item="untitled:${id}"] .ash-sessions-list-item`).click();
	await expect(workspace()).toHaveText('Worktree · review/independent');
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
		await expect(workspace).toHaveText('sessions-clone-source');
		const checkout = join(destination, 'sessions-clone-source');
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
