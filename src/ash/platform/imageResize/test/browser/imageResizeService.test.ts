import { suite, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../test/unit/browser/context.js';

suite('Image resize pixels', () => {
	const browser = useBrowserTests();
	test('shared service bounds the longest edge and keeps transparent PNG pixels', async () => {
		await browser.page.goto('/imageResize.html');
		await browser.page.waitForFunction(() => !!window.imageResizeFixture);
		const image = await browser.page.evaluate(() => window.imageResizeFixture.run(1600, 800));
		expect(image.width).toBe(768); expect(image.height).toBe(384);
		expect(image.type).toBe('image/png'); expect(image.alpha).toBeGreaterThan(120); expect(image.alpha).toBeLessThan(140);
	});
	test('Chat can retain its 2048 pixel budget, while small inputs keep their exact bytes', async () => {
		await browser.page.goto('/imageResize.html');
		await browser.page.waitForFunction(() => !!window.imageResizeFixture);
		expect(await browser.page.evaluate(() => window.imageResizeFixture.run(3000, 1500, 2048))).toMatchObject({ width: 2048, height: 1024 });
		expect(await browser.page.evaluate(() => window.imageResizeFixture.run(160, 80))).toMatchObject({ width: 160, height: 80, unchanged: true });
	});
	test('base64 JPEGs keep their encoding and malformed pixels reject', async () => {
		await browser.page.goto('/imageResize.html');
		await browser.page.waitForFunction(() => !!window.imageResizeFixture);
		expect(await browser.page.evaluate(() => window.imageResizeFixture.run(1600, 800, undefined, 'image/jpeg', true))).toMatchObject({ width: 768, height: 384, type: 'image/jpeg', alpha: 255 });
		expect(await browser.page.evaluate(() => window.imageResizeFixture.invalid())).toBe(true);
	});
});
