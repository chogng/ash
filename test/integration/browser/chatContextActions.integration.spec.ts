import { expect, test } from '@playwright/test';

for (const locale of ['en', 'zh-CN']) {
	test(`context picker adds unsaved editor text, workspace files and registered sources in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const chinese = locale === 'zh-CN';
		const add = page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true });
		await add.press('Enter');
		let picker = page.getByRole('dialog');
		await picker.getByRole('combobox').fill(chinese ? '已打开的编辑器' : 'Open editors');
		await page.keyboard.press('Enter');
		await picker.getByRole('combobox').fill('edited.ts');
		await page.keyboard.press('Enter');
		const attachments = page.getByRole('list', { name: chinese ? '已添加的上下文' : 'Attached context' });
		await expect(attachments.getByRole('listitem')).toHaveCount(1);
		await expect(attachments).toContainText('edited.ts');
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
		await add.press('Enter');
		await picker.getByRole('combobox').fill(chinese ? '工作区文件' : 'Workspace files');
		await page.keyboard.press('Enter');
		await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', chinese ? '搜索文件路径（例如 src/*.ts）' : 'Search file paths (for example, src/*.ts)');
		await picker.getByRole('combobox').fill('src/');
		await expect(picker.getByRole('option')).toHaveCount(1);
		await expect(picker.getByRole('option')).toContainText('src/nested.txt');
		await picker.getByRole('combobox').fill('src/*.txt');
		await expect(picker.getByRole('option')).toContainText('src/nested.txt');
		await page.keyboard.press('Enter');
		await expect(attachments.getByRole('listitem')).toHaveCount(2);
		await add.press('Enter');
		await picker.getByRole('combobox').fill(chinese ? '其他上下文来源' : 'Other context sources');
		await page.keyboard.press('Enter');
		await expect(picker).toContainText('Source context');
		await page.keyboard.press('Enter');
		await expect(attachments.getByRole('listitem')).toHaveCount(3);
		await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
		await expect(page.getByLabel('Submission')).toHaveText(JSON.stringify([
			{ name: 'edited.ts', content: 'Unsaved editor text' },
			{ name: 'nested.txt', content: 'Workspace file content' },
			{ name: 'Source context', content: 'Registered context content' },
		]));
		await expect(attachments).toBeHidden();
	});
}

test('context uploads preview images, retain keyboard focus and remain attached after a failed send', async ({ page }) => {
	await page.goto('/chatInput.html?sendFailure=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	const add = page.getByRole('button', { name: 'Add context', exact: true });
	await add.press('Enter');
	const upload = page.waitForEvent('filechooser');
	await page.getByRole('dialog').getByRole('combobox').fill('Attach files');
	await page.keyboard.press('Enter');
	await (await upload).setFiles([
		{ name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from('Uploaded brief') },
		{ name: 'preview.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Z1kAAAAASUVORK5CYII=', 'base64') },
	]);
	const attachments = page.getByRole('list', { name: 'Attached context' });
	await expect(attachments.getByRole('listitem')).toHaveCount(2);
	await expect(attachments.getByRole('img', { name: 'preview.png' })).toHaveAttribute('src', /^data:image\/png;base64,/);
	await page.getByRole('button', { name: 'Remove brief.txt', exact: true }).press('Enter');
	await expect(page.getByRole('button', { name: 'Remove preview.png', exact: true })).toBeFocused();
	await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
	await expect(page.getByLabel('Submission')).toContainText('"kind":"image"');
	await expect(attachments.getByRole('listitem')).toHaveCount(1);
	await page.getByRole('button', { name: 'Remove preview.png', exact: true }).press('Enter');
	await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
});

test('cancel and provider failures close the context picker and restore focus', async ({ page }) => {
	await page.goto('/chatInput.html');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	const add = page.getByRole('button', { name: 'Add context', exact: true });
	await add.press('Enter');
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
	await add.press('Enter');
	await page.getByRole('dialog').getByRole('combobox').fill('Other context sources');
	await page.keyboard.press('Enter');
	await page.getByRole('dialog').getByRole('combobox').fill('error');
	await expect(page.getByLabel('Context error')).toContainText('Context source failed');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
	await expect(page.getByRole('list', { name: 'Attached context' })).toBeHidden();
});

test('invalid uploads report an error without adding a partial batch, and a later upload succeeds', async ({ page }) => {
	await page.goto('/chatInput.html');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	const add = page.getByRole('button', { name: 'Add context', exact: true });
	await add.press('Enter');
	let chooser = page.waitForEvent('filechooser');
	await page.getByRole('dialog').getByRole('combobox').fill('Attach files');
	await page.keyboard.press('Enter');
	await (await chooser).setFiles([
		{ name: 'valid.txt', mimeType: 'text/plain', buffer: Buffer.from('Valid content') },
		{ name: 'binary.dat', mimeType: 'application/octet-stream', buffer: Buffer.from([255, 254, 0]) },
	]);
	await expect(page.getByLabel('Context error')).toContainText('binary.dat must be a UTF-8 text file');
	await expect(page.getByRole('list', { name: 'Attached context' })).toBeHidden();
	await add.press('Enter');
	chooser = page.waitForEvent('filechooser');
	await page.getByRole('dialog').getByRole('combobox').fill('Attach files');
	await page.keyboard.press('Enter');
	await (await chooser).setFiles({ name: 'valid.txt', mimeType: 'text/plain', buffer: Buffer.from('Valid content') });
	await expect(page.getByRole('list', { name: 'Attached context' }).getByRole('listitem')).toHaveCount(1);
	await expect(page.locator('input[type="file"]')).toHaveCount(0);
});

test('closing the composer releases its context picker', async ({ page }) => {
	await page.goto('/chatInput.html');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	await page.getByRole('dialog').getByRole('combobox').fill('Other context sources');
	await page.keyboard.press('Enter');
	await expect(page.getByRole('dialog')).toContainText('Source context');
	await page.evaluate(() => window.ashChatInputIntegration.dispose());
	await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('attachment names fit a narrow composer and use the high contrast border', async ({ page }) => {
	await page.goto('/chatInput.html');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.setViewportSize({ width: 320, height: 600 });
	await page.locator('main').evaluate(element => {
		element.style.width = '260px';
		element.style.setProperty('--ash-contrastBorder', 'rgb(255, 255, 255)');
		element.style.setProperty('--ash-strokeThickness', '1px');
	});
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	const chooser = page.waitForEvent('filechooser');
	await page.getByRole('dialog').getByRole('combobox').fill('Attach files');
	await page.keyboard.press('Enter');
	const name = `${'very-long-attachment-name-'.repeat(8)}.txt`;
	await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('Long attachment content') });
	const item = page.getByRole('listitem');
	await expect(item).toHaveCSS('border-top-color', 'rgb(255, 255, 255)');
	await expect(item.locator('.ash-chat-input-attachment-label')).toHaveText(name);
	expect(await item.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
	const remove = page.getByRole('button', { name: `Remove ${name}`, exact: true });
	await remove.focus();
	await expect(remove).toBeFocused();
	expect(await remove.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(24);
});


test('workspace path queries discard late results and cancel when the picker closes', async ({ page }) => {
	await page.goto('/chatInput.html?deferFileSearch=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	const picker = page.getByRole('dialog');
	await picker.getByRole('combobox').fill('Workspace files');
	await page.keyboard.press('Enter');
	await expect(page.getByLabel('File search reads', { exact: true })).toHaveText('1');
	await picker.getByRole('combobox').fill('brief');
	await expect(page.getByLabel('File search reads', { exact: true })).toHaveText('2');
	await page.evaluate(() => window.ashChatInputIntegration.releaseFileSearch(2));
	await expect(picker.getByRole('option')).toHaveCount(1);
	await expect(picker.getByRole('option')).toContainText('brief.txt');
	await page.evaluate(() => window.ashChatInputIntegration.releaseFileSearch(1));
	await expect(page.getByLabel('Completed file search reads', { exact: true })).toHaveText('2');
	await expect(picker.getByRole('option')).toHaveCount(1);
	await expect(picker.getByRole('option')).toContainText('brief.txt');
	await picker.getByRole('combobox').fill('src/');
	await expect(page.getByLabel('File search reads', { exact: true })).toHaveText('3');
	await page.keyboard.press('Escape');
	await page.evaluate(() => window.ashChatInputIntegration.releaseFileSearch(3));
	await expect(page.getByLabel('Completed file search reads', { exact: true })).toHaveText('3');
	await expect(picker).toHaveCount(0);
	await expect(page.getByLabel('Context error')).toHaveText('');
	await expect(page.getByRole('list', { name: 'Attached context' })).toBeHidden();
	await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
});

test('disposing the composer cancels an outstanding workspace file scan', async ({ page }) => {
	await page.goto('/chatInput.html?deferFileSearch=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	await page.getByRole('dialog').getByRole('combobox').fill('Workspace files');
	await page.keyboard.press('Enter');
	await expect(page.getByLabel('File search reads', { exact: true })).toHaveText('1');
	await page.evaluate(() => window.ashChatInputIntegration.dispose());
	await page.evaluate(() => window.ashChatInputIntegration.releaseFileSearch(1));
	await expect(page.getByLabel('Completed file search reads', { exact: true })).toHaveText('1');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByLabel('Context error')).toHaveText('');
});
