import { expect, type Page } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../test/unit/browser/context.js';

suite('chatScreenshot browser component', () => {
	const browserTests = useBrowserTests();
	async function openFixture(page: Page, url: string): Promise<void> {
		await page.goto(url);
		await page.waitForFunction(() => !!window.ashChatInputIntegration);
	}
	async function openScreenshot(page: Page, chinese = false): Promise<void> {
		await page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true }).press('Enter');
		await page
			.getByRole('dialog')
			.getByRole('option', { name: chinese ? '截图…' : 'Screenshot…', exact: true })
			.click();
		await expect(
			page
				.frameLocator('iframe')
				.getByRole('dialog', { name: chinese ? '屏幕截图' : 'Screen Capture', exact: true }),
		).toBeVisible();
	}

	test('the existing screenshot shortcut resolves the extension and preserves the draft', async function () {
		const { page } = browserTests;
		await openFixture(page, '/chatInput.html?screenshotFixture=1&inlineCode=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
		await input.focus();
		await page.keyboard.insertText('Shortcut draft');
		await page.keyboard.press(process.platform === 'darwin' ? 'Control+Meta+A' : 'Control+Alt+S');
		const overlay = page.frameLocator('iframe').getByRole('dialog', { name: 'Screen Capture', exact: true });
		await expect(overlay).toBeVisible();
		await overlay.getByRole('button', { name: 'Entire screen', exact: true }).click();
		await expect(overlay.getByRole('button', { name: 'Copy', exact: true })).toHaveClass(/primary/);
		await expect(overlay.getByRole('button', { name: 'Add to Chat', exact: true })).not.toHaveClass(/primary/);
		expect(await page.evaluate(() => window.ashScreenshotIntegration.state().pending)).toBe(false);
		await page.keyboard.press('Escape');
		await expect(page.locator('iframe')).toHaveCount(0);
		expect(await page.evaluate(() => window.ashScreenshotIntegration.draft())).toBe('Shortcut draft');
	});

	test('the admitted Snapshot command creates a code image from unsaved selected text without capturing the screen', async function () {
		const { page } = browserTests;
		await openFixture(page, '/chatInput.html?screenshotFixture=1&inlineCode=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.getByRole('button', { name: 'Create code image', exact: true }).click();
		const overlay = page.frameLocator('iframe').getByRole('dialog', { name: 'Screen Capture', exact: true });
		await expect(overlay).toBeVisible();
		const greenPixels = await overlay.locator('canvas').evaluate(canvas => {
			const element = canvas as HTMLCanvasElement;
			const image = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
			let count = 0;
			for (let offset = 0; offset < image.length; offset += 4)
				if (image[offset] === 0 && image[offset + 1] === 170 && image[offset + 2] === 0) count++;
			return count;
		});
		expect(greenPixels).toBeGreaterThan(10);
		const surface = overlay.getByRole('group', { name: 'Frozen screen and region selection' });
		await surface.press('Alt+F2');
		const summary = page.frameLocator('iframe').getByRole('dialog', { name: 'Screenshot selection', exact: true });
		await expect(summary.getByRole('textbox')).toHaveValue(/const unsaved = 42;\nreturn unsaved;/);
		await page.keyboard.press('Escape');
		await overlay.getByRole('button', { name: 'Add to Chat', exact: true }).click();
		const image = await submittedImage(page);
		expect(image.width).toBeGreaterThan(400);
		expect(image.pixel).toEqual([99, 102, 241, 255]);
		expect(await page.evaluate(() => window.ashScreenshotIntegration.state().calls)).toBe(0);
	});

	test('retiring the extension closes its isolated view and prevents further capture', async function () {
		const { page } = browserTests;
		await openFixture(page, '/chatInput.html?screenshotFixture=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await openScreenshot(page);
		expect(
			await page
				.frameLocator('iframe')
				.locator('body')
				.evaluate(() => {
					try {
						return !!parent.document;
					} catch {
						return false;
					}
				}),
		).toBe(false);
		await page.evaluate(() => window.ashScreenshotIntegration.stopExtension());
		await expect(page.locator('iframe')).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => window.ashScreenshotIntegration.state().pending)).toBe(false);
		await page.getByRole('button', { name: 'Add context', exact: true }).click();
		await page.getByRole('dialog').getByRole('option', { name: 'Screenshot…', exact: true }).click();
		await expect(page.getByLabel('Context error')).toContainText('Enable one default image editor');
		expect(await page.evaluate(() => window.ashScreenshotIntegration.state().calls)).toBe(1);
	});

	test('independent code images survive a draft switch and attach only when requested', async function () {
		const { page } = browserTests;
		await openFixture(page, '/chatInput.html?screenshotFixture=1&inlineCode=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.getByRole('button', { name: 'Create code image', exact: true }).click();
		await expect(
			page.frameLocator('iframe').getByRole('dialog', { name: 'Screen Capture', exact: true }),
		).toBeVisible();
		expect(await page.evaluate(() => window.ashScreenshotIntegration.state().pending)).toBe(false);
		await page.evaluate(() => window.ashScreenshotIntegration.switchDraft());
		const overlay = page.frameLocator('iframe').getByRole('dialog', { name: 'Screen Capture', exact: true });
		await expect(overlay).toBeVisible();
		await overlay.getByRole('button', { name: 'Add to Chat', exact: true }).click();
		await expect(page.locator('iframe')).toHaveCount(0);
		expect(await page.evaluate(() => window.ashScreenshotIntegration.draft())).toMatch(/^Next conversation/);
		expect(await page.evaluate(() => window.ashScreenshotIntegration.state().pending)).toBe(false);
		expect((await submittedImage(page)).width).toBeGreaterThan(400);
	});

	async function submittedImage(page: Page): Promise<{ width: number; height: number; pixel: number[] }> {
		await page.locator('[data-action-id="ash.chat.input.send"] button').click();
		await expect(page.getByLabel('Submission')).not.toBeEmpty();
		return page.evaluate(async () => {
			const [attachment] = JSON.parse(document.querySelector('[aria-label="Submission"]')!.textContent!);
			const bitmap = await createImageBitmap(await (await fetch(attachment.content)).blob());
			try {
				const canvas = document.createElement('canvas');
				canvas.width = bitmap.width;
				canvas.height = bitmap.height;
				const context = canvas.getContext('2d')!;
				context.drawImage(bitmap, 0, 0);
				return {
					width: bitmap.width,
					height: bitmap.height,
					pixel: [...context.getImageData(0, 0, 1, 1).data],
				};
			} finally {
				bitmap.close();
			}
		});
	}

	for (const [locale, theme] of [
		['en', 'light'],
		['zh-CN', 'dark'],
		['en', 'hcDark'],
		['zh-CN', 'hcLight'],
	]) {
		test(`screen selection, keyboard adjustment, accessible help and export in ${locale} ${theme}`, async function () {
			const { page } = browserTests;

			await openFixture(page, `/chatInput.html?screenshotFixture=1&locale=${locale}&theme=${theme}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const chinese = locale === 'zh-CN';
			await openScreenshot(page, chinese);
			const overlay = page
				.frameLocator('iframe')
				.getByRole('dialog', { name: chinese ? '屏幕截图' : 'Screen Capture', exact: true });
			const surface = overlay.getByRole('group', {
				name: chinese ? '冻结的屏幕与区域选择' : 'Frozen screen and region selection',
			});
			await expect(surface).toBeFocused();
			const bounds = (await overlay.locator('canvas').boundingBox())!;
			await page.mouse.move(bounds.x + bounds.width * 0.75, bounds.y + bounds.height * 0.75);
			await page.mouse.down();
			await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5, { steps: 4 });
			await expect(overlay.locator('.ash-screenshot-toolbar')).toBeHidden();
			await page.mouse.up();
			const toolbar = overlay.getByRole('group', { name: chinese ? '截图工具' : 'Screenshot tools' });
			await expect(toolbar).toBeVisible();
			// The opaque extension view must load its own font; labels remain discoverable without visible text.
			await expect
				.poll(() =>
					toolbar.evaluate(element => {
						return [...element.ownerDocument.fonts].some(
							font =>
								font.family.replaceAll(/["']/g, '') === 'Ash Snapshot Icons' &&
								font.status === 'loaded',
						);
					}),
				)
				.toBe(true);
			const buttons = toolbar.getByRole('button');
			expect(await buttons.count()).toBe(14);
			for (const action of await buttons.all()) {
				await expect(action).toHaveText('');
				await expect(action).toHaveAttribute('aria-label', /\S/);
				await expect(action).toHaveAttribute('title', /\S/);
				const glyph = action.locator('[aria-hidden="true"]');
				await expect(glyph).toHaveAttribute('data-glyph', /\S/);
				await expect(glyph).toHaveCSS('font-size', '16px');
				const box = (await action.boundingBox())!;
				expect({ width: box.width, height: box.height }).toEqual({ width: 24, height: 24 });
			}
			await expect(
				toolbar.getByRole('button', { name: chinese ? '选择' : 'Select', exact: true }),
			).toHaveAttribute('aria-pressed', 'true');
			await overlay.getByRole('button', { name: chinese ? '坐标' : 'Coordinates', exact: true }).click();
			await expect(overlay.getByLabel('X', { exact: true })).toHaveValue('400');
			await expect(overlay.getByLabel(chinese ? '宽度' : 'Width', { exact: true })).toHaveValue('200');
			await surface.focus();
			await surface.press('ArrowRight');
			await surface.press('Shift+ArrowRight');
			await expect(overlay.getByLabel('X', { exact: true })).toHaveValue('401');
			await expect(overlay.getByLabel(chinese ? '宽度' : 'Width', { exact: true })).toHaveValue('201');
			await surface.press('ArrowLeft');
			await surface.press('Shift+ArrowLeft');
			await surface.press('Alt+F1');
			const help = page
				.frameLocator('iframe')
				.getByRole('dialog', { name: chinese ? '截图帮助' : 'Screenshot Help', exact: true });
			await expect(help.getByRole('textbox')).toHaveValue(
				new RegExp(chinese ? 'Shift\\+方向键' : 'Shift\\+arrow keys'),
			);
			await page.keyboard.press('Escape');
			await expect(surface).toBeFocused();
			await surface.press('Alt+F2');
			const summary = page
				.frameLocator('iframe')
				.getByRole('dialog', { name: chinese ? '截图选区' : 'Screenshot selection', exact: true });
			await expect(summary.getByRole('textbox')).toHaveValue(new RegExp(chinese ? '宽度 200' : 'Width 200'));
			await page.keyboard.press('Escape');
			expect(
				await overlay
					.locator('.ash-screenshot-toolbar')
					.evaluate(element => getComputedStyle(element).backgroundColor),
			).not.toBe('rgba(0, 0, 0, 0)');
			await page.screenshot({ path: browserTests.info.outputPath(`screen-selection-${locale}-${theme}.png`) });
			await overlay.getByRole('button', { name: chinese ? '加入聊天' : 'Add to Chat', exact: true }).click();
			await expect(page.locator('iframe')).toHaveCount(0);
			await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
			expect(await submittedImage(page)).toEqual({ width: 200, height: 120, pixel: [255, 255, 0, 255] });
		});
	}

	test('selection handles, text, ink, mosaic and undo share the exported image history', async function () {
		const { page } = browserTests;

		await openFixture(page, '/chatInput.html?screenshotFixture=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await openScreenshot(page);
		const overlay = page.frameLocator('iframe').getByRole('dialog', { name: 'Screen Capture', exact: true });
		await overlay.getByRole('button', { name: 'Entire screen', exact: true }).click();
		const image = (await overlay.locator('canvas').boundingBox())!;
		const point = (x: number, y: number) => ({
			x: image.x + (x * image.width) / 800,
			y: image.y + (y * image.height) / 480,
		});
		await overlay.getByRole('button', { name: 'Rectangle', exact: true }).click();
		await page.mouse.move(point(100, 80).x, point(100, 80).y);
		await page.mouse.down();
		await page.mouse.move(point(300, 160).x, point(300, 160).y, { steps: 3 });
		await page.mouse.up();
		expect(
			await overlay
				.locator('canvas')
				.evaluate(canvas => [
					...(canvas as HTMLCanvasElement).getContext('2d')!.getImageData(200, 80, 1, 1).data,
				]),
		).toEqual([239, 68, 68, 255]);
		await overlay.getByRole('button', { name: 'Text', exact: true }).click();
		await page.mouse.click(point(120, 180).x, point(120, 180).y);
		await overlay.getByLabel('Annotation text', { exact: true }).fill('Synthetic label');
		await overlay.getByLabel('Annotation text', { exact: true }).press('Enter');
		await expect(overlay.getByRole('status')).toContainText('Annotations: 2');
		await overlay.getByRole('button', { name: 'Mosaic', exact: true }).click();
		await page.mouse.move(point(400, 240).x, point(400, 240).y);
		await page.mouse.down();
		await page.mouse.move(point(600, 360).x, point(600, 360).y, { steps: 3 });
		await page.mouse.up();
		await expect(overlay.getByRole('status')).toContainText('Annotations: 3');
		await overlay.getByRole('button', { name: 'Undo', exact: true }).click();
		await expect(overlay.getByRole('status')).toContainText('Annotations: 2');
		await overlay.getByRole('button', { name: 'Select', exact: true }).click();
		const handle = overlay.locator('[data-handle="se"]');
		await handle.hover();
		await page.mouse.down();
		await page.mouse.move(point(700, 420).x, point(700, 420).y, { steps: 3 });
		await page.mouse.up();
		await overlay.getByRole('button', { name: 'Add to Chat', exact: true }).click();
		const result = await submittedImage(page);
		expect(result.width).toBe(700);
		expect(result.height).toBe(420);
	});

	test('Retake removes the frozen overlay and captures a fresh image', async function () {
		const { page } = browserTests;

		await openFixture(page, '/chatInput.html?screenshotFixture=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await openScreenshot(page);
		let overlay = page.frameLocator('iframe').getByRole('dialog', { name: 'Screen Capture', exact: true });
		await overlay.getByRole('button', { name: 'Entire screen', exact: true }).click();
		await overlay.getByRole('button', { name: 'Retake', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashScreenshotIntegration.state().calls)).toBe(2);
		overlay = page.frameLocator('iframe').getByRole('dialog', { name: 'Screen Capture', exact: true });
		await overlay.getByRole('button', { name: 'Entire screen', exact: true }).click();
		await overlay.getByRole('button', { name: 'Add to Chat', exact: true }).click();
		expect(await page.evaluate(() => window.ashScreenshotIntegration.state().overlays)).toEqual([0, 0]);
		expect(await submittedImage(page)).toEqual({ width: 800, height: 480, pixel: [0, 0, 255, 255] });
	});

	for (const phase of ['capturing', 'selection']) {
		test(`switching drafts cancels ${phase} and ignores late screenshot results`, async function () {
			const { page } = browserTests;

			await openFixture(
				page,
				`/chatInput.html?screenshotFixture=1${phase === 'capturing' ? '&holdScreenshot=1' : ''}`,
			);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			if (phase === 'selection') await openScreenshot(page);
			else {
				await page.getByRole('button', { name: 'Add context', exact: true }).click();
				await page.getByRole('dialog').getByRole('option', { name: 'Screenshot…', exact: true }).click();
			}
			await expect.poll(() => page.evaluate(() => window.ashScreenshotIntegration.state().calls)).toBe(1);
			await page.evaluate(() => window.ashScreenshotIntegration.switchDraft());
			await expect(page.getByRole('dialog')).toHaveCount(0);
			await page.evaluate(() => window.ashScreenshotIntegration.release());
			await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveValue(
				'Next conversation',
			);
			expect((await page.evaluate(() => window.ashScreenshotIntegration.state())).pending).toBe(false);
		});
	}

	test('Escape restores the unsent draft without adding an image', async function () {
		const { page } = browserTests;

		await openFixture(page, '/chatInput.html?screenshotFixture=1');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
		await input.fill('Keep my draft');
		await openScreenshot(page);
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(input).toBeFocused();
		await expect(input).toHaveValue('Keep my draft');
	});
});
