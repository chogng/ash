import { expect, test } from '../../../automation/test.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { Editor } from '../../../automation/editor.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

test('Guardian setup shares reviewed project background between IDE Chat and Agents without sending', { tag: ['@electron-app-server', '@browser-app-server'] }, async ({ target, workbench, testWorkspace }) => {
	let page = workbench.page;
	const file = join(testWorkspace.directory, 'package.json');
	const original = '{"name":"review-fixture","scripts":{"build":"pnpm build"}}';
	await writeFile(file, original);
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	for (const surface of ['IDE', 'Agents']) {
		if (surface === 'Agents') {
			page = await workbench.openAgentsWindow(target.kind);
			await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		}
		const chat = page.locator(surface === 'IDE' ? '.ash-chat-view-pane .ash-chat:visible' : '.ash-sessions-chat-slot.active:visible');
		const editor = new Editor(chat);
		await editor.waitForEditorFocus();
		await page.keyboard.insertText('/guardian setup');
		await editor.waitForEditorContents(text => text === '/guardian setup');
		await page.keyboard.press('Enter');
		const quick = new QuickAccess(page);
		await expect(quick.items.filter({ has: page.locator('.ash-quick-pick-row-label').getByText('Scan project…', { exact: true }) })).toBeVisible();
		await expect(quick.input).toHaveAttribute('placeholder', /^Review environment: /u);
		const entry = quick.items.filter({ has: page.locator('.ash-quick-pick-row-label').getByText('package.json', { exact: true }) });
		if (surface === 'IDE') {
			await quick.select('Scan project…');
			await quick.select('Summarize with the current task model');
			await quick.select('Continue — generate draft');
			await expect(entry).toContainText('Pending review');
			await expect(entry).toContainText('pnpm build');
			await quick.select('package.json');
			await quick.select('Accept as project background');
			await quick.select('Save accepted entries');
			await expect(quick.element).toBeHidden();
			expect(await readFile(file, 'utf8')).toBe(original);
		} else {
			await expect(entry).toContainText('Accepted');
			await quick.close();
			await writeFile(file, '{"name":"review-fixture","scripts":{"build":"cargo build"}}');
			await editor.waitForEditorFocus();
			await page.keyboard.insertText('/guardian');
			await page.keyboard.press('Enter');
			await expect(entry.filter({ hasText: 'Source changed — excluded from review' })).toHaveCount(1);
			await expect(entry.filter({ hasText: 'Pending review' })).toContainText('cargo build');
			await quick.close();
		}
		await expect(editor.input).toBeFocused();
		await expect(chat.getByRole('log', { name: 'Chat transcript' })).toBeEmpty();
		await editor.waitForEditorContents(text => text === '');
	}
});

test('Sessions review environment scans a draft, accepts entries, and excludes changed sources', async ({ target, workbench, testWorkspace }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	const editor = new Editor(page.locator('.ash-sessions-chat-slot.active:visible'));
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('/permission auto');
	await editor.waitForEditorContents(text => text === '/permission auto');
	await page.keyboard.press('Enter');
	await expect(page.locator(':is(.ash-sessions-chat-input,.ash-sessions-native-chat-input)').first().getByRole('button', { name: 'Permissions: Auto', exact: true })).toBeVisible();
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('/permission manual');
	await editor.waitForEditorContents(text => text === '/permission manual');
	await page.keyboard.press('Enter');
	const permissions = page.locator(':is(.ash-sessions-chat-input,.ash-sessions-native-chat-input)').first().getByRole('button', { name: 'Permissions: Manual', exact: true });
	await permissions.press('ArrowDown');
	const menu = page.getByRole('menu', { name: 'Permissions', exact: true });
	await expect(menu).toBeVisible();
	await expect(menu.getByRole('menuitem')).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(permissions).toBeFocused();
	if (target.appServerMode === 'disabled') return;
	const openSetup = async (): Promise<void> => {
		await editor.input.focus();
		await page.keyboard.insertText('/guardian setup');
		await editor.waitForEditorContents(text => text === '/guardian setup');
		await page.keyboard.press('Enter');
	};
	const file = join(testWorkspace.directory, 'package.json');
	const original = '{"name":"review-fixture","scripts":{"build":"pnpm build"}}';
	await writeFile(file, original);
	await openSetup();
	const quick = new QuickAccess(page);
	await quick.select('Scan project…');
	await expect(quick.items.filter({ hasText: 'Include recent project sessions' })).toContainText('aggregates command names and targets');
	await quick.select('Include recent project sessions');
	await expect(quick.items.filter({ hasText: 'Session limit: 50' })).toHaveCount(1);
	await expect(quick.items.filter({ hasText: 'Commands per session: 200' })).toHaveCount(1);
	await expect(quick.items.filter({ hasText: 'Time range: all dates' })).toHaveCount(1);
	await quick.select('Session limit: 50');
	const sessionLimit = quick.element.getByRole('textbox');
	await sessionLimit.fill('100');
	await sessionLimit.press('Enter');
	await expect(quick.items.filter({ hasText: 'Session limit: 100' })).toHaveCount(1);
	await expect(quick.items.filter({ hasText: 'Include shell history executable names' })).toContainText('excludes arguments');
	await expect(quick.items.filter({ hasText: 'Include other repositories in the home directory' })).toContainText('excludes source code');
	// This fixture has no model connection. Explicitly choose direct extraction before scanning.
	await quick.select('Summarize with the current task model');
	await quick.select('Continue — generate draft');
	await expect(quick.input).toHaveAttribute('placeholder', /0\/0 sessions/u);
	const entry = quick.items.filter({ has: page.locator('.ash-quick-pick-row-label').getByText('package.json', { exact: true }) });
	await expect(entry).toContainText('Pending review');
	await expect(entry).toContainText('pnpm build');
	await quick.select('package.json');
	await quick.select('Accept as project background');
	await expect(entry).toContainText('Accepted');
	await quick.select('Save accepted entries');
	await expect(quick.element).toBeHidden();
	expect(await readFile(file, 'utf8')).toBe(original);
	await openSetup();
	await expect(entry).toContainText('Accepted');
	await quick.close();
	await writeFile(file, '{"name":"review-fixture","scripts":{"build":"cargo build"}}');
	await openSetup();
	await expect(entry.filter({ hasText: 'Source changed — excluded from review' })).toHaveCount(1);
	await expect(entry.filter({ hasText: 'Pending review' })).toContainText('cargo build');
	await expect(entry.filter({ hasText: 'Pending review' })).not.toContainText('Accepted');
	await quick.close();
});
