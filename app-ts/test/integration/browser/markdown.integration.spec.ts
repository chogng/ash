import { expect, test } from '@playwright/test';

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
	await expect(advanced.locator('svg.ash-icon')).toHaveCount(2);
	await expect(advanced.locator('img')).toHaveAttribute('width', '32');
	await expect(advanced.locator('img')).toHaveAttribute('height', '16');
	await expect(advanced.locator('img')).toHaveJSProperty('naturalWidth', 1);
	const imageBounds = await advanced.locator('img').boundingBox();
	expect(imageBounds && { width: imageBounds.width, height: imageBounds.height }).toEqual({ width: 32, height: 16 });
});

test('Markdown keeps supported resource URIs and image dimensions in the browser DOM', async ({ page }) => {
	await page.goto('/markdown.html');
	const resources = page.locator('#resources .ash-markdown');
	await expect(resources.locator('a')).toHaveAttribute('href', 'vscode-remote://ssh-remote+host/src/file.ts');
	await expect(resources.locator('img')).toHaveAttribute('src', 'vscode-file://vscode-app/images/pixel.gif');
	await expect(resources.locator('img')).toHaveAttribute('width', '24');
});

test('Markdown displays host-provided image bytes and releases the image URL after an update', async ({ page }) => {
	await page.goto('/markdown.html');
	const image = page.locator('#loaded-resource img');
	await expect(image).toHaveJSProperty('naturalWidth', 1);
	const url = await image.getAttribute('src');
	expect(url).toMatch(/^blob:/);
	expect(await page.evaluate(() => window.ashMarkdownIntegration.loadedResources())).toEqual([
		'vscode-file://vscode-app/images/pixel.gif',
	]);
	await page.evaluate(() => window.ashMarkdownIntegration.clearLoadedResource());
	await expect(page.locator('#loaded-resource img')).toHaveCount(0);
	const isRevoked = await page.evaluate(async value => {
		try { await fetch(value!); return false; }
		catch { return true; }
	}, url);
	expect(isRevoked).toBe(true);
});
