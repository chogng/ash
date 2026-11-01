import { suite, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../test/unit/browser/context.js';

suite('Sash feedback scope', () => {
	const browser = useBrowserTests();
	for (const orientation of ['horizontal', 'vertical']) {
		test(`${orientation} short grip centers on the painted border without moving default feedback`, async () => {
			const { page } = browser;
			await page.goto(`/sashPresentation.html?orientation=${orientation}&border`);
			await page.waitForFunction(() => !!window.ashSashPresentation);
			const sash = page.locator('.ash-sash').last();
			const centers = () => sash.evaluate(element => {
				const vertical = element.classList.contains('ash-sash-vertical');
				const bounds = element.getBoundingClientRect();
				const style = getComputedStyle(element, '::after');
				const transform = new DOMMatrix(style.transform);
				const pane = [...element.parentElement!.children].filter(child => child.classList.contains('ash-split-view-pane')).at(-1)!;
				const paneBounds = pane.getBoundingClientRect();
				const border = getComputedStyle(pane, '::before');
				return {
					grip: vertical ? bounds.left + parseFloat(style.left) + transform.m41 + parseFloat(style.width) / 2
						: bounds.top + parseFloat(style.top) + transform.m42 + parseFloat(style.height) / 2,
					border: vertical ? paneBounds.left + parseFloat(border.width) / 2 : paneBounds.top + parseFloat(border.height) / 2,
					axis: vertical ? bounds.left + bounds.width / 2 : bounds.top + bounds.height / 2,
				};
			});
			for (const stroke of [1, 2]) {
				await page.locator('#app').evaluate((element, width) => (element as HTMLElement).style.setProperty('--ash-strokeThickness', `${width}px`), stroke);
				const value = await centers();
				expect(value.grip).toBeCloseTo(value.border, 5);
			}
			await page.evaluate(() => window.ashSashPresentation.disable());
			const original = await centers();
			expect(original.grip).toBeCloseTo(original.axis, 5);
		});

		test(`${orientation} scope includes existing and future splits and restores default feedback`, async () => {
			const { page } = browser;
			await page.goto(`/sashPresentation.html?orientation=${orientation}`);
			await page.waitForFunction(() => !!window.ashSashPresentation);
			const lengths = () => page.locator('.ash-sash').evaluateAll(elements => elements.map(element => {
				const style = getComputedStyle(element, '::after');
				return parseFloat(element.classList.contains('ash-sash-vertical') ? style.height : style.width);
			}));
			expect(await lengths()).toEqual([60, 60, 60, 60]);
			const sash = page.locator('.ash-sash').last();
			await sash.hover();
			await expect(sash).toHaveClass(/ash-sash-hover/);
			await expect.poll(() => sash.evaluate(element => getComputedStyle(element, '::after').backgroundColor)).toBe('rgb(128, 128, 128)');
			await sash.focus();
			await sash.press(orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown');
			await expect.poll(() => sash.evaluate(element => getComputedStyle(element, '::after').backgroundColor)).toBe('rgb(0, 100, 200)');
			await page.evaluate(() => window.ashSashPresentation.offset(-18));
			const centers = await page.locator('.ash-sash').evaluateAll(elements => elements.map(element => {
				const style = getComputedStyle(element, '::after');
				return parseFloat(element.classList.contains('ash-sash-vertical') ? style.top : style.left);
			}));
			expect(centers).toEqual(orientation === 'horizontal' ? [132, 150, 132, 150] : [282, 300, 282, 300]);
			await page.evaluate(() => window.ashSashPresentation.disable());
			expect(await lengths()).toEqual(orientation === 'horizontal' ? [300, 300, 300, 300] : [600, 600, 600, 600]);
		});
	}
});
