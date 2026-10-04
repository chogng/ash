import type { ElectronApplication, Locator } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('activity bar badges stay over the icon and can be hidden independently through the menu', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const activitybar = page.locator('[data-part="activitybar"]');
	const explorer = workbench.element.locator('.ash-composite-bar-destination[data-action-id="ash.sidebar"]');
	const badge = explorer.locator('.ash-composite-bar-badge');
	await workbench.openExplorer();
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	await workbench.editors.groupAt(0).editor.element.click({ position: { x: 100, y: 30 } });
	await workbench.editors.groupAt(0).editor.waitForEditorFocus();
	await workbench.editors.groupAt(0).editor.waitForTypeInEditor('badge activity');
	await expect(badge).toHaveText('1');
	const expectBadgeGeometry = async (): Promise<void> => {
		await expect(badge).toHaveCSS('position', 'absolute');
		await expect(explorer.locator('.ash-icon')).toBeVisible();
		const geometry = await explorer.evaluate(element => {
			const item = element.getBoundingClientRect();
			const icon = element.querySelector('.ash-icon')!.getBoundingClientRect();
			const badge = element.querySelector('.ash-composite-bar-badge')!.getBoundingClientRect();
			const bar = element.closest('.ash-composite-bar')!.getBoundingClientRect();
			const tolerance = 0.01; // Fractional window scaling can round touching edges differently.
			return {
				bounds: JSON.stringify({ item: item.toJSON(), icon: icon.toJSON(), badge: badge.toJSON() }),
				inside: badge.left + tolerance >= Math.max(item.left, bar.left) && badge.right - tolerance <= Math.min(item.right, bar.right) && badge.top + tolerance >= item.top && badge.bottom - tolerance <= item.bottom,
				overIcon: badge.left < icon.right && badge.top < icon.bottom,
				lowerRight: badge.right > (icon.left + icon.right) / 2 && badge.bottom > (icon.top + icon.bottom) / 2,
				centered: Math.abs((icon.left + icon.right) / 2 - (item.left + item.right) / 2) <= 1,
			};
		});
		const { bounds, ...placement } = geometry;
		expect(placement, bounds).toEqual({ inside: true, overIcon: true, lowerRight: true, centered: true });
	};
	for (const style of ['Flat', 'Modern']) {
		await workbench.settingsEditor.openUserSettingsUI();
		const settings = page.getByRole('dialog', { name: 'Ash Settings' });
		await settings.locator('[data-settings-group-id="workbench"]').click();
		await settings.locator('[data-settings-category-id="layout"]').click();
		await settings.locator('[data-configuration-key="workbench.layoutStyle"]').getByRole('combobox').click();
		await page.getByRole('option', { name: style, exact: true }).click();
		await settings.locator('.ash-modal-editor-close').click();
		for (const size of ['Default', 'Compact']) {
			await workbench.menus.select(application, () => explorer.click({ button: 'right' }), ['Activity Bar Size', size]);
			await expectBadgeGeometry();
		}
		for (const position of ['Top', 'Bottom', 'Default']) {
			await workbench.menus.select(application, () => explorer.click({ button: 'right' }), ['Activity Bar Position', position]);
			await expectBadgeGeometry();
		}
	}
	await workbench.menus.select(application, () => explorer.click({ button: 'right' }), ['Move Primary Side Bar Right']);
	await expectBadgeGeometry();
	await workbench.menus.select(application, () => explorer.click({ button: 'right' }), ['Move Primary Side Bar Left']);
	await expectBadgeGeometry();
	await explorer.focus();
	await workbench.menus.select(application, () => explorer.press('Shift+F10'), ['Hide Badge']);
	await expect(badge).toHaveCount(0);
	await expect(explorer).toHaveAttribute('aria-label', /1 unsaved file/u);
	const search = activitybar.getByRole('tab', { name: 'Search', exact: true });
	expect(await workbench.menus.inspect(application, () => search.click({ button: 'right' }))).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Hide Badge', enabled: true })]));
	await expect(badge).toHaveCount(0);
	await expect(explorer).toHaveAttribute('aria-label', /1 unsaved file/u);
	await workbench.menus.select(application, () => explorer.click({ button: 'right' }), ['Show Badge']);
	await expect(badge).toHaveText('1');
	await expectBadgeGeometry();
	for (const theme of ['Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const picker = page.locator('.ash-quick-pick').getByRole('combobox');
		await picker.fill(theme);
		await picker.press('Enter');
		await expectBadgeGeometry();
		await expect(badge).toHaveCSS('outline-style', 'solid');
	}
});

test('activity bar badge colors follow theme customizations and survive reopening', async ({ application, target, workbench, reloadWorkbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const badge = (): Locator => workbench.element.locator('.ash-composite-bar-destination[data-action-id="ash.sidebar"] .ash-composite-bar-badge');
	await workbench.openExplorer();
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.element.click({ position: { x: 100, y: 30 } });
	await editor.waitForEditorFocus();
	await editor.waitForTypeInEditor('badge theme activity');
	await expect(badge()).toHaveText('1');
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectGroup('workbench');
	await workbench.settingsEditor.selectCategory('appearance');
	const colors = workbench.page.locator('[data-configuration-key="workbench.colorCustomizations"]');
	for (const [id, value] of [['activityBarBadge.background', '#123456'], ['activityBarBadge.foreground', '#fedcba']]) {
		await colors.getByRole('button', { name: 'Add Color', exact: true }).click();
		const row = colors.locator('.ash-string-map-row').last();
		const key = row.getByRole('combobox');
		await key.fill(id);
		const suggestion = workbench.page.getByRole('option').filter({ hasText: id });
		await expect(suggestion).toHaveCount(1);
		await key.press('ArrowDown');
		await key.press('Enter');
		const input = row.locator('[data-pattern-part="value"]');
		await input.fill(value);
		await input.press('Tab');
	}
	await expect(badge()).toHaveCSS('background-color', 'rgb(18, 52, 86)');
	await expect(badge()).toHaveCSS('color', 'rgb(254, 220, 186)');
	await workbench.page.getByRole('dialog', { name: 'Ash Settings' }).locator('.ash-modal-editor-close').click();
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	await workbench.editors.groupAt(0).editor.waitForEditorContents(content => content.includes('activityBarBadge.background') && content.includes('#123456') && content.includes('activityBarBadge.foreground') && content.includes('#fedcba'));
	({ application, workbench } = await reloadWorkbench());
	for (const theme of ['Ash Light', 'Ash Dark', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const picker = workbench.page.locator('.ash-quick-pick').getByRole('combobox');
		await picker.fill(theme);
		await picker.press('Enter');
		await expect(badge()).toHaveCSS('background-color', 'rgb(18, 52, 86)');
		await expect(badge()).toHaveCSS('color', 'rgb(254, 220, 186)');
	}
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectGroup('workbench');
	await workbench.settingsEditor.selectCategory('appearance');
	const row = workbench.page.locator('[data-settings-item-id="workbench.colorCustomizations"]');
	await row.hover();
	await workbench.menus.select(application, () => row.locator('.ash-setting-item-actions-trigger').click(), ['Reset Setting']);
	await expect(badge()).toHaveCSS('background-color', 'rgb(255, 255, 255)');
	await expect(badge()).toHaveCSS('color', 'rgb(0, 0, 0)');
});

test('activity bar badge setting updates immediately and persists in settings.json', async ({ application, target, workbench, reloadWorkbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const explorer = (): Locator => workbench.element.locator('.ash-composite-bar-destination[data-action-id="ash.sidebar"]');
	const badge = (): Locator => explorer().locator('.ash-composite-bar-badge');
	const createActivity = async (): Promise<void> => {
		if (await explorer().getAttribute('aria-selected') !== 'true' || !await workbench.page.locator('[data-part="sidebar"]').isVisible()) {
			await explorer().click();
		}
		await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
		const editor = workbench.editors.groupAt(0).editor;
		await editor.element.click({ position: { x: 100, y: 30 } });
		await editor.waitForEditorFocus();
		await editor.waitForTypeInEditor('badge settings activity');
	};
	const setBadges = async (enabled: boolean): Promise<void> => {
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('workbench');
		await workbench.settingsEditor.selectCategory('layout');
		const settings = workbench.page.getByRole('dialog', { name: 'Ash Settings' });
		const toggle = settings.getByRole('switch', { name: 'Activity Bar Badges', exact: true });
		await toggle.focus();
		await toggle.press('Space');
		await expect(toggle).toBeChecked({ checked: enabled });
		await settings.locator('.ash-modal-editor-close').click();
	};
	await createActivity();
	await expect(badge()).toHaveText('1');
	await setBadges(false);
	await expect(badge()).toHaveCount(0);
	await expect(explorer()).toHaveAttribute('aria-label', /1 unsaved file/u);
	await workbench.menus.select(application, () => explorer().click({ button: 'right' }), ['Hide Badge']);
	await setBadges(true);
	await expect(badge()).toHaveCount(0);
	await workbench.menus.select(application, () => explorer().click({ button: 'right' }), ['Show Badge']);
	await expect(badge()).toHaveText('1');
	await setBadges(false);
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	await workbench.editors.groupAt(0).editor.waitForEditorContents(content => /"workbench\.activityBar\.badges"\s*:\s*false/u.test(content));
	({ application, workbench } = await reloadWorkbench());
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectGroup('workbench');
	await workbench.settingsEditor.selectCategory('layout');
	const settings = workbench.page.getByRole('dialog', { name: 'Ash Settings' });
	await expect(settings.getByRole('switch', { name: 'Activity Bar Badges', exact: true })).not.toBeChecked();
	await settings.locator('.ash-modal-editor-close').click();
	await expect(explorer()).toHaveAttribute('aria-label', /unsaved file/u);
	await expect(badge()).toHaveCount(0);
	await setBadges(true);
	await expect(badge()).toHaveCount(1);
});

test('activity bar badge visibility survives reopening the workbench', async ({ application, target, workbench, reloadWorkbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	let explorer = workbench.page.locator('[data-part="activitybar"]').getByRole('tab', { name: 'Explorer', exact: true });
	await workbench.menus.select(application, () => explorer.click({ button: 'right' }), ['Hide Badge']);
	({ application, workbench } = await reloadWorkbench());
	explorer = workbench.page.locator('[data-part="activitybar"]').getByRole('tab', { name: 'Explorer', exact: true });
	expect(await workbench.menus.inspect(application, () => explorer.click({ button: 'right' }))).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Show Badge', enabled: true })]));
	await workbench.menus.select(application, () => explorer.click({ button: 'right' }), ['Show Badge']);
	({ application, workbench } = await reloadWorkbench());
	explorer = workbench.page.locator('[data-part="activitybar"]').getByRole('tab', { name: 'Explorer', exact: true });
	expect(await workbench.menus.inspect(application, () => explorer.click({ button: 'right' }))).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Hide Badge', enabled: true })]));
});

test('maximized Panel keeps its state when the sidebar moves and restores its height', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const panel = page.locator('[data-part="panel"]');
	const editor = page.locator('[data-part="editor"]');
	const panelToggle = page.locator('.ash-titlebar-actions [data-action-id="workbench.action.togglePanel"] button');
	await panelToggle.click();
	await expect(panel).toBeVisible();
	const restoredHeight = (await panel.boundingBox())!.height;
	await panel.getByRole('button', { name: 'Maximize Panel', exact: true }).click();
	await expect(editor).toBeHidden();

	await workbench.menus.select(application, () => page.locator('[data-part="activitybar"]').getByRole('button', { name: 'Accounts' }).click({ button: 'right' }), ['Move Primary Side Bar Right']);
	await expect(editor).toBeHidden();
	await expect(panel.getByRole('button', { name: 'Restore Editor Area', exact: true })).toBeVisible();
	await panel.getByRole('button', { name: 'Restore Editor Area', exact: true }).click();
	await expect(editor).toBeVisible();
	await expect.poll(async () => (await panel.boundingBox())!.height).toBeCloseTo(restoredHeight, 0);

	await panel.getByRole('button', { name: 'Maximize Panel', exact: true }).click();
	await panelToggle.click();
	await expect(editor).toBeVisible();
	await expect(panel).toBeHidden();
	await panelToggle.click();
	await expect.poll(async () => (await panel.boundingBox())!.height).toBeCloseTo(restoredHeight, 0);
});

test('Manage Accounts command opens the account picker when the account service is available', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.keyboard.press('F1');
	const commandPicker = page.locator('.ash-quick-pick');
	await commandPicker.getByRole('combobox').fill('Manage Accounts');
	await expect(commandPicker.locator('.ash-quick-pick-row-label', { hasText: 'Manage Accounts' })).toBeVisible();
	await commandPicker.getByRole('combobox').press('Enter');

	if (target.appServerMode === 'required') {
		const accountPicker = page.getByRole('dialog', { name: 'Select an account to manage' });
		await expect(accountPicker.getByRole('combobox')).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(accountPicker).toHaveCount(0);
	} else {
		const notification = page.locator('.ash-notification', { hasText: 'Could not load accounts.' });
		await expect(notification).toBeVisible();
		const [notificationBounds, statusbarBounds, workbenchBounds] = await Promise.all([
			notification.boundingBox(),
			page.locator('.ash-workbench-statusbar').boundingBox(),
			workbench.element.boundingBox(),
		]);
		expect(notificationBounds).not.toBeNull();
		expect(statusbarBounds).not.toBeNull();
		expect(workbenchBounds).not.toBeNull();
		expect(notificationBounds!.y + notificationBounds!.height).toBeLessThanOrEqual(statusbarBounds!.y);
		expect(statusbarBounds!.y - notificationBounds!.y - notificationBounds!.height).toBeLessThanOrEqual(24);
		expect(workbenchBounds!.x + workbenchBounds!.width - notificationBounds!.x - notificationBounds!.width).toBeLessThanOrEqual(24);
		await page.locator('.ash-progress-host').evaluate(host => {
			const item = host.ownerDocument.createElement('div');
			item.className = 'ash-progress-item';
			item.textContent = 'Background task';
			host.append(item);
		});
		const [notificationWithProgress, progressBounds] = await Promise.all([
			notification.boundingBox(),
			page.locator('.ash-progress-item').boundingBox(),
		]);
		expect(notificationWithProgress).not.toBeNull();
		expect(progressBounds).not.toBeNull();
		expect(notificationWithProgress!.y + notificationWithProgress!.height).toBeLessThanOrEqual(progressBounds!.y);
		await notification.getByRole('button', { name: 'Hide notification' }).click();
		await expect(notification).toHaveCount(0);
		await page.getByRole('button', { name: 'Show Notification Center' }).click();
		const center = page.getByRole('region', { name: 'Notification Center' });
		await expect(center).toBeVisible();
		await expect(center.locator('.ash-notifications-row', { hasText: 'Could not load accounts.' })).toBeVisible();
		await center.getByRole('button', { name: 'Clear All' }).click();
		await expect(center.getByText('No notifications')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(center).toBeHidden();
		if (target.kind === 'electron') {
			await page.keyboard.press('ControlOrMeta+k');
			await page.keyboard.press('ControlOrMeta+Shift+n');
		} else {
			await page.keyboard.press('F1');
			await page.locator('.ash-quick-pick').getByRole('combobox').fill('Show Notifications');
			await page.locator('.ash-quick-pick').getByRole('combobox').press('Enter');
		}
		await expect(center).toBeVisible();
		await page.keyboard.press('Alt+F1');
		const help = page.getByRole('dialog', { name: 'Accessibility Help' });
		await expect(help).toBeVisible();
		await help.getByRole('button', { name: 'Close' }).last().click();
		await expect(help).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expect(center).toBeHidden();
		await expect(page.getByRole('dialog', { name: 'Select an account to manage' })).toHaveCount(0);
	}
});

test('desktop GitHub connection error uses a window dialog', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'disabled');
	const page = workbench.page;
	const message = await workbench.dialogs.expectMessage(application, 'Connect GitHub', () => workbench.menus.select(application, () => page.getByRole('button', { name: 'Accounts' }).click(), ['Connect GitHub']));
	expect(message.message).toBe('Could not connect GitHub. Try again.');
	await expect(page.locator('.ash-notification')).toHaveCount(0);
});

test('desktop GitHub authorization opens a browser URL and can be cancelled without a code dialog', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required');
	const electron = application as ElectronApplication;
	await electron.evaluate(({ shell }) => {
		const original = shell.openExternal.bind(shell);
		const state = globalThis as typeof globalThis & { ashGitHubBrowser?: { url?: string; restore: () => void } };
		state.ashGitHubBrowser = { restore: () => { shell.openExternal = original; } };
		shell.openExternal = async url => { state.ashGitHubBrowser!.url = url; };
	});
	try {
		const page = workbench.page;
		await workbench.menus.select(application, () => page.getByRole('button', { name: 'Accounts' }).click(), ['Connect GitHub']);
		await expect.poll(() => electron.evaluate(() => (globalThis as typeof globalThis & { ashGitHubBrowser?: { url?: string } }).ashGitHubBrowser?.url)).toBeTruthy();
		const authorizationUrl = await electron.evaluate(() => (globalThis as typeof globalThis & { ashGitHubBrowser?: { url?: string } }).ashGitHubBrowser?.url);
		const url = new URL(authorizationUrl!);
		expect(url.origin).toBe('https://ash-github-auth.lanxiang0901.workers.dev');
		expect(url.pathname).toBe('/v1/oauth/github/authorize');
		expect(url.searchParams.get('client_id')).toBe('Iv23lieaFUjG1LamZy3K');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		await workbench.menus.select(application, () => page.getByRole('button', { name: 'Accounts' }).click(), ['Cancel GitHub connection']);
		expect(await workbench.menus.inspect(application, () => page.getByRole('button', { name: 'Accounts' }).click())).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Connect GitHub', enabled: true })]));
		await expect(page.getByRole('dialog', { name: 'Connect GitHub' })).toHaveCount(0);
		await expect(page.locator('.ash-notification')).toHaveCount(0);
	} finally {
		await electron.evaluate(() => (globalThis as typeof globalThis & { ashGitHubBrowser?: { restore: () => void } }).ashGitHubBrowser?.restore());
	}
});

test('primary sidebar toggle sits immediately after the application menu', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	test.skip(target.kind === 'electron' && process.platform === 'darwin', 'macOS uses the system menu');
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

test('activity bar remains visible and reopens a selected sidebar view in the light theme', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.selectTheme');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('Ash Light');
	await page.getByRole('option', { name: 'Ash Light', exact: true }).click();
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
	expect(await workbench.menus.inspect(application, () => accounts.click())).toEqual(expect.arrayContaining(['Manage Accounts', 'Connect GitHub'].map(label => expect.objectContaining({ label, enabled: true }))));
	await expect(activitybar.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
	await expect(explorer).toHaveAttribute('aria-selected', 'true');
	await workbench.openExplorer();
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
	await workbench.menus.select(application, () => sidebarActions.getByRole('button', { name: 'More Actions' }).click(), ['Hide Primary Side Bar']);
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

test('activity bar tooltips follow left, right, top and bottom placement', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const activitybar = page.locator('[data-part="activitybar"]');
	const sidebar = page.locator('[data-part="sidebar"]');
	const titlebar = page.locator('[data-part="titlebar"]');
	await activitybar.getByRole('tab', { name: 'Search', exact: true }).click();
	await expect(sidebar).toBeVisible();

	const checkTooltip = async (trigger: Locator, direction: 'left' | 'right' | 'above' | 'below', keyboard = false): Promise<void> => {
		await page.mouse.move(600, 400);
		if (keyboard) {
			await page.getByRole('button', { name: 'Search commands', exact: true }).focus();
			await trigger.focus();
		} else {
			await trigger.hover();
		}
		const tooltip = page.getByRole('tooltip');
		await expect(tooltip).toBeVisible();
		await expect(tooltip).toHaveText(await trigger.getAttribute('aria-label') ?? '');
		const [anchor, hover] = await Promise.all([trigger.boundingBox(), page.locator('.ash-context-view-hover', { has: tooltip }).boundingBox()]);
		expect(anchor).not.toBeNull();
		expect(hover).not.toBeNull();
		if (direction === 'right') expect(hover!.x).toBeGreaterThanOrEqual(anchor!.x + anchor!.width);
		if (direction === 'left') expect(hover!.x + hover!.width).toBeLessThanOrEqual(anchor!.x);
		if (direction === 'below') expect(hover!.y).toBeGreaterThanOrEqual(anchor!.y + anchor!.height);
		if (direction === 'above') expect(hover!.y + hover!.height).toBeLessThanOrEqual(anchor!.y);
		await expect(trigger).toHaveAttribute('aria-describedby', await tooltip.getAttribute('id') ?? '');
		await page.keyboard.press('Escape');
		await expect(tooltip).toHaveCount(0);
		await expect(trigger).not.toHaveAttribute('aria-describedby');
		if (keyboard) await expect(trigger).toBeFocused();
	};
	const setPosition = async (trigger: Locator, position: string): Promise<void> => {
		await workbench.menus.select(application, () => trigger.click({ button: 'right' }), ['Activity Bar Position', position]);
	};

	for (const name of ['Search', 'Marketplace']) {
		await checkTooltip(activitybar.getByRole('tab', { name, exact: true }), 'right');
	}
	for (const name of ['Accounts', 'Manage']) {
		await checkTooltip(activitybar.getByRole('button', { name, exact: true }), 'right', true);
	}
	const marketplaceElement = await activitybar.getByRole('tab', { name: 'Marketplace', exact: true }).elementHandle();
	const manageElement = await activitybar.getByRole('button', { name: 'Manage', exact: true }).elementHandle();
	await workbench.menus.select(application, () => activitybar.getByRole('button', { name: 'Manage', exact: true }).click({ button: 'right' }), ['Move Primary Side Bar Right']);
	await expect(activitybar).toHaveClass(/sidebar-right/);
	// Direction changes must be read by the retained actions without replacing their DOM.
	expect(await marketplaceElement!.evaluate(element => element.isConnected)).toBe(true);
	expect(await manageElement!.evaluate(element => element.isConnected)).toBe(true);
	await marketplaceElement!.dispose();
	await manageElement!.dispose();
	await checkTooltip(activitybar.getByRole('tab', { name: 'Marketplace', exact: true }), 'left', true);
	await checkTooltip(activitybar.getByRole('button', { name: 'Manage', exact: true }), 'left');
	await checkTooltip(activitybar.getByRole('button', { name: 'Accounts', exact: true }), 'left');

	await setPosition(activitybar.getByRole('button', { name: 'Manage', exact: true }), 'Top');
	await expect(activitybar).toBeHidden();
	await checkTooltip(sidebar.getByRole('tab', { name: 'Search', exact: true }), 'below');
	await checkTooltip(titlebar.getByRole('button', { name: 'Manage', exact: true }), 'below', true);
	await checkTooltip(titlebar.getByRole('button', { name: 'Accounts', exact: true }), 'below');
	await setPosition(titlebar.getByRole('button', { name: 'Manage', exact: true }), 'Bottom');
	await checkTooltip(sidebar.getByRole('tab', { name: 'Search', exact: true }), 'above', true);
	await checkTooltip(titlebar.getByRole('button', { name: 'Manage', exact: true }), 'below');

	await setPosition(sidebar.getByRole('tab', { name: 'Search', exact: true }), 'Default');
	await expect(activitybar).toBeVisible();
	await checkTooltip(activitybar.getByRole('tab', { name: 'Search', exact: true }), 'left');
	await workbench.menus.select(application, () => activitybar.getByRole('button', { name: 'Manage', exact: true }).click({ button: 'right' }), ['Move Primary Side Bar Left']);
	await checkTooltip(activitybar.getByRole('tab', { name: 'Marketplace', exact: true }), 'right');
	await checkTooltip(activitybar.getByRole('button', { name: 'Manage', exact: true }), 'right');
});

test('activity bar keeps global actions visible and moves excess views into a menu', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.setViewportSize({ width: 1024, height: 280 });
	const activitybar = page.locator('[data-part="activitybar"]');
	await expect(activitybar.getByRole('button', { name: 'Accounts' })).toBeVisible();
	await expect(activitybar.getByRole('button', { name: 'Manage' })).toBeVisible();
	const overflow = activitybar.getByRole('tab', { name: 'Additional views' });
	await expect(overflow).toBeVisible();
	await overflow.hover();
	const tooltip = page.getByRole('tooltip', { name: 'Additional views' });
	await expect(tooltip).toBeVisible();
	const [overflowBounds, tooltipBounds] = await Promise.all([overflow.boundingBox(), page.locator('.ash-context-view-hover', { has: tooltip }).boundingBox()]);
	expect(tooltipBounds!.x).toBeGreaterThanOrEqual(overflowBounds!.x + overflowBounds!.width);
	await page.keyboard.press('Escape');
	const overflowIcon = overflow.locator('.ash-icon');
	await expect(overflowIcon).toHaveCSS('width', '24px');
	await expect(overflowIcon).toHaveCSS('height', '24px');
	const [iconBounds, labelBounds] = await Promise.all([overflowIcon.boundingBox(), overflow.locator('.ash-icon-label').boundingBox()]);
	expect(iconBounds!.width).toBeLessThanOrEqual(labelBounds!.width);
	expect(iconBounds!.height).toBeLessThanOrEqual(labelBounds!.height);
	const items = await workbench.menus.inspect(application, () => overflow.click());
	expect(items.length).toBeGreaterThan(0);
	await workbench.menus.select(application, () => overflow.click(), [items[0]!.label]);
	await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
});

test('activity bar context menu hides and restores view icons', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const activitybar = page.locator('[data-part="activitybar"]');
	const explorer = activitybar.getByRole('tab', { name: 'Explorer' });
	const search = activitybar.getByRole('tab', { name: 'Search' });
	const openSearchMenu = () => search.click({ button: 'right' });
	expect(await workbench.menus.inspect(application, openSearchMenu)).toEqual(expect.arrayContaining([
		expect.objectContaining({ label: "Hide 'Search'", enabled: true }),
		expect.objectContaining({ label: 'Search', checked: true }),
	]));
	await workbench.menus.select(application, openSearchMenu, ["Hide 'Search'"]);
	await expect(search).toBeHidden();
	const openExplorerMenu = () => explorer.click({ button: 'right' });
	expect(await workbench.menus.inspect(application, openExplorerMenu)).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Search', checked: false })]));
	await workbench.menus.select(application, openExplorerMenu, ['Search']);
	await expect(search).toBeVisible();
	await explorer.focus();
	expect(await workbench.menus.inspect(application, () => explorer.press('Shift+F10'))).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Hide 'Explorer'", enabled: true })]));
});

test('Accounts and Manage menus open beside the activity bar and below the title bar', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.workbenchMode !== 'code', 'This scenario requires the web Code workbench');
	const page = workbench.page;
	const activitybar = page.locator('[data-part="activitybar"]');
	const accounts = activitybar.getByRole('button', { name: 'Accounts' });
	await accounts.click();
	const leftButton = await accounts.boundingBox();
	const leftMenu = await page.getByRole('menu').last().boundingBox();
	expect(leftButton).not.toBeNull();
	expect(leftMenu).not.toBeNull();
	expect(leftMenu!.x).toBeGreaterThanOrEqual(leftButton!.x + leftButton!.width - 1);
	await page.keyboard.press('Escape');

	await workbench.menus.select(application, () => accounts.click({ button: 'right' }), ['Move Primary Side Bar Right']);
	const manage = activitybar.getByRole('button', { name: 'Manage' });
	await manage.click();
	const rightButton = await manage.boundingBox();
	const rightMenu = await page.getByRole('menu').last().boundingBox();
	expect(rightButton).not.toBeNull();
	expect(rightMenu).not.toBeNull();
	expect(rightMenu!.x + rightMenu!.width).toBeLessThanOrEqual(rightButton!.x + 1);
	await page.keyboard.press('Escape');

	await workbench.menus.select(application, () => manage.click({ button: 'right' }), ['Activity Bar Position', 'Top']);
	const titlebarManage = page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Manage' });
	await titlebarManage.click();
	const topButton = await titlebarManage.boundingBox();
	const topMenu = await page.getByRole('menu').last().boundingBox();
	expect(topButton).not.toBeNull();
	expect(topMenu).not.toBeNull();
	expect(topMenu!.y).toBeGreaterThanOrEqual(topButton!.y + topButton!.height - 1);
	await page.keyboard.press('Escape');

	await workbench.menus.select(application, () => titlebarManage.click({ button: 'right' }), ['Activity Bar Position', 'Default']);
	await manage.click();
	const restoredButton = await manage.boundingBox();
	const restoredMenu = await page.getByRole('menu').last().boundingBox();
	expect(restoredButton).not.toBeNull();
	expect(restoredMenu).not.toBeNull();
	expect(restoredMenu!.x + restoredMenu!.width).toBeLessThanOrEqual(restoredButton!.x + 1);
});

test('macOS custom right activity bar menus open beside their buttons', async ({ target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code' || process.platform !== 'darwin', 'This scenario requires macOS Electron Code');
	const page = workbench.page;
	await page.getByRole('button', { name: 'Search commands' }).click();
	await page.getByRole('dialog', { name: 'Search commands (type >, @, or ? for modes)' }).getByRole('combobox').fill('Ash Settings');
	await page.keyboard.press('Enter');
	await page.locator('[data-settings-group-id="workbench"]').click();
	await page.locator('[data-settings-category-id="layout"]').click();
	await page.locator('[data-configuration-key="workbench.sideBar.location"]').getByRole('combobox').click();
	await page.getByRole('option', { name: 'Right' }).click();
	await page.getByRole('searchbox', { name: 'Search settings', exact: true }).fill('window.menuStyle');
	const menuStyle = page.locator('[data-configuration-key="window.menuStyle"]').getByRole('combobox');
	await menuStyle.click();
	await page.getByRole('option', { name: 'Custom', exact: true }).click();
	await page.getByRole('button', { name: 'Close Ash Settings' }).click();
	await workbench.quickaccess.runCommand('notifications.clearAll');

	const activitybar = page.locator('[data-part="activitybar"]');
	for (const name of ['Accounts', 'Manage']) {
		const button = activitybar.getByRole('button', { name });
		await button.click();
		const menu = page.getByRole('menu').last();
		await expect(menu).toBeVisible();
		const buttonBounds = await button.boundingBox();
		const menuBounds = await menu.boundingBox();
		expect(buttonBounds).not.toBeNull();
		expect(menuBounds).not.toBeNull();
		expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(buttonBounds!.x + 1);
		await page.keyboard.press('Escape');
		await expect(button).toHaveAttribute('aria-expanded', 'false');
	}
});

test('macOS context menu converts pointer and activity bar anchors at the current window zoom', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron' || process.platform !== 'darwin', 'This scenario requires macOS Electron');
	const electron = application as ElectronApplication;
	const windowId = await (await electron.browserWindow(workbench.page)).evaluate(window => window.id);
	await electron.evaluate(({ BrowserWindow, Menu }, windowId) => {
		const window = BrowserWindow.fromId(windowId)!;
		const originalPopup = Menu.prototype.popup;
		const originalZoom = window.webContents.getZoomLevel();
		const state = globalThis as typeof globalThis & { ashMenuPosition?: { options?: { x?: number; y?: number; positioningItem?: number; zoom: number }; restore: () => void } };
		state.ashMenuPosition = {
			restore: () => { Menu.prototype.popup = originalPopup; window.webContents.setZoomLevel(originalZoom); },
		};
		Menu.prototype.popup = function(options) {
			if (!options) throw new Error('Expected context menu popup options');
			state.ashMenuPosition!.options = { x: options.x, y: options.y, positioningItem: options.positioningItem, zoom: window.webContents.getZoomFactor() };
			options.callback?.();
		};
		window.webContents.setZoomLevel(2);
	}, windowId);
	try {
		const search = workbench.page.locator('[data-part="activitybar"]').getByRole('tab', { name: 'Search' });
		await workbench.page.evaluate(() => {
			window.addEventListener('contextmenu', event => {
				(window as Window & { ashMenuPointer?: { x: number; y: number } }).ashMenuPointer = { x: event.clientX, y: event.clientY };
			}, { capture: true, once: true });
		});
		await search.click({ button: 'right', position: { x: 2, y: 2 } });
		await expect.poll(() => electron.evaluate(() => (globalThis as typeof globalThis & { ashMenuPosition?: { options?: { x?: number; y?: number } } }).ashMenuPosition?.options)).toBeDefined();
		const actual = await electron.evaluate(() => (globalThis as typeof globalThis & { ashMenuPosition?: { options?: { x?: number; y?: number; positioningItem?: number; zoom: number } } }).ashMenuPosition?.options);
		const pointer = await workbench.page.evaluate(() => (window as Window & { ashMenuPointer?: { x: number; y: number } }).ashMenuPointer);
		expect(pointer).toBeDefined();
		expect(actual!.zoom).toBeGreaterThan(1);
		expect(actual).toEqual({ x: Math.floor(pointer!.x * actual!.zoom), y: Math.floor(pointer!.y * actual!.zoom), positioningItem: undefined, zoom: actual!.zoom });
		await electron.evaluate(() => { (globalThis as typeof globalThis & { ashMenuPosition: { options?: unknown } }).ashMenuPosition.options = undefined; });
		const accounts = workbench.page.locator('[data-part="activitybar"]').getByRole('button', { name: 'Accounts' });
		await accounts.evaluate(element => {
			element.addEventListener('mousedown', () => {
				const bounds = element.getBoundingClientRect();
				(window as Window & { ashMenuAnchor?: { x: number; y: number } }).ashMenuAnchor = { x: bounds.right, y: bounds.top };
			}, { once: true });
		});
		await accounts.click();
		await expect.poll(() => electron.evaluate(() => (globalThis as typeof globalThis & { ashMenuPosition?: { options?: { x?: number; y?: number } } }).ashMenuPosition?.options)).toBeDefined();
		const elementMenu = await electron.evaluate(() => (globalThis as typeof globalThis & { ashMenuPosition?: { options?: { x?: number; y?: number; positioningItem?: number; zoom: number } } }).ashMenuPosition?.options);
		const anchor = await workbench.page.evaluate(() => (window as Window & { ashMenuAnchor?: { x: number; y: number } }).ashMenuAnchor);
		expect(anchor).toBeDefined();
		expect(elementMenu).toEqual({ x: Math.floor(anchor!.x * elementMenu!.zoom), y: Math.floor(anchor!.y * elementMenu!.zoom) + 4, positioningItem: undefined, zoom: elementMenu!.zoom });
	} finally {
		await electron.evaluate(() => (globalThis as typeof globalThis & { ashMenuPosition?: { restore: () => void } }).ashMenuPosition?.restore());
	}
});

test('a late macOS menu close callback leaves the next menu open', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron' || process.platform !== 'darwin', 'This scenario requires macOS Electron');
	const electron = application as ElectronApplication;
	await electron.evaluate(({ Menu }) => {
		const originalPopup = Menu.prototype.popup;
		const state = globalThis as typeof globalThis & { ashMenuCallbacks?: { callbacks: (() => void)[]; restore: () => void } };
		state.ashMenuCallbacks = {
			callbacks: [],
			restore: () => { Menu.prototype.popup = originalPopup; },
		};
		Menu.prototype.popup = function(options) {
			if (!options) throw new Error('Expected context menu popup options');
			state.ashMenuCallbacks!.callbacks.push(() => options.callback?.());
		};
	});
	try {
		const activitybar = workbench.page.locator('[data-part="activitybar"]');
		const accounts = activitybar.getByRole('button', { name: 'Accounts' });
		const manage = activitybar.getByRole('button', { name: 'Manage' });
		await accounts.click();
		await expect.poll(() => electron.evaluate(() => (globalThis as typeof globalThis & { ashMenuCallbacks?: { callbacks: (() => void)[] } }).ashMenuCallbacks?.callbacks.length)).toBe(1);
		await electron.evaluate(() => (globalThis as typeof globalThis & { ashMenuCallbacks: { callbacks: (() => void)[] } }).ashMenuCallbacks.callbacks[0]!());
		await expect(accounts).toHaveAttribute('aria-expanded', 'false');
		await manage.click();
		await expect.poll(() => electron.evaluate(() => (globalThis as typeof globalThis & { ashMenuCallbacks?: { callbacks: (() => void)[] } }).ashMenuCallbacks?.callbacks.length)).toBe(2);
		await expect(manage).toHaveAttribute('aria-expanded', 'true');
		await electron.evaluate(() => (globalThis as typeof globalThis & { ashMenuCallbacks: { callbacks: (() => void)[] } }).ashMenuCallbacks.callbacks[0]!());
		await workbench.page.waitForTimeout(100);
		await expect(manage).toHaveAttribute('aria-expanded', 'true');
		await electron.evaluate(() => (globalThis as typeof globalThis & { ashMenuCallbacks: { callbacks: (() => void)[] } }).ashMenuCallbacks.callbacks[1]!());
		await expect(manage).toHaveAttribute('aria-expanded', 'false');
	} finally {
		await electron.evaluate(() => (globalThis as typeof globalThis & { ashMenuCallbacks?: { callbacks: (() => void)[]; restore: () => void } }).ashMenuCallbacks?.restore());
	}
});

test('blank activity bar context menu lists and toggles views', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const activitybar = workbench.page.locator('[data-part="activitybar"]');
	const compositeBar = activitybar.locator('.ash-composite-bar');
	const search = activitybar.getByRole('tab', { name: 'Search' });
	const bounds = await compositeBar.boundingBox();
	expect(bounds).not.toBeNull();
	const openMenu = () => compositeBar.click({ button: 'right', position: { x: 2, y: bounds!.height - 4 } });
	const items = await workbench.menus.inspect(application, openMenu);
	for (const name of ['Explorer', 'Search', 'Git', 'Run and Debug', 'Testing', 'Marketplace']) {
		expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ label: name, checked: true })]));
	}
	expect(items).toEqual(expect.arrayContaining(['Accounts', 'Activity Bar Position'].map(label => expect.objectContaining({ label, enabled: true }))));
	await workbench.menus.select(application, openMenu, ['Search']);
	await expect(search).toBeHidden();
	expect(await workbench.menus.inspect(application, openMenu)).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Search', checked: false })]));
	await workbench.menus.select(application, openMenu, ['Search']);
	await expect(search).toBeVisible();
});

test('activity bar context menu changes size and position', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const activitybar = page.locator('[data-part="activitybar"]');
	const titlebar = page.locator('[data-part="titlebar"]');
	const sidebar = page.locator('[data-part="sidebar"]');
	const editor = page.locator('[data-part="editor"]');
	await workbench.openExplorer();
	await expect(sidebar).toBeVisible();
	const openAccountsMenu = () => activitybar.getByRole('button', { name: 'Accounts' }).click({ button: 'right' });
	expect(await workbench.menus.inspect(application, openAccountsMenu)).toEqual(expect.arrayContaining([
		expect.objectContaining({ label: 'Accounts', checked: true }),
		...['Activity Bar Position', 'Activity Bar Size', 'Move Primary Side Bar Right'].map(label => expect.objectContaining({ label, enabled: true })),
	]));
	await workbench.menus.select(application, openAccountsMenu, ['Activity Bar Size', 'Compact']);
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
	await workbench.menus.select(application, openAccountsMenu, ['Move Primary Side Bar Right']);
	await expect.poll(async () => (await sidebar.boundingBox())!.x > (await editor.boundingBox())!.x).toBe(true);
	const [sidebarBounds, editorBounds, activityBounds] = await Promise.all([sidebar.boundingBox(), editor.boundingBox(), activitybar.boundingBox()]);
	expect(sidebarBounds).not.toBeNull();
	expect(editorBounds).not.toBeNull();
	expect(activityBounds).not.toBeNull();
	expect(sidebarBounds!.x).toBeGreaterThan(editorBounds!.x);
	expect(activityBounds!.x).toBeGreaterThan(sidebarBounds!.x);
	await expect(activitybar).toHaveCSS('border-left-width', '1px');
	await expect(sidebar).toHaveCSS('border-right-width', '0px');
	const openManageMenu = () => activitybar.getByRole('button', { name: 'Manage' }).click({ button: 'right' });
	const positions = await workbench.menus.inspect(application, openManageMenu, ['Activity Bar Position']);
	expect(positions.map(item => ({ label: item.label, checked: item.checked }))).toEqual([
		{ label: 'Default', checked: true }, { label: 'Top', checked: false },
		{ label: 'Bottom', checked: false }, { label: 'Hidden', checked: false },
	]);
	await workbench.menus.select(application, openManageMenu, ['Activity Bar Position', 'Top']);
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
	expect(await workbench.menus.inspect(application, () => topSelector.getByRole('tab', { name: 'Explorer' }).click({ button: 'right' }))).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Activity Bar Position', enabled: true })]));
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
	expect(await workbench.menus.inspect(application, () => titlebarAccounts.click())).toEqual(expect.arrayContaining(['Manage Accounts', 'Connect GitHub'].map(label => expect.objectContaining({ label, enabled: true }))));
	if (target.kind === 'browser' && target.appServerMode === 'disabled') {
		await workbench.menus.select(application, () => titlebarAccounts.click(), ['Connect GitHub']);
		const dialog = page.getByRole('dialog', { name: 'Connect GitHub' });
		await expect(dialog).toContainText('Could not connect GitHub. Try again.');
		await expect(page.locator('.ash-notification')).toHaveCount(0);
		await dialog.getByRole('button', { name: 'OK' }).click();
	}
	expect(await workbench.menus.inspect(application, () => titlebarManage.click())).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Settings', enabled: true })]));
	await titlebarManage.focus();
	const systemMenu = await workbench.menus.isSystemMenu(application);
	expect(await workbench.menus.inspect(application, async () => {
		await titlebarManage.press('Shift+F10');
		if (!systemMenu) {
			const bounds = await page.getByRole('menu').last().boundingBox();
			expect(bounds).not.toBeNull();
			expect(bounds!.x + bounds!.width).toBeGreaterThan(manageBounds!.x);
		}
	})).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Activity Bar Position', enabled: true })]));
	await workbench.menus.select(application, () => titlebarManage.click({ button: 'right' }), ['Accounts']);
	await expect(titlebarAccounts).toHaveCount(0);
	await workbench.menus.select(application, () => titlebarManage.click({ button: 'right' }), ['Accounts']);
	await expect(titlebarAccounts).toBeVisible();
	await workbench.menus.select(application, () => titlebarManage.click({ button: 'right' }), ['Activity Bar Position', 'Bottom']);
	await expect(activitybar).toBeHidden();
	const bottomSelector = sidebar.locator('.ash-sidebar-composite-bar-bottom').getByRole('tablist');
	await expect(bottomSelector).toHaveAttribute('aria-orientation', 'horizontal');
	const [bottomBar, bottomSidebar] = await Promise.all([bottomSelector.boundingBox(), sidebar.boundingBox()]);
	await expect(sidebar).toHaveCSS('border-bottom-width', '1px');
	expect(bottomBar!.y + bottomBar!.height).toBeGreaterThanOrEqual(bottomSidebar!.y + bottomSidebar!.height - 1);
	await workbench.menus.select(application, () => titlebarManage.click({ button: 'right' }), ['Activity Bar Position', 'Default']);
	await expect(activitybar).toBeVisible();
	await expect(activitybar.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
	await expect(titlebarManage).toHaveCount(0);
	await workbench.menus.select(application, () => activitybar.getByRole('button', { name: 'Manage' }).click({ button: 'right' }), ['Move Primary Side Bar Left']);
	await expect(sidebar).not.toHaveClass(/sidebar-right/u);
	const [leftSidebar, leftEditor, leftBar] = await Promise.all([sidebar.boundingBox(), editor.boundingBox(), activitybar.boundingBox()]);
	expect(leftBar!.x).toBeLessThan(leftSidebar!.x);
	expect(leftSidebar!.x).toBeLessThan(leftEditor!.x);
	await workbench.menus.select(application, () => activitybar.getByRole('button', { name: 'Manage' }).click({ button: 'right' }), ['Accounts']);
	await expect(activitybar.getByRole('button', { name: 'Accounts' })).toBeHidden();
	await workbench.menus.select(application, () => activitybar.getByRole('button', { name: 'Manage' }).click({ button: 'right' }), ['Accounts']);
	await expect(activitybar.getByRole('button', { name: 'Accounts' })).toBeVisible();
	await workbench.menus.select(application, () => activitybar.getByRole('button', { name: 'Manage' }).click({ button: 'right' }), ['Activity Bar Position', 'Hidden']);
	await expect(activitybar).toBeHidden();
});

test('activity bar icon size follows position and compact in Flat and Modern layouts', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const activitybar = page.locator('[data-part="activitybar"]');
	const sidebar = page.locator('[data-part="sidebar"]');
	const railIcons = activitybar.locator('.ash-composite-bar-destination .ash-icon, .ash-global-composite-bar .ash-button-content .ash-icon');
	const expectIconSize = async (icons: typeof railIcons, size: number): Promise<void> => {
		expect(await icons.count()).toBeGreaterThan(0);
		for (const icon of await icons.all()) {
			await expect(icon).toHaveCSS('width', `${size}px`);
			await expect(icon).toHaveCSS('height', `${size}px`);
			const insets = await icon.evaluate(element => {
				const icon = element.getBoundingClientRect();
				const item = element.closest('[role="tab"], button')!.getBoundingClientRect();
				return [icon.left - item.left, item.right - icon.right, icon.top - item.top, item.bottom - icon.bottom];
			});
			for (const inset of insets) expect(inset).toBeGreaterThanOrEqual(0);
			const iconId = await icon.getAttribute('data-ash-icon-id');
			expect(Math.abs(insets[0]! - insets[1]!), `${iconId} horizontal centering: ${insets}`).toBeLessThanOrEqual(1);
			expect(Math.abs(insets[2]! - insets[3]!), `${iconId} vertical centering: ${insets}`).toBeLessThanOrEqual(1);
		}
	};
	const chooseActivityOption = async (menu: string, option: string): Promise<void> => {
		await workbench.menus.select(application, () => page.getByRole('button', { name: 'Manage', exact: true }).click({ button: 'right' }), [menu, option]);
	};
	await workbench.openExplorer();
	await expect(sidebar).toBeVisible();
	for (const style of ['Flat', 'Modern']) {
		await workbench.settingsEditor.openUserSettingsUI();
		const settings = page.getByRole('dialog', { name: 'Ash Settings' });
		await settings.locator('[data-settings-group-id="workbench"]').click();
		await settings.locator('[data-settings-category-id="layout"]').click();
		await settings.locator('[data-configuration-key="workbench.layoutStyle"]').getByRole('combobox').click();
		await page.getByRole('option', { name: style, exact: true }).click();
		await settings.locator('.ash-modal-editor-close').click();
		await expect(settings).toHaveCount(0);
		if (style === 'Modern') await expect(workbench.element).toHaveClass(/modern-ui/);
		else await expect(workbench.element).not.toHaveClass(/modern-ui/);
		await expectIconSize(railIcons, 24);
		await chooseActivityOption('Activity Bar Size', 'Compact');
		await expect(activitybar).toHaveClass(/compact/);
		await expectIconSize(railIcons, 16);
		await chooseActivityOption('Activity Bar Size', 'Default');
		await expect(activitybar).not.toHaveClass(/compact/);
		await expectIconSize(railIcons, 24);
		for (const position of ['Top', 'Bottom']) {
			await chooseActivityOption('Activity Bar Position', position);
			await expect(activitybar).toBeHidden();
			const selector = sidebar.locator(`.ash-sidebar-composite-bar-${position.toLowerCase()}`);
			await expect(selector).toBeVisible();
			await expectIconSize(selector.locator('.ash-composite-bar-destination .ash-icon'), 16);
			const titlebar = page.locator('[data-part="titlebar"]');
			for (const name of ['Accounts', 'Manage']) {
				await expectIconSize(titlebar.getByRole('button', { name, exact: true }).locator('.ash-button-content .ash-icon'), 16);
			}
		}
		await chooseActivityOption('Activity Bar Position', 'Default');
		await expect(activitybar).toBeVisible();
		await expectIconSize(railIcons, 24);
	}
});

test('top activity bar places the view selector inside the sidebar', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const activitybar = page.locator('[data-part="activitybar"]');
	const sidebar = page.locator('[data-part="sidebar"]');
	await workbench.openExplorer();
	await expect(sidebar).toBeVisible();
	const initialSidebar = await sidebar.boundingBox();
	await workbench.menus.select(application, () => activitybar.getByRole('button', { name: 'Manage' }).click({ button: 'right' }), ['Activity Bar Position', 'Top']);

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
	await workbench.menus.select(application, () => page.getByRole('button', { name: 'Manage' }).click(), ['Settings']);
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

test('macOS sidebar toggle starts at the window control safe area', async ({ target, workbench }) => {
	test.skip(target.kind !== 'electron' || process.platform !== 'darwin');
	const titlebar = workbench.page.locator('.ash-electron-titlebar');
	const toggle = titlebar.locator('[data-action-id="workbench.action.toggleSideBar"] button');
	await expect(toggle).toBeVisible();
	const { safeArea, gap } = await toggle.evaluate(button => {
		const titlebar = button.closest('.ash-electron-titlebar')!;
		const probe = document.createElement('div');
		probe.style.width = 'env(titlebar-area-x, 0px)';
		document.body.append(probe);
		const safeArea = probe.getBoundingClientRect().width;
		probe.remove();
		return { safeArea, gap: button.getBoundingClientRect().left - titlebar.getBoundingClientRect().left - safeArea };
	});
	expect(safeArea).toBeGreaterThan(0);
	expect(gap).toBeGreaterThanOrEqual(0);
	expect(gap).toBeLessThanOrEqual(4);
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

	let untitled = 0;
	const openUntitled = async () => {
		await page.keyboard.press('ControlOrMeta+N');
		await expect(workbench.editors.groupAt(0).editor.input).toHaveAttribute('aria-label', `Untitled-${++untitled}`);
	};
	await openUntitled();
	await openUntitled();
	await openUntitled();
	await expect(back).toBeEnabled();
	await expect(forward).toBeDisabled();
	await back.click();
	await expect(workbench.editors.groupAt(0).element.getByRole('tab', { selected: true })).toContainText('Untitled-2');
	await expect(forward).toBeEnabled();
	await back.focus();
	await back.press('ArrowRight');
	await expect(forward).toBeFocused();
	await forward.click();
	await expect(workbench.editors.groupAt(0).element.getByRole('tab', { selected: true })).toContainText('Untitled-3');
	const backShortcut = process.platform === 'darwin' ? 'Control+-' : process.platform === 'linux' ? 'Control+Alt+-' : 'Alt+ArrowLeft';
	await page.keyboard.press(backShortcut);
	await expect(workbench.editors.groupAt(0).element.getByRole('tab', { selected: true })).toContainText('Untitled-2');
	await openUntitled();
	await expect(forward).toBeDisabled();
});

test('titlebar navigation restores a cursor location in the same editor', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
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
	const checkExpandedSpacing = async (): Promise<void> => {
		await expect.poll(() => entry.evaluate(button => {
			const bounds = button.getBoundingClientRect();
			const iconBounds = button.querySelector('.ash-icon-label-icon')!.getBoundingClientRect();
			const labelBounds = button.querySelector('.ash-icon-label-container')!.getBoundingClientRect();
			return {
				left: Math.round(iconBounds.left - bounds.left),
				iconToText: Math.round(labelBounds.left - iconBounds.right),
				right: Math.round(bounds.right - labelBounds.right),
			};
		})).toEqual({ left: 4, iconToText: 6, right: 4 });
	};
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
		await checkExpandedSpacing();
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
		await checkExpandedSpacing();
	}
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect(petal).toHaveCSS('animation-name', 'none');
	if (target.kind === 'electron') {
		await expect.poll(() => expandedLabel.evaluate(element => Number.parseFloat(getComputedStyle(element).transitionDuration))).toBeLessThan(0.001);
	}

	if (target.kind === 'browser') {
		await page.setViewportSize({ width: 1200, height: 800 });
		await entry.click();
		await expect(page).toHaveURL(/sessions-code\.html/u);
		await expect(page.locator('.ash-code-sessions-window')).toBeVisible();
		await expect(page.locator('#app')).toHaveAttribute('data-runtime', 'web');
		await expect(page.getByRole('button', { name: 'Return to Workbench' })).toHaveCount(0);
		await expect(page.locator('.ash-sessions-titlebar-title, .ash-sessions-titlebar-avatar')).toHaveCount(0);
		await expect(page.locator("[data-part='activitybar']")).toBeVisible();
		const activityButtons = page.locator("[data-part='activitybar'] button");
		expect(await activityButtons.locator('svg').evaluateAll(icons => icons.map(icon => icon.getAttribute('data-ash-icon-id')))).toEqual(['chat-2-filled', 'colab', 'library', 'code', 'symbol-color', 'account']);
		await expect(activityButtons.first()).toHaveAttribute('aria-current', 'page');
		await expect(page.getByRole('button', { name: 'Collaboration', exact: true })).toBeEnabled();
		await expect(page.getByRole('button', { name: 'Library', exact: true })).toBeEnabled();
		await expect(page.getByRole('button', { name: 'Code', exact: true })).toBeEnabled();
		const design = page.getByRole('button', { name: 'Design', exact: true });
		await expect(design).toBeEnabled();
		const designBounds = await design.boundingBox();
		const accountBounds = await page.getByRole('button', { name: 'Accounts', exact: true }).boundingBox();
		const navigationBounds = await page.locator("[data-part='activitybar']").boundingBox();
		expect(accountBounds!.y).toBeGreaterThan(designBounds!.y);
		expect(navigationBounds!.y + navigationBounds!.height - (accountBounds!.y + accountBounds!.height)).toBeLessThanOrEqual(16);
		const sidebarBounds = await page.locator("[data-part='sidebar']").boundingBox();
		const sessionsBounds = await page.locator("[data-part='sessions']").boundingBox();
		const sidebarFrameBounds = await page.locator("[data-part='sidebar']").locator('..').boundingBox();
		expect(navigationBounds?.width).toBeCloseTo(44, 0);
		expect(sidebarFrameBounds?.width).toBeCloseTo(260, 0);
		expect(sessionsBounds!.x).toBeGreaterThan(sidebarBounds!.x);
		await expect(page.locator("[data-part='auxiliarybar']")).toBeHidden();
		await expect(page.locator("[data-part='editor']")).toBeHidden();
		const hideSidebar = page.getByRole('button', { name: 'Hide sidebar', exact: true });
		await expect(hideSidebar).toHaveAttribute('aria-pressed', 'true');
		await hideSidebar.click();
		await expect(page.locator("[data-part='sidebar']")).toBeHidden();
		const showSidebar = page.getByRole('button', { name: 'Show sidebar', exact: true });
		await expect(showSidebar).toHaveAttribute('aria-pressed', 'false');
		await showSidebar.click();
		await expect(page.locator("[data-part='sidebar']")).toBeVisible();
		const sessionsNavigation = page.locator("[data-part='activitybar']").getByRole('button', { name: 'Chat', exact: true });
		await sessionsNavigation.focus();
		await page.keyboard.press('Alt+F1');
		await expect(page.getByRole('dialog', { name: 'Accessibility Help' })).toBeVisible();
		await expect(page.getByRole('textbox', { name: 'Accessibility Help' })).toHaveValue(/Use Tab and Shift\+Tab/u);
		await page.getByRole('dialog', { name: 'Accessibility Help' }).getByRole('button', { name: 'Close' }).click();
		await expect(sessionsNavigation).toBeFocused();
		await page.getByRole('searchbox', { name: 'Search sessions' }).fill('no matching session title');
		await expect(page.locator('.ash-sessions-empty')).toHaveText('No matching sessions');
		await expect(page.locator('#app')).toHaveAttribute('data-color-theme', /ash-(?:light|dark)/u);
		await activityButtons.last().click();
		await page.getByRole('menuitem', { name: 'Return to Workbench' }).click();
		await expect(page).toHaveURL(/workbench\.html/u);
	}
});

test('titlebar toolbar icons fit inside their buttons', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const sidebarToggle = page.locator('.ash-titlebar-left-actions [data-action-id="workbench.action.toggleSideBar"] button');
	const panelToggle = page.locator('.ash-titlebar-actions [data-action-id="workbench.action.togglePanel"] button');
	for (const [toggle, accessibleName] of [
		[sidebarToggle, /(?:Show|Hide) Primary Side Bar/u],
		[panelToggle, /(?:Show|Hide) Panel/u],
	] as const) {
		await expect(toggle).toBeVisible();
		await expect(toggle).toHaveAccessibleName(accessibleName);
		await expect(toggle.locator('.ash-icon')).toBeVisible();
		await expect(toggle.locator('.ash-button-label')).toBeHidden();
	}
	const buttons = page.locator('.ash-workbench-titlebar .ash-toolbar .ash-action-view-item.icon > .ash-button');
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
	test.skip(target.kind === 'electron' && process.platform === 'darwin', 'macOS uses the system menu');
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
	await expect(picker.locator('.ash-list-row').nth(20)).toBeVisible();
	await expect.poll(() => viewport.evaluate(element => element.clientHeight)).toBe(initial.listHeight);
	await page.setViewportSize({ width: 900, height: 400 });
	await expect(async () => {
		const compactListHeight = await viewport.evaluate(element => element.clientHeight);
		expect(compactListHeight).toBeGreaterThan(0);
		expect(compactListHeight).toBeLessThan(initial.listHeight);
		expect(Math.abs(compactListHeight / initial.rowHeight - Math.round(compactListHeight / initial.rowHeight))).toBeLessThan(0.03);
		const resized = await picker.evaluate(element => ({
			bottom: element.getBoundingClientRect().bottom,
			viewportHeight: window.innerHeight,
		}));
		expect(resized.bottom).toBeLessThanOrEqual(resized.viewportHeight);
	}).toPass({ timeout: 10_000 });
});

test('titlebar command center opens command search and restores focus', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.selectTheme');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('Ash Light');
	await page.keyboard.press('Enter');
	await expect(page.locator('.ash-quick-pick')).toHaveCount(0);
	const commandCenter = page.getByRole('button', { name: 'Search commands' });
	await expect(commandCenter).toBeVisible();

	const titlebar = page.locator('.ash-workbench-titlebar');
	const appIcon = titlebar.locator('.ash-titlebar-app-icon');
	await expect(appIcon).toHaveCSS('mask-image', /ash-mark.*\.svg/u);
	await expect(appIcon).toHaveCSS('background-image', 'none');
	await expect(appIcon).toHaveCSS('background-color', await appIcon.evaluate(element => getComputedStyle(element).color));
	if (process.platform === 'darwin') {
		await expect(appIcon).toBeHidden();
	} else {
		await expect(appIcon).toBeVisible();
		const bounds = await appIcon.boundingBox();
		expect(bounds!.width).toBeGreaterThanOrEqual(13);
		expect(bounds!.height).toBeGreaterThanOrEqual(13);
	}
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
	await expect(page.getByRole('tooltip')).toHaveText(target.kind === 'browser' && target.appServerMode === 'required' ? `Welcome — ${testWorkspace.directory.split(/[\\/]/u).at(-1)} — Ash Code` : 'Welcome — Ash Code');

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
		await expect(async () => {
			const bounds = await commandCenter.evaluate(element => {
				const titlebar = element.closest('.ash-workbench-titlebar')!;
				const left = titlebar.querySelector('.ash-workbench-part-title')!.getBoundingClientRect();
				const control = element.getBoundingClientRect();
				const right = titlebar.querySelector('.ash-workbench-part-content')!.getBoundingClientRect();
				return { titlebarWidth: titlebar.getBoundingClientRect().width, leftRight: left.right, controlLeft: control.left, controlRight: control.right, controlWidth: control.width, rightLeft: right.left };
			});
			expect(bounds.titlebarWidth).toBe(width);
			expect(bounds.leftRight).toBeLessThanOrEqual(bounds.controlLeft);
			expect(bounds.controlRight).toBeLessThanOrEqual(bounds.rightLeft);
			if (width === 700) expect(bounds.controlWidth).toBe(32);
		}).toPass({ timeout: 10_000 });
	}
	await commandCenter.click();
	await expect(picker.getByRole('combobox')).toBeFocused();
});
