import { expect, test } from '@playwright/test';

test('action menu grows with content, respects width limits and truncates long labels', async ({ page }) => {
	await page.goto('/actionWidget.html');
	const widget = page.locator('.ash-action-widget');
	await page.evaluate(() => window.ashActionWidgetIntegration.show(['Run', 'Plan']));
	const shortWidth = await widget.evaluate(element => element.getBoundingClientRect().width);
	expect(shortWidth).toBeGreaterThanOrEqual(100);
	expect(shortWidth).toBeLessThan(240);
	await page.keyboard.press('Escape');
	await expect(page.getByRole('button', { name: 'Open actions' })).toBeFocused();
	await page.evaluate(() => window.ashActionWidgetIntegration.show(['Run'], { minWidth: 220 }));
	await expect(widget).toHaveCSS('width', '220px');
	const label = 'Run the selected action with a longer descriptive label';
	await page.evaluate(text => window.ashActionWidgetIntegration.show([text]), label);
	expect(await widget.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(shortWidth);
	await page.evaluate(text => window.ashActionWidgetIntegration.show([text], { maxWidth: 200 }), label);
	await expect(widget).toHaveCSS('width', '200px');
	await expect(widget.getByRole('menuitemradio', { name: label })).toBeFocused();
	const overflow = await widget.evaluate(element => {
		const label = element.querySelector('.ash-button-label')!;
		return {
			popup: element.scrollWidth - element.clientWidth,
			truncated: label.scrollWidth > label.clientWidth,
			ellipsis: getComputedStyle(label).textOverflow,
		};
	});
	expect(overflow).toEqual({ popup: 0, truncated: true, ellipsis: 'ellipsis' });
	await page.keyboard.press('Enter');
	await expect(page.getByRole('status', { name: 'Selection' })).toHaveText(label);
	await expect(widget).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Open actions' })).toBeFocused();
});

test('action menu follows the viewport width when the window shrinks and grows', async ({ page }) => {
	await page.setViewportSize({ width: 1000, height: 600 });
	await page.goto('/actionWidget.html');
	await page.evaluate(() => window.ashActionWidgetIntegration.show(['A long action label '.repeat(15)]));
	const widget = page.locator('.ash-action-widget');
	await expect(widget).toHaveCSS('width', '800px');
	await page.setViewportSize({ width: 320, height: 600 });
	await expect(widget).toHaveCSS('width', '256px');
	expect(await widget.evaluate(element => ({
		hasOverflow: element.scrollWidth > element.clientWidth,
		insideViewport: element.getBoundingClientRect().left >= 0 && element.getBoundingClientRect().right <= innerWidth,
	}))).toEqual({ hasOverflow: false, insideViewport: true });
	await page.setViewportSize({ width: 1000, height: 600 });
	await expect(widget).toHaveCSS('width', '800px');
});

test('filtering keeps the full menu width and keyboard focus', async ({ page }) => {
	await page.goto('/actionWidget.html');
	await page.evaluate(() => window.ashActionWidgetIntegration.show(['Run', 'Run the selected action with a longer descriptive label'], { showFilter: true }));
	const widget = page.locator('.ash-action-widget');
	const width = await widget.evaluate(element => element.getBoundingClientRect().width);
	await page.keyboard.press('ControlOrMeta+f');
	const search = widget.getByRole('searchbox');
	await expect(search).toBeFocused();
	await search.fill('selected');
	await expect(widget.getByRole('menuitemradio')).toHaveCount(1);
	expect(await widget.evaluate(element => element.getBoundingClientRect().width)).toBe(width);
	await search.press('ArrowDown');
	await expect(widget.getByRole('menuitemradio')).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(widget).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Open actions' })).toBeFocused();
});

test('switching tabs recomputes the menu width without replacing its owner', async ({ page }) => {
	await page.goto('/actionWidget.html');
	await page.evaluate(() => window.ashActionWidgetIntegration.showTabs());
	const widget = page.locator('.ash-action-widget');
	const shortWidth = await widget.evaluate(element => element.getBoundingClientRect().width);
	await widget.getByRole('tab', { name: 'Long' }).click();
	await expect(widget.getByRole('menuitemradio')).toHaveText('Run the selected action with a longer descriptive label');
	expect(await widget.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(shortWidth);
	await widget.getByRole('tab', { name: 'Short' }).click();
	expect(await widget.evaluate(element => element.getBoundingClientRect().width)).toBe(shortWidth);
	await page.keyboard.press('ArrowDown');
	await expect(widget.getByRole('menuitemradio', { name: 'Run' })).toBeFocused();
});
