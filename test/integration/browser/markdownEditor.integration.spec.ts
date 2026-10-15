import { expect, test, type Page } from '@playwright/test';
import { startMarkdownParser } from './markdownParserFixture.js';
import { createLargeMarkdownDocument } from './markdownLargeDocument.js';
import { createHash } from 'node:crypto';

let parser: Awaited<ReturnType<typeof startMarkdownParser>>;
test.beforeAll(async () => { test.setTimeout(180000); parser = await startMarkdownParser(); });
test.afterAll(async () => { await parser?.dispose(); });
test.beforeEach(async ({ page }) => {
	await page.route('**/__markdown_parse', async route => {
		try { await route.fulfill({ json: await parser.parse(route.request().postDataJSON()) }); }
		catch (error) { await route.fulfill({ status: 503, json: { error: String(error) } }); }
	});
});

for (const locale of ['en', 'zh-CN']) {
	test(`Markdown rich editor renders math and ordinary Markdown (${locale})`, async ({ page }, testInfo) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/markdownEditor.html?locale=${locale}`);
		const content = page.locator('.ash-markdown-content');
		await expect(content).toContainText('中文段落');
		await expect(content.getByRole('heading', { name: 'Markdown audit', exact: true, level: 1 })).toBeVisible();
		await expect(content.locator('strong')).toContainText('bold');
		await expect(content.getByRole('link', { name: 'a link', exact: true })).toHaveAttribute('href', 'https://example.com/');
		await expect(content.locator('.katex')).toHaveCount(2);
		await expect(content.locator('.katex-display')).toHaveCount(1);
		await expect(content.locator('.katex-error')).toHaveCount(0);
		await expect(content.locator('table')).toContainText('42');
		await expect(content.locator('pre')).toContainText('const answer = 42;');
		await expect(content.getByRole('checkbox')).toBeChecked();
		await page.evaluate(() => document.fonts.ready);
		const formulaBounds = await content.locator('.katex-display').boundingBox();
		expect(formulaBounds && formulaBounds.width > 0 && formulaBounds.height > 0).toBe(true);
		expect(await page.evaluate(() => [...document.fonts].filter(font => font.family.startsWith('KaTeX')).some(font => font.status === 'loaded'))).toBe(true);
		expect(errors).toEqual([]);
		await page.screenshot({ path: testInfo.outputPath(`markdown-editor-${locale}.png`), fullPage: true });
	});
}

test('Markdown rich editor updates formulas and refuses untrusted math resources', async ({ page }) => {
	const requests: string[] = [];
	await page.route('https://audit-image.invalid/**', async route => { requests.push(route.request().url()); await route.abort(); });
	await page.goto('/markdownEditor.html');
	const content = page.locator('.ash-markdown-content');
	await expect(content.locator('.katex')).toHaveCount(2);
	const text = '# Updated\n\n$$\n\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}\n$$\n\n$\\includegraphics{https://audit-image.invalid/pixel}$\n\n$\\unknownAuditCommand$';
	await page.evaluate(text => window.postMessage({ type: 'document', version: 2, text, readOnly: true }, location.origin), text);
	await expect(content.getByRole('heading', { name: 'Updated', exact: true, level: 1 })).toBeVisible();
	await expect(content.locator('.katex-display')).toHaveCount(1);
	await expect(content.locator('.katex-display')).toContainText('a');
	await expect(content.locator('.katex-display')).toContainText('d');
	await expect(content.locator('img[src]')).toHaveCount(0);
	await expect(content).toContainText('unknownAuditCommand');
	expect(requests).toEqual([]);
});

async function openHost(page: Page, locale = 'en') {
	await page.goto(`/markdownEditorHost.html?locale=${locale}`);
	await expect.poll(() => page.evaluate(() => window.ashMarkdownHost?.sharedModel)).toBe(true);
	const frame = page.frameLocator('#editor iframe').frameLocator('iframe');
	await expect(frame.getByRole('heading', { name: '标题', exact: true })).toBeVisible();
	return frame;
}

test('real Rust extension and shared host preserve Chinese composition, source, saves and history', async ({ page, context }, testInfo) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	const frame = await openHost(page);
	const initial = await page.evaluate(() => window.ashMarkdownHost.text);
	const savedInitial = await page.evaluate(() => window.ashMarkdownHost.saved);
	await frame.locator('.ash-markdown-block').filter({ hasText: '中文段落' }).click();
	const input = frame.getByRole('textbox', { name: 'Edit Markdown block', exact: true });
	await expect(input).toBeFocused();
	await input.evaluate((element: HTMLTextAreaElement) => { const offset = element.value.indexOf('中文段落') + 4; element.setSelectionRange(offset, offset); });
	const session = await context.newCDPSession(page);
	await session.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
	expect(await page.evaluate(() => window.ashMarkdownHost.text)).toBe(initial);
	await session.send('Input.imeSetComposition', { text: '中文输入😀', selectionStart: 6, selectionEnd: 6 });
	expect(await page.evaluate(() => window.ashMarkdownHost.text)).toBe(initial);
	await session.send('Input.insertText', { text: '中文输入😀' });
	const expected = initial.replace('中文段落', '中文段落中文输入😀');
	await expect.poll(() => page.evaluate(() => window.ashMarkdownHost.text)).toBe(expected);
	expect(await page.evaluate(() => window.ashMarkdownHost.saved)).toBe(savedInitial);
	await input.press('Control+s');
	await expect.poll(() => page.evaluate(() => window.ashMarkdownHost.saved)).toBe(expected);
	await expect.poll(() => page.evaluate(() => window.ashMarkdownHost.dirty)).toBe(false);
	await input.press('Control+z');
	await expect.poll(() => page.evaluate(() => window.ashMarkdownHost.text)).toBe(initial);
	await expect.poll(() => page.evaluate(() => window.ashMarkdownHost.dirty)).toBe(true);
	await expect(frame.getByRole('textbox', { name: 'Edit Markdown block', exact: true })).toHaveValue(/中文段落 \*\*保留加粗\*\*/u);
	await frame.getByRole('textbox', { name: 'Edit Markdown block', exact: true }).press('Control+Shift+z');
	await expect.poll(() => page.evaluate(() => window.ashMarkdownHost.text)).toBe(expected);
	// The source view's undo acts on exactly the same history as the rich view.
	await page.evaluate(() => window.ashMarkdownHost.undo());
	await expect.poll(() => page.evaluate(() => window.ashMarkdownHost.text)).toBe(initial);
	await page.evaluate(() => window.ashMarkdownHost.redo());
	await expect.poll(() => page.evaluate(() => window.ashMarkdownHost.text)).toBe(expected);
	await frame.getByRole('textbox', { name: 'Edit Markdown block', exact: true }).press('Escape');
	await expect(frame.locator('strong')).toContainText('保留加粗');
	await expect(frame.getByRole('link', { name: '引用' })).toHaveAttribute('href', 'https://example.com');
	expect(errors).toEqual([]);
	await page.screenshot({ path: testInfo.outputPath('ash-markdown-rust-host.png'), fullPage: true });
	await session.detach();
});

test('external edits during composition retain the draft and never overwrite the shared source', async ({ page, context }) => {
	const frame = await openHost(page, 'zh-CN');
	await frame.locator('.ash-markdown-block').filter({ hasText: '中文段落' }).click();
	const input = frame.getByRole('textbox', { name: '编辑 Markdown 段落', exact: true });
	const session = await context.newCDPSession(page);
	await session.send('Input.imeSetComposition', { text: '保留草稿', selectionStart: 4, selectionEnd: 4 });
	const external = await page.evaluate(() => {
		window.ashMarkdownHost.edit(0, 0, 'External\r\n');
		return window.ashMarkdownHost.text;
	});
	await expect(frame.getByRole('status')).toContainText('草稿');
	await session.send('Input.insertText', { text: '保留草稿' });
	await expect(input).toHaveValue(/保留草稿/u);
	expect(await page.evaluate(() => window.ashMarkdownHost.text)).toBe(external);
	await expect(input).toHaveAttribute('readonly', '');
	await frame.getByRole('button', { name: '重新载入文档', exact: true }).click();
	await expect(frame.getByRole('status')).toBeEmpty();
	expect(await page.evaluate(() => window.ashMarkdownHost.text)).toBe(external);
	await session.detach();
});

test('keyboard formatting and whole-source edits preserve unrelated CRLF and reference definitions', async ({ page }) => {
	const frame = await openHost(page);
	const initial = await page.evaluate(() => window.ashMarkdownHost.text);
	await frame.getByRole('button', { name: 'Edit document source', exact: true }).click();
	const input = frame.getByRole('textbox', { name: 'Edit document source', exact: true });
	await input.evaluate((element: HTMLTextAreaElement) => { const offset = element.value.indexOf('中文段落'); element.setSelectionRange(offset, offset + 4); });
	await input.press('Control+b');
	await expect.poll(() => page.evaluate(() => window.ashMarkdownHost.text)).toBe(initial.replace('中文段落', '**中文段落**'));
	await input.press('Control+b');
	await expect.poll(() => page.evaluate(() => window.ashMarkdownHost.text)).toBe(initial);
	await input.press('Control+b');
	await expect.poll(() => page.evaluate(() => window.ashMarkdownHost.text)).toBe(initial.replace('中文段落', '**中文段落**'));
	await input.press('Control+z');
	await expect.poll(() => page.evaluate(() => window.ashMarkdownHost.text)).toBe(initial);
	await frame.getByRole('textbox', { name: 'Edit document source', exact: true }).press('Alt+F10');
	await expect(frame.getByRole('button', { name: 'Bold', exact: true })).toBeFocused();
	await frame.getByRole('button', { name: 'Bold', exact: true }).press('ArrowRight');
	await expect(frame.getByRole('button', { name: 'Italic', exact: true })).toBeFocused();
	await frame.getByRole('button', { name: 'Italic', exact: true }).press('Escape');
	await expect(frame.getByRole('textbox', { name: 'Edit document source', exact: true })).toBeFocused();
});

test('readonly Markdown remains inert and blocks HTML, unsafe links and remote image requests', async ({ page }) => {
	const requests: string[] = [];
	await page.route('https://audit-image.invalid/**', async route => { requests.push(route.request().url()); await route.abort(); });
	await page.goto('/markdownEditor.html');
	await expect(page.locator('.ash-markdown-content')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeDisabled();
	await expect(page.getByRole('checkbox')).toBeDisabled();
	const text = '# Safe\n\n<script>window.auditExecuted=true</script>\n\n[unsafe](javascript:alert(1))\n\n![tracking](https://audit-image.invalid/pixel)\n\n- [ ] Readonly';
	await page.evaluate(text => window.postMessage({ type: 'document', version: 2, text, readOnly: true }, location.origin), text);
	await expect(page.getByRole('heading', { name: 'Safe', exact: true })).toBeVisible();
	await expect(page.locator('.ash-markdown-content script, .ash-markdown-content img, .ash-markdown-content a')).toHaveCount(0);
	await page.getByRole('heading', { name: 'Safe', exact: true }).click();
	await expect(page.locator('.ash-markdown-input')).toHaveCount(0);
	expect(requests).toEqual([]);
});

test('unavailable Rust provider retains source editing, exact saves and a Chinese error', async ({ page }) => {
	await page.route('**/__markdown_parse', route => route.fulfill({ status: 503, json: { error: 'Provider disabled' } }));
	await page.goto('/markdownEditorHost.html?locale=zh-CN');
	await expect.poll(() => page.evaluate(() => window.ashMarkdownHost?.sharedModel)).toBe(true);
	const frame = page.frameLocator('#editor iframe').frameLocator('iframe');
	await expect(frame.getByRole('status')).toContainText('Rust Markdown 解析扩展不可用');
	await frame.getByRole('button', { name: '编辑全文源码', exact: true }).click();
	const input = frame.getByRole('textbox', { name: '编辑全文源码', exact: true });
	const initial = await page.evaluate(() => window.ashMarkdownHost.initial);
	await input.fill(initial.replace(/\r\n/gu, '\n') + '尾部😀');
	await expect.poll(() => page.evaluate(() => window.ashMarkdownHost.text)).toBe(initial + '尾部😀');
	await input.press('Control+s');
	await expect.poll(() => page.evaluate(() => window.ashMarkdownHost.saved)).toBe(initial + '尾部😀');
	await input.press('Control+z');
	await expect.poll(() => page.evaluate(() => window.ashMarkdownHost.text)).toBe(initial);
});

test('an older Rust parse cannot replace a newer source version', async ({ page }) => {
	const frame = await openHost(page);
	let release!: () => void;
	let entered!: () => void;
	const started = new Promise<void>(resolve => entered = resolve);
	const waiting = new Promise<void>(resolve => release = resolve);
	await page.route('**/__markdown_parse', async route => {
		const snapshot = route.request().postDataJSON();
		const result = await parser.parse(snapshot);
		if (snapshot.text.includes('较旧标题')) { entered(); await waiting; }
		await route.fulfill({ json: result });
	});
	try {
		await page.evaluate(() => { const start = window.ashMarkdownHost.text.indexOf('标题'); window.ashMarkdownHost.edit(start, start + 2, '较旧标题'); });
		await started;
		await page.evaluate(() => { const start = window.ashMarkdownHost.text.indexOf('较旧标题'); window.ashMarkdownHost.edit(start, start + 4, '最新标题'); });
		await expect(frame.getByRole('heading', { name: '最新标题', exact: true })).toBeVisible();
		release();
		await expect.poll(() => page.evaluate(() => window.ashMarkdownHost.text)).toContain('# 最新标题');
		await expect(frame.getByRole('heading', { name: '最新标题', exact: true })).toBeVisible();
		await expect(frame.getByRole('heading', { name: '较旧标题', exact: true })).toHaveCount(0);
	} finally { release(); }
});

test('multi-megabyte source crosses the actual Worker boundary and retains saves and shared undo', async ({ page, context }, testInfo) => {
	test.setTimeout(120000);
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	const initial = createLargeMarkdownDocument();
	expect(Buffer.byteLength(initial)).toBeGreaterThan(4 * 1024 * 1024);
	const hash = (text: string) => createHash('sha256').update(text).digest('hex');
	const originalHash = hash(initial);
	const expectedHash = hash(initial.replace('中文段落', '中文段落大文件输入😀'));
	const digest = (saved = false) => page.evaluate(async saved => {
		const text = saved ? window.ashMarkdownHost.saved : window.ashMarkdownHost.text;
		return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(value => value.toString(16).padStart(2, '0')).join('');
	}, saved);
	await page.goto('/markdownEditorHost.html?large=1');
	const frame = page.frameLocator('#editor iframe').frameLocator('iframe');
	await expect(frame.getByRole('heading', { name: '大文件 Markdown', exact: true })).toBeVisible({ timeout: 60000 });
	await expect(frame.locator('.ash-markdown-content p')).toHaveCount(9002);
	await expect(frame.getByRole('status')).toBeEmpty();
	expect(await digest()).toBe(originalHash);
	await frame.locator('.ash-markdown-block').filter({ hasText: '中文段落' }).click();
	let input = frame.getByRole('textbox', { name: 'Edit Markdown block', exact: true });
	await input.evaluate((element: HTMLTextAreaElement) => { const offset = element.value.indexOf('中文段落') + 4; element.setSelectionRange(offset, offset); });
	const session = await context.newCDPSession(page);
	await session.send('Input.imeSetComposition', { text: '大文件输入😀', selectionStart: 7, selectionEnd: 7 });
	expect(await digest()).toBe(originalHash);
	await session.send('Input.insertText', { text: '大文件输入😀' });
	await expect.poll(() => digest(), { timeout: 30000 }).toBe(expectedHash);
	await input.press('Control+s');
	await expect.poll(() => digest(true), { timeout: 30000 }).toBe(expectedHash);
	await input.press('Control+z');
	await expect.poll(() => digest(), { timeout: 30000 }).toBe(originalHash);
	input = frame.getByRole('textbox', { name: 'Edit Markdown block', exact: true });
	await expect(input).not.toHaveValue(/大文件输入/u, { timeout: 30000 });
	await input.press('Control+Shift+z');
	await expect.poll(() => digest(), { timeout: 30000 }).toBe(expectedHash);
	await page.evaluate(() => window.ashMarkdownHost.undo());
	await expect.poll(() => digest(), { timeout: 30000 }).toBe(originalHash);
	await expect(frame.getByRole('textbox', { name: 'Edit Markdown block', exact: true })).not.toHaveValue(/大文件输入/u, { timeout: 30000 });
	await page.evaluate(() => window.ashMarkdownHost.redo());
	await expect.poll(() => digest(), { timeout: 30000 }).toBe(expectedHash);
	await expect(frame.getByRole('textbox', { name: 'Edit Markdown block', exact: true })).toHaveValue(/大文件输入/u, { timeout: 30000 });
	await frame.getByRole('textbox', { name: 'Edit Markdown block', exact: true }).press('Escape');
	await expect(frame.getByRole('heading', { name: '大文件 Markdown', exact: true })).toBeVisible();
	expect(errors).toEqual([]);
	await page.screenshot({ path: testInfo.outputPath('markdown-large-source.png') });
	await session.detach();
});
