import type { Locator } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('editor title scrollbars preserve overflow, focus and clipping through size and visibility changes', async ({ workbench }) => {
	const page = workbench.page;
	for (let i = 0; i < 9; i++) await page.keyboard.press('ControlOrMeta+N');
	const group = workbench.editors.groupAt(0);
	const tabs = group.title.locator('.ash-ordinary-editor-tabs-row .ash-tab-list');
	const breadcrumbs = group.title.locator('.ash-breadcrumbs-widget');
	await tabs.evaluate(element => { (element as HTMLElement).style.width = '220px'; });
	await breadcrumbs.evaluate(element => { (element as HTMLElement).style.width = '60px'; });
	const tabViewport = tabs.locator('.ash-scrollbar-viewport');
	const breadcrumbViewport = breadcrumbs.locator('.ash-scrollbar-viewport');
	const tabBar = tabs.getByRole('scrollbar', { name: 'Horizontal scrollbar', includeHidden: true });
	const breadcrumbBar = breadcrumbs.getByRole('scrollbar', { name: 'Horizontal scrollbar', includeHidden: true });
	const selected = tabs.locator('.ash-tab.checked');
	const identity = await selected.getByRole('tab').getAttribute('id');
	const originalViewport = await tabViewport.elementHandle();
	for (const [viewport, bar] of [[tabViewport, tabBar], [breadcrumbViewport, breadcrumbBar]]) {
		await expect.poll(() => viewport.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
		await expect(bar).toHaveCSS('height', '3px');
	}
	const changeSetting = async (key: string, option: string): Promise<void> => {
		await workbench.quickaccess.runCommand('workbench.action.openSettings');
		const settings = page.locator('.ash-settings-editor');
		await settings.locator('[data-settings-category-id="editor"]').click();
		await settings.getByRole('searchbox', { name: 'Search settings' }).fill(`workbench.editor.titleScrollbar${key}`);
		await settings.locator(`[data-configuration-key="workbench.editor.titleScrollbar${key}"]`).getByRole('combobox').click();
		await page.getByRole('option', { name: option, exact: true }).click();
		await page.locator('.ash-modal-editor-close').click();
	};
	const exercise = async (viewport: Locator, bar: Locator): Promise<void> => {
		await viewport.evaluate(element => { element.scrollLeft = 0; });
		await viewport.hover();
		await page.mouse.wheel(0, 60);
		await expect.poll(() => viewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
		await bar.focus();
		await expect(bar).toHaveCSS('opacity', '1');
		await bar.press('Home');
		await expect.poll(() => viewport.evaluate(element => element.scrollLeft)).toBe(0);
		const thumb = await bar.locator('.ash-scrollbar-thumb').boundingBox();
		expect(thumb).not.toBeNull();
		await page.mouse.move(thumb!.x + thumb!.width / 2, thumb!.y + thumb!.height / 2);
		await page.mouse.down();
		await page.mouse.move(thumb!.x + thumb!.width / 2 + 30, thumb!.y + thumb!.height / 2);
		await page.mouse.move(thumb!.x + thumb!.width / 2 + 30, thumb!.y + 50);
		await expect(bar).toHaveCSS('opacity', '1');
		await page.mouse.up();
		await expect.poll(() => viewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
	};
	await exercise(tabViewport, tabBar);
	await exercise(breadcrumbViewport, breadcrumbBar);
	await changeSetting('Sizing', 'Large');
	await expect(tabBar).toHaveCSS('height', '10px');
	await expect(breadcrumbBar).toHaveCSS('height', '8px');
	await expect(selected.getByRole('tab')).toHaveAttribute('id', identity!);
	expect(await tabViewport.evaluate((element, previous) => element === previous, originalViewport)).toBe(true);

	await page.mouse.move(0, 0);
	await page.getByRole('button', { name: 'Search commands', exact: true }).focus();
	await expect(tabBar).toHaveCSS('opacity', '0');
	await expect(breadcrumbBar).toHaveCSS('opacity', '0');
	await exercise(tabViewport, tabBar);
	await exercise(breadcrumbViewport, breadcrumbBar);
	await tabViewport.evaluate(element => { element.scrollLeft = 0; });
	await expect(selected).toHaveClass(/connected-tab-right-clipped/u);
	await selected.getByRole('tab').focus();
	await expect.poll(() => selected.evaluate(tab => {
		const viewport = tab.closest('.ash-scrollbar-viewport')!.getBoundingClientRect();
		const bounds = tab.getBoundingClientRect();
		return bounds.left >= viewport.left - 1 && bounds.right <= viewport.right + 1;
	})).toBe(true);
	await expect(selected).not.toHaveClass(/connected-tab-right-clipped/u);
	await expect(selected).toHaveCSS('border-bottom-width', '0px');
	await changeSetting('Visibility', 'Visible');
	await page.mouse.move(0, 0);
	await page.getByRole('button', { name: 'Search commands', exact: true }).focus();
	await expect(tabBar).toHaveCSS('opacity', '1');
	await expect(breadcrumbBar).toHaveCSS('opacity', '1');
	await changeSetting('Visibility', 'Hidden');
	await expect(tabBar).toBeHidden();
	await expect(breadcrumbBar).toBeHidden();
	await selected.getByRole('tab').press('Alt+Enter');
	const sticky = group.title.locator('.ash-sticky-editor-tabs-row .ash-tab-list');
	await expect(sticky).toHaveCSS('--ash-scrollbar-size', '10px');
	await expect(sticky.locator('.ash-scrollbar-track-horizontal')).toBeHidden();
	await changeSetting('Sizing', 'Default');
	await expect(sticky).toHaveCSS('--ash-scrollbar-size', '3px');
	await changeSetting('Visibility', 'Auto');
	await expect(tabBar).not.toBeHidden();
});
