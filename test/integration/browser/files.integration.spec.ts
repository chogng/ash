import { expect, test } from '@playwright/test';

test('an offline extension sees accessible browser roots and excludes registered inaccessible backend roots', async ({ page }) => {
	await page.goto('/files.html');
	await expect.poll(() => page.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
	expect(await page.evaluate(() => window.ashFilesIntegration.offlineExtensionFolders())).toEqual(['ash-userdata:/offline-project']);
});

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

test('comparison groups update their accessible names and release source listeners before reload', async ({ page }) => {
	await page.goto('/files.html');
	await expect.poll(() => page.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
	await page.evaluate(() => window.ashFilesIntegration.showComparisonGroups(false));
	await expect(page.getByRole('tab', { name: 'Before ↔ After', exact: true })).toHaveCount(2);
	await page.evaluate(() => window.ashFilesIntegration.renameComparison('Renamed'));
	await expect(page.getByRole('tab', { name: 'Renamed ↔ After', exact: true })).toHaveCount(2);
	await page.evaluate(() => window.ashFilesIntegration.closeFirstComparisonGroup());
	await page.evaluate(() => window.ashFilesIntegration.renameComparison('Still open'));
	await expect(page.getByRole('tab', { name: 'Still open ↔ After', exact: true })).toHaveCount(1);
	expect(await page.evaluate(() => window.ashFilesIntegration.saveAndCloseComparisons())).toBe(false);
	await expect(page.getByRole('tab')).toHaveCount(0);
	await page.reload();
	await expect.poll(() => page.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
	await page.evaluate(() => window.ashFilesIntegration.showComparisonGroups(true));
	await expect(page.getByRole('tab', { name: 'Still open ↔ After', exact: true })).toHaveCount(1);
	await expect(page.locator('#comparison-groups .ash-binary-editor-content').last()).toContainText('48 69 ff');
});

test('text groups share provider content and release it only after the last view closes', async ({ page }) => {
	await page.goto('/files.html');
	await expect.poll(() => page.evaluate(() => Boolean(window.ashFilesIntegration))).toBe(true);
	await page.evaluate(() => window.ashFilesIntegration.showTextGroups());
	expect(await page.evaluate(() => window.ashFilesIntegration.getTextState())).toEqual({ disposed: false, resolutions: 2, values: ['Provider content', 'Provider content'], sameModel: true });
	await expect(page.getByRole('tab', { name: 'Provider text', exact: true })).toHaveCount(2);
	const controls = page.locator('#text-groups .stanza-editor-input');
	await controls.last().focus();
	await page.keyboard.insertText('must not change');
	expect((await page.evaluate(() => window.ashFilesIntegration.getTextState())).values).toEqual(['Provider content', 'Provider content']);
	await page.evaluate(() => window.ashFilesIntegration.closeFirstTextGroup());
	await expect.poll(() => page.evaluate(() => window.ashFilesIntegration.getTextState())).toEqual({ disposed: false, resolutions: 2, values: ['Remaining view'], sameModel: true });
	await expect(page.locator('#text-groups .view-lines')).toContainText('Remaining view');
	await page.evaluate(() => window.ashFilesIntegration.closeTextGroups());
	expect((await page.evaluate(() => window.ashFilesIntegration.getTextState())).disposed).toBe(true);
	await expect(page.getByRole('tab')).toHaveCount(0);
	await page.evaluate(() => window.ashFilesIntegration.reopenText());
	await expect(page.locator('#text-groups .view-lines')).toContainText('Provider content');
	expect(await page.evaluate(() => window.ashFilesIntegration.getTextState())).toEqual({ disposed: false, resolutions: 3, values: ['Provider content'], sameModel: true });
});
