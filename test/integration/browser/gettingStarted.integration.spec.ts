import { expect, test } from '@playwright/test';

for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
	test(`Recents exposes removable history on hover and keyboard focus (${theme})`, async ({ page }, testInfo) => {
		await page.goto(`/gettingStarted.html?theme=${theme}`);
		await expect(page.getByRole('heading', { name: 'Recents', exact: true })).toBeVisible();
		const row = page.locator('.ash-getting-started-recent-item').filter({ hasText: 'alpha' });
		const open = row.locator('.ash-getting-started-recent-content');
		const actions = row.locator('.ash-getting-started-recent-actions');
		const remove = row.getByRole('button', { name: 'Remove alpha from Recents', exact: true });
		await expect(actions).toHaveCSS('opacity', '0');
		const before = await open.boundingBox();
		expect(before!.height).toBe(22);
		const card = await page.locator('.ash-getting-started-card').first().boundingBox();
		const name = await row.locator('.ash-getting-started-recent-name').boundingBox();
		const path = await row.locator('.ash-getting-started-recent-path').boundingBox();
		const lastCard = await page.locator('.ash-getting-started-card').nth(1).boundingBox();
		const rowBounds = (await row.boundingBox())!;
		expect(rowBounds.x).toBe(card!.x);
		expect(rowBounds.x + rowBounds.width).toBe(lastCard!.x + lastCard!.width);
		expect(name!.x - rowBounds.x).toBe(8);
		expect(rowBounds.x + rowBounds.width - path!.x - path!.width).toBe(8);
		const idleBackground = await row.evaluate(element => getComputedStyle(element).backgroundColor);
		await row.hover();
		await expect(actions).toHaveCSS('opacity', '1');
		expect(await row.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(idleBackground);
		expect(await open.boundingBox()).toEqual(before);
		await open.focus();
		await page.keyboard.press('Tab');
		await expect(remove).toBeFocused();
		await expect(row).toHaveCSS('outline-style', 'solid');
		await expect(row).toHaveCSS('outline-width', '1px');
		const rowBox = await row.boundingBox();
		const actionBox = await actions.boundingBox();
		const removeBox = await remove.boundingBox();
		const iconBox = await remove.locator('svg').boundingBox();
		expect(iconBox!.x + iconBox!.width / 2).toBeCloseTo(removeBox!.x + removeBox!.width / 2, 2);
		expect(iconBox!.y + iconBox!.height / 2).toBeCloseTo(removeBox!.y + removeBox!.height / 2, 2);
		expect(rowBox!.x + rowBox!.width - removeBox!.x - removeBox!.width).toBeCloseTo(1, 1);
		expect(actionBox!.y).toBeGreaterThan(rowBox!.y);
		expect(actionBox!.y + actionBox!.height).toBeLessThan(rowBox!.y + rowBox!.height);
		await page.screenshot({ path: testInfo.outputPath(`recents-${theme}.png`) });
		await page.keyboard.press('Enter');
		await expect(row).toHaveCount(0);
		await expect(page.locator('.ash-getting-started-recent-content')).toBeFocused();
		expect(await page.evaluate(() => window.ashWelcomeIntegration.opened)).toEqual([]);
		await page.goto(`/gettingStarted.html?theme=${theme}&seed=false`);
		await expect(page.locator('.ash-getting-started-recent-item')).toHaveCount(1);
		await page.getByRole('button', { name: 'Remove beta from Recents', exact: true }).focus();
		await page.keyboard.press('Space');
		await expect(page.locator('.ash-getting-started-recent')).toBeHidden();
		await expect(page.getByRole('button', { name: 'Open folder', exact: true })).toBeFocused();
	});
}


test('Recents opens rows and removes only the clicked history entry', async ({ page }) => {
	await page.goto('/gettingStarted.html');
	const alpha = page.locator('.ash-getting-started-recent-item').filter({ hasText: 'alpha' });
	await alpha.locator('.ash-getting-started-recent-content').click();
	expect(await page.evaluate(() => window.ashWelcomeIntegration.opened)).toEqual(['/synthetic/projects/with-a-long-parent-path/alpha']);
	await alpha.getByRole('button', { name: 'Remove alpha from Recents', exact: true }).click();
	await expect(alpha).toHaveCount(0);
	await expect(page.locator('.ash-getting-started-recent-item')).toHaveCount(1);
	expect(await page.evaluate(() => window.ashWelcomeIntegration.opened)).toEqual(['/synthetic/projects/with-a-long-parent-path/alpha']);
});


test('Recents keeps the focused remove action when history refreshes', async ({ page }) => {
	await page.goto('/gettingStarted.html');
	const remove = page.getByRole('button', { name: 'Remove alpha from Recents', exact: true });
	await remove.focus();
	await page.evaluate(() => window.ashWelcomeIntegration.addRecent('gamma'));
	await expect(page.locator('.ash-getting-started-recent-item')).toHaveCount(3);
	await expect(remove).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(remove).toHaveCount(0);
	await expect(page.locator('.ash-getting-started-recent-item').filter({ hasText: 'beta' }).locator('.ash-getting-started-recent-content')).toBeFocused();
});

test('Recents removes a workspace file with spaces and URL characters durably', async ({ page }) => {
	await page.goto('/gettingStarted.html?workspace');
	await page.locator('.ash-getting-started-recent-item').hover();
	await page.getByRole('button', { name: 'Remove Team from Recents', exact: true }).click();
	await expect(page.locator('.ash-getting-started-recent')).toBeHidden();
	await page.goto('/gettingStarted.html?seed=false');
	await expect(page.locator('.ash-getting-started-recent')).toBeHidden();
	expect(await page.evaluate(() => window.ashWelcomeIntegration.opened)).toEqual([]);
});

test('Recents stays within a narrow editor and supports touch removal', async ({ page, browser }) => {
	await page.setViewportSize({ width: 320, height: 720 });
	await page.goto('/gettingStarted.html');
	const row = page.locator('.ash-getting-started-recent-item').first();
	await row.hover();
	const box = await row.boundingBox();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(320);
	const touchContext = await browser.newContext({ baseURL: new URL(page.url()).origin, hasTouch: true, isMobile: true, viewport: { width: 320, height: 720 } });
	try {
		const touchPage = await touchContext.newPage();
		await touchPage.goto('/gettingStarted.html');
		await expect(touchPage.locator('.ash-getting-started-recent-actions').first()).toHaveCSS('opacity', '1');
		await touchPage.getByRole('button', { name: 'Remove alpha from Recents', exact: true }).tap();
		await expect(touchPage.locator('.ash-getting-started-recent-item')).toHaveCount(1);
	} finally {
		await touchContext.close();
	}
});
