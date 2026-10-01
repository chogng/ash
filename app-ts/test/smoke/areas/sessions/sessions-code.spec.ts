import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { readFile } from 'node:fs/promises';
import { test as browserTest } from '@playwright/test';

test.describe('Sessions from an Electron Workbench', () => {
	test.skip(({ target }) => target.kind === 'browser', 'The browser Sessions page has its own launch test below.');

	test('Sessions Code reuses Files and Changes and retains its Workbench editor across pages', async ({ application, target, workbench, testWorkspace }) => {
		test.skip(target.workbenchMode !== 'code');
		let page = workbench.page;
		if (target.kind === 'browser') {
			await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
		} else {
			if (!('windows' in application)) throw new Error('Expected Electron windows');
			const opened = application.waitForEvent('window');
			await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
			page = await opened;
		}
		const failures: string[] = [];
		page.on('pageerror', error => failures.push(error.message));
		const auxiliary = page.locator('[data-part="auxiliarybar"]');
		const editors = page.locator('[data-part="editor"]');
		const navigation = page.locator('.ash-sessions-activity-content');
		await expect(auxiliary).toBeHidden();
		await expect(page.getByText('Session details', { exact: true })).toHaveCount(0);
		await navigation.getByRole('button', { name: 'Code', exact: true }).click();
		await expect(auxiliary).toBeVisible();
		await expect(editors).toBeHidden();
		const files = auxiliary.getByRole('tab', { name: 'Files', exact: true });
		const changes = auxiliary.getByRole('tab', { name: 'Changes', exact: true });
		await expect(files).toHaveAttribute('aria-selected', 'true');
		await changes.click();
		await expect(auxiliary.getByRole('status')).toHaveText('Changes appear after the agent edits files.');
		await expect(auxiliary.getByRole('button', { name: 'Review all changes', exact: true })).toBeDisabled();
		await files.click();
		if (target.appServerMode === 'required' && target.kind === 'electron') {
			await auxiliary.getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
			await expect(editors).toBeVisible();
			const editor = new Editor(editors);
			await editor.waitForEditorFocus();
			await editor.waitForEditorContents(text => text === 'const value = 1;\n');
			await page.keyboard.press('ControlOrMeta+A');
			await page.keyboard.insertText('const value = 42;\n');
			await page.keyboard.press('ControlOrMeta+S');
			await expect.poll(() => readFile(testWorkspace.file, 'utf8')).toBe('const value = 42;\n');
			const input = await editor.input.elementHandle();
			await navigation.getByRole('button', { name: /^Chat(?:\.|$)/u }).click();
			await expect(auxiliary).toBeHidden();
			await expect(editors).toBeHidden();
			await navigation.getByRole('button', { name: 'Code', exact: true }).click();
			await expect(editors).toBeVisible();
			await editor.waitForEditorContents(text => text === 'const value = 42;\n');
			expect(await editor.input.evaluate((element, original) => element === original, input)).toBe(true);
			await input?.dispose();
		} else {
			await navigation.getByRole('button', { name: /^Chat(?:\.|$)/u }).click();
			await expect(auxiliary).toBeHidden();
			await navigation.getByRole('button', { name: 'Code', exact: true }).click();
			await expect(files).toHaveAttribute('aria-selected', 'true');
		}
		expect(failures).toEqual([]);
	});
});

browserTest.describe('Browser Sessions Code', () => {
	browserTest.beforeEach(({}, testInfo) => {
		browserTest.skip(testInfo.project.name !== 'browser-ui', 'This fixture runs in the browser-ui project.');
	});

	browserTest('Browser Sessions Code shows Files and Changes and retains the selected view across pages and reload', async ({ page }) => {
		const failures: string[] = [];
		page.on('pageerror', error => failures.push(error.message));
		await page.goto('/browser/sessions/sessions-code.html');
		const navigation = page.locator('.ash-sessions-activity-content');
		const auxiliary = page.locator('[data-part="auxiliarybar"]');
		await expect(auxiliary).toBeHidden();
		await expect(page.getByText('Session details', { exact: true })).toHaveCount(0);
		await navigation.getByRole('button', { name: 'Code', exact: true }).click();
		await expect(auxiliary.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute('aria-selected', 'true');
		await auxiliary.getByRole('tab', { name: 'Changes', exact: true }).click();
		await expect(auxiliary.getByRole('status')).toHaveText('Changes appear after the agent edits files.');
		await expect(auxiliary.getByRole('button', { name: 'Review all changes', exact: true })).toBeDisabled();
		await navigation.getByRole('button', { name: /^Chat(?:\.|$)/u }).click();
		await expect(auxiliary).toBeHidden();
		await navigation.getByRole('button', { name: 'Code', exact: true }).click();
		await expect(auxiliary.getByRole('tab', { name: 'Changes', exact: true })).toHaveAttribute('aria-selected', 'true');
		await page.setViewportSize({ width: 1_000, height: 760 });
		await expect(auxiliary).toBeVisible();
		await page.reload();
		await navigation.getByRole('button', { name: 'Code', exact: true }).click();
		await expect(auxiliary.getByRole('tab', { name: 'Changes', exact: true })).toHaveAttribute('aria-selected', 'true');
		expect(failures).toEqual([]);
	});
});
