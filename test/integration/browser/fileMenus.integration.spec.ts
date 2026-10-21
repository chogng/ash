import { expect, test } from '@playwright/test';

test.afterEach(async ({ page }) => { await page.evaluate(() => window.ashFileMenusIntegration?.dispose()); });

test('Explorer keeps file scrolling inside its pane and uses themed scrolling for overflowing pane headers', async ({ page }, testInfo) => {
	await page.goto('/fileMenus.html?paneLayout');
	await page.waitForFunction(() => !!window.ashFileMenusIntegration);
	const host = page.locator('#explorer');
	const panes = host.locator('.ash-pane-view-container');
	const tree = host.getByRole('tree');
	await expect(tree.getByRole('treeitem').first()).toBeVisible();
	const timeline = host.getByRole('button', { name: 'Timeline', exact: true });
	const before = await timeline.boundingBox();
	await tree.hover();
	await page.mouse.wheel(0, 500);
	const treeViewport = host.locator('.ash-list-scrollable > .ash-scrollbar-viewport');
	await expect.poll(() => treeViewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
	expect(await timeline.boundingBox()).toEqual(before);
	await expect(panes).toHaveCSS('overflow-y', 'hidden');
	await expect(panes.locator(':scope > .ash-scrollbar-track-vertical')).toBeHidden();
	await host.screenshot({ path: testInfo.outputPath('explorer-contained-scrollbar.png') });

	await page.evaluate(() => window.ashFileMenusIntegration.layoutPanes(80));
	const track = panes.locator(':scope > .ash-scrollbar-track-vertical');
	await panes.hover();
	await expect(track).toBeVisible();
	await expect(track).toHaveAttribute('aria-disabled', 'false');
	await track.focus();
	await track.press('End');
	await expect(timeline).toBeInViewport({ ratio: 1 });
	await timeline.focus();
	await expect(timeline).toBeFocused();
	await host.screenshot({ path: testInfo.outputPath('overflowing-pane-scrollbar.png') });
	await page.evaluate(() => window.ashFileMenusIntegration.layoutPanes(500));
	await expect(track).toBeHidden();
	await expect(timeline).toBeInViewport({ ratio: 1 });
});

for (const locale of ['en', 'zh-CN']) {
	test(`Explorer keeps top-level folders lazy and truncates compact paths once (${locale})`, async ({ page }, testInfo) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/fileMenus.html?locale=${locale}&compactFolders`);
		await page.waitForFunction(() => !!window.ashFileMenusIntegration);
		const rows = page.locator('#explorer .ash-tree-row');
		await expect(rows.locator('.ash-icon-label-text')).toHaveText(['examples', 'services', 'main.ts']);
		const rowGeometry = await rows.evaluateAll(elements => elements.map(element => ({
			height: element.getBoundingClientRect().height,
			top: element.getBoundingClientRect().top,
			lineHeight: getComputedStyle(element).lineHeight,
		})));
		expect(rowGeometry.map(row => [row.height, row.lineHeight])).toEqual([[22, '22px'], [22, '22px'], [22, '22px']]);
		expect(rowGeometry.slice(1).map((row, index) => row.top - rowGeometry[index]!.top)).toEqual([22, 22]);
		const iconActions = page.locator('#explorer .ash-toolbar .ash-action-view-item.icon > .ash-button');
		expect(await iconActions.count()).toBeGreaterThan(0);
		for (const action of await iconActions.all()) {
			await expect(action).toHaveCSS('width', '22px');
			await expect(action).toHaveCSS('height', '22px');
			expect(await action.boundingBox()).toMatchObject({ width: 22, height: 22 });
			await expect(action.locator('.ash-icon').first()).toHaveCSS('width', '16px');
			await expect(action.locator('.ash-icon').first()).toHaveCSS('height', '16px');
		}
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
	const pressCommand = async (command: string) => {
		const keys: Record<string, string> = { cmd: 'Meta', ctrl: 'Control', shift: 'Shift', alt: 'Alt', enter: 'Enter' };
		for (const chord of bindings[command]!.split(' ')) {
			const shortcut = chord.split('+').map(key => keys[key] ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key)).join('+');
			await page.keyboard.press(shortcut);
		}
	};
	const expectedPath = await page.evaluate(() => navigator.userAgent.includes('Windows') ? '\\workspace\\main.ts' : '/workspace/main.ts');
	await pressCommand('copyFilePath');
	await expect.poll(() => page.evaluate(() => window.ashFileMenusIntegration.clipboard())).toEqual([expectedPath]);
	await pressCommand('copyRelativeFilePath');
	await expect.poll(() => page.evaluate(() => window.ashFileMenusIntegration.clipboard())).toEqual([expectedPath, 'main.ts']);
	await pressCommand('explorer.openToSide');
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

test("application menu switches its root submenus on pointer entry", async ({ page }) => {
	await page.goto('/fileMenus.html?applicationMenu');
	await page.waitForFunction(() => !!window.ashFileMenusIntegration);
	const trigger = page.getByRole('toolbar', { name: 'Title bar left actions' }).getByRole('button', { name: 'Application menu' });
	await expect(trigger).toHaveCount(1);
	await expect(trigger).toHaveAccessibleName('Application menu');
	await expect(trigger.locator('.ash-icon')).toBeVisible();
	await expect(trigger.locator('.ash-button-label')).toBeHidden();
	await expect(trigger).toHaveCSS('width', '22px');
	await expect(trigger).toHaveCSS('height', '22px');
	await expect(page.getByRole('toolbar', { name: 'Title bar left actions' }).getByRole('menubar')).toHaveCount(0);
	const adjacentAction = page.getByRole('button', { name: 'Toggle sidebar', exact: true });
	const [triggerBounds, actionBounds] = await Promise.all([trigger.boundingBox(), adjacentAction.boundingBox()]);
	expect(triggerBounds).not.toBeNull();
	expect(actionBounds).not.toBeNull();
	expect({ width: triggerBounds!.width, height: triggerBounds!.height }).toEqual({ width: actionBounds!.width, height: actionBounds!.height });
	await trigger.hover();
	await expect(trigger).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	await trigger.click();
	const mainMenu = page.getByRole('menu').first();
	const fileMenuItem = mainMenu.getByRole('menuitem', { name: 'File' });
	const editMenuItem = mainMenu.getByRole('menuitem', { name: 'Edit' });

	await fileMenuItem.hover();
	await expect(fileMenuItem).toHaveAttribute('aria-expanded', 'true');
	await editMenuItem.hover();
	await expect(fileMenuItem).toHaveAttribute('aria-expanded', 'false');
	await expect(editMenuItem).toHaveAttribute('aria-expanded', 'true');
	const bounds = await editMenuItem.boundingBox();
	expect(bounds).not.toBeNull();
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
	await trigger.press('Enter');
	await expect(mainMenu).toBeFocused();
	await expect(editMenuItem).toHaveAttribute('aria-expanded', 'false');
	await expect(mainMenu.locator('.ash-action-view-item.focused')).toHaveCount(0);
	await page.mouse.move(bounds!.x + bounds!.width / 2 + 2, bounds!.y + bounds!.height / 2);
	await expect(editMenuItem).toHaveAttribute('aria-expanded', 'true');
});

test("application menu keeps submenu arrows inside their menu rows", async ({ page }) => {
	await page.goto('/fileMenus.html?applicationMenu');
	await page.waitForFunction(() => !!window.ashFileMenusIntegration);
	await page.getByRole('button', { name: 'Application menu' }).click();
	const mainMenu = page.getByRole('menu').first();
	const fileItem = mainMenu.getByRole('menuitem', { name: 'File' });
	await fileItem.hover();
	await expect(fileItem).toHaveAttribute('aria-expanded', 'true');
	const arrow = fileItem.locator('.ash-submenu-indicator > .ash-icon');
	const [itemBounds, arrowBounds] = await Promise.all([fileItem.boundingBox(), arrow.boundingBox()]);
	expect(itemBounds).not.toBeNull();
	expect(arrowBounds).not.toBeNull();
	expect(arrowBounds!.width).toBe(12);
	expect(itemBounds!.x + itemBounds!.width - arrowBounds!.x - arrowBounds!.width).toBeGreaterThanOrEqual(8);
});

test("application menu aligns command labels with and without icons", async ({ page }) => {
	await page.goto('/fileMenus.html?applicationMenu');
	await page.waitForFunction(() => !!window.ashFileMenusIntegration);
	await page.getByRole('button', { name: 'Application menu' }).click();
	const fileItem = page.getByRole('menu').first().getByRole('menuitem', { name: 'File' });
	await fileItem.hover();
	await expect(fileItem).toHaveAttribute('aria-expanded', 'true');
	const fileMenu = page.getByRole('menu').last();
	await expect(fileMenu.locator('..')).toHaveCSS('border-radius', '8px');
	const iconLabel = fileMenu.getByRole('menuitem', { name: 'With icon' }).locator('.ash-button-label');
	const plainLabel = fileMenu.getByRole('menuitem', { name: 'Without icon' }).locator('.ash-button-label');
	for (const [name, shortcut] of [['With icon', process.platform === 'darwin' ? '⌘N' : 'Ctrl+N'], ['Without icon', process.platform === 'darwin' ? '⌘A' : 'Ctrl+A']] as const) {
		const item = fileMenu.getByRole('menuitem', { name, exact: true });
		await expect(item.locator('.ash-button-label')).toHaveText(name);
		await expect(item.locator('.ash-menu-keybinding')).toHaveClass(/ash-keybinding-label-plain/u);
		const key = item.locator('.ash-menu-keybinding kbd');
		await expect(key).toHaveText(shortcut);
		const font = (element: Element) => ({ family: getComputedStyle(element).fontFamily, size: getComputedStyle(element).fontSize });
		expect(await key.evaluate(font)).toEqual(await item.evaluate(font));
	}
	const [iconBounds, plainBounds] = await Promise.all([iconLabel.boundingBox(), plainLabel.boundingBox()]);
	expect(iconBounds).not.toBeNull();
	expect(plainBounds).not.toBeNull();
	expect(Math.abs(iconBounds!.x - plainBounds!.x)).toBeLessThanOrEqual(1);
});

test("checked View menu icons stay inside the leading slot", async ({ page }) => {
	await page.goto('/fileMenus.html?applicationMenu');
	await page.waitForFunction(() => !!window.ashFileMenusIntegration);
	await page.getByRole('button', { name: 'Application menu' }).click();
	const view = page.getByRole('menu').first().getByRole('menuitem', { name: 'File' });
	await view.hover();
	await expect(view).toHaveAttribute('aria-expanded', 'true');
	const viewMenu = page.getByRole('menu').last();
	for (const [actionId, checked, iconSelector] of [
		['fixture.checked', 'true', '.ash-menu-leading-check > .ash-icon'],
		['fixture.unchecked', 'false', '.ash-menu-leading-check > .ash-icon-label-icon > .ash-icon'],
	] as const) {
		const item = viewMenu.locator(`[data-action-id="${actionId}"] button`);
		await expect(item).toHaveAttribute('aria-checked', checked);
		const slot = item.locator('.ash-menu-leading-slot');
		const icon = item.locator(iconSelector);
		const label = item.locator('.ash-button-label');
		const [slotBounds, iconBounds, labelBounds] = await Promise.all([
			slot.boundingBox(), icon.boundingBox(), label.boundingBox(),
		]);
		expect(slotBounds).not.toBeNull();
		expect(iconBounds).not.toBeNull();
		expect(labelBounds).not.toBeNull();
		expect(iconBounds!.x).toBeGreaterThanOrEqual(slotBounds!.x);
		expect(iconBounds!.x + iconBounds!.width).toBeLessThanOrEqual(slotBounds!.x + slotBounds!.width);
		expect(labelBounds!.x).toBeGreaterThanOrEqual(iconBounds!.x + iconBounds!.width + 4);
	}
});
