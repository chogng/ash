import { expect, test } from '@playwright/test';

for (const locale of ['en', 'zh-CN']) {
	test(`Skill file editing completes header keys and shows their description in ${locale}`, async ({ page }) => {
		await page.goto(`/chatTranscript.html?prompt=1&locale=${locale}`);
		const editor = page.locator('section[aria-label="File editor"] .stanza-editor');
		await editor.locator('.stanza-editor-input').focus();
		await page.keyboard.insertText('de');
		await page.keyboard.press('Control+Space');
		await expect(page.locator('.stanza-editor-completion-label').getByText('description', { exact: true })).toBeVisible();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file)).toBe('---\ndescription: \n---\nBody');
		await page.keyboard.press('Home');
		await page.keyboard.press('ControlOrMeta+k');
		await page.keyboard.press('ControlOrMeta+i');
		const help = locale === 'en' ? 'Required. Describe when this Skill should be used, in 1 to 1024 characters.' : '必填。用 1 到 1024 个字符描述何时使用此 Skill。';
		await expect(page.getByText(help, { exact: true }).last()).toBeVisible();
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`Response code blocks copy safely, insert with undo and open an unsaved file in ${locale}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/chatTranscript.html?locale=${locale}`);
		expect(errors).toEqual([]);
		const block = page.locator('.ash-chat-code-block');
		const copy = block.getByRole('button', { name: locale === 'en' ? 'Copy' : '复制', exact: true });
		const insert = block.getByRole('button', { name: locale === 'en' ? 'Insert at cursor' : '插入到光标处', exact: true });
		const newFile = block.getByRole('button', { name: locale === 'en' ? 'Open in new file' : '在新文件中打开', exact: true });
		await expect(block).toBeVisible();
		await expect(block.locator('img')).toHaveCount(0);
		await copy.focus();
		await copy.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied)).toBe('const code = "<safe>";\nsecond line');
		await expect(copy).toBeFocused();
		await copy.press('ArrowRight');
		await expect(insert).toBeFocused();
		await insert.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file)).toBe('before const code = "<safe>";\nsecond lineafter');
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file)).toBe('before after');
		await newFile.click();
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state())).toMatchObject({ file: 'const code = "<safe>";\nsecond line', resource: expect.stringContaining('untitled:') });
		await page.evaluate(() => window.ashChatTranscriptIntegration.remove());
		await expect(block).toHaveCount(0);
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().editorCount)).toBe(1);
		expect(errors).toEqual([]);
	});
}

test('Response code blocks preserve nodes and selections through wrapping and theme updates and stay read-only', async ({ page }) => {
	await page.goto('/chatTranscript.html');
	const block = page.locator('.ash-chat-code-block');
	const editor = block.locator('.stanza-editor');
	await editor.click();
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.insertText('must not replace response');
	await expect(editor.locator('.stanza-editor-line-text')).toHaveText(['const code = "<safe>";', 'second line']);
	const selection = await page.evaluate(() => window.ashChatTranscriptIntegration.state().selection);
	const original = await editor.elementHandle();
	await page.evaluate(() => window.ashChatTranscriptIntegration.refresh());
	expect(await editor.evaluate((element, previous) => element === previous, original)).toBe(true);
	await page.evaluate(() => window.ashChatTranscriptIntegration.setWrap(true));
	for (const palette of ['dark', 'light', 'hc'] as const) {
		await page.evaluate(value => window.ashChatTranscriptIntegration.setTheme(value), palette);
		await expect(block).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(block).toHaveCSS('border-top-width', '1px');
	}
	expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().selection)).toEqual(selection);
	await block.getByRole('button', { name: 'Copy', exact: true }).focus();
	await expect(block.getByRole('button', { name: 'Copy', exact: true })).toBeFocused();
	await page.evaluate(() => window.ashChatTranscriptIntegration.setReadonly(true));
	await block.getByRole('button', { name: 'Insert at cursor', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().notifications)).toContain('Could not perform the code block action: Error: The active file editor is read-only.');
	await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file)).toBe('before after');
	await original?.dispose();
});

test('Response code blocks cap their viewport while copying the complete long source', async ({ page }) => {
	await page.goto('/chatTranscript.html');
	await page.evaluate(() => window.ashChatTranscriptIntegration.setCodeLineHeight(24));
	const code = await page.evaluate(() => window.ashChatTranscriptIntegration.showLongCode());
	const editor = page.locator('.ash-chat-code-block-editor');
	await expect.poll(() => editor.evaluate(element => element.getBoundingClientRect().height)).toBe(496);
	await page.locator('.ash-chat-code-block').getByRole('button', { name: 'Copy', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied)).toBe(code);
});


for (const locale of ['en', 'zh-CN']) {
	test(`agentHost tool progress retains keyboard focus, expansion and safe content in ${locale}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/chatTranscript.html?locale=${locale}`);
		await page.evaluate(() => window.ashChatTranscriptIntegration.showTool());
		const tool = page.locator('.ash-chat-tool-invocation');
		const summary = tool.locator('summary');
		await expect(tool).not.toHaveAttribute('open');
		await expect(summary).toHaveText(locale === 'en' ? 'shell · Awaiting result' : 'shell · 等待结果');
		await summary.focus();
		await summary.press('Enter');
		await expect(tool).toHaveAttribute('open', '');
		const original = await tool.elementHandle();
		await page.evaluate(() => window.ashChatTranscriptIntegration.updateTool(false));
		expect(await tool.evaluate((element, previous) => element === previous, original)).toBe(true);
		await expect(summary).toBeFocused();
		await expect(tool).toContainText('/remote/project');
		await expect(tool).toContainText('<img src=x onerror=alert(1)>');
		await expect(tool).toContainText('warning');
		await expect(tool.locator('img, script')).toHaveCount(0);
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.openAccessibleView(false))).toBe(true);
		const accessibleText = page.locator('.ash-accessible-view-content');
		await expect(accessibleText).toHaveValue(/<img src=x onerror=alert\(1\)>/);
		await expect(accessibleText).toHaveAttribute('readonly', '');
		await page.evaluate(() => window.ashChatTranscriptIntegration.updateTool(true));
		await expect(accessibleText).toHaveValue(/Denied <script>/);
		await page.keyboard.press('Escape');
		await expect(accessibleText).toHaveCount(0);
		await expect(summary).toBeFocused();
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.openAccessibleView(true))).toBe(true);
		await expect(accessibleText).toHaveValue(locale === 'en' ? /tool summary/ : /工具摘要/);
		await page.keyboard.press('Escape');
		await expect(accessibleText).toHaveCount(0);
		await expect(summary).toHaveText(locale === 'en' ? 'shell · Failed' : 'shell · 失败');
		await expect(summary).toBeFocused();
		await expect(tool).toHaveAttribute('open', '');
		for (const palette of ['dark', 'light', 'hc'] as const) {
			await page.evaluate(value => window.ashChatTranscriptIntegration.setTheme(value), palette);
			await expect(summary).toHaveCSS('outline-style', 'solid');
			expect(await summary.evaluate(element => getComputedStyle(element).outlineColor === getComputedStyle(element).color)).toBe(false);
		}
		await page.evaluate(() => { document.querySelector<HTMLElement>('main')!.style.width = '180px'; });
		expect(await tool.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
		await summary.press('Space');
		await expect(tool).not.toHaveAttribute('open');
		await summary.press('Space');
		await expect(tool).toHaveAttribute('open', '');
		await page.evaluate(() => window.ashChatTranscriptIntegration.remove());
		await expect(tool).toHaveCount(0);
		await page.evaluate(() => window.ashChatTranscriptIntegration.dispose());
		await original?.dispose();
		expect(errors).toEqual([]);
	});
}
