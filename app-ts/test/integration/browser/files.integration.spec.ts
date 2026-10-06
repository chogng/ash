import { expect, test } from '@playwright/test';

test('browser files persist through reload and reject competing saves from two windows', async ({ page, context }) => {
	await page.goto('/files.html');
	await expect.poll(() => page.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
	expect(await page.evaluate(() => window.ashFilesIntegration.write('// initial\n[]'))).toBe('saved');
	const baseline = await page.evaluate(() => window.ashFilesIntegration.read());
	const other = await context.newPage();
	try {
		await other.goto('/files.html');
		await expect.poll(() => other.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
		const results = await Promise.all([
			page.evaluate(revision => window.ashFilesIntegration.write('// first\n[]', revision), baseline.revision),
			other.evaluate(revision => window.ashFilesIntegration.write('// second\n[]', revision), baseline.revision),
		]);
		expect(results.sort()).toEqual(['FileRevisionConflictError', 'saved']);
		await expect.poll(() => other.evaluate(() => window.ashFilesIntegration.changes)).toBeGreaterThan(0);
		const result = await page.evaluate(() => window.ashFilesIntegration.read());
		expect(result.content).toMatch(/first|second/u);
		await page.reload();
		await expect.poll(() => page.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
		expect((await page.evaluate(() => window.ashFilesIntegration.read())).content).toBe(result.content);
		expect(await page.evaluate(() => window.ashFilesIntegration.copyAndRename())).toEqual([result.content, result.content]);
	} finally { await other.close(); }
});


test('binary comparison reloads both byte previews and resolves their file paths', async ({ page }) => {
	await page.goto('/files.html');
	await expect.poll(() => page.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
	for (const restored of [false, true]) {
		if (restored) {
			await page.reload();
			await expect.poll(() => page.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
		}
		expect(await page.evaluate(restored => window.ashFilesIntegration.showBinaryComparison(restored), restored)).toEqual({ primary: '/binary/after.bin', secondary: '/binary/before.bin' });
		const sides = page.locator('#binary-comparison .ash-side-by-side-editor > section');
		await expect(sides).toHaveCount(2);
		await expect(sides.first().locator('.ash-binary-editor-content')).toContainText('48 69');
		await expect(sides.last().locator('.ash-binary-editor-content')).toContainText('48 69 00 ff');
		await expect(sides.last().getByRole('region')).toBeFocused();
		const boxes = await sides.evaluateAll(elements => elements.map(element => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right })));
		expect(boxes[1]!.left).toBeGreaterThanOrEqual(boxes[0]!.right);
	}
});
