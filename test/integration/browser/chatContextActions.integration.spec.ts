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
		await expect(attachments.getByRole('listitem')).toHaveCount(1);
		await expect(attachments).toContainText('edited.ts');
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
	await expect(attachments.getByRole('listitem')).toHaveCount(1);
	await expect(picker.getByRole('combobox')).toBeFocused();
	await picker.getByRole('combobox').fill('nested');
	await expect(picker.getByRole('option', { name: /nested.txt/ })).toBeVisible();
	await page.keyboard.press('Control+Enter');
	await expect(attachments.getByRole('listitem')).toHaveCount(2);
	await picker.getByRole('combobox').fill('edited');
	await page.keyboard.press('Control+Enter');
	await expect(attachments.getByRole('listitem')).toHaveCount(2);
	await page.keyboard.press('Escape');
	await expect(picker).toHaveCount(0);
	await expect(page.getByLabel('Opened editor count')).toHaveText('0');
	await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
	await expect(page.getByLabel('Submission')).toHaveText(JSON.stringify([
		{ name: 'edited.ts', content: 'Unsaved editor text' },
		{ name: 'nested.txt', content: 'Workspace file content' },
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
		await expect(attachments.getByRole('listitem')).toHaveCount(3);
		await expect(attachments.getByRole('img')).toHaveCount(2);
		await page.locator('[data-action-id="ash.chat.input.send"] button').press('Enter');
		const contexts = JSON.parse((await page.getByLabel('Submission').textContent())!) as { name: string; content: string; kind?: string; }[];
		expect(contexts.slice(0, 2).map(item => item.kind)).toEqual(['image', 'image']);
		expect(contexts[0].content).toMatch(/^data:image\/png;base64,/);
		expect(contexts[1].content).toBe(contexts[0].content);
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
		await expect(picker.getByRole('option')).toHaveCount(1);
		await page.keyboard.press('Enter');
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
		await expect(picker.getByRole('option')).toHaveCount(0);
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
	await picker.getByRole('option').click();
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
	await expect(page.getByRole('list', { name: 'Attached context' }).getByRole('listitem')).toHaveCount(1);
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
