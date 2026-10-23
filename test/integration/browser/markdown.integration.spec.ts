import { expect, test } from '@playwright/test';
import { trackDocumentStyles } from './documentStyles.js';

test('Markdown chat code editor disposal restores document styles', async ({ page }) => {
	await page.goto('/markdown.html');
	await expect(page.locator('#default .ash-markdown')).toBeVisible();
	await using styles = await trackDocumentStyles(page.locator('html'));
	try {
		for (let version = 1; version <= 3; version++) {
			await page.evaluate(version => window.ashMarkdownIntegration.streamChat(`\x60\x60\x60typescript\nconst value = ${version};\n\x60\x60\x60`, true), version);
			await expect(page.locator('#service-chat .stanza-editor')).toHaveCount(1);
			await page.evaluate(() => window.ashMarkdownIntegration.streamChat('Plain text', true));
			await expect(page.locator('#service-chat .stanza-editor')).toHaveCount(0);
			await styles.assertUnchanged();
		}
	} finally {
		await page.evaluate(() => window.ashMarkdownIntegration.dispose());
	}
	await styles.assertUnchanged();
});

test('Markdown service preserves chat code editors, text selection and focus during streaming', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/markdown.html');
	const initial = 'Read this paragraph.\n\n```typescript\nconst first = 1;';
	await page.evaluate(value => window.ashMarkdownIntegration.streamChat(value), initial);
	const root = page.locator('#service-chat');
	const paragraph = root.locator('p').first();
	const paragraphNode = await paragraph.elementHandle();
	const editor = root.locator('.stanza-editor');
	const editorNode = await editor.elementHandle();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+A');
	const selection = await page.evaluate(() => window.ashMarkdownIntegration.chatSelection());
	const input = editor.locator('.stanza-editor-input');
	await expect(input).toBeFocused();
	await page.evaluate(value => window.ashMarkdownIntegration.streamChat(value, true), `${initial}\nconst second = 2;\n\x60\x60\x60`);
	expect(await editor.evaluate((element, previous) => element === previous, editorNode)).toBe(true);
	expect(await paragraph.evaluate((element, previous) => element === previous, paragraphNode)).toBe(true);
	await expect(input).toBeFocused();
	expect(await page.evaluate(() => window.ashMarkdownIntegration.chatSelection())).toEqual(selection);
	await paragraph.click();
	await paragraph.evaluate(element => { const selection = window.getSelection()!; selection.setBaseAndExtent(element.firstChild!, 5, element.firstChild!, 9); });
	await page.evaluate(value => window.ashMarkdownIntegration.streamChat(value, true), `${initial}\nconst second = 2;\n\x60\x60\x60\n\nComplete.`);
	expect(await page.evaluate(() => window.getSelection()!.toString())).toBe('this');
	expect(await page.evaluate(() => window.ashMarkdownIntegration.chatState())).toEqual({ editors: 1, defaultCodeCalls: 0 });
	await page.evaluate(() => window.ashMarkdownIntegration.streamChat('Replacement', true));
	await expect(editor).toHaveCount(0);
	expect(await page.evaluate(() => window.ashMarkdownIntegration.chatState())).toEqual({ editors: 0, defaultCodeCalls: 0 });
	await page.evaluate(() => window.ashMarkdownIntegration.dispose());
	await editorNode?.dispose();
	await paragraphNode?.dispose();
	expect(errors).toEqual([]);
});

test('Markdown honors raw HTML opt in and preserves safe parsed content', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/markdown.html');

	const plain = page.locator('#default .ash-markdown');
	const supported = page.locator('#html-supported .ash-markdown');
	await expect(plain).toBeVisible();
	await expect(supported).toBeVisible();
	await expect(plain.locator('em')).toHaveCount(0);
	await expect(supported.locator('em')).toHaveText('b');
	await expect(plain.locator('code')).toHaveText('<span>code</span>');
	await expect(plain.locator('.ash-markdown-checkbox input')).toBeChecked();
	await expect(plain.locator('a')).toHaveAttribute('href', 'https://example.com');
	await plain.locator('a').click();
	expect(await page.evaluate(() => window.ashMarkdownIntegration.openedLinks())).toEqual(['https://example.com']);
	expect(page.url()).toContain('/markdown.html');
	expect(errors).toEqual([]);

	await page.evaluate(() => window.ashMarkdownIntegration.dispose());
	await expect(page.locator('.ash-markdown')).toHaveCount(0);
});

test('vendored DOMPurify preserves fragment, in-place, and hook sanitization', async ({ page }) => {
	await page.goto('/markdown.html');
	const result = await page.evaluate(() => window.ashMarkdownIntegration.checkDomPurify());
	expect(result).toEqual({
		version: '3.4.16',
		fragment: '<a>safe</a>',
		inPlace: '<div><img><strong>safe</strong></div>',
		hooked: '<a>safe</a>',
	});
});

test('HTML sanitizer applies URL, attribute, plaintext, and safe insertion policies', async ({ page }) => {
	await page.goto('/markdown.html');
	const result = await page.evaluate(() => window.ashMarkdownIntegration.checkSanitizerPolicy());
	expect(result).toEqual({
		defaultHtml: '<div><a>link</a></div>',
		custom: '<custom-tag title="new">kept</custom-tag>',
		relative: '<a href="guide.md">guide</a><img src="images/icon.png"><img>',
		filteredMedia: '<img>',
		plaintext: '<div>&lt;unknown-tag&gt;visible&lt;/unknown-tag&gt;</div>',
		target: '<b>safe</b>',
		fragment: '<a href="https://example.com">safe</a>',
	});
});

test('Markdown renders alerts, registered icons, and an incomplete emphasis tail', async ({ page }) => {
	await page.goto('/markdown.html');
	await page.evaluate(() => {
		document.documentElement.style.setProperty('--ash-input-background', '#123456');
		document.documentElement.style.setProperty('--ash-accent-foreground', '#abcdef');
	});
	const advanced = page.locator('#advanced .ash-markdown');
	const alert = advanced.locator('blockquote.ash-markdown-alert');
	await expect(alert).toHaveCount(1);
	await expect(alert).toHaveCSS('background-color', 'rgb(18, 52, 86)');
	await expect(alert).toHaveCSS('border-left-color', 'rgb(171, 205, 239)');
	await expect(advanced.locator('blockquote')).toContainText('Read');
	await expect(advanced.locator('strong:not(.ash-markdown-alert-label)')).toHaveText('bold');
	await expect(advanced.locator('.ash-icon')).toHaveCount(2);
	await expect(advanced.locator('img')).toHaveAttribute('width', '32');
	await expect(advanced.locator('img')).toHaveAttribute('height', '16');
	await expect(advanced.locator('img')).toHaveJSProperty('naturalWidth', 1);
	const imageBounds = await advanced.locator('img').boundingBox();
	expect(imageBounds && { width: imageBounds.width, height: imageBounds.height }).toEqual({ width: 32, height: 16 });
});

test('Markdown keeps supported resource URIs and image dimensions in the browser DOM', async ({ page }) => {
	await page.goto('/markdown.html');
	const resources = page.locator('#resources .ash-markdown');
	await expect(resources.locator('a')).toHaveAttribute('href', 'ash-remote://ssh+host/src/file.ts');
	await expect(resources.locator('img')).toHaveAttribute('src', 'ash-remote://ssh+host/images/pixel.gif');
	await expect(resources.locator('img')).toHaveAttribute('width', '24');
});

test('Markdown displays host-provided image bytes and releases the image URL after an update', async ({ page }) => {
	await page.goto('/markdown.html');
	const image = page.locator('#loaded-resource img');
	await expect(image).toHaveJSProperty('naturalWidth', 1);
	const url = await image.getAttribute('src');
	expect(url).toMatch(/^blob:/);
	expect(await page.evaluate(() => window.ashMarkdownIntegration.loadedResources())).toEqual([
		'ash-remote://ssh+host/images/pixel.gif',
	]);
	await page.evaluate(() => window.ashMarkdownIntegration.clearLoadedResource());
	await expect(page.locator('#loaded-resource img')).toHaveCount(0);
	const isRevoked = await page.evaluate(async value => {
		try { await fetch(value!); return false; }
		catch { return true; }
	}, url);
	expect(isRevoked).toBe(true);
});
