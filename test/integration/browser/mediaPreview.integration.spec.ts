import { expect, test } from '@playwright/test';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('Image copy encodes raster and SVG sources in a Worker and terminates each completed Worker', async ({ page }) => {
	const started: string[] = [];
	page.on('worker', worker => { started.push(worker.url()); });
	await page.goto('/imagePreview.html');
	for (const format of ['png', 'jpg', 'svg']) {
		await page.evaluate(format => window.imagePreviewFixture.open(format), format);
		await page.evaluate(() => navigator.clipboard.writeText('before-copy'));
		await page.getByLabel('Image viewport', { exact: true }).focus();
		await page.keyboard.press('ControlOrMeta+C');
		await expect.poll(() => page.evaluate(async () => {
			const item = (await navigator.clipboard.read()).find(item => item.types.includes('image/png'));
			if (!item) { return undefined; }
			const bitmap = await createImageBitmap(await item.getType('image/png'));
			try { return [bitmap.width, bitmap.height]; } finally { bitmap.close(); }
		})).toEqual([800, 600]);
		await expect.poll(() => page.workers().length).toBe(0);
		if (format === 'png') { expect(started).toEqual([]); }
	}
	expect(started).toHaveLength(2);
	expect(started.every(url => url.includes('imageEncoderWorkerMain'))).toBe(true);
});

test('Failed image encoding releases its Worker and a later copy can succeed', async ({ page }) => {
	await page.route('**/*imageEncoderWorkerMain*.js', route => route.fulfill({
		contentType: 'application/javascript', body: "throw new Error('Injected image encoder startup failure');",
	}));
	await page.goto('/imagePreview.html');
	await page.evaluate(() => window.imagePreviewFixture.open('svg'));
	const viewport = page.getByLabel('Image viewport', { exact: true });
	await viewport.focus();
	await viewport.press('ControlOrMeta+C');
	await expect(page.getByRole('alert')).toContainText('Could not encode the image as PNG:');
	await expect.poll(() => page.workers().length).toBe(0);
	await expect(viewport.locator('img')).toHaveJSProperty('naturalWidth', 800);
	await page.unroute('**/*imageEncoderWorkerMain*.js');
	await page.evaluate(() => navigator.clipboard.writeText('before-retry'));
	await viewport.press('ControlOrMeta+C');
	await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.read()).some(item => item.types.includes('image/png')))).toBe(true);
	await expect.poll(() => page.workers().length).toBe(0);
});
