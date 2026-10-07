import { expect, test } from '../../../automation/test.js';

// The same renderer interaction is exercised in Browser, Electron UI and connected Electron.
test('Workbench context picker uploads, previews and removes attachments with the keyboard', async ({ workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	const add = chat.getByRole('button', { name: 'Add context', exact: true });
	await add.press('Enter');
	await expect(page.getByRole('dialog', { name: 'Add context', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(chat.locator('.stanza-editor-input')).toBeFocused();
	await add.press('Enter');
	const upload = page.waitForEvent('filechooser');
	await page.getByRole('dialog', { name: 'Add context', exact: true }).getByRole('combobox').fill('Attach files');
	await page.keyboard.press('Enter');
	await (await upload).setFiles([
		{ name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from('Workbench attachment brief') },
		{ name: 'preview.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Z1kAAAAASUVORK5CYII=', 'base64') },
	]);
	const attachments = chat.getByRole('list', { name: 'Attached context' });
	await expect(attachments.getByRole('listitem')).toHaveCount(2);
	await expect(page.locator('input[type="file"][aria-label="Attach files"]')).toHaveCount(0);
	await expect(attachments.getByRole('img', { name: 'preview.png' })).toHaveAttribute('src', /^data:image\/png;base64,/);
	const remove = chat.getByRole('button', { name: 'Remove brief.txt', exact: true });
	await remove.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/including unsaved text/);
	await page.keyboard.press('Escape');
	await expect(remove).toBeFocused();
	await remove.press('Enter');
	await expect(chat.getByRole('button', { name: 'Remove preview.png', exact: true })).toBeFocused();
	await page.keyboard.press('Alt+F2');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue('preview.png');
	await page.keyboard.press('Escape');
	await chat.getByRole('button', { name: 'Remove preview.png', exact: true }).press('Enter');
	await expect(attachments).toBeHidden();
	await expect(chat.locator('.stanza-editor-input')).toBeFocused();
});

test('cancelling attachment selection removes the picker and lets the composer attach again', async ({ workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	const add = chat.getByRole('button', { name: 'Add context', exact: true });
	await add.press('Enter');
	const cancelledUpload = page.waitForEvent('filechooser');
	await page.getByRole('dialog', { name: 'Add context', exact: true }).getByRole('combobox').fill('Attach files');
	await page.keyboard.press('Enter');
	await cancelledUpload;
	const input = page.locator('input[type="file"][aria-label="Attach files"]');
	await input.dispatchEvent('cancel');
	await expect(input).toHaveCount(0);
	await expect(chat.locator('.stanza-editor-input')).toBeFocused();
	await add.press('Enter');
	const upload = page.waitForEvent('filechooser');
	await page.getByRole('dialog', { name: 'Add context', exact: true }).getByRole('combobox').fill('Attach files');
	await page.keyboard.press('Enter');
	await (await upload).setFiles({ name: 'after-cancel.txt', mimeType: 'text/plain', buffer: Buffer.from('Attach after cancellation') });
	await expect(chat.getByRole('button', { name: 'Remove after-cancel.txt', exact: true })).toBeVisible();
	await expect(input).toHaveCount(0);
});
