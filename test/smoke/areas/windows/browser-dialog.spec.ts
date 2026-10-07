import { expect, test } from '../../../automation/test.js';
import type { Page } from '@playwright/test';

test.use({ openWorkspace: false });

test('browser keeps its save confirmation in the workbench', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser', 'This scenario requires the Code browser');
	const page = workbench.page;
	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('New Untitled Text Editor');
	await page.keyboard.press('Enter');
	const input = workbench.editors.groupAt(0).content.locator('.stanza-editor-input');
	await expect(input).toBeVisible();
	await input.focus();
	await input.type('unsaved draft');
	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('Close Editor');
	await page.keyboard.press('Enter');
	const dialog = page.getByRole('dialog', { name: 'Save Changes' });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: "Don't Save" }).click();
	await expect(dialog).toHaveCount(0);
	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('Reopen Closed Editor');
	await page.keyboard.press('Enter');
	await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'Untitled-1' })).toHaveCount(0);
});

test('desktop dirty editor sends its choices through the owning window dialog', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'disabled');
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	const input = workbench.editors.groupAt(0).content.locator('.stanza-editor-input');
	await input.focus();
	await input.type('unsaved draft');
	const message = await workbench.dialogs.confirm(application, 'Save Changes', "Don't Save", () => workbench.quickaccess.runCommand('workbench.action.closeActiveEditor'));
	expect(message.buttons).toEqual(['Save', "Don't Save", 'Cancel']);
	await expect(input).toHaveCount(0);
});

test('browser Save As writes an untitled editor to the selected folder', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.appServerMode !== 'disabled', 'This scenario requires the standalone Code browser');
	const page = workbench.page;
	const folderName = await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const name = `ash-dialog-save-${crypto.randomUUID()}`;
		const folder = await root.getDirectoryHandle(name, { create: true });
		Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
		return name;
	});
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	const firstGroup = workbench.editors.groupAt(0);
	const input = firstGroup.editor.input;
	await firstGroup.editor.waitForEditorFocus();
	await firstGroup.editor.waitForTypeInEditor('saved through the file dialog');
	await expect.poll(() => hasWorkingCopyBackup(page, 'saved through the file dialog')).toBe(true);
	await workbench.quickaccess.runCommand('workbench.action.splitEditorHorizontal');
	await expect(workbench.editors.groupAt(1).tabs.filter({ hasText: 'Untitled-1' })).toHaveCount(1);
	await input.press('Control+S');
	const dialog = page.getByRole('dialog', { name: 'Save File' });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('textbox', { name: 'File name, field 1' }).fill('draft.txt');
	await dialog.getByRole('button', { name: 'OK' }).click();
	await expect(dialog).toHaveCount(0);
	for (const index of [0, 1]) {
		await expect(workbench.editors.groupAt(index).tabs.filter({ hasText: 'draft.txt' })).toHaveCount(1);
		await expect(workbench.editors.groupAt(index).tabs.filter({ hasText: 'Untitled-1' })).toHaveCount(0);
	}
	await expect.poll(() => page.evaluate(async name => {
		const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
		return (await (await folder.getFileHandle('draft.txt')).getFile()).text();
	}, folderName)).toBe('saved through the file dialog');
	await expect.poll(() => hasWorkingCopyBackup(page, 'saved through the file dialog')).toBe(false);
	await firstGroup.tabs.filter({ hasText: 'draft.txt' }).click();
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	await expect(firstGroup.tabs.filter({ hasText: 'Untitled-' })).toHaveAttribute('aria-selected', 'true');
	await firstGroup.editor.waitForEditorFocus();
	await firstGroup.editor.waitForTypeInEditor('replacement draft');
	await firstGroup.editor.input.press('Control+S');
	const secondDialog = page.getByRole('dialog', { name: 'Save File' });
	await secondDialog.getByRole('textbox', { name: 'File name, field 1' }).fill('draft.txt');
	await secondDialog.getByRole('button', { name: 'OK' }).click();
	const replacement = page.getByRole('dialog', { name: 'Confirm' });
	await expect(replacement).toContainText('Replace the existing file draft.txt?');
	await replacement.getByRole('button', { name: 'Cancel' }).click();
	await expect.poll(() => page.evaluate(async name => {
		const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
		return (await (await folder.getFileHandle('draft.txt')).getFile()).text();
	}, folderName)).toBe('saved through the file dialog');
});

async function hasWorkingCopyBackup(page: Page, content: string): Promise<boolean> {
	return page.evaluate(async expectedContent => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('ash-working-copy-backups', 1);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error('Could not read working-copy backups'));
		});
		try {
			const records = await new Promise<Array<{ readonly content?: string; }>>((resolve, reject) => {
				const request = database.transaction('backups', 'readonly').objectStore('backups').getAll();
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error ?? new Error('Could not read working-copy backups'));
			});
			return records.some(record => record.content === expectedContent);
		} finally {
			database.close();
		}
	}, content);
}

test('browser Open File selects multiple files from the current workspace', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.appServerMode !== 'disabled', 'This scenario requires the standalone Code browser');
	const page = workbench.page;
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const folder = await root.getDirectoryHandle(`ash-dialog-open-${crypto.randomUUID()}`, { create: true });
		const file = await folder.getFileHandle('paper.md', { create: true });
		const writable = await file.createWritable();
		await writable.write('opened through the file dialog');
		await writable.close();
		const second = await folder.getFileHandle('second.md', { create: true });
		const secondWritable = await second.createWritable();
		await secondWritable.write('second file through the dialog');
		await secondWritable.close();
		Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
	});
	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('Open Folder...');
	await page.keyboard.press('Enter');
	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('Open File...');
	await page.keyboard.press('Enter');
	const picker = page.locator('.ash-quick-pick');
	await expect(picker.locator('.ash-quick-pick-row-label', { hasText: 'paper.md' })).toBeVisible();
	await picker.locator('.ash-quick-pick-row-label', { hasText: 'Select paper.md' }).click();
	await picker.locator('.ash-quick-pick-row-label', { hasText: 'Select second.md' }).click();
	await picker.locator('.ash-quick-pick-row-label', { hasText: 'Done (2)' }).click();
	await expect(workbench.editors.groupAt(0).tabs).toContainText(['paper.md', 'second.md']);
	await workbench.editors.groupAt(0).tabs.filter({ hasText: 'second.md' }).click();
	await expect(page.getByRole('tabpanel', { name: 'second.md' }).locator('.stanza-editor-line-text').first()).toHaveText('second file through the dialog');
});
