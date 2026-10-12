import { expect, test } from '@playwright/test';

test('locked scrolling preserves offsets through real wheel input and keeps diff sides aligned', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/scrollLocking.html');
	await expect.poll(async () => ({ count: await page.evaluate(() => window.ashScrollLockingIntegration?.read().length), errors })).toEqual({ count: 3, errors: [] });
	await page.evaluate(async () => {
		const h = window.ashScrollLockingIntegration;
		h.scroll(0, 100, 20); h.scroll(1, 300, 80); h.scroll(2, 500, 100);
		await h.toggle();
	});
	const locked = page.getByRole('button', { name: 'Scrolling Locked', exact: true });
	await expect(locked).toBeVisible();
	await page.locator('.stanza-editor:visible').first().hover({ position: { x: 180, y: 180 } });
	await page.mouse.wheel(0, 80);
	await expect.poll(() => page.evaluate(() => window.ashScrollLockingIntegration.read()[0].scrollTop)).toBeGreaterThan(100);
	const positions = await page.evaluate(() => window.ashScrollLockingIntegration.read());
	expect(positions[1].scrollTop - positions[0].scrollTop).toBeCloseTo(200, 0);
	expect(positions[2].scrollTop - positions[0].scrollTop).toBeCloseTo(400, 0);
	expect(await page.evaluate(() => window.ashScrollLockingIntegration.diffSides())).toEqual([positions[2].scrollTop, positions[2].scrollTop]);
	await page.evaluate(() => window.ashScrollLockingIntegration.scroll(0, 180, 50));
	expect(await page.evaluate(() => window.ashScrollLockingIntegration.read())).toEqual([
		{ scrollTop: 180, scrollLeft: 50 }, { scrollTop: 380, scrollLeft: 110 }, { scrollTop: 580, scrollLeft: 130 },
	]);
	await locked.focus();
	await locked.press('Enter');
	await expect(locked).toHaveCount(0);
	await page.evaluate(() => window.ashScrollLockingIntegration.scroll(0, 200, 60));
	expect((await page.evaluate(() => window.ashScrollLockingIntegration.read()))[1]).toEqual({ scrollTop: 380, scrollLeft: 110 });
	await page.evaluate(() => window.ashScrollLockingIntegration.dispose());
	expect(errors).toEqual([]);
});

test('held locked scrolling restores state on release and blur, while explicit toggles retain ownership', async ({ page }) => {
	await page.goto('/scrollLocking.html');
	await expect.poll(() => page.evaluate(() => window.ashScrollLockingIntegration?.read().length)).toBe(3);
	await page.evaluate(() => { const h = window.ashScrollLockingIntegration; h.scroll(0, 100, 0); h.scroll(1, 300, 0); });
	await page.keyboard.down('Control');
	await page.keyboard.down('l');
	const locked = page.getByRole('button', { name: 'Scrolling Locked', exact: true });
	await expect(locked).toBeVisible();
	await page.keyboard.down('l');
	await expect(locked).toBeVisible();
	await page.evaluate(() => window.ashScrollLockingIntegration.scroll(0, 150, 0));
	expect((await page.evaluate(() => window.ashScrollLockingIntegration.read()))[1].scrollTop).toBe(350);
	await page.keyboard.up('l');
	await page.keyboard.up('Control');
	await expect(locked).toHaveCount(0);
	await page.keyboard.press('Control+Shift+l');
	await expect(locked).toBeVisible();
	await page.keyboard.down('Control');
	await page.keyboard.down('l');
	await expect(locked).toHaveCount(0);
	await page.evaluate(() => window.dispatchEvent(new Event('blur')));
	await expect(locked).toBeVisible();
	await page.keyboard.up('l');
	await page.keyboard.up('Control');
	await page.keyboard.down('Control');
	await page.keyboard.down('l');
	await expect(locked).toHaveCount(0);
	await page.evaluate(() => window.ashScrollLockingIntegration.toggle());
	await page.keyboard.up('l');
	await page.keyboard.up('Control');
	await expect(locked).toBeVisible();
	await page.evaluate(() => window.ashScrollLockingIntegration.stop());
	await expect(locked).toHaveCount(0);
	await page.evaluate(() => window.ashScrollLockingIntegration.scroll(0, 250, 0));
	expect((await page.evaluate(() => window.ashScrollLockingIntegration.read()))[1].scrollTop).toBe(350);
});

test('locked scrolling rebuilds its baseline for hidden groups, modal panes and closed editors', async ({ page }) => {
	await page.goto('/scrollLocking.html');
	await expect.poll(() => page.evaluate(() => window.ashScrollLockingIntegration?.read().length)).toBe(3);
	await page.evaluate(async () => {
		const h = window.ashScrollLockingIntegration;
		h.scroll(0, 100, 0); h.scroll(1, 300, 0); h.scroll(2, 500, 0);
		await h.toggle();
		await h.hideSecond();
		h.scroll(0, 140, 0);
	});
	expect((await page.evaluate(() => window.ashScrollLockingIntegration.read())).map(p => p.scrollTop)).toEqual([140, 540]);
	await page.evaluate(() => window.ashScrollLockingIntegration.modal());
	await expect.poll(() => page.evaluate(() => window.ashScrollLockingIntegration.read().length)).toBe(3);
	await page.evaluate(() => window.ashScrollLockingIntegration.scroll(0, 30, 0));
	expect((await page.evaluate(() => window.ashScrollLockingIntegration.read())).map(p => p.scrollTop)).toEqual([30, 170, 570]);
	await page.evaluate(() => window.ashScrollLockingIntegration.closeLast());
	await expect.poll(() => page.evaluate(() => window.ashScrollLockingIntegration.read().length)).toBe(2);
	await page.evaluate(() => window.ashScrollLockingIntegration.scroll(0, 200, 0));
	expect((await page.evaluate(() => window.ashScrollLockingIntegration.read())).map(p => p.scrollTop)).toEqual([200, 600]);
});
