import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('browser keeps its save confirmation in the workbench', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.workbenchMode !== 'code', 'This scenario requires the Code browser');
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
});

test('browser Save As writes an untitled editor to the selected folder', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.workbenchMode !== 'code' || target.appServerMode !== 'disabled', 'This scenario requires the standalone Code browser');
	const page = workbench.page;
	const folderName = await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const name = `ash-dialog-save-${crypto.randomUUID()}`;
		const folder = await root.getDirectoryHandle(name, { create: true });
		Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
		return name;
	});
	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('New Untitled Text Editor');
	await page.keyboard.press('Enter');
	const input = workbench.editors.groupAt(0).content.locator('.stanza-editor-input');
	await expect(input).toBeVisible();
	await input.focus();
	await input.type('saved through the file dialog');
	await input.press('Control+S');
	const dialog = page.getByRole('dialog', { name: 'Save File' });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('textbox', { name: 'File name, field 1' }).fill('draft.txt');
	await dialog.getByRole('button', { name: 'OK' }).click();
	await expect(dialog).toHaveCount(0);
	await expect.poll(() => page.evaluate(async name => {
		const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
		return (await (await folder.getFileHandle('draft.txt')).getFile()).text();
	}, folderName)).toBe('saved through the file dialog');
	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('New Untitled Text Editor');
	await page.keyboard.press('Enter');
	const secondInput = workbench.editors.groupAt(0).content.locator('.stanza-editor-input').last();
	await secondInput.focus();
	await secondInput.type('replacement draft');
	await secondInput.press('Control+S');
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

test('browser Open File selects multiple files from the current workspace', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.workbenchMode !== 'code' || target.appServerMode !== 'disabled', 'This scenario requires the standalone Code browser');
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
