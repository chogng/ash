import { expect, test } from '@playwright/test';

test('App Server queued notifications yield browser tasks, preserve order and drain before EOF', async ({ page }) => {
	await page.goto('/appServerDecode.html');
	try {
		await page.evaluate(() => window.ashAppServerDecodeIntegration.prepare(128, 4096));
		const result = await page.evaluate(() => window.ashAppServerDecodeIntegration.burst());
		expect(result).toMatchObject({ count: 2000, ordered: true, turns: 128, state: 'crashed' });
		expect(result.yieldedAfter).toBeGreaterThan(0);
		expect(result.yieldedAfter).toBeLessThan(2000);
	} finally {
		await page.evaluate(() => window.ashAppServerDecodeIntegration.dispose());
	}
});

test('App Server large responses cross the real Worker and retain complete results', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	let workers = 0;
	page.on('worker', () => workers++);
	await page.goto('/appServerDecode.html');
	try {
		for (const [turns, textBytes] of [
			[1, 4096],
			[128, 4096],
			[1, 8 * 1024 * 1024],
		]) {
			await page.evaluate(
				([turns, textBytes]) => window.ashAppServerDecodeIntegration.prepare(turns, textBytes),
				[turns, textBytes],
			);
			expect(await page.evaluate(() => window.ashAppServerDecodeIntegration.run())).toEqual({
				turns,
				textBytes,
				state: 'ready',
			});
		}
		expect(workers).toBe(2);
		expect(errors).toEqual([]);
	} finally {
		await page.evaluate(() => window.ashAppServerDecodeIntegration.dispose());
	}
});
