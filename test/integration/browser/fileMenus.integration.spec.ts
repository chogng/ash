import { expect, test } from '@playwright/test';

test.afterEach(async ({ page }) => { await page.evaluate(() => window.ashFileMenusIntegration?.dispose()); });

for (const locale of ['en', 'zh-CN']) {
	test(`Explorer keeps top-level folders lazy and truncates compact paths once (${locale})`, async ({ page }, testInfo) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/fileMenus.html?locale=${locale}&compactFolders`);
		await page.waitForFunction(() => !!window.ashFileMenusIntegration);
		const rows = page.locator('#explorer .ash-tree-row');
		await expect(rows.locator('.ash-icon-label-text')).toHaveText(['examples', 'services', 'main.ts']);
		expect(await page.evaluate(() => window.ashFileMenusIntegration.directoryReads())).toEqual(['/workspace']);
		await rows.filter({ hasText: 'examples' }).click();
		await page.keyboard.press('ArrowRight');
		const compact = rows.filter({ hasText: 'examples/extensions/inspector-with-a-long-folder-name' });
		await expect(compact).toHaveCount(1);
		const label = compact.locator('.ash-icon-label-text');
		await expect(label.locator('.ash-icon-label-segment')).toHaveText(['examples', 'extensions', 'inspector-with-a-long-folder-name']);
		await page.locator('#explorer').evaluate(element => element.style.width = '240px');
		const geometry = await label.evaluate(element => {
			const style = getComputedStyle(element);
			return {
				display: style.display,
				overflow: style.overflowX,
				textOverflow: style.textOverflow,
				truncated: element.scrollWidth > element.clientWidth,
				segments: [...element.querySelectorAll('.ash-icon-label-segment')].map(segment => {
					const range = document.createRange();
					range.selectNodeContents(segment);
					return { box: segment.getBoundingClientRect().width, text: range.getBoundingClientRect().width };
				}),
			};
		});
		expect(geometry).toMatchObject({ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', truncated: true });
		for (const segment of geometry.segments) expect(Math.abs(segment.box - segment.text)).toBeLessThan(1);
		await label.hover();
		await expect(page.locator('.ash-hover')).toContainText('examples/extensions/inspector-with-a-long-folder-name');
		await page.mouse.move(700, 600);
		await page.keyboard.press('ArrowLeft');
		await expect(compact.locator('.ash-explorer-active-segment')).toHaveText('extensions');
		await page.keyboard.press('ArrowLeft');
		await expect(compact.locator('.ash-explorer-active-segment')).toHaveText('examples');
		await page.keyboard.press('ArrowRight');
		await expect(compact.locator('.ash-explorer-active-segment')).toHaveText('extensions');
		await page.screenshot({ path: testInfo.outputPath(`compact-folders-${locale}.png`) });
		await page.evaluate(() => window.ashFileMenusIntegration.setCompactFolders(false));
		await expect(rows.locator('.ash-icon-label-text.multiple')).toHaveCount(0);
		expect(errors).toEqual([]);
	});
}

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
