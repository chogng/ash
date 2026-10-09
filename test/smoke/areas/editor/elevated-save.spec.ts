import { expect, test } from '../../../automation/test.js';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('read-only save recovery preserves edits and overwrites with ordinary permissions', async ({ target, application, testWorkspace, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires real workspace IO');
	const name = 'permission-save.txt';
	const path = join(testWorkspace.directory, name);
	await writeFile(path, '\uFEFForiginal\r\n');
	await workbench.page.locator('.ash-explorer').getByRole('treeitem').filter({ has: workbench.page.getByText(name, { exact: true }) }).dblclick();
	const group = workbench.editors.groupAt(0);
	const input = group.content.getByRole('textbox', { name, exact: true });
	const tab = group.element.locator('.ash-tab').filter({ hasText: name });
	await input.press('ControlOrMeta+Home');
	await input.type('editor ');
	await expect(tab).toHaveAttribute('data-state', 'dirty');
	await chmod(path, 0o444);
	try {
		const message = await workbench.dialogs.expectMessage(application, 'Save a read-only file', () => input.press('ControlOrMeta+s'));
		expect(message.buttons).toContain('Overwrite');
		expect(message.buttons).toContain('Save As...');
		expect(message.buttons).toContain('Revert');
		expect(message.buttons).not.toContain('Retry with administrator permission');
		await expect(input).toBeFocused();
		await expect(tab).toHaveAttribute('data-state', 'dirty');
		await expect(group.editor.lines).toHaveText(['editor original', '']);
		expect(await readFile(path, 'utf8')).toBe('\uFEFForiginal\r\n');
		await workbench.dialogs.confirm(application, 'Save a read-only file', 'Overwrite', () => input.press('ControlOrMeta+s'));
		await expect.poll(() => readFile(path, 'utf8')).toBe('\uFEFFeditor original\r\n');
		await expect(tab).not.toHaveAttribute('data-state', /dirty|conflict/);
	} finally { await chmod(path, 0o644); }
});


test('system permission save failures require an explicit desktop authorization choice', async ({ target, application, testWorkspace, workbench }) => {
	test.skip(target.appServerMode !== 'required' || process.platform === 'win32', 'Requires real workspace IO and Unix directory modes');
	const directory = join(testWorkspace.directory, 'protected-save');
	const name = 'protected.txt';
	const path = join(directory, name);
	await mkdir(directory);
	await writeFile(path, 'original');
	const folder = workbench.page.locator('.ash-explorer').getByRole('treeitem', { name: 'protected-save', exact: true });
	await folder.locator('.ash-tree-twistie').click();
	await expect(folder).toHaveAttribute('aria-expanded', 'true');
	await workbench.page.locator('.ash-explorer').getByRole('treeitem').filter({ has: workbench.page.getByText(name, { exact: true }) }).dblclick();
	const group = workbench.editors.groupAt(0);
	const input = group.content.getByRole('textbox', { name, exact: true });
	const tab = group.element.locator('.ash-tab').filter({ hasText: name });
	await input.press('ControlOrMeta+Home');
	await input.type('editor ');
	await chmod(directory, 0o555);
	try {
		const title = target.kind === 'electron' ? 'Save with administrator permission' : 'Could not save file';
		const message = await workbench.dialogs.expectMessage(application, title, () => input.press('ControlOrMeta+s'));
		expect(message.buttons.includes('Retry with administrator permission')).toBe(target.kind === 'electron');
		expect(message.buttons).toContain('Save As...');
		expect(message.buttons).toContain('Revert');
		await expect(input).toBeFocused();
		await expect(tab).toHaveAttribute('data-state', 'dirty');
		expect(await readFile(path, 'utf8')).toBe('original');
	} finally { await chmod(directory, 0o755); }
});


for (const outcome of ['approve', 'cancel'] as const) {
	test(`real system authorization ${outcome} retains file permissions and editor state`, async ({ target, application, testWorkspace, workbench }) => {
		test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || process.env.ASH_TEST_SYSTEM_AUTHORIZATION !== outcome, 'Opt-in interactive system authorization acceptance');
		test.setTimeout(240_000);
		const directory = join(testWorkspace.directory, 'system-authorization');
		const name = 'system-authorization.txt';
		const path = join(directory, name);
		await mkdir(directory);
		await writeFile(path, '\uFEFForiginal\r\n');
		const folder = workbench.page.locator('.ash-explorer').getByRole('treeitem', { name: 'system-authorization', exact: true });
		await folder.locator('.ash-tree-twistie').click();
		await expect(folder).toHaveAttribute('aria-expanded', 'true');
		await workbench.page.locator('.ash-explorer').getByRole('treeitem').filter({ has: workbench.page.getByText(name, { exact: true }) }).dblclick();
		const group = workbench.editors.groupAt(0);
		const input = group.content.getByRole('textbox', { name, exact: true });
		const tab = group.element.locator('.ash-tab').filter({ hasText: name });
		await input.press('ControlOrMeta+Home');
		await input.type('editor ');
		const before = await stat(path);
		const run = promisify(execFile);
		const identity = process.platform === 'win32' ? (await run('whoami')).stdout.trim() : undefined;
		try {
			if (identity) {
				// Restrict writes to Administrators/System while preserving the owner's DACL recovery rights.
				await run('icacls', [directory, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)RX`, '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', '/T']);
			} else { await chmod(directory, 0o555); }
			const aclBefore = identity ? (await run('icacls', [path])).stdout : undefined;
			console.log(`In the upcoming SYSTEM authorization window, ${outcome === 'approve' ? 'authorize the save' : 'cancel authorization'}. Do not enter credentials in the test runner.`);
			await workbench.dialogs.confirm(application, 'Save with administrator permission', 'Retry with administrator permission', () => input.press('ControlOrMeta+s'));
			if (outcome === 'approve') {
				await expect.poll(() => readFile(path, 'utf8'), { timeout: 200_000 }).toBe('\uFEFFeditor original\r\n');
				await expect(tab).not.toHaveAttribute('data-state', /dirty|conflict/);
			} else {
				await workbench.dialogs.expectMessage(application, 'Could not save file', async () => { }, 200_000);
				await expect(tab).toHaveAttribute('data-state', 'dirty');
				await expect(group.editor.lines).toHaveText(['editor original', '']);
				expect(await readFile(path, 'utf8')).toBe('\uFEFForiginal\r\n');
			}
			const after = await stat(path);
			if (identity) { expect((await run('icacls', [path])).stdout).toBe(aclBefore); }
			else { expect([after.uid, after.gid, after.mode]).toEqual([before.uid, before.gid, before.mode]); }
			await expect(input).toBeFocused();
		} finally {
			if (identity) { await run('icacls', [directory, '/inheritance:e', '/grant:r', `${identity}:(OI)(CI)F`, '/T']); }
			else { await chmod(directory, 0o755); }
		}
	});
}
