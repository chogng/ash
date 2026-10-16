import { expect, test, type Page } from '@playwright/test';

async function openScreenshot(page: Page, chinese = false): Promise<void> {
	await page.getByRole('button', { name: chinese ? '添加上下文' : 'Add context', exact: true }).press('Enter');
	await page.getByRole('dialog').getByRole('option', { name: chinese ? '截图…' : 'Screenshot…', exact: true }).click();
}

async function submittedImage(page: Page): Promise<{ width: number; height: number; pixel: number[]; }> {
	await page.locator('[data-action-id="ash.chat.input.send"] button').click();
	await expect(page.getByLabel('Submission')).not.toBeEmpty();
	return page.evaluate(async () => {
		const [attachment] = JSON.parse(document.querySelector('[aria-label="Submission"]')!.textContent!);
		const bitmap = await createImageBitmap(await (await fetch(attachment.content)).blob());
		try {
			const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
			const context = canvas.getContext('2d')!;
			context.drawImage(bitmap, 0, 0);
			return { width: bitmap.width, height: bitmap.height, pixel: [...context.getImageData(0, 0, 1, 1).data] };
		} finally { bitmap.close(); }
	});
}

for (const [locale, theme] of [['en', 'light'], ['zh-CN', 'dark'], ['en', 'hcDark'], ['zh-CN', 'hcLight']]) {
	test(`screenshot preview, keyboard crop and confirmation in ${locale} ${theme}`, async ({ page }) => {
		await page.goto(`/chatInput.html?screenshotFixture=1&locale=${locale}&theme=${theme}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const chinese = locale === 'zh-CN';
		await openScreenshot(page, chinese);
		const dialog = page.getByRole('dialog', { name: chinese ? '截图预览' : 'Screenshot Preview' });
		const confirm = dialog.getByRole('button', { name: chinese ? '加入聊天' : 'Add to Chat', exact: true });
		await expect(confirm).toBeFocused();
		await expect(dialog.getByRole('status')).toHaveText(chinese ? '800 × 480 像素' : '800 × 480 pixels');
		expect(await page.evaluate(() => window.ashScreenshotIntegration.state())).toEqual({ calls: 1, overlays: [0], pending: true, providers: 2 });
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeEmpty();
		const help = await page.evaluate(() => window.ashScreenshotIntegration.accessibility('help'));
		expect(help).toContain(chinese ? 'Shift+方向键' : 'Shift+arrow keys');
		await expect(confirm).toBeFocused();
		await dialog.getByRole('button', { name: chinese ? '框选区域' : 'Select Region' }).click();
		const fields = [dialog.getByLabel('X', { exact: true }), dialog.getByLabel('Y', { exact: true }), dialog.getByLabel(chinese ? '宽度' : 'Width', { exact: true }), dialog.getByLabel(chinese ? '高度' : 'Height', { exact: true })];
		for (const [index, value] of ['400', '240', '200', '120'].entries()) { await fields[index].fill(value); await fields[index].press('Tab'); }
		const imageArea = dialog.getByRole('group');
		await imageArea.focus();
		await imageArea.press('ArrowRight');
		await imageArea.press('Shift+ArrowRight');
		await expect(fields[0]).toHaveValue('401');
		await expect(fields[2]).toHaveValue('201');
		await imageArea.press('ArrowLeft');
		await imageArea.press('Shift+ArrowLeft');
		const accessible = await page.evaluate(() => window.ashScreenshotIntegration.accessibility('view'));
		expect(accessible).toContain(chinese ? '宽度 200' : 'Width 200');
		await expect(imageArea).toBeFocused();
		await dialog.getByRole('button', { name: chinese ? '预览区域' : 'Preview Region' }).click();
		await expect(confirm).toBeFocused();
		await expect(dialog.getByRole('status')).toHaveText(chinese ? '200 × 120 像素' : '200 × 120 pixels');
		await page.screenshot({ path: test.info().outputPath(`screenshot-preview-${locale}-${theme}.png`) });
		await confirm.click();
		await expect(dialog).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeFocused();
		expect(await page.evaluate(() => window.ashScreenshotIntegration.state())).toEqual({ calls: 1, overlays: [0], pending: false, providers: 0 });
		expect(await submittedImage(page)).toEqual({ width: 200, height: 120, pixel: [255, 255, 0, 255] });
	});
}

test('reverse drag maps a scaled preview to image pixels, and Entire Window restores the original', async ({ page }) => {
	await page.goto('/chatInput.html?screenshotFixture=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await openScreenshot(page);
	const dialog = page.getByRole('dialog', { name: 'Screenshot Preview' });
	await dialog.getByRole('button', { name: 'Select Region' }).click();
	await expect(dialog.locator('img')).toHaveJSProperty('naturalWidth', 800);
	const bounds = (await dialog.locator('img').boundingBox())!;
	await page.mouse.move(bounds.x + bounds.width * 0.9, bounds.y + bounds.height * 0.9);
	await page.mouse.down();
	await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + bounds.height * 0.6, { steps: 3 });
	await page.mouse.up();
	await expect(dialog.getByLabel('X', { exact: true })).toHaveValue('480');
	await expect(dialog.getByLabel('Y', { exact: true })).toHaveValue('288');
	await expect(dialog.getByLabel('Width', { exact: true })).toHaveValue('240');
	await expect(dialog.getByLabel('Height', { exact: true })).toHaveValue('144');
	await dialog.getByRole('button', { name: 'Preview Region' }).click();
	await expect(dialog.getByRole('status')).toHaveText('240 × 144 pixels');
	await dialog.getByRole('button', { name: 'Entire Window' }).click();
	await expect(dialog.getByRole('status')).toHaveText('800 × 480 pixels');
	await dialog.getByRole('button', { name: 'Add to Chat', exact: true }).click();
	expect(await submittedImage(page)).toEqual({ width: 800, height: 480, pixel: [255, 0, 0, 255] });
});

test('Retake hides the preview before capture and attaches the fresh image', async ({ page }) => {
	await page.goto('/chatInput.html?screenshotFixture=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	await openScreenshot(page);
	const dialog = page.getByRole('dialog', { name: 'Screenshot Preview' });
	await dialog.getByRole('button', { name: 'Retake' }).click();
	await expect(dialog.getByRole('button', { name: 'Add to Chat', exact: true })).toBeFocused();
	await expect.poll(() => page.evaluate(() => window.ashScreenshotIntegration.state().calls)).toBe(2);
	await dialog.getByRole('button', { name: 'Add to Chat', exact: true }).click();
	expect(await page.evaluate(() => window.ashScreenshotIntegration.state().overlays)).toEqual([0, 0]);
	expect(await submittedImage(page)).toEqual({ width: 800, height: 480, pixel: [0, 0, 255, 255] });
});

test('Escape discards a preview, restores focus and leaves the existing draft intact', async ({ page }) => {
	await page.goto('/chatInput.html?screenshotFixture=1');
	await page.evaluate(() => window.ashChatInputIntegration.showModels());
	const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
	await input.fill('Keep my draft');
	await openScreenshot(page);
	const confirm = page.getByRole('button', { name: 'Add to Chat', exact: true });
	await expect(confirm).toBeFocused();
	await confirm.press('Tab');
	await expect(page.getByRole('dialog')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(input).toBeFocused();
	await expect(input).toHaveValue('Keep my draft');
	expect(await page.evaluate(() => window.ashScreenshotIntegration.state().providers)).toBe(0);
});

for (const phase of ['capturing', 'preview']) {
	test(`switching drafts cancels ${phase} and ignores late screenshot results`, async ({ page }) => {
		await page.goto(`/chatInput.html?screenshotFixture=1${phase === 'capturing' ? '&holdScreenshot=1' : ''}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await openScreenshot(page);
		await expect.poll(() => page.evaluate(() => window.ashScreenshotIntegration.state().calls)).toBe(1);
		if (phase === 'preview') await expect(page.getByRole('button', { name: 'Add to Chat', exact: true })).toBeFocused();
		await page.evaluate(() => window.ashScreenshotIntegration.switchDraft());
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await page.evaluate(() => window.ashScreenshotIntegration.release());
		await expect(page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveValue('Next conversation');
		expect(await page.evaluate(() => window.ashScreenshotIntegration.state())).toEqual({ calls: 1, overlays: [0], pending: false, providers: 0 });
	});
}
