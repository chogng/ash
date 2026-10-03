import { expect, test } from '../../../automation/test.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { Editor } from '../../../automation/editor.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

test('Sessions review environment scans a draft, accepts entries, and excludes changed sources', async ({ application, target, workbench, testWorkspace }) => {
	test.skip(target.workbenchMode !== 'code');
	let page = workbench.page;
	if (target.kind === 'browser') {
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	} else {
		if (!('windows' in application)) { throw new Error('Expected Electron windows'); }
		const opened = application.waitForEvent('window');
		await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
		page = await opened;
	}
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Chat', exact: true }).click();
	const editor = new Editor(page.locator('.ash-sessions-chat-slot.active:visible'));
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('/permission auto');
	await editor.waitForEditorContents(text => text === '/permission auto');
	await page.keyboard.press('Enter');
	await expect(page.locator('.ash-sessions-chat-input').first().getByRole('button', { name: 'Permissions: Auto', exact: true })).toBeVisible();
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('/permission manual');
	await editor.waitForEditorContents(text => text === '/permission manual');
	await page.keyboard.press('Enter');
	const permissions = page.locator('.ash-sessions-chat-input').first().getByRole('button', { name: 'Permissions: Manual', exact: true });
	await permissions.press('ArrowDown');
	const menu = page.getByRole('menu', { name: 'Permissions', exact: true });
	const prepare = menu.getByRole('menuitem', { name: 'Prepare review environment…', exact: true });
	if (target.appServerMode === 'disabled') {
		await expect(prepare).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expect(permissions).toBeFocused();
		return;
	}
	const file = join(testWorkspace.directory, 'package.json');
	const original = '{"name":"review-fixture","scripts":{"build":"pnpm build"}}';
	await writeFile(file, original);
	await expect(prepare).toBeVisible();
	await prepare.click();
	const quick = new QuickAccess(page);
	await quick.select('Scan project…');
	await expect(quick.items.filter({ hasText: 'Include shell history executable names' })).toContainText('excludes arguments');
	await expect(quick.items.filter({ hasText: 'Include other repositories in the home directory' })).toContainText('excludes source code');
	// This fixture has no model connection. Explicitly choose direct extraction before scanning.
	await quick.select('Summarize with the current task model');
	await quick.select('Continue — generate draft');
	const entry = quick.items.filter({ has: page.locator('.ash-quick-pick-row-label').getByText('package.json', { exact: true }) });
	await expect(entry).toContainText('Pending review');
	await expect(entry).toContainText('pnpm build');
	await quick.select('package.json');
	await quick.select('Accept as project background');
	await expect(entry).toContainText('Accepted');
	await quick.select('Save accepted entries');
	await expect(quick.element).toBeHidden();
	expect(await readFile(file, 'utf8')).toBe(original);
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('/guardian setup');
	await editor.waitForEditorContents(text => text === '/guardian setup');
	await page.keyboard.press('Enter');
	await expect(entry).toContainText('Accepted');
	await quick.close();
	await writeFile(file, '{"name":"review-fixture","scripts":{"build":"cargo build"}}');
	await permissions.press('ArrowDown');
	await menu.getByRole('menuitem', { name: 'Prepare review environment…', exact: true }).click();
	await expect(entry.filter({ hasText: 'Source changed — excluded from review' })).toHaveCount(1);
	await expect(entry.filter({ hasText: 'Pending review' })).toContainText('cargo build');
	await expect(entry.filter({ hasText: 'Pending review' })).not.toContainText('Accepted');
	await quick.close();
});
