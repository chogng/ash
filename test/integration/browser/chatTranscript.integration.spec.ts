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


for (const locale of ['en', 'zh-CN']) {
	test(`persistent user and tool media load in the original Thread and release playback in ${locale}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/chatTranscript.html?locale=${locale}`);
		await page.evaluate(() => window.ashChatTranscriptIntegration.showMedia(false));
		const imageRow = page.locator('[data-item-id="image"]');
		const loadImage = imageRow.getByRole('button', { name: locale === 'en' ? 'Load image' : '加载图片' });
		await loadImage.focus();
		await loadImage.press('Enter');
		await expect(imageRow.locator('img')).toBeVisible();
		await expect.poll(() => imageRow.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(2);
		const imageUrl = await imageRow.locator('img').getAttribute('src');
		await expect(imageRow.locator('figure')).toBeFocused();
		const audioRow = page.locator('[data-item-id="audio"]');
		await audioRow.getByRole('button', { name: locale === 'en' ? 'Load audio' : '加载音频' }).click();
		await expect(audioRow.locator('audio')).toBeVisible();
		const audio = await audioRow.locator('audio').elementHandle();
		await audioRow.locator('audio').evaluate(async player => { await (player as HTMLAudioElement).play(); });
		await expect.poll(() => audioRow.locator('audio').evaluate(player => (player as HTMLAudioElement).paused)).toBe(false);
		await page.evaluate(() => window.ashChatTranscriptIntegration.refreshMedia());
		expect(await audioRow.locator('audio').evaluate((player, previous) => player === previous, audio)).toBe(true);
		await expect(imageRow.locator('img')).toHaveAttribute('src', imageUrl!);
		await expect.poll(() => audioRow.locator('audio').evaluate(player => (player as HTMLAudioElement).paused)).toBe(false);
		const tool = page.locator('.ash-chat-tool-invocation');
		await tool.locator('summary').click();
		await tool.getByRole('button', { name: locale === 'en' ? 'Load image' : '加载图片' }).click();
		await expect(tool.locator('img')).toBeVisible();
		expect(await page.evaluate(() => window.ashChatTranscriptIntegration.mediaState().requests)).toEqual([
			{ sessionId: 'media-session', threadId: 'media-thread', itemId: 'image' },
			{ sessionId: 'media-session', threadId: 'media-thread', itemId: 'audio' },
			{ sessionId: 'media-session', threadId: 'media-thread', itemId: 'result', contentIndex: 1 },
		]);
		await page.evaluate(() => window.ashChatTranscriptIntegration.remove());
		expect(await audio!.evaluate(player => ({ paused: (player as HTMLAudioElement).paused, source: player.getAttribute('src') }))).toEqual({ paused: true, source: null });
		expect(await page.evaluate(async url => { try { await fetch(url!); return false; } catch { return true; } }, imageUrl)).toBe(true);
		await audio?.dispose();
		expect(errors).toEqual([]);
	});
}

test('removing an attachment cancels its read and rejects a late media result', async ({ page }) => {
	await page.goto('/chatTranscript.html');
	await page.evaluate(() => window.ashChatTranscriptIntegration.showMedia(true));
	await page.locator('[data-item-id="image"]').getByRole('button', { name: 'Load image' }).click();
	await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.mediaState().requests.length)).toBe(1);
	await page.evaluate(() => window.ashChatTranscriptIntegration.remove());
	await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.mediaState().aborted)).toBe(true);
	await page.evaluate(() => window.ashChatTranscriptIntegration.finishMedia());
	await expect(page.locator('.ash-chat-media')).toHaveCount(0);
});


test('streaming Markdown retains completed text, one code model, selection and focus through completion', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/chatTranscript.html');
	const first = 'Read this paragraph.\n\n```typescript\nconst first = 1;';
	await page.evaluate(value => window.ashChatTranscriptIntegration.stream(value, false), first);
	const article = page.locator('[data-item-id="stream"]');
	const paragraph = article.locator('p').first();
	const editor = article.locator('.ash-chat-code-block .stanza-editor');
	const original = await editor.elementHandle();
	const paragraphNode = await paragraph.elementHandle();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+A');
	const selection = await page.evaluate(() => window.ashChatTranscriptIntegration.state().selection);
	await page.evaluate(value => window.ashChatTranscriptIntegration.stream(value, false), `${first}\nconst second = 2;`);
	expect(await editor.evaluate((element, previous) => element === previous, original)).toBe(true);
	await expect(editor.locator('.stanza-editor-input')).toBeFocused();
	expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().selection)).toEqual(selection);
	const complete = `${first}\nconst second = 2;\n\x60\x60\x60\n\nDone.`;
	await page.evaluate(value => window.ashChatTranscriptIntegration.stream(value, true), complete);
	expect(await editor.evaluate((element, previous) => element === previous, original)).toBe(true);
	expect(await paragraph.evaluate((element, previous) => element === previous, paragraphNode)).toBe(true);
	await expect(editor.locator('.stanza-editor-input')).toBeFocused();
	expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().editorCount)).toBe(2);
	await article.getByRole('button', { name: 'Copy', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().copied)).toBe('const first = 1;\nconst second = 2;');
	await paragraph.evaluate(element => { const selection = window.getSelection()!; selection.setBaseAndExtent(element.firstChild!, 5, element.firstChild!, 9); });
	await page.evaluate(value => window.ashChatTranscriptIntegration.stream(value, true), `${complete} More.`);
	expect(await page.evaluate(() => window.getSelection()!.toString())).toBe('this');
	await page.evaluate(() => window.ashChatTranscriptIntegration.stream('Rewritten reply.', true));
	await expect(article.locator('.ash-chat-code-block')).toHaveCount(0);
	expect(await page.evaluate(() => window.ashChatTranscriptIntegration.state().editorCount)).toBe(1);
	await original?.dispose();
	await paragraphNode?.dispose();
	expect(errors).toEqual([]);
});

for (const locale of ['en', 'zh-CN']) {
	test(`Skill YAML editing shows precise draft diagnostics, repairs them and completes the directory name in ${locale}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/chatTranscript.html?prompt=1&locale=${locale}`);
		const invalid = '---\nname: review\ndescription: [one, two]\nmetadata:\n  owner: [editor]\nmodel: unknown\n---';
		await page.evaluate(value => window.ashChatTranscriptIntegration.setFile(value, 3, 15), invalid);
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.diagnostics().map(marker => marker.code))).toEqual(['textField', 'metadataShape', 'unknownField']);
		const editor = page.locator('section[aria-label="File editor"] .stanza-editor');
		await editor.locator('.stanza-editor-input').focus();
		await page.keyboard.press('ControlOrMeta+k');
		await page.keyboard.press('ControlOrMeta+i');
		await expect(page.getByText(locale === 'en' ? 'The Skill field description requires a text value.' : 'Skill 字段 description 需要文本值。', { exact: true }).last()).toBeVisible();
		await page.keyboard.press('Escape');
		await page.evaluate(() => window.ashChatTranscriptIntegration.setFile('---\n"name": review\ndescription: >-\n  Review changes.\nmetadata: { owner: editor }\n---', 2, 3));
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.diagnostics())).toEqual([]);
		await page.evaluate(() => window.ashChatTranscriptIntegration.setFile('---\nname: re\ndescription: Review\n---', 2, 9));
		await editor.locator('.stanza-editor-input').focus();
		await page.keyboard.press('Control+Space');
		await expect(page.locator('.stanza-editor-completion-label').getByText('review', { exact: true })).toBeVisible();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file)).toBe('---\nname: review\ndescription: Review\n---');
		await page.evaluate(() => window.ashChatTranscriptIntegration.setFile('---\nname: review\ndescription: Review\nallowed-tools: re\n---', 4, 18));
		await editor.locator('.stanza-editor-input').focus();
		await page.keyboard.press('Control+Space');
		await expect(page.locator('.stanza-editor-completion-label').getByText('read_file', { exact: true })).toBeVisible();
		await expect(page.locator('.stanza-editor-completion-label').getByText('internal_tool', { exact: true })).toHaveCount(0);
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.state().file)).toBe('---\nname: review\ndescription: Review\nallowed-tools: read_file\n---');
		expect(errors).toEqual([]);
	});
}
