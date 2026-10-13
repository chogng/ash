import { expect, test } from '@playwright/test';

test.afterEach(async ({ page }) => { await page.evaluate(() => window.ashFileMenusIntegration?.dispose()); });

for (const locale of ['en', 'zh-CN']) {
	test(`Explorer and editor title menus show scoped shortcuts (${locale})`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/fileMenus.html?locale=${locale}`);
		expect(errors).toEqual([]);
		await page.waitForFunction(() => !!window.ashFileMenusIntegration);
		await page.locator('.ash-tree-row').filter({ hasText: 'main.ts' }).click({ button: 'right' });
		const labels = await page.evaluate(() => window.ashFileMenusIntegration.labels());
		for (const { title, chords } of labels) {
			const item = page.getByRole('menuitem', { name: title, exact: true });
			await expect(item).toBeVisible();
			await expect(item.locator('.ash-menu-keybinding kbd')).toHaveText(chords);
		}
		await page.keyboard.press('Escape');
		await expect(page.getByRole('menu')).toHaveCount(0);
		await expect(page.locator('.ash-tree')).toBeFocused();
		await page.locator('#editor-menu').click({ button: 'right' });
		for (const { title, chords } of labels.slice(4, 6)) {
			await expect(page.getByRole('menuitem', { name: title, exact: true }).locator('.ash-menu-keybinding kbd')).toHaveText(chords);
		}
		expect(errors).toEqual([]);
	});
}

test('Explorer default shortcuts copy paths and open to the side through the command service', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/fileMenus.html');
	expect(errors).toEqual([]);
	await page.waitForFunction(() => !!window.ashFileMenusIntegration);
	await page.locator('.ash-tree-row').filter({ hasText: 'main.ts' }).click({ button: 'right' });
	await page.keyboard.press('Escape');
	const bindings = await page.evaluate(() => window.ashFileMenusIntegration.bindings());
	for (const command of ['copyFilePath', 'copyRelativeFilePath', 'explorer.openToSide']) {
		for (const chord of bindings[command]!.split(' ')) {
			await page.keyboard.press(chord.replaceAll('cmd', 'Meta').replaceAll('ctrl', 'Control').replaceAll('shift', 'Shift').replaceAll('alt', 'Alt').replaceAll('enter', 'Enter'));
		}
	}
	await expect.poll(() => page.evaluate(() => window.ashFileMenusIntegration.clipboard())).toEqual(['/workspace/main.ts', 'main.ts']);
	await expect.poll(() => page.evaluate(() => window.ashFileMenusIntegration.opened())).toEqual([{ resource: 'file:///workspace/main.ts', target: 'sideGroup' }]);
});

test.describe('Windows file menu defaults', () => {
	test.use({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36' });
	test('Explorer displays Windows path shortcuts including the relative-path chord', async ({ page }) => {
		await page.goto('/fileMenus.html');
		await page.waitForFunction(() => !!window.ashFileMenusIntegration);
		expect(await page.evaluate(() => window.ashFileMenusIntegration.bindings())).toEqual({
			copyFilePath: 'shift+alt+c', copyRelativeFilePath: 'ctrl+k ctrl+shift+c', 'explorer.openToSide': 'ctrl+enter',
		});
		await page.locator('.ash-tree-row').filter({ hasText: 'main.ts' }).click({ button: 'right' });
		const item = page.getByRole('menuitem', { name: 'Copy Relative Path', exact: true });
		await expect(item.locator('.ash-menu-keybinding kbd')).toHaveText(['Ctrl+K', 'Ctrl+Shift+C']);
	});
});
