import { expect, test } from '../../../automation/test.js';

const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 1, 8, 6, 0, 0, 0, 244, 34, 127, 138, 0, 0, 0, 14, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 240, 31, 4, 1, 16, 248, 3, 253, 78, 149, 193, 111, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
const longName = 'library-secondary-product-photography-for-the-autumn-brand-campaign-and-design-reference.png';

test('Sessions Library coordinates independent container Views and a retained browsing editor', async ({ application, target, workbench }) => {
	let page = workbench.page;
	if (target.kind === 'browser') { await page.locator('[data-action-id="ash.code.open-sessions"] button').click(); }
	else {
		if (!('windows' in application)) { throw new Error('Expected Electron windows'); }
		const opened = application.waitForEvent('window');
		await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
		page = await opened;
	}
	const navigation = page.locator('.ash-sessions-activity-content');
	await navigation.getByRole('button', { name: 'Library', exact: true }).click();
	const library = page.locator('.ash-library');
	await expect(library).toBeVisible();
	await expect(page.locator('[data-part="editor"]')).toBeVisible();
	await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
	await expect(page.locator('[data-part="sidebar"] [data-view-id="sessions.library.navigation.view"]')).toBeVisible();
	await expect(page.locator('[data-part="auxiliarybar"] [data-view-id="sessions.library.details.view"]')).toBeVisible();
	await expect(library.locator('.ash-library-sidebar, .ash-library-details')).toHaveCount(0);
	await expect(page.getByRole('tab', { name: 'Library', exact: true })).toHaveCount(1);
	await expect(page.locator('[data-part="library"], [data-part="creator"]')).toHaveCount(0);
	await expect(library.getByRole('heading', { name: 'All', exact: true })).toBeVisible();
	const categories = page.locator('[data-part="sidebar"]').getByRole('navigation', { name: 'Library categories' });
	await categories.getByRole('button', { name: 'All', exact: true }).focus();
	await page.keyboard.press('ArrowDown');
	await expect(categories.getByRole('button', { name: 'Favorites', exact: true })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(categories.getByRole('button', { name: 'Favorites', exact: true })).toHaveAttribute('aria-current', 'page');
	await library.getByRole('searchbox').fill('Retained search');
	await library.getByRole('button', { name: 'List view', exact: true }).click();
	await expect(library).toHaveClass(/list-view/);
	await navigation.getByRole('button', { name: /^Chat/, exact: false }).click();
	await expect(library).toBeHidden();
	await navigation.getByRole('button', { name: 'Library', exact: true }).click();
	await expect(library.getByRole('searchbox')).toHaveValue('Retained search');
	await expect(library).toHaveClass(/list-view/);
	await library.getByRole('searchbox').focus();
	await page.keyboard.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/Library stores reusable images/);
	await page.keyboard.press('Escape');
	await expect(library.getByRole('searchbox')).toBeFocused();
	await navigation.getByRole('button', { name: 'Chat', exact: true }).click();
	await expect(page.locator('[data-part="sessions"]')).toBeVisible();
	await expect(library).toBeHidden();
	await navigation.getByRole('button', { name: 'Library', exact: true }).click();
	await expect(library).toBeVisible();
	if (target.kind === 'browser') { await page.setViewportSize({ width: 640, height: 780 }); }
	else {
		if (!('windows' in application)) { throw new Error('Expected Electron windows'); }
		await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('sessions-code.html'))!.setSize(640, 780); });
	}
	await expect(library).toHaveClass(/narrow/);
	await expect.poll(() => library.evaluate(element => [...element.querySelectorAll<HTMLElement>('*')].filter(child => child.scrollWidth > child.clientWidth && getComputedStyle(child).overflowX === 'visible').map(child => ({ className: child.className, width: child.clientWidth, contentWidth: child.scrollWidth })))).toEqual([]);
	if (target.appServerMode === 'disabled') {
		await expect(library.getByRole('status')).toContainText('Could not load the library');
		await library.getByRole('button', { name: 'Refresh', exact: true }).click();
		await expect(library.getByRole('status')).toContainText('Could not load the library');
	}
});

test('Sessions Library imports real images and preserves favorites and collections after reload', async ({ application, target, workbench }) => {
	test.skip(target.appServerMode !== 'required');
	let page = workbench.page;
	if (target.kind === 'browser') { await page.locator('[data-action-id="ash.code.open-sessions"] button').click(); }
	else {
		if (!('windows' in application)) { throw new Error('Expected Electron windows'); }
		const opened = application.waitForEvent('window');
		await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
		page = await opened;
	}
	const navigation = page.locator('.ash-sessions-activity-content');
	await navigation.getByRole('button', { name: 'Library', exact: true }).click();
	const library = page.locator('.ash-library');
	await library.locator('input[type=file]').setInputFiles([{ name: 'library-product.png', mimeType: 'image/png', buffer: image }, { name: longName, mimeType: 'image/png', buffer: image }]);
	const item = library.getByRole('button', { name: 'library-product.png', exact: true });
	await expect(item).toBeVisible();
	const longItem = library.getByRole('button', { name: longName, exact: true });
	await expect(longItem).toBeVisible();
	await expect(longItem.locator('.ash-library-item-name')).toHaveCSS('text-overflow', 'ellipsis');
	await expect.poll(() => library.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
	await expect.poll(() => item.locator('img').evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(2);
	await item.click();
	const details = page.locator('[data-part="auxiliarybar"]').getByRole('complementary', { name: 'Asset details' });
	await expect(details).toContainText('file-upload:/library-product.png');
	await details.getByRole('button', { name: 'Add to favorites', exact: true }).click();
	await expect(details.getByRole('button', { name: 'Remove from favorites', exact: true })).toBeEnabled();
	await details.getByRole('button', { name: 'New collection', exact: true }).click();
	const input = page.locator('.ash-quick-pick').getByRole('textbox');
	await input.fill('Brand assets');
	await input.press('Enter');
	const membership = details.getByRole('checkbox', { name: 'Brand assets' });
	await expect(membership).toBeEnabled();
	await membership.check();
	await expect(membership).toBeChecked();
	await expect(membership).toBeEnabled();
	await page.locator('[data-part="sidebar"]').getByRole('navigation').getByRole('button', { name: 'Brand assets', exact: true }).click();
	await expect(library.getByRole('listitem')).toHaveCount(1);
	await library.getByRole('searchbox').fill('no match');
	await expect(library.getByRole('listitem')).toHaveCount(0);
	await library.getByRole('searchbox').fill('product');
	await expect(item).toBeVisible();
	await library.getByRole('button', { name: 'List view', exact: true }).click();
	await page.reload();
	await navigation.getByRole('button', { name: 'Library', exact: true }).click();
	await expect(library).toHaveClass(/list-view/);
	await page.locator('[data-part="sidebar"]').getByRole('navigation').getByRole('button', { name: 'Brand assets', exact: true }).click();
	await expect(item).toBeVisible();
	await item.focus();
	await page.keyboard.press('Enter');
	await expect(item).toBeFocused();
	await expect(details.getByRole('button', { name: 'Remove from favorites', exact: true })).toBeEnabled();
	await page.keyboard.press('Alt+F2');
	const accessible = page.getByRole('dialog', { name: 'Accessible View', exact: true });
	await expect(accessible.getByRole('textbox')).toHaveValue(/library-product.png.*Favorite/);
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
	await expect(item).toBeFocused();
	await library.getByRole('button', { name: 'Delete collection', exact: true }).click();
	await expect(page.locator('[data-part="sidebar"]').getByRole('navigation').getByRole('button', { name: 'Brand assets', exact: true })).toHaveCount(0);
	await expect(item).toBeVisible();
	await item.click();
	await details.getByRole('button', { name: 'Add to conversation', exact: true }).click();
	await expect(page.locator('.ash-sessions-chat-input:visible').getByRole('button', { name: 'Remove library-product.png', exact: true })).toBeVisible();
	await navigation.getByRole('button', { name: 'Library', exact: true }).click();
	await expect(details.getByRole('button', { name: 'Use in Design', exact: true })).toBeEnabled();
	await details.getByRole('button', { name: 'Use in Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas' });
	await expect(canvas.locator('svg image')).toHaveCount(1);
	await expect(canvas.locator('svg image')).toHaveAttribute('href', /^blob:/);
	await navigation.getByRole('button', { name: 'Library', exact: true }).click();
	await expect(details.getByRole('button', { name: 'Use in Design', exact: true })).toBeEnabled();
	await details.getByRole('button', { name: 'Use in Design', exact: true }).click();
	await expect(canvas.locator('svg image')).toHaveCount(2);
});

test('Sessions Library keeps text and keyboard focus readable across themes', async ({ application, target, workbench }) => {
	let page = workbench.page;
	for (const [theme, scheme] of [['Ash Light', 'light'], ['Ash Dark', 'dark'], ['Ash High Contrast Dark', 'high-contrast-dark'], ['Ash High Contrast Light', 'high-contrast-light']]) {
		if (target.kind === 'browser') {
			await page.goto('/browser/workbench/workbench.html');
			await workbench.waitForReady();
		}
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const picker = workbench.page.locator('.ash-quick-pick');
		await picker.getByRole('combobox').fill(theme);
		await picker.getByRole('combobox').press('Enter');
		await expect(picker).toHaveCount(0);
		if (target.kind === 'browser') { await page.locator('[data-action-id="ash.code.open-sessions"] button').click(); }
		else if (page === workbench.page) {
			if (!('windows' in application)) { throw new Error('Expected Electron windows'); }
			const opened = application.waitForEvent('window');
			await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
			page = await opened;
		}
		await expect(page.locator('#app')).toHaveAttribute('data-color-scheme', scheme);
		await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Library', exact: true }).click();
		const library = page.locator('.ash-library');
		const colors = await library.evaluate(element => ({ text: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
		expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
		expect(colors.text).not.toBe(colors.background);
		const search = library.getByRole('searchbox');
		await search.focus();
		await expect(search).toHaveCSS('outline-style', 'solid');
		if (target.appServerMode === 'required') {
			if (scheme === 'light') { await library.locator('input[type=file]').setInputFiles({ name: 'theme-preview.png', mimeType: 'image/png', buffer: image }); }
			const item = library.getByRole('button', { name: 'theme-preview.png', exact: true });
			await expect(item).toBeVisible();
			if (scheme.startsWith('high-contrast')) {
				const colors = await item.evaluate(element => {
					const probe = document.createElement('span');
					probe.style.color = 'var(--ash-contrast-border)'; element.append(probe);
					const contrast = getComputedStyle(probe).color; probe.remove();
					return { border: getComputedStyle(element).borderTopColor, contrast };
				});
				expect(colors.border).toBe(colors.contrast);
			}
		}
	}
});

test('Sessions Library uses Chinese labels and localized keyboard help', async ({ application, target, workbench, restartWorkbench }) => {
	let page = workbench.page;
	await page.keyboard.press('ControlOrMeta+,');
	let settings = page.locator('.ash-settings-editor');
	await settings.locator('[data-settings-category-id="general"]').click();
	const language = settings.locator('[data-settings-item-id="workbench.locale"]').getByRole('combobox');
	await language.click();
	await page.keyboard.press('End');
	await page.keyboard.press('Enter');
	await expect(language).toHaveText('简体中文');
	({ workbench, application } = await restartWorkbench());
	page = workbench.page;
	await page.keyboard.press('ControlOrMeta+,');
	await page.locator('.ash-modal-editor-close').click();
	if (target.kind === 'browser') { await page.locator('[data-action-id="ash.code.open-sessions"] button').click(); }
	else {
		if (!('windows' in application)) { throw new Error('Expected Electron windows'); }
		const opened = application.waitForEvent('window');
		await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
		page = await opened;
	}
	await page.waitForFunction(() => document.querySelector('.ash-sessions-activity-content') || document.querySelector('#app > section > textarea[readonly]'));
	if (await page.locator('#app > section > textarea[readonly]').count()) throw new Error(await page.locator('#app > section > textarea[readonly]').inputValue());

	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: '资料库', exact: true }).click();
	const library = page.locator('.ash-library');
	await expect(library.getByRole('heading', { name: '全部', exact: true })).toBeVisible();
	await expect(library.getByRole('button', { name: '导入', exact: true })).toBeVisible();
	await library.getByRole('searchbox', { name: '搜索素材库' }).focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/素材库独立于对话保存可复用的图片/);
	await page.keyboard.press('Escape');
	await expect(library.getByRole('searchbox', { name: '搜索素材库' })).toBeFocused();
});
