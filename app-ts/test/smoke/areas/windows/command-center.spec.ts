import type { ElectronApplication } from '@playwright/test';
import type { BrowserWindow, MessageBoxOptions } from 'electron';
import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('desktop GitHub connection error uses a window dialog', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'disabled');
	const electron = application as ElectronApplication;
	await electron.evaluate(({ dialog }) => {
		const original = dialog.showMessageBox.bind(dialog);
		const state = globalThis as typeof globalThis & { ashGitHubDialog?: { options?: MessageBoxOptions; finish?: () => void; restore: () => void } };
		state.ashGitHubDialog = { restore: () => { dialog.showMessageBox = original; } };
		dialog.showMessageBox = ((...args: [MessageBoxOptions] | [BrowserWindow, MessageBoxOptions]) => new Promise(resolve => {
			state.ashGitHubDialog!.options = args.length === 1 ? args[0] : args[1];
			state.ashGitHubDialog!.finish = () => resolve({ response: 0, checkboxChecked: false });
		})) as typeof dialog.showMessageBox;
	});
	try {
		const page = workbench.page;
		await page.getByRole('button', { name: 'Accounts' }).click();
		await page.getByRole('menu').last().getByRole('menuitem', { name: 'Connect GitHub' }).click();
		await expect.poll(() => electron.evaluate(() => {
			const options = (globalThis as typeof globalThis & { ashGitHubDialog?: { options?: MessageBoxOptions } }).ashGitHubDialog?.options;
			return options ? { title: options.title, message: options.message } : undefined;
		})).toEqual({
			title: 'Connect GitHub',
			message: 'Could not connect GitHub. Try again.',
		});
		await expect(page.locator('.ash-notification')).toHaveCount(0);
	} finally {
		await electron.evaluate(() => {
			const state = (globalThis as typeof globalThis & { ashGitHubDialog?: { finish?: () => void; restore: () => void } }).ashGitHubDialog;
			state?.finish?.();
			state?.restore();
		});
	}
});

test('primary sidebar toggle sits immediately after the application menu', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const actionId = 'workbench.action.toggleSideBar';
	const toggle = page.locator(`.ash-titlebar-left-actions [data-action-id="${actionId}"] button`);
	const toolbar = page.getByRole('toolbar', { name: 'Title bar left actions' });
	const menu = toolbar.getByRole('button', { name: 'Application menu' });
	await expect(page.locator(`.ash-titlebar-actions [data-action-id="${actionId}"]`)).toHaveCount(0);
	await expect(toggle).toBeVisible();
	await expect(menu).toBeVisible();
	expect(await toolbar.locator('.ash-action-view-item').evaluateAll(elements =>
		elements.slice(0, 2).map(element => element.getAttribute('data-action-id')))).toEqual([
		'ash.applicationMenu',
		actionId,
	]);
	const rightGap = await page.locator('.ash-titlebar-actions .ash-action-bar').evaluate(element =>
		Number.parseFloat(getComputedStyle(element).columnGap));
	const [menuBounds, toggleBounds] = await Promise.all([menu.boundingBox(), toggle.boundingBox()]);
	expect(menuBounds).not.toBeNull();
	expect(toggleBounds).not.toBeNull();
	expect(toggleBounds!.x - menuBounds!.x - menuBounds!.width).toBeCloseTo(rightGap, 0);
	const sidebar = page.locator('[data-part="sidebar"]');
	const wasVisible = await sidebar.isVisible();
	await toggle.click();
	await expect(toggle).toBeFocused();
	if (wasVisible) {
		await expect(sidebar).toBeHidden();
	} else {
		await expect(sidebar).toBeVisible();
	}
});

test('activity bar remains visible and reopens a selected sidebar view', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const activitybar = page.locator('[data-part="activitybar"]');
	const sidebar = page.locator('[data-part="sidebar"]');
	const explorer = activitybar.getByRole('tab', { name: 'Explorer' });
	const search = activitybar.getByRole('tab', { name: 'Search' });
	const accounts = activitybar.getByRole('button', { name: 'Accounts' });
	const manage = activitybar.getByRole('button', { name: 'Manage' });
	await expect(activitybar).toBeVisible();
	await expect(accounts).toBeVisible();
	await expect(manage).toBeVisible();
	const [searchBounds, accountsBounds, manageBounds] = await Promise.all([search.boundingBox(), accounts.boundingBox(), manage.boundingBox()]);
	expect(searchBounds).not.toBeNull();
	expect(accountsBounds).not.toBeNull();
	expect(manageBounds).not.toBeNull();
	expect(accountsBounds!.y).toBeGreaterThan(searchBounds!.y);
	expect(manageBounds!.y).toBeGreaterThan(accountsBounds!.y);
	await accounts.click();
	await expect(page.getByRole('menu').last().getByRole('menuitem', { name: 'Sign in with ChatGPT' })).toBeVisible();
	await expect(page.getByRole('menu').last().getByRole('menuitem', { name: 'Connect GitHub' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(activitybar.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
	await expect(explorer).toHaveAttribute('aria-selected', 'true');
	await explorer.click();
	await expect(sidebar).toBeVisible();
	await expect(page.locator('.ash-workbench')).toHaveClass(/modern-ui/);
	await expect(explorer).toHaveCSS('height', '36px');
	await expect(explorer).toHaveCSS('width', '36px');
	await expect(explorer.locator('.ash-icon')).toHaveCSS('width', '24px');
	await expect(accounts.locator('.ash-button-content .ash-icon').first()).toHaveCSS('width', '24px');
	const selectedBackground = await explorer.evaluate(element => getComputedStyle(element, '::after').backgroundColor);
	expect(selectedBackground).not.toBe('rgba(0, 0, 0, 0)');
	const selectedSpacing = await explorer.evaluate(element => {
		const style = getComputedStyle(element, '::after');
		return { width: style.width, height: style.height, radius: style.borderRadius };
	});
	expect(selectedSpacing).toEqual({ width: '32px', height: '32px', radius: '4px' });
	const [outerBox, itemBox] = await Promise.all([activitybar.boundingBox(), explorer.boundingBox()]);
	expect(outerBox).not.toBeNull();
	expect(itemBox).not.toBeNull();
	expect(itemBox!.x - outerBox!.x).toBe(4);
	expect(itemBox!.y - outerBox!.y).toBe(4);
	const selectedBackgroundGap = await explorer.evaluate(element => {
		const outer = element.closest<HTMLElement>('[data-part="activitybar"]')!.getBoundingClientRect();
		const item = element.getBoundingClientRect();
		const style = getComputedStyle(element, '::after');
		const width = Number.parseFloat(style.width);
		const x = item.left + Number.parseFloat(style.left) + new DOMMatrixReadOnly(style.transform).m41;
		return {
			left: x - outer.left,
			right: outer.right - x - width,
			top: item.top + Number.parseFloat(style.top) - outer.top,
		};
	});
	expect(selectedBackgroundGap).toEqual({ left: 6, right: 6, top: 6 });
	await expect(activitybar).toHaveClass(/sidebar-open/);
	await expect(activitybar).toHaveCSS('border-top-left-radius', '8px');
	await expect(activitybar).toHaveCSS('border-top-right-radius', '0px');
	await expect(activitybar).toHaveCSS('border-right-width', '1px');
	await expect(activitybar).toHaveCSS('border-right-color', 'rgb(229, 229, 229)');
	await expect(sidebar).toHaveCSS('border-left-width', '0px');
	await expect(sidebar).toHaveCSS('border-top-left-radius', '0px');
	await expect(sidebar.locator('.ash-sidebar-title-label')).toHaveText('Explorer');
	const sidebarActions = sidebar.locator('.ash-pane-composite-title-actions');
	await sidebarActions.getByRole('button', { name: 'More Actions' }).click();
	await page.getByRole('menu').last().getByRole('menuitemcheckbox', { name: 'Hide Primary Side Bar' }).click();
	await expect(sidebar).toBeHidden();
	await expect(activitybar).toBeVisible();
	await explorer.click();
	await expect(sidebar).toBeVisible();
	const [railBounds, sidebarBounds] = await Promise.all([activitybar.boundingBox(), sidebar.boundingBox()]);
	expect(railBounds).not.toBeNull();
	expect(sidebarBounds).not.toBeNull();
	expect(railBounds!.width).toBe(44);
	await expect(activitybar).toHaveCSS('background-color', 'rgb(248, 248, 248)');
	await expect(sidebar).toHaveCSS('background-color', 'rgb(248, 248, 248)');
	expect(Math.abs(railBounds!.x + railBounds!.width - sidebarBounds!.x)).toBeLessThan(1);
	await explorer.focus();
	await explorer.press('ArrowDown');
	await expect(search).toBeFocused();
	await search.press('Enter');
	await expect(search).toHaveAttribute('aria-selected', 'true');
	await expect(sidebar.locator('.ash-sidebar-title-label')).toHaveText('Search');
	await search.click();
	await expect(sidebar).toBeHidden();
	await expect(activitybar).toBeVisible();
	await expect(activitybar).not.toHaveClass(/sidebar-open/);
	await expect(activitybar).toHaveCSS('border-top-right-radius', '8px');
	const [closedRailBounds, editorBounds] = await Promise.all([
		activitybar.boundingBox(),
		page.locator('[data-part="editor"]').boundingBox(),
	]);
	expect(closedRailBounds).not.toBeNull();
	expect(editorBounds).not.toBeNull();
	expect(editorBounds!.x - closedRailBounds!.x - closedRailBounds!.width).toBe(6);
	await search.click();
	await expect(sidebar).toBeVisible();
	await page.locator('.ash-titlebar-left-actions [data-action-id="workbench.action.toggleSideBar"] button').click();
	await expect(sidebar).toBeHidden();
	await expect(activitybar).toBeVisible();
	await search.click();
	await expect(sidebar).toBeVisible();
	await expect(search).toHaveAttribute('aria-selected', 'true');
});

test('activity bar keeps global actions visible and moves excess views into a menu', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.setViewportSize({ width: 1024, height: 280 });
	const activitybar = page.locator('[data-part="activitybar"]');
	await expect(activitybar.getByRole('button', { name: 'Accounts' })).toBeVisible();
	await expect(activitybar.getByRole('button', { name: 'Manage' })).toBeVisible();
	const overflow = activitybar.getByRole('tab', { name: 'Additional views' });
	await expect(overflow).toBeVisible();
	await overflow.click();
	const menu = page.getByRole('menu').last();
	await expect(menu.getByRole('menuitemcheckbox').first()).toBeVisible();
	await menu.getByRole('menuitemcheckbox').first().click();
	await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
});

test('activity bar context menu hides and restores view icons', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const activitybar = page.locator('[data-part="activitybar"]');
	const explorer = activitybar.getByRole('tab', { name: 'Explorer' });
	const search = activitybar.getByRole('tab', { name: 'Search' });
	await search.click({ button: 'right' });
	const itemMenu = page.getByRole('menu').last();
	await expect(itemMenu.getByRole('menuitem', { name: "Hide 'Search'" })).toBeVisible();
	await expect(itemMenu.getByRole('menuitemcheckbox', { name: 'Search' })).toHaveAttribute('aria-checked', 'true');
	await itemMenu.getByRole('menuitem', { name: "Hide 'Search'" }).click();
	await expect(search).toBeHidden();
	await explorer.click({ button: 'right' });
	const barMenu = page.getByRole('menu').last();
	await expect(barMenu.getByRole('menuitemcheckbox', { name: 'Search' })).toHaveAttribute('aria-checked', 'false');
	await barMenu.getByRole('menuitemcheckbox', { name: 'Search' }).click();
	await expect(search).toBeVisible();
	await explorer.focus();
	await explorer.press('Shift+F10');
	await expect(page.getByRole('menu').last().getByRole('menuitem', { name: "Hide 'Explorer'" })).toBeVisible();
});

test('blank activity bar context menu lists and toggles views', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const activitybar = workbench.page.locator('[data-part="activitybar"]');
	const compositeBar = activitybar.locator('.ash-composite-bar');
	const search = activitybar.getByRole('tab', { name: 'Search' });
	const bounds = await compositeBar.boundingBox();
	expect(bounds).not.toBeNull();
	await compositeBar.click({ button: 'right', position: { x: 2, y: bounds!.height - 4 } });
	let menu = workbench.page.getByRole('menu').last();
	for (const name of ['Explorer', 'Search', 'Git', 'Run and Debug', 'Testing', 'Marketplace', 'Language servers', 'Skills']) {
		await expect(menu.getByRole('menuitemcheckbox', { name })).toHaveAttribute('aria-checked', 'true');
	}
	await expect(menu.getByRole('menuitemcheckbox', { name: 'Accounts' })).toBeVisible();
	await expect(menu.getByRole('menuitem', { name: 'Activity Bar Position' })).toBeVisible();
	await menu.getByRole('menuitemcheckbox', { name: 'Search' }).click();
	await expect(search).toBeHidden();

	await compositeBar.click({ button: 'right', position: { x: 2, y: bounds!.height - 4 } });
	menu = workbench.page.getByRole('menu').last();
	await expect(menu.getByRole('menuitemcheckbox', { name: 'Search' })).toHaveAttribute('aria-checked', 'false');
	await menu.getByRole('menuitemcheckbox', { name: 'Search' }).click();
	await expect(search).toBeVisible();
});

test('activity bar context menu changes size and position', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const activitybar = page.locator('[data-part="activitybar"]');
	const titlebar = page.locator('[data-part="titlebar"]');
	const sidebar = page.locator('[data-part="sidebar"]');
	const editor = page.locator('[data-part="editor"]');
	await activitybar.getByRole('tab', { name: 'Explorer' }).click();
	await expect(sidebar).toBeVisible();
	await activitybar.getByRole('button', { name: 'Accounts' }).click({ button: 'right' });
	let menu = page.getByRole('menu').last();
	await expect(menu.getByRole('menuitemcheckbox', { name: 'Accounts' })).toHaveAttribute('aria-checked', 'true');
	await expect(menu.getByRole('menuitem', { name: 'Activity Bar Position' })).toBeVisible();
	await expect(menu.getByRole('menuitem', { name: 'Activity Bar Size' })).toBeVisible();
	await expect(menu.getByRole('menuitem', { name: 'Move Primary Side Bar Right' })).toBeVisible();
	await menu.getByRole('menuitem', { name: 'Activity Bar Size' }).hover();
	await page.getByRole('menu').last().getByRole('menuitemcheckbox', { name: 'Compact' }).click();
	await expect(activitybar).toHaveCSS('width', '36px');
	const compactExplorer = activitybar.getByRole('tab', { name: 'Explorer' });
	await expect(compactExplorer).toHaveCSS('height', '28px');
	await expect(compactExplorer).toHaveCSS('width', '28px');
	await expect(compactExplorer.locator('.ash-icon')).toHaveCSS('width', '16px');
	await expect(activitybar.getByRole('button', { name: 'Accounts' }).locator('.ash-button-content .ash-icon').first()).toHaveCSS('width', '16px');
	expect(await compactExplorer.evaluate(element => {
		const style = getComputedStyle(element, '::after');
		return { width: style.width, height: style.height, radius: style.borderRadius };
	})).toEqual({ width: '24px', height: '24px', radius: '4px' });
	const [compactOuterBox, compactItemBox] = await Promise.all([activitybar.boundingBox(), compactExplorer.boundingBox()]);
	expect(compactOuterBox).not.toBeNull();
	expect(compactItemBox).not.toBeNull();
	expect(compactItemBox!.x - compactOuterBox!.x).toBe(4);
	expect(compactItemBox!.y - compactOuterBox!.y).toBe(4);
	await activitybar.getByRole('button', { name: 'Accounts' }).click({ button: 'right' });
	menu = page.getByRole('menu').last();
	await menu.getByRole('menuitem', { name: 'Move Primary Side Bar Right' }).click();
	const [sidebarBounds, editorBounds, activityBounds] = await Promise.all([sidebar.boundingBox(), editor.boundingBox(), activitybar.boundingBox()]);
	expect(sidebarBounds).not.toBeNull();
	expect(editorBounds).not.toBeNull();
	expect(activityBounds).not.toBeNull();
	expect(sidebarBounds!.x).toBeGreaterThan(editorBounds!.x);
	expect(activityBounds!.x).toBeGreaterThan(sidebarBounds!.x);
	await expect(activitybar).toHaveCSS('border-left-width', '1px');
	await expect(sidebar).toHaveCSS('border-right-width', '0px');
	await activitybar.getByRole('button', { name: 'Manage' }).click({ button: 'right' });
	await page.getByRole('menu').last().getByRole('menuitem', { name: 'Activity Bar Position' }).hover();
	const positionMenu = page.getByRole('menu').last();
	await expect(positionMenu.getByRole('menuitemcheckbox')).toHaveText(['Default', 'Top', 'Bottom', 'Hidden']);
	await expect(positionMenu.getByRole('menuitemcheckbox', { name: 'Default' })).toHaveAttribute('aria-checked', 'true');
	await positionMenu.getByRole('menuitemcheckbox', { name: 'Top' }).click();
	await expect(activitybar).toBeHidden();
	const topSelector = sidebar.locator('.ash-sidebar-composite-bar-top').getByRole('tablist');
	await expect(topSelector).toHaveAttribute('aria-orientation', 'horizontal');
	await expect(sidebar).toHaveCSS('border-right-width', '1px');
	await expect(sidebar).toHaveCSS('border-top-right-radius', '8px');
	const [rightSidebar, workbenchBounds] = await Promise.all([sidebar.boundingBox(), page.locator('.ash-workbench').boundingBox()]);
	expect(rightSidebar).not.toBeNull();
	expect(workbenchBounds).not.toBeNull();
	expect(workbenchBounds!.x + workbenchBounds!.width - rightSidebar!.x - rightSidebar!.width).toBe(8);
	await expect(topSelector.getByRole('tab', { name: 'Explorer' }).locator('.ash-icon')).toHaveCSS('width', '16px');
	await topSelector.getByRole('tab', { name: 'Explorer' }).click({ button: 'right' });
	await expect(page.getByRole('menu').last().getByRole('menuitem', { name: 'Activity Bar Position' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(sidebar).toHaveCSS('border-top-width', '1px');
	const titlebarAccounts = titlebar.getByRole('button', { name: 'Accounts' });
	const titlebarManage = titlebar.getByRole('button', { name: 'Manage' });
	const titlebarActions = titlebar.getByRole('toolbar', { name: 'Title Bar global actions' });
	await expect(titlebarActions).toBeVisible();
	await expect(titlebarAccounts).toBeVisible();
	await expect(titlebarManage).toHaveCSS('width', '22px');
	for (const button of [titlebarAccounts, titlebarManage]) {
		await expect(button.locator('.ash-button-content .ash-icon')).toHaveCSS('width', '16px');
		await expect(button.locator('.ash-dropdown-menu-indicator')).toBeHidden();
	}
	const panelToggle = titlebarActions.locator('[data-action-id="workbench.action.togglePanel"] button');
	await expect(panelToggle).toHaveCSS('width', '22px');
	await expect(titlebarActions.locator('[data-action-id="ash.activityBar.accounts"]')).toHaveCount(1);
	await expect(titlebarActions.locator('[data-action-id="ash.activityBar.manage"]')).toHaveCount(1);
	const appearance = async (button: typeof panelToggle) => button.evaluate(element => {
		const style = getComputedStyle(element);
		return { width: style.width, height: style.height, color: style.color, background: style.backgroundColor, radius: style.borderRadius };
	});
	expect(await appearance(titlebarAccounts)).toEqual(await appearance(panelToggle));
	expect(await appearance(titlebarManage)).toEqual(await appearance(panelToggle));
	await titlebarAccounts.focus();
	await titlebarAccounts.press('ArrowRight');
	await expect(titlebarManage).toBeFocused();
	await titlebarManage.press('ArrowLeft');
	await expect(titlebarAccounts).toBeFocused();
	const [titlebarBounds, accountBounds, manageBounds] = await Promise.all([titlebar.boundingBox(), titlebarAccounts.boundingBox(), titlebarManage.boundingBox()]);
	expect(titlebarBounds).not.toBeNull();
	expect(accountBounds).not.toBeNull();
	expect(manageBounds).not.toBeNull();
	expect(accountBounds!.x).toBeLessThan(manageBounds!.x);
	expect(manageBounds!.y).toBeGreaterThanOrEqual(titlebarBounds!.y);
	expect(manageBounds!.y + manageBounds!.height).toBeLessThanOrEqual(titlebarBounds!.y + titlebarBounds!.height);
	await titlebarAccounts.click();
	await expect(page.getByRole('menu').last().getByRole('menuitem', { name: 'Sign in with ChatGPT' })).toBeVisible();
	const connectGitHub = page.getByRole('menu').last().getByRole('menuitem', { name: 'Connect GitHub' });
	await expect(connectGitHub).toBeVisible();
	if (target.kind === 'browser' && target.appServerMode === 'disabled') {
		await connectGitHub.click();
		const dialog = page.getByRole('dialog', { name: 'Connect GitHub' });
		await expect(dialog).toContainText('Could not connect GitHub. Try again.');
		await expect(page.locator('.ash-notification')).toHaveCount(0);
		await dialog.getByRole('button', { name: 'OK' }).click();
	} else {
		await page.keyboard.press('Escape');
	}
	await titlebarManage.click();
	await expect(page.getByRole('menu').last().getByRole('menuitem', { name: 'Settings' })).toBeVisible();
	await page.keyboard.press('Escape');
	await titlebarManage.focus();
	await titlebarManage.press('Shift+F10');
	await expect(page.getByRole('menu').last().getByRole('menuitem', { name: 'Activity Bar Position' })).toBeVisible();
	const keyboardMenuBounds = await page.getByRole('menu').last().boundingBox();
	expect(keyboardMenuBounds).not.toBeNull();
	expect(keyboardMenuBounds!.x + keyboardMenuBounds!.width).toBeGreaterThan(manageBounds!.x);
	await page.keyboard.press('Escape');
	await titlebarManage.click({ button: 'right' });
	await page.getByRole('menu').last().getByRole('menuitemcheckbox', { name: 'Accounts' }).click();
	await expect(titlebarAccounts).toHaveCount(0);
	await titlebarManage.click({ button: 'right' });
	await page.getByRole('menu').last().getByRole('menuitemcheckbox', { name: 'Accounts' }).click();
	await expect(titlebarAccounts).toBeVisible();
	await titlebarManage.click({ button: 'right' });
	await page.getByRole('menu').last().getByRole('menuitem', { name: 'Activity Bar Position' }).hover();
	await page.getByRole('menu').last().getByRole('menuitemcheckbox', { name: 'Bottom' }).click();
	await expect(activitybar).toBeHidden();
	const bottomSelector = sidebar.locator('.ash-sidebar-composite-bar-bottom').getByRole('tablist');
	await expect(bottomSelector).toHaveAttribute('aria-orientation', 'horizontal');
	const [bottomBar, bottomSidebar] = await Promise.all([bottomSelector.boundingBox(), sidebar.boundingBox()]);
	await expect(sidebar).toHaveCSS('border-bottom-width', '1px');
	expect(bottomBar!.y + bottomBar!.height).toBeGreaterThanOrEqual(bottomSidebar!.y + bottomSidebar!.height - 1);
	await titlebarManage.click({ button: 'right' });
	await page.getByRole('menu').last().getByRole('menuitem', { name: 'Activity Bar Position' }).hover();
	await page.getByRole('menu').last().getByRole('menuitemcheckbox', { name: 'Default' }).click();
	await expect(activitybar).toBeVisible();
	await expect(activitybar.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
	await expect(titlebarManage).toHaveCount(0);
	await activitybar.getByRole('button', { name: 'Manage' }).click({ button: 'right' });
	await page.getByRole('menu').last().getByRole('menuitem', { name: 'Move Primary Side Bar Left' }).click();
	const [leftSidebar, leftEditor, leftBar] = await Promise.all([sidebar.boundingBox(), editor.boundingBox(), activitybar.boundingBox()]);
	expect(leftBar!.x).toBeLessThan(leftSidebar!.x);
	expect(leftSidebar!.x).toBeLessThan(leftEditor!.x);
	await activitybar.getByRole('button', { name: 'Manage' }).click({ button: 'right' });
	await page.getByRole('menu').last().getByRole('menuitemcheckbox', { name: 'Accounts' }).click();
	await expect(activitybar.getByRole('button', { name: 'Accounts' })).toBeHidden();
	await activitybar.getByRole('button', { name: 'Manage' }).click({ button: 'right' });
	await page.getByRole('menu').last().getByRole('menuitemcheckbox', { name: 'Accounts' }).click();
	await expect(activitybar.getByRole('button', { name: 'Accounts' })).toBeVisible();
	await activitybar.getByRole('button', { name: 'Manage' }).click({ button: 'right' });
	await page.getByRole('menu').last().getByRole('menuitem', { name: 'Activity Bar Position' }).hover();
	await page.getByRole('menu').last().getByRole('menuitemcheckbox', { name: 'Hidden' }).click();
	await expect(activitybar).toBeHidden();
});

test('top activity bar places the view selector inside the sidebar', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const activitybar = page.locator('[data-part="activitybar"]');
	const sidebar = page.locator('[data-part="sidebar"]');
	await activitybar.getByRole('tab', { name: 'Explorer' }).click();
	await expect(sidebar).toBeVisible();
	const initialSidebar = await sidebar.boundingBox();
	await activitybar.getByRole('button', { name: 'Manage' }).click({ button: 'right' });
	await page.getByRole('menu').last().getByRole('menuitem', { name: 'Activity Bar Position' }).hover();
	await page.getByRole('menu').last().getByRole('menuitemcheckbox', { name: 'Top' }).click();

	await expect(activitybar).toBeHidden();
	const selector = sidebar.locator('.ash-sidebar-composite-bar-top').getByRole('tablist');
	await expect(selector).toHaveAttribute('aria-orientation', 'horizontal');
	await expect(selector.getByRole('tab', { name: 'Explorer' })).toBeVisible();
	const nextSidebar = await sidebar.boundingBox();
	expect(initialSidebar).not.toBeNull();
	expect(nextSidebar).not.toBeNull();
	expect(nextSidebar!.height).toBe(initialSidebar!.height);
	expect(nextSidebar!.x).toBe(6);
	await expect(sidebar).toHaveCSS('border-left-width', '1px');
	await expect(sidebar).toHaveCSS('border-bottom-left-radius', '8px');
	const leftInsets = () => sidebar.evaluate(root => {
		const left = root.getBoundingClientRect().x;
		const title = root.querySelector<HTMLElement>('.ash-sidebar-title-label')!;
		const titleText = document.createRange();
		titleText.selectNodeContents(title);
		return {
			tab: root.querySelector<HTMLElement>('.ash-sidebar-composite-bar-top .ash-composite-bar-item')!.getBoundingClientRect().x - left,
			title: titleText.getBoundingClientRect().x - left,
			paneTwisty: root.querySelector<HTMLElement>('.ash-pane-view-header-twisty-container')!.getBoundingClientRect().x - left,
		};
	});
	await expect.poll(leftInsets).toEqual({ tab: 9, title: 17, paneTwisty: 17 });
	await page.getByRole('button', { name: 'Manage' }).click();
	await page.getByRole('menu').last().getByRole('menuitem', { name: 'Settings' }).click();
	await page.locator('[data-settings-group-id="workbench"]').click();
	await page.locator('[data-settings-category-id="layout"]').click();
	const layoutStyle = page.locator('[data-configuration-key="workbench.layoutStyle"]').getByRole('combobox');
	await layoutStyle.click();
	await page.getByRole('option', { name: 'Flat' }).click();
	await expect(page.locator('.ash-workbench')).not.toHaveClass(/modern-ui/);
	await expect.poll(leftInsets).toEqual({ tab: 0, title: 12, paneTwisty: 8 });
});

test('command center opens without a first-run guide', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const search = page.getByRole('button', { name: 'Search commands' });
	await expect(search).toBeVisible();
	await expect(page.getByRole('dialog', { name: 'Find commands quickly' })).toHaveCount(0);
	await search.click();
	await expect(page.locator('.ash-quick-pick').getByRole('combobox')).toBeFocused();
});

test('titlebar navigation moves through editor history beside Quick Access', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const navigation = page.locator('.ash-titlebar-command-center-navigation');
	const back = navigation.getByRole('button', { name: 'Go Back' });
	const forward = navigation.getByRole('button', { name: 'Go Forward' });
	const search = page.getByRole('button', { name: 'Search commands' });
	await expect(back).toBeDisabled();
	await expect(forward).toBeDisabled();
	const originalViewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
	for (const width of [1200, 700]) {
		await page.setViewportSize({ width, height: 800 });
		const [leftBounds, navigationBounds, searchBounds] = await Promise.all([
			page.locator('.ash-workbench-titlebar > .ash-workbench-part-title').boundingBox(),
			navigation.boundingBox(),
			search.boundingBox(),
		]);
		expect(leftBounds).not.toBeNull();
		expect(navigationBounds).not.toBeNull();
		expect(searchBounds).not.toBeNull();
		expect(navigationBounds!.x - leftBounds!.x - leftBounds!.width).toBeGreaterThanOrEqual(0);
		expect(searchBounds!.x - navigationBounds!.x - navigationBounds!.width).toBeGreaterThanOrEqual(6);
	}
	await page.setViewportSize(originalViewport);

	const openUntitled = async () => {
		await page.getByRole('button', { name: 'Application menu' }).click();
		await page.getByRole('menu').first().getByRole('menuitem', { name: 'File' }).hover();
		await page.getByRole('menu').last().getByRole('menuitem', { name: 'New Untitled Text Editor' }).click();
	};
	await openUntitled();
	await openUntitled();
	await openUntitled();
	await expect(back).toBeEnabled();
	await expect(forward).toBeDisabled();
	await back.click();
	await expect(page.locator('.ash-tab.checked')).toContainText('Untitled-2');
	await expect(forward).toBeEnabled();
	await back.focus();
	await back.press('ArrowRight');
	await expect(forward).toBeFocused();
	await forward.click();
	await expect(page.locator('.ash-tab.checked')).toContainText('Untitled-3');
	const backShortcut = process.platform === 'darwin' ? 'Control+-' : process.platform === 'linux' ? 'Control+Alt+-' : 'Alt+ArrowLeft';
	await page.keyboard.press(backShortcut);
	await expect(page.locator('.ash-tab.checked')).toContainText('Untitled-2');
	await openUntitled();
	await expect(forward).toBeDisabled();
});

test('titlebar navigation restores a cursor location in the same editor', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.getByRole('button', { name: 'Application menu' }).click();
	await page.getByRole('menu').first().getByRole('menuitem', { name: 'File' }).hover();
	await page.getByRole('menu').last().getByRole('menuitem', { name: 'New Untitled Text Editor' }).click();
	const input = workbench.editors.groupAt(0).content.locator('.stanza-editor-input');
	await input.focus();
	await page.keyboard.insertText(Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n'));
	const cursor = page.locator('[data-statusbar-item-id="ash.status.editor.cursor"]');
	const start = process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home';
	const end = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';
	await page.keyboard.press(start);
	await expect(cursor).toContainText('Ln 1, Col 1');
	await page.keyboard.press(end);
	await expect(cursor).toContainText('Ln 40, Col 8');
	await page.locator('.ash-titlebar-command-center-navigation').getByRole('button', { name: 'Go Back' }).click();
	await expect(cursor).toContainText('Ln 1, Col 1');
	await page.locator('.ash-titlebar-command-center-navigation').getByRole('button', { name: 'Go Forward' }).click();
	await expect(cursor).toContainText('Ln 40, Col 8');
});

test('Sessions entry sits beside Quick Access and animates its Ash mark on intent', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const commandCenter = page.locator('.ash-titlebar-command-center-button');
	const actionId = target.kind === 'electron' ? 'workbench.action.chat.openAgentsWindow.titleBar' : 'ash.code.open-sessions';
	const entry = page.locator(`.ash-titlebar-center-adjacent-actions [data-action-id="${actionId}"] button`);
	await expect(page.locator(`.ash-titlebar-left-actions [data-action-id="${actionId}"]`)).toHaveCount(0);
	await expect(entry).toBeVisible();
	await expect(entry).toHaveAttribute('aria-label', target.kind === 'electron' ? 'Open in Agents' : 'Open Code Sessions');
	const mark = entry.locator('svg.ash-titlebar-mark');
	await expect(mark.locator('path')).toHaveCount(9);
	const expandedLabel = entry.locator('.ash-icon-label-container');
	if (target.kind === 'electron') {
		await expect(expandedLabel).toHaveText('Open in Agents');
		await expect(expandedLabel).toHaveCSS('opacity', '0');
	}

	for (const width of [1200, 700]) {
		await page.setViewportSize({ width, height: 800 });
		await expect.poll(async () => {
			const searchBounds = await commandCenter.boundingBox();
			const entryBounds = await entry.boundingBox();
			if (!searchBounds || !entryBounds) return -Infinity;
			if (width >= 800) {
				return entryBounds.x - searchBounds.x - searchBounds.width;
			}
			return Math.max(
				entryBounds.x - searchBounds.x - searchBounds.width,
				searchBounds.x - entryBounds.x - entryBounds.width,
			);
		}).toBeGreaterThanOrEqual(6);
		const searchBounds = await commandCenter.boundingBox();
		const entryBounds = await entry.boundingBox();
		expect(searchBounds).not.toBeNull();
		expect(entryBounds).not.toBeNull();
		expect(Math.abs(entryBounds!.y + entryBounds!.height / 2 - searchBounds!.y - searchBounds!.height / 2)).toBeLessThan(1);
	}

	const collapsedWidth = await entry.evaluate(button => button.getBoundingClientRect().width);
	const petal = mark.locator('#petal-north');
	await entry.hover({ position: { x: 2, y: 11 } });
	await expect(petal).toHaveCSS('animation-name', 'ash-titlebar-mark-bloom');
	if (target.kind === 'electron') {
		await expect(expandedLabel).toHaveCSS('opacity', '1');
		await expect.poll(() => entry.evaluate(button => button.getBoundingClientRect().width)).toBeGreaterThan(collapsedWidth + 20);
	}
	await page.mouse.move(400, 180);
	if (target.kind === 'electron') {
		await expect(expandedLabel).toHaveCSS('opacity', '0');
	}
	await commandCenter.focus();
	await page.keyboard.press('Tab');
	await expect(entry).toBeFocused();
	await expect(petal).toHaveCSS('animation-name', 'ash-titlebar-mark-bloom');
	if (target.kind === 'electron') {
		await expect(expandedLabel).toHaveCSS('opacity', '1');
	}
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect(petal).toHaveCSS('animation-name', 'none');
	if (target.kind === 'electron') {
		await expect.poll(() => expandedLabel.evaluate(element => Number.parseFloat(getComputedStyle(element).transitionDuration))).toBeLessThan(0.001);
	}

	if (target.kind === 'browser') {
		await entry.click();
		await expect(page).toHaveURL(/sessions-code\.html/u);
		await expect(page.locator('.ash-code-sessions-window')).toBeVisible();
		await expect(page.locator('#app')).toHaveAttribute('data-runtime', 'web');
		const returnButtonBounds = await page.getByRole('button', { name: 'Workbench' }).boundingBox();
		expect(returnButtonBounds?.x).toBeLessThan(50);
		await expect(page.locator('#app')).toHaveAttribute('data-color-theme', /ash-(?:light|dark)/u);
	}
});

test('titlebar toolbar icons fit inside their buttons', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const buttons = workbench.page.locator('.ash-workbench-titlebar .ash-toolbar .ash-action-view-item.icon > .ash-button');
	await expect(buttons.first()).toBeVisible();
	const iconBounds = await buttons.evaluateAll(elements => elements.map(button => {
		const label = button.querySelector('.ash-icon-label');
		const icon = label?.querySelector('svg.ash-icon');
		if (!label || !icon) throw new Error('Toolbar icon button is missing its icon');
		const labelRect = label.getBoundingClientRect();
		const iconRect = icon.getBoundingClientRect();
		const buttonRect = button.getBoundingClientRect();
		return {
			buttonWidth: buttonRect.width,
			labelWidth: labelRect.width,
			iconWidth: iconRect.width,
			leftInset: iconRect.left - labelRect.left,
			rightInset: labelRect.right - iconRect.right,
			buttonLeftInset: iconRect.left - buttonRect.left,
			buttonRightInset: buttonRect.right - iconRect.right,
		};
	}));
	for (const bounds of iconBounds) {
		expect(bounds.buttonWidth).toBe(22);
		expect(bounds.iconWidth).toBe(16);
		expect(bounds.labelWidth).toBeGreaterThanOrEqual(bounds.iconWidth);
		expect(bounds.leftInset).toBeGreaterThanOrEqual(0);
		expect(bounds.rightInset).toBeGreaterThanOrEqual(0);
		expect(bounds.buttonLeftInset).toBeCloseTo(3, 1);
		expect(bounds.buttonRightInset).toBeCloseTo(3, 1);
	}
});

test('Quick Access has no backdrop and lets workbench controls receive clicks', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.keyboard.press('F1');
	const host = page.locator('.ash-quick-input-host');
	const picker = page.locator('.ash-quick-pick');
	await expect(picker.getByRole('combobox')).toBeFocused();
	await expect(host).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	await expect(host).toHaveCSS('pointer-events', 'none');
	await expect(picker).toHaveCSS('pointer-events', 'auto');
	await page.getByRole('button', { name: 'Application menu' }).click();
	await expect(picker).toHaveCount(0);
	await expect(page.getByRole('menu').first()).toBeVisible();
});

test('Quick Access scrolls its results within the list', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.keyboard.press('F1');
	const picker = page.locator('.ash-quick-pick');
	const listContainer = picker.locator('.ash-quick-pick-list');
	const scrollable = picker.locator('.ash-quick-pick-list-scrollable');
	const viewport = scrollable.locator('.ash-scrollbar-viewport');
	const scrollbar = scrollable.locator('.ash-scrollbar-track-vertical');
	await picker.getByRole('combobox').fill('>');
	await expect(picker.locator('.ash-list-row').nth(20)).toBeVisible();
	const initial = await listContainer.evaluate(container => {
		const viewport = container.querySelector<HTMLElement>('.ash-scrollbar-viewport')!;
		const scrollbar = container.querySelector<HTMLElement>('.ash-scrollbar-track-vertical')!;
		const thumb = scrollbar.querySelector<HTMLElement>('.ash-scrollbar-thumb')!;
		const picker = container.closest('.ash-quick-pick')!;
		return {
			containerOverflow: getComputedStyle(container).overflowY,
			containerScrollHeight: container.scrollHeight,
			containerHeight: container.clientHeight,
			listScrollHeight: viewport.scrollHeight,
			listHeight: viewport.clientHeight,
			rowHeight: container.querySelector<HTMLElement>('.ash-list-row')!.getBoundingClientRect().height,
			scrollbarRightInset: picker.getBoundingClientRect().right - scrollbar.getBoundingClientRect().right,
			thumbBorder: getComputedStyle(thumb).borderRightWidth,
			thumbWidth: thumb.getBoundingClientRect().width,
			trackWidth: scrollbar.getBoundingClientRect().width,
		};
	});
	expect(initial.containerOverflow).toBe('hidden');
	expect(initial.containerScrollHeight).toBeLessThanOrEqual(initial.containerHeight + 1);
	expect(initial.listScrollHeight).toBeGreaterThan(initial.listHeight);
	expect(Math.abs(initial.listHeight / initial.rowHeight - Math.round(initial.listHeight / initial.rowHeight))).toBeLessThan(0.03);
	expect(initial.scrollbarRightInset).toBeLessThanOrEqual(2);
	expect(initial.thumbBorder).toBe('0px');
	expect(initial.thumbWidth).toBe(initial.trackWidth);
	const [rowBounds, trackBounds] = await Promise.all([
		picker.locator('.ash-list-row.is-active').boundingBox(),
		scrollbar.boundingBox(),
	]);
	expect(rowBounds).not.toBeNull();
	expect(trackBounds).not.toBeNull();
	expect(Math.abs(rowBounds!.x + rowBounds!.width - trackBounds!.x)).toBeLessThanOrEqual(1);
	const [bindingBounds, scrollbarBounds] = await Promise.all([
		picker.locator('.ash-quick-pick-row-keybinding').first().boundingBox(),
		scrollbar.boundingBox(),
	]);
	expect(bindingBounds).not.toBeNull();
	expect(scrollbarBounds).not.toBeNull();
	expect(bindingBounds!.x + bindingBounds!.width).toBeLessThanOrEqual(scrollbarBounds!.x - 4);
	for (let index = 0; index < 20; index++) {
		await picker.getByRole('combobox').press('ArrowDown');
	}
	const scrolled = await viewport.evaluate(element => element.scrollTop);
	expect(scrolled).toBeGreaterThan(0);
	expect(await listContainer.evaluate(element => element.scrollTop)).toBe(0);
	const active = picker.locator('.ash-list-row.is-active');
	await expect(active).toBeInViewport();
	await expect(scrollbar).toHaveAttribute('aria-orientation', 'vertical');
	await picker.getByRole('combobox').fill('>Toggle Minimap');
	await expect(picker.locator('.ash-list-row')).toHaveCount(2);
	await expect.poll(() => scrollable.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(initial.listHeight);
	await picker.getByRole('combobox').fill('>no-such-command-quick-access-scroll');
	await expect(scrollable).toBeHidden();
	await expect(picker.locator('.ash-quick-pick-empty')).toBeVisible();
	await picker.getByRole('combobox').fill('>');
	const restoredListHeight = await viewport.evaluate(element => element.clientHeight);
	expect(Math.abs(restoredListHeight / initial.rowHeight - Math.round(restoredListHeight / initial.rowHeight))).toBeLessThan(0.03);
	await page.setViewportSize({ width: 900, height: 400 });
	await expect.poll(() => viewport.evaluate(element => element.clientHeight)).toBeLessThan(initial.listHeight);
	const compactListHeight = await viewport.evaluate(element => element.clientHeight);
	expect(Math.abs(compactListHeight / initial.rowHeight - Math.round(compactListHeight / initial.rowHeight))).toBeLessThan(0.03);
	const resized = await picker.evaluate(element => ({
		bottom: element.getBoundingClientRect().bottom,
		viewportHeight: window.innerHeight,
	}));
	expect(resized.bottom).toBeLessThanOrEqual(resized.viewportHeight);
});

test('titlebar command center opens command search and restores focus', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const commandCenter = page.getByRole('button', { name: 'Search commands' });
	await expect(commandCenter).toBeVisible();

	const titlebar = page.locator('.ash-workbench-titlebar');
	const appIcon = titlebar.locator('.ash-titlebar-app-icon');
	await expect(appIcon).toHaveCSS('mask-image', /ash-mark.*\.svg/u);
	await expect(appIcon).toHaveCSS('background-image', 'none');
	await expect(appIcon).toHaveCSS('background-color', await appIcon.evaluate(element => getComputedStyle(element).color));
	const markSize = await appIcon.evaluate(async element => {
		const mask = getComputedStyle(element).maskImage;
		const image = new Image();
		image.src = mask.slice(5, -2);
		await image.decode();
		const canvas = document.createElement('canvas');
		canvas.width = element.clientWidth;
		canvas.height = element.clientHeight;
		const context = canvas.getContext('2d')!;
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
		let left = canvas.width;
		let top = canvas.height;
		let right = -1;
		let bottom = -1;
		for (let y = 0; y < canvas.height; y++) {
			for (let x = 0; x < canvas.width; x++) {
				if (pixels[(y * canvas.width + x) * 4 + 3] === 0) continue;
				left = Math.min(left, x);
				top = Math.min(top, y);
				right = Math.max(right, x);
				bottom = Math.max(bottom, y);
			}
		}
		return { width: right - left + 1, height: bottom - top + 1 };
	});
	expect(markSize.width).toBeGreaterThanOrEqual(13);
	expect(markSize.height).toBeGreaterThanOrEqual(13);
	const [titlebarBounds, controlBounds] = await Promise.all([titlebar.boundingBox(), commandCenter.boundingBox()]);
	expect(titlebarBounds).not.toBeNull();
	expect(controlBounds).not.toBeNull();
	expect(controlBounds!.width).toBeGreaterThan(300);
	expect(titlebarBounds!.height).toBe(35);
	expect(controlBounds!.height).toBe(24);
	expect(Math.abs(controlBounds!.x + controlBounds!.width / 2 - titlebarBounds!.x - titlebarBounds!.width / 2)).toBeLessThan(2);
	expect(Math.abs(controlBounds!.y + controlBounds!.height / 2 - titlebarBounds!.y - titlebarBounds!.height / 2)).toBeLessThan(0.6);
	const contentBounds = await commandCenter.locator('.ash-button-content').boundingBox();
	expect(contentBounds).not.toBeNull();
	expect(Math.abs(contentBounds!.x + contentBounds!.width / 2 - controlBounds!.x - controlBounds!.width / 2)).toBeLessThan(1);
	await expect(commandCenter).toHaveCSS('background-color', 'rgb(246, 246, 246)');
	await expect(commandCenter).toHaveCSS('border-color', 'rgb(208, 208, 208)');
	await page.mouse.move(0, 100);
	await commandCenter.hover();
	await expect(commandCenter).toHaveCSS('background-color', 'rgb(235, 235, 235)');
	await page.waitForTimeout(600);
	await expect(page.locator('.ash-hover')).toHaveCount(0);

	await commandCenter.click();
	await expect(commandCenter).toHaveAttribute('aria-expanded', 'true');
	await expect(commandCenter).toHaveClass(/active/);
	const picker = page.locator('.ash-quick-pick');
	const query = picker.getByRole('combobox');
	await expect(query).toBeFocused();
	await expect(query).toHaveAttribute('placeholder', 'Search commands (type >, @, or ? for modes)');
	await expect(page.locator('.ash-hover')).toHaveCount(0);
	const initialPicker = await picker.elementHandle();
	await query.fill('?');
	await expect(query).toHaveAttribute('placeholder', 'Select a search mode');
	await expect(picker.locator('.ash-quick-pick-row-label', { hasText: '> Commands' })).toBeVisible();
	await query.fill('@');
	await expect(query).toHaveAttribute('placeholder', 'Type the name of a symbol in the workspace');
	await query.fill('?');
	await expect(picker.locator('.ash-quick-pick-row-label', { hasText: '? Show Search Modes' })).toHaveCount(0);
	await query.press('Enter');
	await expect(query).toHaveValue('>');
	await expect(query).toHaveAttribute('placeholder', 'Type the name of a command to run');
	expect(await query.evaluate(input => (input as HTMLInputElement).selectionStart)).toBe(1);
	expect(await page.evaluate(element => element === document.querySelector('.ash-quick-pick'), initialPicker)).toBe(true);
	await query.pressSequentially('Toggle Minimap');
	await expect(query).toHaveValue('>Toggle Minimap');
	await expect(picker.locator('.ash-quick-pick-row-label', { hasText: 'Toggle Minimap' })).toBeVisible();
	await query.press('Escape');
	await expect(picker).toHaveCount(0);
	await expect(commandCenter).toHaveAttribute('aria-expanded', 'false');
	await expect(commandCenter).toBeFocused();
	await expect(page.locator('.ash-hover')).toHaveCount(0);

	await commandCenter.press('Enter');
	await expect(picker.getByRole('combobox')).toBeFocused();
	await picker.getByRole('combobox').press('Escape');

	for (const width of [801, 700]) {
		await page.setViewportSize({ width, height: 800 });
		await expect(commandCenter).toBeVisible();
		const [left, control, right] = await Promise.all([
			titlebar.locator('.ash-workbench-part-title').boundingBox(),
			commandCenter.boundingBox(),
			titlebar.locator('.ash-workbench-part-content').boundingBox(),
		]);
		expect(left!.x + left!.width).toBeLessThanOrEqual(control!.x);
		expect(control!.x + control!.width).toBeLessThanOrEqual(right!.x);
		if (width === 700) expect(control!.width).toBe(32);
	}
	await commandCenter.click();
	await expect(picker.getByRole('combobox')).toBeFocused();
});
