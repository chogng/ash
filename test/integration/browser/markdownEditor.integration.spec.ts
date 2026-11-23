import { expect, test, type Locator, type Page } from '@playwright/test';
import { startMarkdownExtension, startMarkdownMathExtension } from '../../fixtures/markdownExtension.js';
import { trackDocumentStyles } from '../../fixtures/browser/documentStyles.js';

let parser: Awaited<ReturnType<typeof startMarkdownExtension>>;
let chinese: Awaited<ReturnType<typeof startMarkdownExtension>>;
let math: Awaited<ReturnType<typeof startMarkdownMathExtension>>;

test.beforeAll(async () => {
	test.setTimeout(600000);
	parser = await startMarkdownExtension();
	chinese = await startMarkdownExtension('zh-CN');
	math = await startMarkdownMathExtension();
});
test.afterAll(async () => { await Promise.all([parser?.dispose(), chinese?.dispose(), math?.dispose()]); });
test.beforeEach(async ({ page }) => {
	await page.route('**/__markdown_extension?*', async route => {
		const extension = new URL(route.request().url()).searchParams.get('locale') === 'zh-CN' ? chinese : parser;
		await route.fulfill({ json: { generation: 1, extensions: [{ id: 'ash.markdown-language-features', version: '1.0.0', packageDigest: `sha256:${'a'.repeat(64)}`, runtimeApiVersion: 1, activationGeneration: 1, incarnation: 1, lifecycle: 'ready', failure: null, stderr: '', outputEvents: [], registrations: extension.registrations }] } });
	});
	await page.route('**/__markdown_render**', async route => {
		try {
			const query = new URL(route.request().url()).searchParams;
			const extension = query.get('locale') === 'zh-CN' ? chinese : parser;
			await route.fulfill({ json: await extension.render(query.get('view') ?? 'vscode.markdown.preview.editor', { document: { languageId: 'markdown', ...route.request().postDataJSON() } }) });
		} catch (error) { await route.fulfill({ status: 503, json: { error: String(error) } }); }
	});
	await page.route('**/__markdown_math', async route => {
		if (route.request().method() === 'POST') {
			await route.fulfill({ json: await math.invoke('math.render.v2', 'receiveData', route.request().postDataJSON()) });
		} else {
			await route.fulfill({ json: { generation: 1, extensions: [{ id: 'ash.markdown-math', version: '1', packageDigest: `sha256:${'a'.repeat(64)}`, runtimeApiVersion: 1, activationGeneration: 1, incarnation: 1, lifecycle: 'ready', registrations: math.registrations, outputEvents: [] }] } });
		}
	});
});

async function openPreview(page: Page) {
	await page.goto('/markdownEditorHost.html?view=vscode.markdown.preview.editor');
	await expect.poll(() => page.evaluate(() => window.ashMarkdownHost?.sharedModel)).toBe(true);
	const frame = page.frameLocator('#editor iframe').frameLocator('iframe');
	await expect(frame.locator('#markdown-preview')).toBeVisible();
	return frame;
}

test('Markdown preview applies typography updates through the Rust provider and rejects invalid sandbox styles', async ({ page }) => {
	const preview: Record<string, unknown> = { fontFamily: 'Georgia, serif', codeFontFamily: '"Courier New", monospace', blockquoteFontFamily: 'Arial, sans-serif', fontSize: 20, lineHeight: 2 };
	const runtime = await startMarkdownExtension('en', [], { markdown: { preview } });
	try {
		await page.route('**/__markdown_render**', async route => {
			await route.fulfill({ json: await runtime.render('vscode.markdown.preview.editor', { document: { languageId: 'markdown', ...route.request().postDataJSON() } }) });
		});
		const frame = await openPreview(page);
		const main = frame.locator('main');
		await page.evaluate(() => window.ashMarkdownHost.edit(0, 0, '> Quoted text with `inline code`\n>\n> ```js\n> const quoted = true;\n> ```\n\nBody with `inline code`\n\n```js\nconst body = true;\n```\n\n'));
		await expect(main.locator('blockquote')).toHaveCSS('font-family', 'Arial, sans-serif');
		for (const selector of ['blockquote code', 'blockquote pre', 'main > p code', 'main > pre']) {
			expect(await frame.locator(selector).count()).toBeGreaterThan(0);
			for (const element of await frame.locator(selector).all()) await expect(element).toHaveCSS('font-family', '"Courier New", monospace');
		}
		await expect(main).toHaveCSS('font-family', 'Georgia, serif');
		await expect(main).toHaveCSS('font-size', '20px');
		await expect(main).toHaveCSS('line-height', '40px');
		await expect(main.locator('h1')).toHaveCSS('font-size', '40px');
		await main.evaluate(element => element.setAttribute('data-retained', 'true'));
		Object.assign(preview, { fontFamily: 'Arial, sans-serif', codeFontFamily: 'monospace', blockquoteFontFamily: '', fontSize: 18, lineHeight: 1.5 });
		await page.evaluate(() => window.ashMarkdownHost.edit(0, 0, '# Updated typography\n\n'));
		await expect(main.getByRole('heading', { name: 'Updated typography', exact: true })).toBeVisible();
		await expect(main).toHaveCSS('font-family', 'Arial, sans-serif');
		await expect(main.locator('blockquote')).toHaveCSS('font-family', 'Arial, sans-serif');
		await expect(main.locator('blockquote code').first()).toHaveCSS('font-family', 'monospace');
		await expect(main).toHaveCSS('font-size', '18px');
		await expect(main).toHaveCSS('line-height', '27px');
		await expect(main).toHaveAttribute('data-retained', 'true');
		Object.assign(preview, { fontFamily: 'serif; color: red', codeFontFamily: 'monospace; color: red', blockquoteFontFamily: 'serif; color: red', fontSize: '18px', lineHeight: 0 });
		await page.evaluate(() => window.ashMarkdownHost.edit(0, 0, '# Invalid styles\n\n'));
		await expect(main.getByRole('heading', { name: 'Invalid styles', exact: true })).toBeVisible();
		await expect(main).toHaveCSS('font-size', '13px');
		await expect(main).toHaveCSS('line-height', '22.75px');
		expect(await main.evaluate(element => getComputedStyle(element).fontFamily)).toContain('system-ui');
		expect(await main.locator('blockquote').evaluate(element => getComputedStyle(element).fontFamily)).toContain('system-ui');
		await expect(main.locator('blockquote code').first()).toHaveCSS('font-family', 'ui-monospace, Consolas, monospace');
	} finally {
		await runtime.dispose();
	}
});

test('Markdown preview preserves sandbox and host styles on disposal', async ({ page }) => {
	const frame = await openPreview(page);
	await using outer = await trackDocumentStyles(page.locator('html'));
	// The first update transfers theme variables from the bootstrap stylesheet
	// to the sandbox root's inline style. Compare later updates in that state.
	await page.evaluate(() => window.ashMarkdownHost.edit(0, window.ashMarkdownHost.text.length, '# Update 1\n\n$E=mc^2$\n'));
	await expect(frame.getByRole('heading', { name: 'Update 1', exact: true })).toBeVisible();
	await expect(frame.locator('.katex')).toHaveCount(1);
	await outer.assertUnchanged();
	// Release frame handles before disposal removes their execution context.
	{
		await using inner = await trackDocumentStyles(frame.locator('html'));
		for (let version = 2; version <= 4; version++) {
			await page.evaluate(version => window.ashMarkdownHost.edit(0, window.ashMarkdownHost.text.length, `# Update ${version}\n\n$E=mc^2$\n`), version);
			await expect(frame.getByRole('heading', { name: `Update ${version}`, exact: true })).toBeVisible();
			await expect(frame.locator('.katex')).toHaveCount(1);
			await inner.assertUnchanged();
			await outer.assertUnchanged();
		}
	}
	await page.evaluate(() => window.ashMarkdownHost.disable());
	await outer.assertUnchanged();
	// The fixture owns the view lifetime through pagehide, including its iframe.
	await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
	await expect(page.locator('#editor iframe')).toHaveCount(0);
	await outer.assertUnchanged();
});

test('preview updates keep the sandbox, focus, selection and scroll while rendering metadata, anchors and math', async ({ page }) => {
	const frame = await openPreview(page);
	expect(await page.evaluate(() => window.ashMarkdownHost.editable)).toBe(false);
	const content = '---\ntitle: hidden metadata\n---\n\n# Cafe\u0301\n\n[Jump](#CAFE%CC%81)\n\n$E=mc^2$\n\n' + 'A stable paragraph with words.\n\n'.repeat(100) + 'Last paragraph.\n';
	await page.evaluate(text => window.ashMarkdownHost.edit(0, window.ashMarkdownHost.text.length, text), content);
	await expect(frame.locator('#markdown-preview .katex')).toHaveCount(1);
	await expect(frame.locator('#markdown-preview')).not.toContainText('hidden metadata');
	const heading = frame.getByRole('heading', { name: 'Cafe\u0301', exact: true });
	await expect(heading).toHaveAttribute('id', 'cafe\u0301');
	await frame.getByRole('link', { name: 'Jump' }).click();
	await expect(heading).toBeFocused();
	await frame.locator('#markdown-preview').evaluate(element => {
		element.setAttribute('data-retained', 'true');
		const paragraph = element.querySelector('p:nth-last-child(2)')!;
		const selection = getSelection()!; selection.setBaseAndExtent(paragraph.firstChild!, 2, paragraph.firstChild!, 8);
		document.scrollingElement!.scrollTop = 600;
	});
	await page.evaluate(() => { const text = window.ashMarkdownHost.text; window.ashMarkdownHost.edit(text.indexOf('Last paragraph.'), text.length, 'Changed ending.\n'); });
	await expect(frame.locator('#markdown-preview')).toContainText('Changed ending.');
	await expect(frame.locator('#markdown-preview')).toHaveAttribute('data-retained', 'true');
	await expect(heading).toBeFocused();
	expect(await frame.locator('#markdown-preview').evaluate(() => ({ selection: getSelection()!.toString(), scroll: document.scrollingElement!.scrollTop }))).toEqual({ selection: 'stable', scroll: 600 });
	await expect(frame.locator('textarea')).toHaveCount(0);
});

test('disabling math refreshes an open preview without changing its source', async ({ page }) => {
	const runtime = await startMarkdownExtension();
	try {
		await page.route('**/__markdown_render**', async route => {
			const query = new URL(route.request().url()).searchParams;
			await route.fulfill({ json: await runtime.render(query.get('view') ?? 'vscode.markdown.preview.editor', { document: { languageId: 'markdown', ...route.request().postDataJSON() } }) });
		});
		const frame = await openPreview(page);
		const text = '# Math\n\n$E=mc^2$\n';
		await page.evaluate(text => window.ashMarkdownHost.edit(0, window.ashMarkdownHost.text.length, text), text);
		await expect(frame.locator('.katex')).toHaveCount(1);
		const expectedSource = await page.evaluate(() => window.ashMarkdownHost.text);
		await runtime.disableMath();
		await page.evaluate(() => window.ashMarkdownHost.refreshPackages());
		await expect(frame.locator('.katex')).toHaveCount(0);
		await expect(frame.locator('#markdown-preview')).toContainText('E=mc^2');
		expect(await page.evaluate(() => window.ashMarkdownHost.text)).toBe(expectedSource);
	} finally { await runtime.dispose(); }
});

async function openArkdown(page: Page, options: { locale?: string; readOnly?: boolean; } = {}) {
	await page.goto(`/markdownEditorHost.html?locale=${options.locale ?? 'en'}${options.readOnly ? '&readOnly' : ''}`);
	await expect.poll(() => page.evaluate(() => window.ashMarkdownHost?.sharedModel)).toBe(true);
	await expect(page.locator('#editor iframe')).toHaveCount(0);
	const body = page.locator('.stanza-arkdown-prose');
	await expect(body).toBeVisible();
	return body;
}

async function setSource(page: Page, source: string) {
	await page.evaluate(text => window.ashMarkdownHost.edit(0, window.ashMarkdownHost.text.length, text), source);
}

async function selectInline(body: Locator, text: string, start = text.length, end = start) {
	await body.focus();
	await body.evaluate((element, selection) => {
		const nodes = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
			const offset = node.textContent!.indexOf(selection.text);
			if (offset === -1) continue;
			element.ownerDocument.getSelection()!.setBaseAndExtent(node, offset + selection.start, node, offset + selection.end);
			return;
		}
		throw new Error('Text selection target not found');
	}, { text, start, end });
}

for (const locale of ['en', 'zh-CN']) {
	test(`native Markdown editor renders themed formulas and ordinary Markdown (${locale})`, async ({ page }) => {
		const body = await openArkdown(page, { locale });
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await setSource(page, '# Markdown audit\n\n中文段落 **bold** [a link](https://example.com/) and $x^2$.\n\n```math\n\\frac{1}{2}\n```\n\n| A |\n| --- |\n| 42 |\n\n- [x] Done\n');
		await expect(body.getByRole('heading', { name: 'Markdown audit', level: 1 })).toBeVisible();
		await expect(body.getByRole('link', { name: 'a link' })).toHaveAttribute('href', 'https://example.com/');
		await expect(body.locator('strong')).toHaveText('bold');
		await expect(body.locator('.katex')).toHaveCount(2);
		await expect(body.locator('.katex-display')).toHaveCount(1);
		await expect(body.locator('table')).toContainText('42');
		await expect(body.getByRole('checkbox')).toBeChecked();
		await page.evaluate(() => document.fonts.ready);
		await using styles = await trackDocumentStyles(page.locator('html'));
		await setSource(page, '# Updated\n\n$$\n\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}\n$$\n\n$\\unknownAuditCommand$');
		await expect(body.locator('.katex-display')).toContainText('d');
		await expect(body.locator('[data-math-diagnostic]')).toHaveCount(1);
		await styles.assertUnchanged();
		expect(errors).toEqual([]);
	});
}

test('native Markdown updates task progress and writes localized JSON fields as one undo step', async ({ page }) => {
	const body = await openArkdown(page, { locale: 'zh-CN' });
	const source = [
		'# 中文😀', '', '- [ ] 发布', '', '```widget:task-progress', '```', '',
		'```widget:json', '{ "渠道😀" : "预览", "审核": false, "重试": 1.00 }', '```', '',
		'```widget:json', '{ "nested": [] }', '```', '',
	].join('\r\n');
	await setSource(page, source);
	const progress = body.getByRole('progressbar', { name: '任务进度' });
	await expect(progress).toHaveAttribute('aria-valuetext', '已完成 0 项，共 1 项');
	const task = body.getByRole('checkbox', { name: '任务：发布' });
	await task.press('Space');
	await expect(task).toBeChecked();
	await expect(progress).toHaveAttribute('aria-valuetext', '已完成 1 项，共 1 项');
	const toggled = await page.evaluate(() => window.ashMarkdownHost.text);
	const form = body.getByRole('form', { name: 'JSON 表单' });
	await expect(body.locator('pre')).toContainText('{ "nested": [] }');
	await form.getByRole('textbox', { name: '渠道😀' }).fill('稳定 "版本"');
	await form.getByRole('checkbox', { name: '审核' }).check();
	await form.getByRole('button', { name: '应用更改' }).press('Enter');
	const edited = toggled.replace('"预览"', JSON.stringify('稳定 "版本"')).replace('false', 'true');
	await expect.poll(() => page.evaluate(() => window.ashMarkdownHost.text)).toBe(edited);
	await expect(form.getByRole('textbox', { name: '重试' })).toHaveValue('1.00');
	await page.evaluate(() => window.ashMarkdownHost.undo());
	await expect.poll(() => page.evaluate(() => window.ashMarkdownHost.text)).toBe(toggled);
	await expect(form.getByRole('textbox', { name: '渠道😀' })).toHaveValue('预览');
});

test('native Markdown shares Chinese composition, undo, and saves with the source model', async ({ page, context }) => {
	const body = await openArkdown(page);
	const heading = body.getByRole('heading', { name: '标题' });
	await heading.evaluate(element => element.setAttribute('data-retained', 'true'));
	const initial = await page.evaluate(() => window.ashMarkdownHost.text);
	await selectInline(body, '中文段落');
	const cdp = await context.newCDPSession(page);
	try {
		await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
		expect(await page.evaluate(() => window.ashMarkdownHost.text)).toBe(initial);
		await cdp.send('Input.imeSetComposition', { text: '中文输入😀', selectionStart: 6, selectionEnd: 6 });
		await cdp.send('Input.insertText', { text: '中文输入😀' });
		const expected = initial.replace('中文段落', '中文段落中文输入😀');
		await expect.poll(() => page.evaluate(() => window.ashMarkdownHost.text)).toBe(expected);
		await expect(body.getByRole('link', { name: '引用' })).toHaveAttribute('href', 'https://example.com');
		await page.evaluate(() => window.ashMarkdownHost.save());
		await expect.poll(() => page.evaluate(() => window.ashMarkdownHost.saved)).toBe(expected);
		await page.evaluate(() => window.ashMarkdownHost.undo());
		await expect.poll(() => page.evaluate(() => window.ashMarkdownHost.text)).toBe(initial);
		await page.evaluate(() => window.ashMarkdownHost.redo());
		await expect(body).toContainText('中文段落中文输入😀');
		await page.evaluate(() => window.ashMarkdownHost.disable());
		expect(await page.evaluate(() => window.ashMarkdownHost.registered)).toBe(true);
	} finally { await cdp.detach(); }
});

test('native Markdown keeps an uncommitted composition after an external edit', async ({ page, context }) => {
	const body = await openArkdown(page, { locale: 'zh-CN' });
	await selectInline(body, '中文段落');
	const cdp = await context.newCDPSession(page);
	try {
		await cdp.send('Input.imeSetComposition', { text: '保留草稿', selectionStart: 4, selectionEnd: 4 });
		const external = await page.evaluate(() => {
			window.ashMarkdownHost.edit(0, 0, 'External\r\n');
			return window.ashMarkdownHost.text;
		});
		await cdp.send('Input.insertText', { text: '保留草稿' });
		await expect(page.locator('.ash-arkdown-conflict')).toContainText('保留草稿');
		await expect(body).toHaveAttribute('aria-readonly', 'true');
		expect(await page.evaluate(() => window.ashMarkdownHost.text)).toBe(external);
		await page.getByRole('button', { name: '重新载入文档' }).click();
		await expect(body).toHaveAttribute('aria-readonly', 'false');
		expect(await page.evaluate(() => window.ashMarkdownHost.text)).toBe(external);
	} finally { await cdp.detach(); }
});

test('read-only native Markdown keeps HTML, unsafe links, and remote images inert', async ({ page }) => {
	const requests: string[] = [];
	await page.route('https://audit-image.invalid/**', async route => { requests.push(route.request().url()); await route.abort(); });
	const body = await openArkdown(page, { readOnly: true });
	await setSource(page, '# Safe\n\n<script>window.auditExecuted=true</script>\n\n[unsafe](javascript:alert(1))\n\n![tracking](https://audit-image.invalid/pixel)\n\n- [ ] Readonly\n\n$\\includegraphics{https://audit-image.invalid/math}$');
	await expect(body.getByRole('heading', { name: 'Safe' })).toBeVisible();
	await expect(body).toHaveAttribute('contenteditable', 'false');
	await expect(body.getByRole('checkbox')).toBeDisabled();
	await expect(body.locator('script, img[src], a[href]')).toHaveCount(0);
	await expect(body.locator('.ash-markdown-math .katex')).toContainText('\\includegraphics');
	expect(requests).toEqual([]);
});
