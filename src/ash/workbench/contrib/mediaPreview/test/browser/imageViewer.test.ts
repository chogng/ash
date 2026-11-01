import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('Built-in image viewer', () => {
	const browser = useBrowserTests();
	browser.use({ permissions: ['clipboard-read', 'clipboard-write'] });

	test('opens browser-native formats without an extension package and shows their metadata', async () => {
		const { page } = browser;
		await page.goto('/imagePreview.html');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await expect(page.locator('.ash-image-preview-controls, [role="toolbar"]')).toHaveCount(0);
		for (const format of ['png', 'jpg', 'webp', 'gif', 'svg']) {
			await page.evaluate(format => window.imagePreviewFixture.open(format), format);
			await expect(page.locator('.ash-image-viewer img')).toHaveAttribute('alt', `product.${format}`);
			await expect(page.locator('#status')).toContainText(format === 'gif' ? '1 × 1 pixels' : '800 × 600 pixels');
		}
	});

	test('fits within the editor viewport percentage and applies the configured default zoom live', async () => {
		const { page } = browser;
		await page.goto('/imagePreview.html');
		await page.evaluate(() => window.imagePreviewFixture.configure('fitToWindowPercentage', 50));
		await page.evaluate(() => window.imagePreviewFixture.open('png'));
		const viewport = page.getByLabel('Image viewport', { exact: true });
		const fittedWidth = (): Promise<{ actual: number; expected: number; }> => viewport.evaluate(element => {
			const image = element.querySelector('img')!;
			return { actual: image.getBoundingClientRect().width, expected: 800 * Math.min(element.clientWidth / 800 * 0.5, element.clientHeight / 600 * 0.5) };
		});
		const width = await fittedWidth();
		expect(width.actual).toBeCloseTo(width.expected, 1);
		await page.locator('#editor').evaluate(element => { element.style.width = '300px'; });
		await expect.poll(async () => (await fittedWidth()).actual).toBe(150);
		await page.evaluate(() => window.imagePreviewFixture.configure('defaultZoom', 'actualSize'));
		await expect(viewport.locator('img')).toHaveCSS('width', '800px');
		await page.evaluate(() => window.imagePreviewFixture.open('svg'));
		await expect(viewport.locator('img')).toHaveCSS('width', '800px');
		await page.evaluate(() => window.imagePreviewFixture.configure('defaultZoom', 'fit'));
		await expect(viewport.locator('img')).toHaveCSS('width', '150px');
		await page.evaluate(() => window.imagePreviewFixture.configure('fitToWindowPercentage', 100));
		await expect(viewport.locator('img')).toHaveCSS('width', '300px');
		await page.evaluate(() => window.imagePreviewFixture.open('gif'));
		await expect(viewport.locator('img')).toHaveCSS('width', '300px');
		await viewport.press('+');
		await expect(viewport.locator('img')).toHaveCSS('width', '300px');
	});

	test('a 150-pixel SVG grows and shrinks with its editor while actual size stays at 100 percent', async () => {
		const { page } = browser;
		await page.goto('/imagePreview.html');
		await page.evaluate(() => window.imagePreviewFixture.open('svg', 150, 150));
		const viewport = page.getByLabel('Image viewport', { exact: true });
		const image = viewport.locator('img');
		const height = await viewport.evaluate(element => element.clientHeight);
		await expect(image).toHaveCSS('height', `${height}px`);
		expect(height).toBeGreaterThan(150);
		await expect(image).not.toHaveClass(/pixelated/u);
		await expect(page.locator('.ash-image-preview-summary')).toContainText('150 × 150 pixels');
		await page.locator('#editor').evaluate(element => { element.style.width = '250px'; });
		await expect(image).toHaveCSS('width', '250px');
		await page.locator('#editor').evaluate(element => { element.style.width = '600px'; element.style.height = '700px'; });
		await expect(image).toHaveCSS('width', '600px');
		await expect(image).not.toHaveClass(/pixelated/u);
		await page.evaluate(() => window.imagePreviewFixture.configure('fitToWindowPercentage', 80));
		await expect(image).toHaveCSS('width', '480px');
		await viewport.press('1');
		await expect(image).toHaveCSS('width', '150px');
		await page.locator('#editor').evaluate(element => { element.style.width = '500px'; });
		await expect(image).toHaveCSS('width', '150px');
		await viewport.press('0');
		await expect(image).toHaveCSS('width', '400px');
		await page.evaluate(() => window.imagePreviewFixture.close());
		await page.locator('#editor').evaluate(element => { element.style.width = '350px'; });
		await page.evaluate(() => window.imagePreviewFixture.open('svg', 150, 150));
		await expect(image).toHaveCSS('width', '280px');
		await browser.info.attach('small-svg-fit.png', { body: await page.screenshot(), contentType: 'image/png' });
	});

	test('zooms with keyboard, wheel and click and restores scale and scroll after reopening', async () => {
		const { page } = browser;
		await page.goto('/imagePreview.html');
		await page.evaluate(() => window.imagePreviewFixture.open('png'));
		const viewport = page.getByLabel('Image viewport', { exact: true });
		const image = viewport.locator('img');
		await viewport.focus();
		await viewport.press('1');
		await expect(image).toHaveCSS('width', '800px');
		await viewport.press('+');
		await expect(image).toHaveCSS('width', '1200px');
		await viewport.evaluate(element => { element.scrollLeft = 200; element.scrollTop = 100; });
		await page.evaluate(() => window.imagePreviewFixture.close());
		await expect(page.locator('#status')).toBeEmpty();
		await page.evaluate(() => window.imagePreviewFixture.open('png'));
		await expect.poll(() => page.evaluate(() => window.imagePreviewFixture.state())).toEqual({ scale: 1.5, scrollLeft: 200, scrollTop: 100 });
		await viewport.focus();
		await viewport.dispatchEvent('wheel', { deltaY: -10, ctrlKey: true, bubbles: true, cancelable: true });
		await expect.poll(async () => (await page.evaluate(() => window.imagePreviewFixture.state()))!.scale).not.toBe(1.5);
		await viewport.click({ position: { x: 200, y: 200 } });
		await expect(page.locator('#status')).toContainText('200%');
		await viewport.press('Shift+F10');
		await expect(page.locator('#menu')).toContainText('Copy image');
	});

	test('copies raster and SVG images to the real browser clipboard as PNG', async () => {
		const { page } = browser;
		await page.goto('/imagePreview.html');
		for (const format of ['png', 'jpg', 'svg']) {
			await page.evaluate(format => window.imagePreviewFixture.open(format), format);
			await page.evaluate(() => navigator.clipboard.writeText('before-image-copy'));
			await page.getByLabel('Image viewport', { exact: true }).focus();
			await page.keyboard.press('ControlOrMeta+C');
			await expect.poll(() => page.evaluate(async () => {
				const items = await navigator.clipboard.read();
				const item = items.find(item => item.types.includes('image/png'));
				const png = await item?.getType('image/png');
				if (!png) return undefined;
				const bitmap = await createImageBitmap(png);
				try { return [bitmap.width, bitmap.height]; } finally { bitmap.close(); }
			})).toEqual([800, 600]);
		}
	});

	test('resolves image binary diffs to two previews and keeps themes and keyboard focus visible', async () => {
		const { page } = browser;
		await page.goto('/imagePreview.html');
		await page.evaluate(() => window.imagePreviewFixture.openDiff());
		await expect(page.locator('.ash-image-preview')).toHaveCount(2);
		await expect(page.locator('.ash-image-preview-controls, [role="toolbar"]')).toHaveCount(0);
		await expect(page.locator('.ash-side-by-side-editor-secondary .ash-image-preview-summary')).toContainText('800 × 600');
		await expect(page.locator('.ash-side-by-side-editor-primary .ash-image-preview-summary')).toContainText('320 × 240');
		for (const theme of ['dark', 'light', 'hcDark', 'hcLight']) {
			await page.evaluate(theme => window.imagePreviewFixture.theme(theme), theme);
			const viewport = page.getByLabel('Image viewport', { exact: true }).first();
			await viewport.focus();
			await page.keyboard.press('1');
			await expect(viewport).toBeFocused();
			await expect(viewport).toHaveCSS('outline-style', 'solid');
			await expect(viewport.locator('img')).toHaveCSS('width', '800px');
			await browser.info.attach(`image-preview-${theme}.png`, { body: await page.screenshot(), contentType: 'image/png' });
		}
	});
});
