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
		const attachments = page.getByRole('list', { name: chinese ? '已添加的上下文' : 'Attached context' });
		await expect(attachments).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveValue('edited.ts ');
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
		await add.press('Enter');
		await picker.getByRole('combobox').fill(chinese ? '文件和文件夹' : 'Files & Folders');
		await page.keyboard.press('Enter');
		await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', chinese ? '按名称搜索文件或文件夹' : 'Search file or folder by name');
		await picker.getByRole('combobox').fill('src/');
		await expect(picker.getByRole('option', { name: /nested.txt/ })).toHaveCount(1);
		await picker.getByRole('combobox').fill('src/*.txt');
		await expect(picker.getByRole('option', { name: /nested.txt/ })).toHaveCount(1);
		await picker.getByRole('option', { name: /nested.txt/ }).click();
		await expect(attachments).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveValue('edited.ts nested.txt ');
		await add.press('Enter');
		await picker.getByRole('combobox').fill(chinese ? '其他上下文来源' : 'Other context sources');
		await page.keyboard.press('Enter');
		await expect(picker).toContainText('Source context');
		await page.keyboard.press('Enter');
		await expect(attachments).toHaveCount(0);
		await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
		await expect(page.getByLabel('Submission')).toHaveText(JSON.stringify([
			{ name: 'edited.ts', content: 'Unsaved editor text' },
			{ name: 'nested.txt', content: 'Workspace file content' },
			{ name: 'Source context', content: 'Registered context content' },
		]));
		await expect(attachments).toHaveCount(0);
	});
}

for (const variant of [
	{ locale: 'en', theme: 'light', surface: 'code' },
	{ locale: 'en', theme: 'light', surface: 'cowork' },
	{ locale: 'zh-CN', theme: 'dark', surface: 'code' },
	{ locale: 'en', theme: 'hcDark', surface: 'code' },
	{ locale: 'zh-CN', theme: 'hcLight', surface: 'code' },
]) {
	test(`Add context anchors searchable child menus and restores keyboard focus (${variant.locale}, ${variant.theme}, ${variant.surface})`, async ({ page }) => {
		await page.setViewportSize({ width: 760, height: 900 });
		await page.goto(`/chatInput.html?locale=${variant.locale}&theme=${variant.theme}&surface=${variant.surface}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.locator('main').evaluate(element => { element.style.marginTop = '480px'; });
		const chinese = variant.locale === 'zh-CN';
		const add = page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true });
		const picker = page.getByRole('dialog');
		const search = picker.getByRole('combobox');
		const assertAbove = async (): Promise<void> => {
			await expect.poll(async () => {
				const button = await add.boundingBox();
				const menu = await picker.boundingBox();
				return button && menu ? Math.round(button.y - menu.y - menu.height) : -1;
			}).toBe(4);
			const button = (await add.boundingBox())!;
			const menu = (await picker.boundingBox())!;
			expect(Math.abs(menu.x - Math.max(8, button.x))).toBeLessThanOrEqual(1);
			expect(menu.width).toBe(380);
		};
		await expect(add).toHaveAttribute('aria-haspopup', 'dialog');
		await expect(add).toHaveAttribute('aria-expanded', 'false');
		await add.press('Space');
		await expect(search).toBeFocused();
		await expect(add).toHaveAttribute('aria-expanded', 'true');
		await assertAbove();
		const menuBounds = (await picker.boundingBox())!;
		const buttonBounds = (await add.boundingBox())!;
		await page.screenshot({ path: test.info().outputPath('attachment-menu.png'), clip: { x: menuBounds.x - 8, y: menuBounds.y - 8, width: 600, height: buttonBounds.y + buttonBounds.height - menuBounds.y + 24 } });
		await expect(picker).toHaveCSS('border-radius', '8px');
		if (variant.theme.startsWith('hc')) await expect(picker).toHaveCSS('border-top-color', variant.theme === 'hcDark' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)');
		await search.fill(chinese ? '会话' : 'Sessions');
		await assertAbove();
		await page.keyboard.press('Enter');
		await expect(search).toHaveAttribute('placeholder', chinese ? '选择会话' : 'Select a session');
		await expect(search).toBeFocused();
		await assertAbove();
		await search.fill(chinese ? '返回' : 'Go back');
		await page.keyboard.press('Enter');
		await expect(search).toHaveAttribute('placeholder', chinese ? '搜索附件' : 'Search attachments');
		await search.fill('edited');
		await page.keyboard.press('Control+Enter');
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveValue('edited.ts ');
		await expect(search).toBeFocused();
		await assertAbove();
		await page.keyboard.press('Escape');
		await expect(picker).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
		await expect(add).toHaveAttribute('aria-expanded', 'false');
		await add.press('Enter');
		await search.fill('nested');
		await expect(picker.getByRole('option', { name: /nested.txt/ })).toBeVisible();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowUp');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveValue('edited.ts nested.txt ');
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
	});
}

test('attachment menu flips below Add, fits a narrow viewport, follows resize and toggles closed', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 600 });
	await page.goto('/chatInput.html');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	const add = page.getByRole('button', { name: 'Add context', exact: true });
	const picker = page.getByRole('dialog');
	await add.click();
	await expect(picker.getByRole('combobox')).toBeFocused();
	await expect.poll(async () => {
		const button = await add.boundingBox();
		const menu = await picker.boundingBox();
		return button && menu ? Math.round(menu.y - button.y - button.height) : -1;
	}).toBe(4);
	let menu = (await picker.boundingBox())!;
	expect(menu.x).toBeGreaterThanOrEqual(8);
	expect(menu.x + menu.width).toBeLessThanOrEqual(312);
	expect(menu.y + menu.height).toBeLessThanOrEqual(592);
	await page.locator('main').evaluate(element => { element.style.marginTop = '480px'; });
	await page.setViewportSize({ width: 760, height: 900 });
	await expect.poll(async () => {
		const button = await add.boundingBox();
		const bounds = await picker.boundingBox();
		return button && bounds ? Math.round(button.y - bounds.y - bounds.height) : -1;
	}).toBe(4);
	await add.click();
	await expect(picker).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
	await expect(add).toHaveAttribute('aria-expanded', 'false');
	await add.press('Enter');
	await expect(picker).toBeVisible();
	const message = page.getByRole('textbox', { name: 'Chat message', exact: true });
	await message.click({ position: { x: (await message.boundingBox())!.width - 12, y: 12 } });
	await expect(picker).toHaveCount(0);
	await expect(message).toBeFocused();
	await add.press('Enter');
	await picker.getByRole('combobox').press('Tab');
	await expect.poll(() => picker.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
	await page.keyboard.press('Escape');
	await expect(picker).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
	await add.press('Enter');
	await picker.getByRole('combobox').press('Shift+Tab');
	await expect(picker).toHaveCount(0);
	await expect(add).toHaveAttribute('aria-expanded', 'false');
});

test('context uploads preview images, retain keyboard focus and remain attached after a failed send', async ({ page }) => {
	await page.goto('/chatInput.html?inlineCode=1&sendFailure=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	const add = page.getByRole('button', { name: 'Add context', exact: true });
	await add.press('Enter');
	const upload = page.waitForEvent('filechooser');
	await page.getByRole('dialog').getByRole('combobox').fill('Attach files');
	await page.keyboard.press('Enter');
	await (await upload).setFiles([
		{ name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from('Uploaded brief') },
		{ name: 'preview.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DQAAAEgQGALFXOsAAAAABJRU5ErkJggg==', 'base64') },
	]);
	const attachments = page.getByRole('list', { name: 'Attached context' });
	await expect(attachments).toHaveCount(0);
	const thumbnail = page.locator('.ash-chat-image-reference-control').getByRole('img', { name: 'preview.png' });
	await expect(thumbnail).toHaveAttribute('src', /^data:image\/png;base64,/);
	const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
	expect(await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft())).toBe('brief.txt preview.png ');
	await input.press('Home');
	await input.press('Delete');
	await expect(page.locator('.ash-chat-code-reference')).toHaveCount(0);
	await expect(input).toBeFocused();
	await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
	await expect(page.getByLabel('Submission')).toContainText('"kind":"image"');
	await expect(thumbnail).toBeVisible();
	await page.getByRole('button', { name: 'Remove preview.png', exact: true }).press('Enter');
	await expect(thumbnail).toHaveCount(0);
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
	await expect(page.getByRole('list', { name: 'Attached context' })).toBeHidden();
	await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveValue('valid.txt ');
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

test('uploaded file references wrap inside a narrow composer and delete from the message', async ({ page }, testInfo) => {
	await page.goto('/chatInput.html?inlineCode=1&theme=hcDark');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.setViewportSize({ width: 320, height: 600 });
	await page.locator('main').evaluate(element => { element.style.width = '260px'; });
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	const chooser = page.waitForEvent('filechooser');
	await page.getByRole('dialog').getByRole('option', { name: 'Attach files', exact: true }).click();
	const name = `${'very-long-code-file-name-'.repeat(8)}.ts`;
	await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('const uploaded = true;') });
	const references = page.locator('.ash-chat-code-reference');
	await expect.poll(async () => (await references.allTextContents()).join('')).toBe(name);
	await expect(references.first()).toHaveCSS('outline-style', 'solid');
	await expect(page.getByRole('list', { name: 'Attached context' })).toBeHidden();
	expect(await page.locator('.ash-chat-input-editor').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
	const input = page.locator('.ash-chat-input-editor').getByRole('textbox');
	await expect(input).toBeFocused();
	await page.screenshot({ path: testInfo.outputPath('wrapped-file-reference.png') });
	await input.press('Home');
	await input.press('Delete');
	await expect(references).toHaveCount(0);
});


test('workspace path queries discard late results and cancel when the picker closes', async ({ page }) => {
	await page.goto('/chatInput.html?deferFileSearch=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	const picker = page.getByRole('dialog');
	await picker.getByRole('combobox').fill('nested');
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
	await page.getByRole('dialog').getByRole('combobox').fill('nested');
	await expect(page.getByLabel('File search reads', { exact: true })).toHaveText('1');
	await page.evaluate(() => window.ashChatInputIntegration.dispose());
	await page.evaluate(() => window.ashChatInputIntegration.releaseFileSearch(1));
	await expect(page.getByLabel('Completed file search reads', { exact: true })).toHaveText('1');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByLabel('Context error')).toHaveText('');
});

test('attachment search mixes sources with recent files and accepts repeatedly without opening an editor', async ({ page }) => {
	await page.goto('/chatInput.html');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	const picker = page.getByRole('dialog');
	await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Search attachments');
	await expect(picker.getByRole('separator', { name: 'Recently opened' })).toHaveCount(1);
	await expect(picker.getByRole('option', { name: /closed.ts/ })).toBeVisible();
	await picker.getByRole('combobox').fill('edited');
	await page.keyboard.press('Control+Enter');
	const attachments = page.getByRole('list', { name: 'Attached context' });
	await expect(attachments).toHaveCount(0);
	await expect(picker.getByRole('combobox')).toBeFocused();
	await picker.getByRole('combobox').fill('nested');
	await expect(picker.getByRole('option', { name: /nested.txt/ })).toBeVisible();
	await page.keyboard.press('Control+Enter');
	await expect(attachments).toHaveCount(0);
	await picker.getByRole('combobox').fill('edited');
	await page.keyboard.press('Control+Enter');
	await expect(attachments).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveValue('edited.ts nested.txt edited.ts ');
	await page.keyboard.press('Escape');
	await expect(picker).toHaveCount(0);
	await expect(page.getByLabel('Opened editor count')).toHaveText('0');
	await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
	await expect(page.getByLabel('Submission')).toHaveText(JSON.stringify([
		{ name: 'edited.ts', content: 'Unsaved editor text' },
		{ name: 'nested.txt', content: 'Workspace file content' },
		{ name: 'edited.ts', content: 'Unsaved editor text' },
	]));
});

for (const locale of ['en', 'zh-CN']) {
	test(`folder attachments carry their scope and manifest and allow going back in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const chinese = locale === 'zh-CN';
		await page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true }).press('Enter');
		const picker = page.getByRole('dialog');
		await picker.getByRole('option', { name: chinese ? '文件和文件夹…' : 'Files & Folders…', exact: true }).click();
		await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', chinese ? '按名称搜索文件或文件夹' : 'Search file or folder by name');
		await picker.getByRole('option', { name: chinese ? '返回 ↩' : 'Go back ↩', exact: true }).click();
		await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', chinese ? '搜索附件' : 'Search attachments');
		await picker.getByRole('option', { name: chinese ? '文件和文件夹…' : 'Files & Folders…', exact: true }).click();
		await expect(picker.getByRole('option', { name: /src \/workspace/ })).toBeVisible();
		await picker.getByRole('option', { name: /src \/workspace/ }).click();
		await expect(picker).toHaveCount(0);
		await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
		await expect(page.getByLabel('Submission')).toHaveText(JSON.stringify([{ name: 'src', content: 'Directory: file:///workspace/src\nFiles:\nnested.txt' }]));
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`clipboard, screenshot and session context send snapshots in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const chinese = locale === 'zh-CN';
		const add = page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true });
		for (const name of chinese ? ['剪贴板中的图片', '截图…', '会话…'] : ['Image from Clipboard', 'Screenshot…', 'Sessions…']) {
			await add.press('Enter');
			await page.getByRole('dialog').getByRole('option', { name, exact: true }).click();
			if (name === 'Sessions…' || name === '会话…') {
				await expect(page.getByRole('dialog').getByRole('option', { name: 'Current session', exact: true })).toHaveCount(0);
				await page.getByRole('dialog').getByRole('option', { name: 'Earlier design', exact: true }).click();
			}
			await expect(page.getByRole('dialog')).toHaveCount(0);
			await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
		}
		const attachments = page.getByRole('list', { name: chinese ? '已添加的上下文' : 'Attached context' });
		await expect(attachments).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).not.toBeEmpty();
		await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
		const contexts = JSON.parse((await page.getByLabel('Submission').textContent())!) as { name: string; content: string; kind?: string; }[];
		expect(contexts.slice(0, 2).map(item => item.kind)).toEqual(['image', 'image']);
		expect(contexts[0].content).toMatch(/^data:image\/png;base64,/);
		expect(contexts[1].content).not.toBe(contexts[0].content);
		expect(contexts[2]).toEqual({ name: 'Earlier design', content: 'Conversation: Earlier design\nSession: previous-session\nThread: previous-thread\n\nUser: Design the attachment picker\n\nAssistant: Use one resource search owner' });
	});

	test(`GitHub context selects repositories, pages issues and snapshots a linked PR in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const chinese = locale === 'zh-CN';
		const add = page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true });
		const picker = page.getByRole('dialog');
		await add.press('Enter');
		await picker.getByRole('option', { name: 'Issue…', exact: true }).click();
		await picker.getByRole('option', { name: /team\/alpha workspace/ }).click();
		await expect(picker.getByRole('option', { name: /#12 Attachment issue/ })).toBeVisible();
		await picker.getByRole('option', { name: chinese ? '加载更多' : 'Load more', exact: true }).click();
		await expect(picker.getByRole('option', { name: /#12 Attachment issue/ })).toBeVisible();
		await picker.getByRole('option', { name: /#13 Follow-up issue/ }).click();
		await expect(picker).toHaveCount(0);
		await add.press('Enter');
		await picker.getByRole('option', { name: 'Pull Request…', exact: true }).click();
		await picker.getByRole('combobox').fill('https://github.com/other/project/pull/27');
		await picker.getByRole('option', { name: 'other/project/pull/27', exact: true }).click();
		await expect(picker).toHaveCount(0);
		await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
		const contexts = JSON.parse((await page.getByLabel('Submission').textContent())!) as { name: string; content: string; }[];
		expect(contexts).toHaveLength(2);
		expect(contexts[0].content).toContain('https://github.com/team/alpha/issues/13');
		expect(contexts[0].content).toContain('Issue body\n\nComment: Issue discussion');
		expect(contexts[1].content).toContain('https://github.com/other/project/pull/27');
		expect(contexts[1].content).toContain('Branches: feature → main\nCommit: abc123');
		expect(contexts[1].content).toContain('modified: picker.ts\n+attach context');
		const reads = JSON.parse((await page.getByLabel('GitHub reads').textContent())!);
		expect(reads.filter((item: { type: string; }) => item.type === 'issues').map((item: { page: number; }) => item.page)).toEqual([1, 2]);
		expect(reads.every((item: { repository: { accountId: string; }; }) => item.repository.accountId === 'account')).toBe(true);
		expect(reads.filter((item: { type: string; }) => item.type === 'pullRequests')).toHaveLength(0);
	});
}

test('empty clipboard reports an error and cancelling screenshot returns to attachment search', async ({ page }) => {
	await page.goto('/chatInput.html?emptyClipboard=1&cancelScreenshot=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	const add = page.getByRole('button', { name: 'Add context', exact: true });
	await add.press('Enter');
	await page.getByRole('dialog').getByRole('option', { name: 'Image from Clipboard', exact: true }).click();
	await expect(page.getByLabel('Context error')).toContainText('The clipboard does not contain an image');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
	await add.press('Enter');
	await page.getByRole('dialog').getByRole('option', { name: 'Screenshot…', exact: true }).click();
	await expect(page.getByRole('dialog').getByRole('combobox')).toHaveAttribute('placeholder', 'Search attachments');
	await expect(page.getByRole('dialog').getByRole('combobox')).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('list', { name: 'Attached context' })).toBeHidden();
});

test('GitHub selection accepts manual repositories and numbers without forwarding mismatched links', async ({ page }) => {
	await page.goto('/chatInput.html');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	const picker = page.getByRole('dialog');
	await picker.getByRole('option', { name: 'Issue…', exact: true }).click();
	for (const link of ['https://other.test/team/alpha/issues/12', 'https://github.com/team/alpha/pull/12']) {
		await picker.getByRole('combobox').fill(link);
		await expect(picker.getByRole('option')).toHaveCount(1);
		await expect(picker.getByRole('option', { name: 'Go back ↩', exact: true })).toBeVisible();
		await expect(page.getByLabel('GitHub reads')).toHaveText('[]');
	}
	await picker.getByRole('combobox').fill('other/project');
	await picker.getByRole('option', { name: 'other/project', exact: true }).click();
	await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Search issues or enter #number');
	await picker.getByRole('combobox').fill('#99');
	await picker.getByRole('option', { name: /#99 Attachment issue/ }).click();
	await expect(picker).toHaveCount(0);
	await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
	await expect(page.getByLabel('Submission')).toContainText('https://github.com/other/project/issues/99');
});

test('GitHub body search retains server matches even when the title does not match', async ({ page }) => {
	await page.goto('/chatInput.html');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	const picker = page.getByRole('dialog');
	await picker.getByRole('option', { name: 'Issue…', exact: true }).click();
	await picker.getByRole('option', { name: /team\/alpha workspace/ }).click();
	await picker.getByRole('combobox').fill('body:repro');
	await expect(picker.getByRole('option', { name: /#12 Attachment issue/ })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Search attachments');
	await page.keyboard.press('Escape');
});

test('GitHub account selection keeps the chosen host and grant with a pasted issue', async ({ page }) => {
	await page.goto('/chatInput.html?multipleGitHubAccounts=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	const picker = page.getByRole('dialog');
	await picker.getByRole('option', { name: 'Issue…', exact: true }).click();
	await picker.getByRole('option', { name: /work-developer github.company.test/ }).click();
	await picker.getByRole('combobox').fill('https://github.company.test/team/project/issues/8');
	await picker.getByRole('option', { name: 'team/project/issues/8', exact: true }).click();
	await expect(picker).toHaveCount(0);
	const reads = JSON.parse((await page.getByLabel('GitHub reads').textContent())!);
	expect(reads).toEqual([{ type: 'issue', repository: { host: 'github.company.test', accountId: 'work-account', owner: 'team', name: 'project' }, number: 8 }]);
});

test('GitHub requires an account and a later context selection still succeeds', async ({ page }) => {
	await page.goto('/chatInput.html?noGitHubAccount=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	const add = page.getByRole('button', { name: 'Add context', exact: true });
	await add.press('Enter');
	await page.getByRole('dialog').getByRole('option', { name: 'Pull Request…', exact: true }).click();
	await expect(page.getByLabel('Context error')).toContainText('Connect a GitHub account in Settings');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
	await add.press('Enter');
	await page.getByRole('dialog').getByRole('option', { name: 'Image from Clipboard', exact: true }).click();
	await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
});

test('GitHub query changes and composer disposal cancel reads and discard late results', async ({ page }) => {
	await page.goto('/chatInput.html?deferGitHubSearch=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	const picker = page.getByRole('dialog');
	await picker.getByRole('option', { name: 'Issue…', exact: true }).click();
	await picker.getByRole('option', { name: /team\/alpha workspace/ }).click();
	await picker.getByRole('combobox').fill('older');
	await expect(page.getByLabel('GitHub reads')).toContainText('"query":"older"');
	await picker.getByRole('combobox').fill('newer');
	await expect(page.getByLabel('GitHub reads')).toContainText('"query":"newer"');
	await page.evaluate(() => window.ashChatInputIntegration.releaseGitHubSearch('newer'));
	await expect(picker.getByRole('option', { name: /#12 Attachment issue/ })).toBeVisible();
	await page.evaluate(() => window.ashChatInputIntegration.releaseGitHubSearch('older'));
	await expect(page.getByLabel('GitHub reads')).toContainText('"query":"older","cancelled":true');
	await expect(picker.getByRole('option', { name: /Old result/ })).toHaveCount(0);
	await picker.getByRole('combobox').fill('pending');
	await expect(page.getByLabel('GitHub reads')).toContainText('"query":"pending"');
	await page.evaluate(() => window.ashChatInputIntegration.dispose());
	await page.evaluate(() => window.ashChatInputIntegration.releaseGitHubSearch('pending'));
	await expect(page.getByLabel('GitHub reads')).toContainText('"query":"pending","cancelled":true');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByLabel('Context error')).toHaveText('');
});

for (const capability of ['text', 'image', 'unknown'] as const) {
	test(`context image actions follow the selected model's ${capability} capability`, async ({ page }) => {
		await page.goto(`/chatInput.html?imageCapability=${capability}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const add = page.getByRole('button', { name: 'Add context', exact: true });
		await add.press('Enter');
		const picker = page.getByRole('dialog');
		await expect(picker.getByRole('option', { name: 'Image from Clipboard', exact: true })).toHaveCount(capability === 'text' ? 0 : 1);
		await expect(picker.getByRole('option', { name: 'Screenshot…', exact: true })).toHaveCount(capability === 'text' ? 0 : 1);
		if (capability === 'text') {
			const chooser = page.waitForEvent('filechooser');
			await picker.getByRole('option', { name: 'Attach files', exact: true }).click();
			await (await chooser).setFiles({ name: 'unsupported.png', mimeType: 'image/png', buffer: Buffer.from('image') });
			await expect(page.getByLabel('Context error')).toContainText('The selected model does not support images');
			await expect(page.getByRole('list', { name: 'Attached context' })).toBeHidden();
			await add.press('Enter');
			await page.getByRole('dialog').getByRole('option', { name: 'Open editors', exact: true }).click();
			await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
			await expect(page.getByLabel('Submission')).toContainText('Unsaved editor text');
		} else {
			await picker.getByRole('option', { name: 'Image from Clipboard', exact: true }).click();
			await expect(picker).toHaveCount(0);
			await page.evaluate(() => window.ashChatInputIntegration.setImageCapability('text'));
			await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
			await expect(page.getByLabel('Context error')).toContainText('The selected model does not support images');
			await expect(page.getByRole('list', { name: 'Attached context' })).toBeHidden();
			await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveValue('Pasted Image ');
			await expect(page.getByLabel('Submission')).toHaveText('');
			await page.evaluate(() => window.ashChatInputIntegration.setImageCapability('image'));
			await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
			await expect(page.getByLabel('Submission')).toContainText('"kind":"image"');
		}
	});
}

test('images decode, resize transparently and retain separate references across upload and clipboard', async ({ page }) => {
	await page.goto('/chatInput.html?inlineCode=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	const large = await page.evaluate(() => {
		const canvas = document.createElement('canvas');
		canvas.width = 4096; canvas.height = 2048;
		canvas.getContext('2d')!.fillRect(0, 0, 2048, 2048);
		return canvas.toDataURL('image/png').split(',')[1];
	});
	const add = page.getByRole('button', { name: 'Add context', exact: true });
	await add.press('Enter');
	let chooser = page.waitForEvent('filechooser');
	await page.getByRole('dialog').getByRole('option', { name: 'Attach files', exact: true }).click();
	await (await chooser).setFiles({ name: 'large.png', mimeType: 'image/png', buffer: Buffer.from(large, 'base64') });
	const image = page.getByRole('img', { name: 'large.png', exact: true });
	await expect.poll(() => image.evaluate(element => [(element as HTMLImageElement).naturalWidth, (element as HTMLImageElement).naturalHeight])).toEqual([2048, 1024]);
	expect(await image.evaluate(element => {
		const canvas = document.createElement('canvas'); canvas.width = 2048; canvas.height = 1024;
		const context = canvas.getContext('2d')!; context.drawImage(element as HTMLImageElement, 0, 0);
		return context.getImageData(1800, 500, 1, 1).data[3];
	})).toBe(0);
	await add.press('Enter');
	await page.getByRole('dialog').getByRole('option', { name: 'Image from Clipboard', exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
	await add.press('Enter');
	chooser = page.waitForEvent('filechooser');
	await page.getByRole('dialog').getByRole('option', { name: 'Attach files', exact: true }).click();
	await (await chooser).setFiles({ name: 'duplicate.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DQAAAEgQGALFXOsAAAAABJRU5ErkJggg==', 'base64') });
	await expect(page.locator('.ash-chat-image-reference-control img')).toHaveCount(3);
	await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
	await expect(page.getByRole('img', { name: 'Pasted Image', exact: true })).toBeVisible();
	await add.press('Enter');
	chooser = page.waitForEvent('filechooser');
	await page.getByRole('dialog').getByRole('option', { name: 'Attach files', exact: true }).click();
	await (await chooser).setFiles([{ name: 'valid.txt', mimeType: 'text/plain', buffer: Buffer.from('Valid') }, { name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('Invalid image') }]);
	await expect(page.getByLabel('Context error')).toContainText('invalid.png could not be decoded as an image');
	await expect(page.locator('.ash-chat-image-reference-control img')).toHaveCount(3);
});

test('source buttons preserve file, folder, session and GitHub destinations through draft capture and restore', async ({ page }) => {
	await page.goto('/chatInput.html?inlineCode=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	const add = page.getByRole('button', { name: 'Add context', exact: true });
	await add.press('Enter');
	let picker = page.getByRole('dialog');
	await picker.getByRole('combobox').fill('edited');
	await page.keyboard.press('Enter');
	await add.press('Enter');
	await picker.getByRole('option', { name: 'Files & Folders…', exact: true }).click();
	await picker.getByRole('option', { name: /src \/workspace/ }).click();
	await add.press('Enter');
	await picker.getByRole('option', { name: 'Sessions…', exact: true }).click();
	await picker.getByRole('option', { name: 'Earlier design', exact: true }).click();
	await add.press('Enter');
	await picker.getByRole('option', { name: 'Issue…', exact: true }).click();
	await picker.getByRole('combobox').fill('https://github.com/team/alpha/issues/12');
	await picker.getByRole('option', { name: 'team/alpha/issues/12', exact: true }).click();
	await expect(picker).toHaveCount(0);
	expect(await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft())).toBe('edited.ts src Earlier design team/alpha #12: Attachment issue ');
	for (const name of ['src', 'Earlier design', 'team/alpha #12: Attachment issue']) {
		await page.getByRole('button', { name: `Open ${name}`, exact: true }).press('Enter');
	}
	await expect(page.getByLabel('Opened sources')).toHaveText(JSON.stringify([
		{ command: 'revealInExplorer', resource: 'file:///workspace/src' },
		{ sessionId: 'previous-session', threadId: 'previous-thread' },
		{ resource: 'https://github.com/team/alpha/issues/12', options: { fromUserGesture: true, openExternal: true } },
	]));
	await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
});

test('child context pickers go back one step and continue adding after Ctrl+Enter', async ({ page }) => {
	await page.goto('/chatInput.html?multipleGitHubAccounts=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	const picker = page.getByRole('dialog');
	await picker.getByRole('option', { name: 'Sessions…', exact: true }).click();
	await picker.getByRole('option', { name: 'Go back ↩', exact: true }).click();
	await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Search attachments');
	await picker.getByRole('option', { name: 'Sessions…', exact: true }).click();
	await picker.getByRole('combobox').fill('Earlier design');
	await expect(picker.getByRole('option', { name: 'Earlier design', exact: true })).toBeVisible();
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowUp');
	await expect(picker.getByRole('combobox')).toHaveAttribute('aria-activedescendant', (await picker.getByRole('option', { name: 'Earlier design', exact: true }).getAttribute('id'))!);
	await page.keyboard.press('Control+Enter');
	await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Search attachments');
	await picker.getByRole('option', { name: 'Issue…', exact: true }).click();
	await picker.getByRole('option', { name: 'developer github.com', exact: true }).click();
	await picker.getByRole('option', { name: /team\/alpha workspace/ }).click();
	await picker.getByRole('option', { name: 'Go back ↩', exact: true }).click();
	await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Select a repository, enter owner/repository, or paste a GitHub link');
	await picker.getByRole('option', { name: 'Go back ↩', exact: true }).click();
	await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Select a GitHub account');
	await picker.getByRole('option', { name: 'developer github.com', exact: true }).click();
	await picker.getByRole('option', { name: /team\/alpha workspace/ }).click();
	await picker.getByRole('combobox').fill('#12');
	await expect(picker.getByRole('option', { name: /#12 Attachment issue/ })).toBeVisible();
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowUp');
	await expect(picker.getByRole('combobox')).toHaveAttribute('aria-activedescendant', (await picker.getByRole('option', { name: /#12 Attachment issue/ }).getAttribute('id'))!);
	await page.keyboard.press('Control+Enter');
	await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Search attachments');
	await expect(picker.getByRole('combobox')).toBeFocused();
	await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
	await page.keyboard.press('Escape');
});

test('long source attachment buttons fit a narrow composer and remain keyboard accessible', async ({ page }) => {
	await page.goto('/chatInput.html?inlineCode=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.setViewportSize({ width: 320, height: 600 });
	await page.locator('main').evaluate(element => { element.style.width = '260px'; element.style.setProperty('--ash-contrastBorder', 'rgb(255, 255, 255)'); });
	const owner = 'a'.repeat(160);
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	const picker = page.getByRole('dialog');
	await picker.getByRole('option', { name: 'Issue…', exact: true }).click();
	await picker.getByRole('combobox').fill(`https://github.com/${owner}/project/issues/12`);
	await picker.getByRole('option', { name: `${owner}/project/issues/12`, exact: true }).click();
	const item = page.locator('.ash-chat-input-editor');
	await expect(page.locator('.ash-chat-context-reference').first()).toHaveCSS('outline-color', 'rgb(255, 255, 255)');
	expect(await item.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
	const open = item.getByRole('button', { name: `Open ${owner}/project #12: Attachment issue`, exact: true });
	await open.press('Enter');
	await expect(open).toBeFocused();
	await expect(page.getByLabel('Opened sources')).toContainText(`https://github.com/${owner}/project/issues/12`);
});

for (const locale of ['en', 'zh-CN']) {
	test(`terminal, symbols and search results keep snapshots and source buttons after draft restore in ${locale}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/chatInput.html?inlineCode=1&contextSources=1&locale=${locale}`);
		await expect.poll(async () => ({ ready: await page.evaluate(() => Boolean(window.ashChatInputIntegration)), errors })).toEqual({ ready: true, errors: [] });
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const chinese = locale === 'zh-CN';
		const add = page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true });
		const picker = page.getByRole('dialog');
		await add.press('Enter');
		await picker.getByRole('option', { name: chinese ? '终端…' : 'Terminal…', exact: true }).click();
		await picker.getByRole('combobox').fill('Shell');
		await expect(picker.getByRole('option', { name: /Shell \/workspace/ })).toBeVisible();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowUp');
		await expect(picker.getByRole('combobox')).toHaveAttribute('aria-activedescendant', (await picker.getByRole('option', { name: /Shell \/workspace/ }).getAttribute('id'))!);
		await page.keyboard.press('Control+Enter');
		await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', chinese ? '搜索附件' : 'Search attachments');
		// Stable terminal identity replaces its snapshot rather than creating a second chip.
		await picker.getByRole('option', { name: chinese ? '终端…' : 'Terminal…', exact: true }).click();
		await picker.getByRole('option', { name: /Shell \/workspace/ }).click();
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
		await add.press('Enter');
		await picker.getByRole('option', { name: chinese ? '符号…' : 'Symbols…', exact: true }).click();
		await picker.getByRole('combobox').fill('attach');
		await expect(picker.getByRole('option', { name: /attach/ })).toBeVisible();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowUp');
		await expect(picker.getByRole('combobox')).toHaveAttribute('aria-activedescendant', (await picker.getByRole('option', { name: /attach/ }).getAttribute('id'))!);
		await page.keyboard.press('Control+Enter');
		await picker.getByRole('option', { name: chinese ? '搜索结果' : 'Search Results', exact: true }).click();
		await expect(picker).toHaveCount(0);
		await page.evaluate(() => { window.ashChatInputIntegration.changeContextSources(); });
		await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft());
		const names = [chinese ? '终端：Shell' : 'Terminal: Shell', 'attach', chinese ? '搜索结果：needle' : 'Search Results: needle'];
		for (const name of names) await page.getByRole('button', { name: `${chinese ? '打开' : 'Open'} ${name}`, exact: true }).press('Enter');
		await expect(page.getByLabel('Opened sources')).toHaveText(JSON.stringify([
			{ command: 'workbench.action.terminal.focus', resource: 'context-shell' },
			{ resource: 'file:///workspace/symbol.ts#2,1-4,2', options: { fromUserGesture: true, openExternal: false } },
			{ command: 'workbench.action.findInFiles' },
		]));
		await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
		await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
		await expect(page.getByLabel('Submission')).toHaveText(JSON.stringify([
			{ name: names[0], content: 'Terminal: Shell\nDirectory: /workspace\n\ncontext terminal ready' },
			{ name: names[1], content: 'Symbol: attach\nSource: file:///workspace/symbol.ts#2,1-4,2\n\nfunction attach() {\n  return 42;\n}' },
			{ name: names[2], content: 'Matches: 1\n# Search: needle\n# File: file:///workspace/main.ts\n  2:1-2:7: needle' },
		]));
		await expect(page.getByLabel('Opened editor count')).toHaveText('0');
		await expect(page.getByLabel('Context error')).toHaveText('');
	});
}

test('context picker hides unavailable terminal and search sources and lets symbol pickers go back', async ({ page }) => {
	await page.goto('/chatInput.html');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	const picker = page.getByRole('dialog');
	for (const name of ['Terminal…', 'Symbols…', 'Search Results']) await expect(picker.getByRole('option', { name, exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await page.goto('/chatInput.html?contextSources=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	await picker.getByRole('option', { name: 'Symbols…', exact: true }).click();
	await picker.getByRole('option', { name: 'Go back ↩', exact: true }).click();
	await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Search attachments');
	await page.keyboard.press('Escape');
	await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
	await expect(page.locator('.ash-chat-input-attachment-item')).toHaveCount(0);
});

test('stale indexed symbols never attach the code at an outdated range', async ({ page }) => {
	await page.goto('/chatInput.html?contextSources=1&staleSymbol=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	await page.getByRole('dialog').getByRole('option', { name: 'Symbols…', exact: true }).click();
	await page.getByRole('dialog').getByRole('option', { name: /attach/ }).click();
	await expect(page.getByLabel('Context error')).toContainText('The symbol source changed. Search again to attach its current code.');
	await expect(page.locator('.ash-chat-input-attachment-item')).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
});

test('symbol search cancellation discards late provider results after composer disposal', async ({ page }) => {
	await page.goto('/chatInput.html?contextSources=1&deferSymbolSearch=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	const picker = page.getByRole('dialog');
	await picker.getByRole('option', { name: 'Symbols…', exact: true }).click();
	await picker.getByRole('combobox').fill('pending');
	await expect(picker.getByRole('option', { name: /pending/ })).toHaveCount(0);
	await page.evaluate(() => window.ashChatInputIntegration.dispose());
	await page.evaluate(() => window.ashChatInputIntegration.releaseSymbolSearch('pending'));
	await expect(page.getByLabel('Symbol reads')).toContainText('"query":"pending","aborted":true');
	await expect(picker).toHaveCount(0);
	await expect(page.getByLabel('Submission')).toHaveText('');
	await expect(page.getByLabel('Context error')).toHaveText('');
});

for (const locale of ['en', 'zh-CN']) {
	test(`instructions retain their authorized reference through background acceptance and draft restore in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const chinese = locale === 'zh-CN';
		const add = page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true });
		const picker = page.getByRole('dialog');
		await add.press('Enter');
		await picker.getByRole('option', { name: chinese ? '指令…' : 'Instructions…', exact: true }).click();
		await picker.getByRole('combobox').fill('contracts');
		await expect(picker.getByRole('option', { name: /API review/ })).toContainText(chinese ? '目录' : 'Directory');
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowUp');
		await expect(picker.getByRole('combobox')).toHaveAttribute('aria-activedescendant', (await picker.getByRole('option', { name: /API review/ }).getAttribute('id'))!);
		await page.keyboard.press('Control+Enter');
		await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', chinese ? '搜索附件' : 'Search attachments');
		await picker.getByRole('option', { name: chinese ? '指令…' : 'Instructions…', exact: true }).click();
		await picker.getByRole('combobox').fill('review.md');
		await picker.getByRole('option', { name: /API review/ }).click();
		const attachments = page.locator('.ash-chat-input-editor');
		await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
		await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft());
		await attachments.getByRole('button', { name: chinese ? '打开 API review' : 'Open API review', exact: true }).press('Enter');
		await expect(page.getByLabel('Opened sources')).toContainText('file:///workspace/.ash/instructions/review.md');
		await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
		await expect(page.getByLabel('Submission')).toHaveText(JSON.stringify([{ name: 'API review', content: '/workspace/.ash/instructions/review.md', kind: 'instruction' }]));
	});
}

test('instruction availability and catalog errors preserve the composer', async ({ page }) => {
	await page.goto('/chatInput.html?noInstructions=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	await expect(page.getByRole('option', { name: 'Instructions…', exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await page.goto('/chatInput.html?instructionFailure=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	await page.getByRole('option', { name: 'Instructions…', exact: true }).click();
	await expect(page.getByLabel('Context error')).toContainText('Instruction catalog failed');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
});

test('cancelled instruction catalogs cannot recreate a picker or attachment', async ({ page }) => {
	await page.goto('/chatInput.html?deferInstructions=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	await page.getByRole('option', { name: 'Instructions…', exact: true }).click();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog').getByRole('combobox')).toHaveAttribute('placeholder', 'Search attachments');
	await page.keyboard.press('Escape');
	await page.evaluate(() => window.ashChatInputIntegration.releaseInstructions());
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByRole('list', { name: 'Attached context' })).toBeHidden();
	await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
});

for (const locale of ['en', 'zh-CN']) {
	test(`tools attach catalog metadata, hide internal tools and preserve source navigation in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const chinese = locale === 'zh-CN';
		const add = page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true });
		const picker = page.getByRole('dialog');
		await add.press('Enter');
		await picker.getByRole('option', { name: chinese ? '工具…' : 'Tools…', exact: true }).click();
		await expect(picker.getByRole('option', { name: /internal_broker/ })).toHaveCount(0);
		await picker.getByRole('combobox').fill('docs-server');
		await expect(picker.getByRole('option', { name: /^connector_search(?:\s|$)/ })).toHaveCount(1);
		await picker.getByRole('combobox').fill('connector_search');
		await expect(picker.getByRole('option', { name: /^connector_search(?:\s|$)/ })).toBeVisible();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowUp');
		await expect(picker.getByRole('combobox')).toHaveAttribute('aria-activedescendant', (await picker.getByRole('option', { name: /^connector_search(?:\s|$)/ }).getAttribute('id'))!);
		await page.keyboard.press('Control+Enter');
		await picker.getByRole('option', { name: chinese ? '工具…' : 'Tools…', exact: true }).click();
		await picker.getByRole('combobox').fill('source document');
		await picker.getByRole('option', { name: /read_file/ }).click();
		await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft());
		const attachments = page.locator('.ash-chat-input-editor');
		await expect(attachments.getByRole('button', { name: /^(Remove|移除)/ })).toHaveCount(2);
		await attachments.getByRole('button', { name: chinese ? '打开 工具：read_file' : 'Open Tool: read_file', exact: true }).press('Enter');
		await expect(page.getByLabel('Opened sources')).toHaveText(JSON.stringify([{ command: 'workbench.action.openSettings', resource: { section: 'tools' } }]));
		await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
		const contexts = JSON.parse((await page.getByLabel('Submission').textContent())!);
		expect(contexts.map((context: { content: string; }) => JSON.parse(context.content))).toEqual([
			{ name: 'connector_search', description: 'Search external references', source: 'mcp', sourceDetails: ['docs-server'], exposure: 'deferred', authority: 'providerDefined' },
			{ name: 'read_file', description: 'Read a source document', source: 'local', sourceDetails: ['directory'], exposure: 'direct', authority: 'directoryRead' },
		]);
	});
}

test('unavailable tools stay hidden and catalog failure returns focus without attachments', async ({ page }) => {
	await page.goto('/chatInput.html?noTools=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	await expect(page.getByRole('option', { name: 'Tools…', exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await page.goto('/chatInput.html?toolFailure=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	await page.getByRole('option', { name: 'Tools…', exact: true }).click();
	await expect(page.getByLabel('Context error')).toContainText('Tool catalog failed');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByRole('list', { name: 'Attached context' })).toBeHidden();
	await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
});

for (const locale of ['en', 'zh-CN']) {
	test(`tool selection toggles sets and members, discards cancellation and survives send in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?inlineCode=1&locale=${locale}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const chinese = locale === 'zh-CN';
		const add = page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true });
		const picker = page.getByRole('dialog');
		const toolsLabel = chinese ? '工具…' : 'Tools…';
		const configureLabel = chinese ? '配置工具…' : 'Configure tools…';
		const applyLabel = chinese ? '应用工具选择' : 'Apply tool selection';
		const attachments = page.locator('.ash-chat-input-editor');
		const openSelection = async (): Promise<void> => {
			await add.press('Enter');
			await picker.getByRole('option', { name: toolsLabel, exact: true }).click();
			await picker.getByRole('option', { name: configureLabel, exact: true }).click();
		};
		await openSelection();
		await picker.getByRole('combobox').fill('read_file');
		await picker.getByRole('option', { name: /^read_file(?:\s|$)/ }).click();
		await expect(picker.getByRole('option', { name: /^read_file(?:\s|$)/ })).toContainText(chinese ? '已禁用' : 'Disabled');
		await picker.getByRole('combobox').fill('directory');
		await expect(picker.getByRole('option', { name: /directory/ })).toContainText(chinese ? '部分启用' : 'Partly enabled');
		await picker.getByRole('option', { name: /directory/ }).click();
		await expect(picker.getByRole('option', { name: /directory/ })).toContainText(chinese ? '已启用' : 'Enabled');
		await picker.getByRole('option', { name: /directory/ }).click();
		await picker.getByRole('option', { name: applyLabel, exact: true }).click();
		await expect(attachments).toContainText(chinese ? '工具选择：已禁用 2 个' : 'Tool selection: 2 disabled');
		await openSelection();
		await picker.getByRole('combobox').fill('directory');
		await picker.getByRole('option', { name: /directory/ }).click();
		await page.keyboard.press('Escape');
		await expect(attachments).toContainText(chinese ? '工具选择：已禁用 2 个' : 'Tool selection: 2 disabled');
		await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', chinese ? '搜索附件' : 'Search attachments');
		await page.keyboard.press('Escape');
		await expect(picker).toHaveCount(0);
		await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft());
		const message = page.getByRole('textbox', { name: 'Chat message', exact: true });
		await message.press('End');
		await message.pressSequentially('Use only enabled tools');
		await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
		await expect(page.getByLabel('Submission')).toContainText('toolSelection');
		const submitted = JSON.parse((await page.getByLabel('Submission').textContent())!);
		expect(JSON.parse(submitted[0].content)).toEqual(['read_file', 'write_file']);
		await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
		await add.press('Enter');
		await picker.getByRole('option', { name: toolsLabel, exact: true }).click();
		await picker.getByRole('combobox').fill('read_file');
		await expect(picker.getByRole('option', { name: /^read_file(?:\s|$)/ })).toHaveCount(0);
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await attachments.getByRole('button', { name: /^(Remove|移除)/ }).click();
		await openSelection();
		await picker.getByRole('combobox').fill('read_file');
		await expect(picker.getByRole('option', { name: /^read_file(?:\s|$)/ })).toContainText(chinese ? '已启用' : 'Enabled');
		await page.keyboard.press('Escape');
	});
}

test('terminal context uses shell cwd in the picker and attachment while retaining launch cwd fallback', async ({ page }) => {
	await page.goto('/chatInput.html?contextSources=1&terminalCwd=%2Fworkspace%2Fcurrent%3Bfolder');
	await page.waitForFunction(() => Boolean(window.ashChatInputIntegration));
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	const picker = page.getByRole('dialog');
	await picker.getByRole('option', { name: 'Terminal…', exact: true }).click();
	await picker.getByRole('combobox').fill('Shell');
	await picker.getByRole('option', { name: /Shell \/workspace\/current;folder/ }).click();
	await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
	await expect(page.getByLabel('Submission')).toHaveText(JSON.stringify([{ name: 'Terminal: Shell', content: 'Terminal: Shell\nDirectory: /workspace/current;folder\n\ncontext terminal ready' }]));
});

for (const storageDisabled of [false, true]) test(`terminal context retains command text, capability and trust with command storage disabled=${storageDisabled}`, async ({ page }) => {
	await page.goto(`/chatInput.html?contextSources=1&shellHistory=1${storageDisabled ? '&disableCommandStorage=1' : ''}`);
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await page.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	const picker = page.getByRole('dialog');
	await picker.getByRole('option', { name: 'Terminal…', exact: true }).click();
	await picker.getByRole('option', { name: /Shell \/workspace/ }).click();
	await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveValue('Terminal: Shell ');
	await page.evaluate(() => window.ashChatInputIntegration.changeContextSources());
	await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft());
	await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
	const contexts = JSON.parse((await page.getByLabel('Submission').textContent())!) as { content: string; }[];
	const output = 'Terminal: Shell\nDirectory: /workspace\n\ncontext terminal ready';
	expect(contexts[0].content).toBe(output + (storageDisabled ? '' : '\n\n' + JSON.stringify({
		hasRichCommandDetection: true, commands: [
			{ commandId: 'first', status: 'succeeded', exitCode: 0, command: 'echo 中文; "quoted"', isTrusted: true, cwd: '/workspace' },
			{ commandId: 'second', status: 'failed', exitCode: 9, command: 'unverified\ncommand', isTrusted: false, cwd: '/workspace/current' },
		]
	}, null, 2)));
	await expect(page.getByLabel('Context error')).toHaveText('');
});

for (const locale of ['en', 'zh-CN']) {
	test(`terminal snapshot preview survives source disposal and draft handoff in ${locale}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		const chinese = locale === 'zh-CN';
		await page.goto(`/chatInput.html?inlineCode=1&contextSources=1&locale=${locale}&theme=${chinese ? 'hcLight' : 'dark'}`);
		const add = page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true });
		await add.press('Enter');
		const picker = page.getByRole('dialog');
		await picker.getByRole('option', { name: chinese ? '终端…' : 'Terminal…', exact: true }).click();
		await picker.getByRole('option', { name: /Shell \/workspace/ }).click();
		const previewButton = page.getByRole('button', { name: chinese ? '预览终端快照' : 'Preview terminal snapshot', exact: true });
		await expect(previewButton).toBeVisible();
		await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
		await page.evaluate(() => window.ashChatInputIntegration.disposeContextTerminal());
		await page.evaluate(() => window.ashChatInputIntegration.restoreCapturedDraft());
		await previewButton.focus();
		await previewButton.press('Enter');
		const dialog = page.getByRole('dialog', { name: chinese ? '已保存的终端输出：终端：Shell' : 'Saved terminal output: Terminal: Shell', exact: true });
		const preview = dialog.locator('.ash-chat-terminal-preview-screen');
		await expect(preview.locator('.xterm-rows')).toContainText('context terminal ready');
		const input = preview.getByRole('textbox', { name: chinese ? '已保存的终端输出（只读）' : 'Saved terminal output (read only)', exact: true });
		await expect(input).toHaveAttribute('readonly', '');
		await expect.poll(() => preview.boundingBox().then(box => box?.height)).toBe(160);
		const close = dialog.getByRole('button', { name: chinese ? '关闭终端预览' : 'Close terminal preview', exact: true });
		await expect(close).toBeFocused();
		await expect.poll(() => close.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('solid');
		await close.press('Escape');
		await expect(preview).toHaveCount(0);
		await expect(previewButton).toBeFocused();
		await previewButton.press('Enter');
		await expect(dialog.locator('.xterm-rows')).toContainText('context terminal ready');
		await close.click();
		await expect(dialog).toHaveCount(0);
		await expect(previewButton).toBeFocused();
		await page.getByRole('button', { name: chinese ? '移除 终端：Shell' : 'Remove Terminal: Shell', exact: true }).click();
		await expect(previewButton).toHaveCount(0);

		expect(errors).toEqual([]);
	});
}
