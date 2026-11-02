import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../../../../test/unit/browser/context.js';

suite('Chat image reference editor hover', () => {
	const browser = useBrowserTests();
	const imageName = 'captured-image.png';

	async function imageData(width = 320, height = 180): Promise<string> {
		return browser.page.evaluate(({ width, height }) => {
			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext('2d')!;
			context.fillStyle = '#e3edff';
			context.fillRect(0, 0, width, height);
			context.fillStyle = '#2c5b9c';
			context.fillRect(40, 40, 240, 100);
			return canvas.toDataURL('image/png');
		}, { width, height });
	}

	async function pasteImage(): Promise<void> {
		const data = await imageData();
		const input = browser.page.getByRole('textbox', { name: 'Chat message', exact: true });
		await input.focus();
		await input.evaluate((element, { data, name }) => {
			const bytes = Uint8Array.from(atob(data.split(',')[1]!), character => character.charCodeAt(0));
			const transfer = new DataTransfer();
			transfer.items.add(new File([bytes], name, { type: 'image/png' }));
			element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
		}, { data, name: imageName });
		await expect(browser.page.locator('.ash-chat-image-reference-control')).toContainText(imageName);
	}

	async function openKeyboardHover(): Promise<void> {
		const input = browser.page.getByRole('textbox', { name: 'Chat message', exact: true });
		await input.press('Home');
		await input.press('ControlOrMeta+k');
		await input.press('ControlOrMeta+i');
	}

	for (const locale of ['en', 'zh-CN']) for (const theme of ['dark', 'light', 'hcDark', 'hcLight']) {
		test(`keyboard image preview keeps capture, focus and accessibility in ${locale} ${theme}`, async () => {
			const { page } = browser;
			await page.goto(`/chatInput.html?inlineCode&locale=${locale}&theme=${theme}`);
			await pasteImage();
			const help = await page.evaluate(() => window.ashChatInputIntegration.inputAccessibility());
			assert.ok(help?.includes(locale === 'zh-CN' ? '在行内图片引用处' : 'At an inline image reference'), JSON.stringify(help));
			const draft = await page.evaluate(() => window.ashChatInputIntegration.dropState().text);
			await openKeyboardHover();
			const hover = page.locator('.stanza-editor-hover:not([hidden])');
			const content = hover.locator('.ash-chat-image-reference-preview');
			await expect(content).toBeFocused();
			const image = content.getByRole('img', { name: imageName, exact: true });
			await expect(image).toBeVisible();
			assert.deepEqual(await image.evaluate(image => {
				const element = image as HTMLImageElement;
				return [element.naturalWidth, element.naturalHeight];
			}), [320, 180]);
			const accessible = await page.evaluate(() => window.ashChatInputIntegration.contextAccessibility());
			assert.ok(accessible.content?.includes(locale === 'zh-CN' ? `图片预览：${imageName}` : `Image preview: ${imageName}`));
			assert.ok(accessible.content?.includes('320 × 180'));
			const bounds = await hover.boundingBox();
			assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1281 && bounds.y + bounds.height <= 721);
			const style = await hover.evaluate(element => {
				const computed = getComputedStyle(element);
				return { border: parseFloat(computed.borderTopWidth), foreground: computed.color, background: computed.backgroundColor };
			});
			assert.ok(style.border > 0);
			assert.notEqual(style.foreground, 'rgba(0, 0, 0, 0)');
			assert.notEqual(style.background, 'rgba(0, 0, 0, 0)');
			if (locale === 'en' && theme === 'light') {
				await page.screenshot({ path: browser.info.outputPath('image-reference-hover.png') });
			}
			await content.press('Tab');
			const close = content.getByRole('button', { name: locale === 'zh-CN' ? '关闭图片预览' : 'Close image preview', exact: true });
			await expect(close).toBeFocused();
			await close.press('Enter');
			await expect(content).toHaveCount(0);
			await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
			assert.equal(await page.evaluate(() => window.ashChatInputIntegration.dropState().text), draft);
			await expect(page.getByLabel('Submission', { exact: true })).toBeEmpty();
		});
	}

	test('mouse hover previews the same captured image without opening a dialog', async () => {
		const { page } = browser;
		await page.goto('/chatInput.html?inlineCode');
		await pasteImage();
		const preview = page.getByRole('button', { name: `Preview ${imageName}`, exact: true });
		await expect(preview).toBeEnabled();
		await preview.hover();
		await expect(page.locator('.stanza-editor-hover:not([hidden])').getByRole('img', { name: imageName, exact: true })).toBeVisible();
		await expect(page.getByRole('dialog', { name: `Preview ${imageName}`, exact: true })).toHaveCount(0);
	});

	test('closing a pending hover preserves the canonical image capture', async () => {
		const { page } = browser;
		await page.goto('/chatInput.html?inlineCode');
		const data = await imageData();
		await page.evaluate(data => window.ashChatInputIntegration.addDeferredImageContext(data), data);
		await openKeyboardHover();
		const content = page.locator('.stanza-editor-hover:not([hidden]) .ash-chat-image-reference-preview');
		await expect(content).toHaveAttribute('aria-busy', 'true');
		await expect(content).toBeFocused();
		const accessible = await page.evaluate(() => window.ashChatInputIntegration.contextAccessibility());
		assert.ok(accessible.content?.includes('Loading preview: draft.png'), JSON.stringify(accessible));
		await page.keyboard.press('Escape');
		await expect(content).toHaveCount(0);
		await page.evaluate(() => window.ashChatInputIntegration.releaseReferencePreview());
		await expect(page.getByRole('button', { name: 'Preview draft.png', exact: true })).toBeEnabled();
		await expect(content).toHaveCount(0);
		await openKeyboardHover();
		await expect(content.getByRole('img', { name: 'draft.png', exact: true })).toBeVisible();
	});

	test('a replacement draft retires a pending image hover', async () => {
		const { page } = browser;
		await page.goto('/chatInput.html?inlineCode');
		const data = await imageData();
		await page.evaluate(data => window.ashChatInputIntegration.addDeferredImageContext(data), data);
		await openKeyboardHover();
		const hover = page.locator('.stanza-editor-hover:not([hidden])');
		await expect(hover.locator('.ash-chat-image-reference-preview')).toBeFocused();
		await page.evaluate(() => {
			window.ashChatInputIntegration.replaceDropDraft();
			window.ashChatInputIntegration.releaseReferencePreview();
		});
		await expect(hover).toHaveCount(0);
		assert.equal(await page.evaluate(() => window.ashChatInputIntegration.dropState().text), 'Replacement draft');
		await expect(page.locator('.ash-chat-image-reference-control')).toHaveCount(0);
	});

	test('a large image fits a narrow editor hover without horizontal scrolling', async () => {
		const { page } = browser;
		await page.goto('/chatInput.html?inlineCode');
		await page.setViewportSize({ width: 400, height: 640 });
		await page.locator('main').evaluate(element => { element.style.width = '320px'; });
		const data = await imageData(1600, 900);
		await page.evaluate(data => {
			window.ashChatInputIntegration.addDeferredImageContext(data);
			window.ashChatInputIntegration.releaseReferencePreview();
		}, data);
		await openKeyboardHover();
		const hover = page.locator('.stanza-editor-hover:not([hidden])');
		await expect(hover.getByRole('img', { name: 'draft.png', exact: true })).toBeVisible();
		const dimensions = await hover.evaluate(element => {
			const image = element.querySelector('img')!;
			const bounds = element.getBoundingClientRect();
			return {
				left: bounds.left, right: bounds.right, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
				imageWidth: image.getBoundingClientRect().width, naturalWidth: image.naturalWidth
			};
		});
		assert.equal(dimensions.naturalWidth, 1600);
		assert.ok(dimensions.left >= 0 && dimensions.right <= 401);
		assert.ok(dimensions.scrollWidth <= dimensions.clientWidth + 1, JSON.stringify(dimensions));
		assert.ok(dimensions.imageWidth <= dimensions.clientWidth);
	});

	for (const content of ['https://image.invalid/private.png', 'data:image/png;base64,not-an-image']) {
		test(`unavailable image content remains local (${content.startsWith('https:') ? 'remote URL' : 'bad bytes'})`, async () => {
			const { page } = browser;
			let remoteRequests = 0;
			await page.route('https://image.invalid/**', route => { remoteRequests++; return route.abort(); });
			await page.goto('/chatInput.html?inlineCode');
			await page.evaluate(content => window.ashChatInputIntegration.addDeferredImageContext(content), content);
			await openKeyboardHover();
			await page.evaluate(() => window.ashChatInputIntegration.releaseReferencePreview());
			const hover = page.locator('.stanza-editor-hover:not([hidden]) .ash-chat-image-reference-preview');
			await expect(hover).toBeFocused();
			await expect(hover).toHaveAttribute('aria-busy', 'false');
			await expect(hover).toContainText('Preview unavailable: draft.png');
			await expect(hover.locator('img')).toHaveCount(0);
			const accessible = await page.evaluate(() => window.ashChatInputIntegration.contextAccessibility());
			assert.ok(accessible.content?.includes('Preview unavailable: draft.png'), JSON.stringify(accessible));
			assert.equal(remoteRequests, 0);
		});
	}
});
