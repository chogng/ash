import { expect, test } from '@playwright/test';

test('Welcome renders its brand and light-theme action cards', async ({ page }) => {
	await page.goto('/gettingStarted.html?theme=light');
	const welcome = page.getByRole('region', { name: 'Welcome', exact: true });
	await expect(welcome.locator('.ash-getting-started-brand')).toHaveText('ASH');
	await expect(welcome.getByRole('button', { name: 'Open folder', exact: true })).toBeVisible();
	const mark = welcome.locator('.ash-getting-started-mark');
	await expect(mark).toBeVisible();
	await expect(mark).toHaveAttribute('aria-hidden', 'true');
	await expect(mark).toHaveCSS('mask-image', /ash-mark.*\.svg/u);
	await expect(mark).toHaveCSS('background-image', 'none');
	await expect(mark).toHaveCSS('background-color', await mark.evaluate(element => getComputedStyle(element).color));
	const cards = welcome.locator('.ash-getting-started-card');
	await expect(cards).toHaveCount(4);
	await expect(cards.locator('.ash-getting-started-card-label')).toHaveText(['Open folder', 'Clone repo', 'Connect via SSH', 'Connect GitHub']);
	for (const index of [0, 1, 2]) {
		const card = cards.nth(index);
		await expect(card).toHaveCSS('background-color', 'rgb(243, 243, 243)');
		await expect(card).toHaveCSS('border-color', 'rgb(212, 212, 212)');
		await expect(card).toHaveCSS('opacity', '1');
		await expect(card.locator('svg.ash-icon')).toHaveCSS('width', '16px');
		await card.hover();
		await expect(card).toHaveCSS('background-color', 'rgb(228, 228, 228)');
	}
	const github = cards.nth(3);
	await expect(github).toBeEnabled();
	await expect(github.locator('.ash-getting-started-card-arrow')).toHaveCount(0);
	await expect(github).toHaveCSS('background-color', 'rgb(0, 0, 0)');
	await expect(github).toHaveCSS('color', 'rgb(255, 255, 255)');
	await expect(github.locator('svg.ash-icon')).toHaveCSS('color', 'rgb(255, 255, 255)');
	await expect(github.locator('svg.ash-icon path').first()).toHaveCSS('fill', 'rgb(255, 255, 255)');
	await github.hover();
	await expect(github).toHaveCSS('background-color', 'rgb(38, 38, 38)');
});

test('Welcome cards keep even spacing and shrink before wrapping in a narrow editor', async ({ page }) => {
	await page.goto('/gettingStarted.html');
	const welcome = page.getByRole('region', { name: 'Welcome', exact: true });
	const cards = welcome.locator('.ash-getting-started-card');
	await expect(cards).toHaveCount(4);
	const [topLeft, topRight, bottomLeft, bottomRight] = await Promise.all([0, 1, 2, 3].map(index => cards.nth(index).boundingBox()));
	expect(topLeft && topRight && bottomLeft && bottomRight ? {
		columnGap: Math.round(topRight.x - topLeft.x - topLeft.width),
		rowGap: Math.round(bottomLeft.y - topLeft.y - topLeft.height),
		leftColumnAligned: topLeft.x === bottomLeft.x,
		rightColumnAligned: topRight.x === bottomRight.x,
	} : null).toEqual({ columnGap: 12, rowGap: 12, leftColumnAligned: true, rightColumnAligned: true });
	for (const [width, expectedCardWidth, sameRow] of [[364, 160, true], [350, 180, false]] as const) {
		await page.setViewportSize({ width, height: 720 });
		await expect.poll(() => cards.evaluateAll(elements => {
			const [first, second] = elements.map(element => element.getBoundingClientRect());
			return {
				cardWidth: Math.round(first!.width),
				secondCardOnFirstRow: first!.top === second!.top,
				labelOverflow: Math.max(0, ...elements.map(card => {
					const label = card.querySelector('.ash-getting-started-card-label')!;
					return label.getBoundingClientRect().right - card.getBoundingClientRect().right;
				})),
			};
		})).toEqual({ cardWidth: expectedCardWidth, secondCardOnFirstRow: sameRow, labelOverflow: 0 });
	}
});

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
		const heading = await page.getByRole('heading', { name: 'Recents', exact: true }).boundingBox();
		expect(heading!.x).toBe(card!.x);
		expect(rowBounds.x).toBe(card!.x);
		expect(rowBounds.x + rowBounds.width).toBe(lastCard!.x + lastCard!.width);
		expect(name!.x - rowBounds.x).toBe(8);
		expect(rowBounds.x + rowBounds.width - path!.x - path!.width).toBe(8);
		await expect(row.locator('.ash-getting-started-recent-path')).toHaveCSS('text-align', 'right');
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
		expect(removeBox).toMatchObject({ width: 20, height: 20 });
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
