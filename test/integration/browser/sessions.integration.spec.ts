import { expect, test, type Locator } from '@playwright/test';

async function expectActivityIconSize(navigation: Locator, size: number, horizontal = false): Promise<void> {
	await expect.poll(() => navigation.evaluate(element => element.classList.contains('horizontal'))).toBe(horizontal);
	if (!horizontal) {
		await expect.poll(() => navigation.evaluate(element => element.classList.contains('compact'))).toBe(size === 16);
	}
	await expect(navigation).toHaveCSS('display', 'flex');
	await expect(navigation).toHaveCSS('justify-content', 'space-between');
	await expect.poll(() => navigation.evaluate(element => getComputedStyle(element).flexDirection === (element.classList.contains('horizontal') ? 'row' : 'column'))).toBe(true);
	const icons = navigation.locator('button svg.ash-icon');
	const compact = size === 16;
	const itemSize = horizontal ? 24 : compact ? 28 : 36;
	for (const item of await navigation.locator('.ash-composite-bar-navigation-item > button').all()) {
		await expect(item).toHaveCSS('width', `${itemSize}px`);
		await expect(item).toHaveCSS('height', `${itemSize}px`);
	}
	await expect(icons).toHaveCount(horizontal ? 6 : 7);
	const accounts = navigation.page().getByRole('button', { name: 'Accounts', exact: true });
	await expect(accounts).toHaveCount(1);
	const titlebarAccounts = navigation.page().locator('[data-part="titlebar"]').getByRole('button', { name: 'Accounts', exact: true });
	await expect(titlebarAccounts).toHaveCount(horizontal ? 1 : 0);
	if (horizontal) {
		await expect(navigation.getByRole('button', { name: 'Accounts', exact: true })).toHaveCount(0);
		await expect(titlebarAccounts.locator('svg')).toHaveCSS('width', '16px');
		await expect(titlebarAccounts.locator('svg')).toHaveCSS('height', '16px');
		await expect(titlebarAccounts).toHaveAttribute('aria-haspopup', 'menu');
	}
	for (const icon of await icons.all()) {
		await expect(icon).toHaveCSS('width', `${size}px`);
		await expect(icon).toHaveCSS('height', `${size}px`);
		const bounds = await icon.evaluate(element => {
			const icon = element.getBoundingClientRect();
			const button = element.closest('button')!.getBoundingClientRect();
			return {
				x: Math.abs(icon.x + icon.width / 2 - button.x - button.width / 2),
				y: Math.abs(icon.y + icon.height / 2 - button.y - button.height / 2),
			};
		});
		expect(bounds.x).toBeLessThanOrEqual(1);
		expect(bounds.y).toBeLessThanOrEqual(1);
	}
}


test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/sessions.html');
	await expect.poll(async () => ({ ready: await page.locator('body').getAttribute('data-ready'), errors })).toEqual({ ready: 'true', errors: [] });
});

test.afterEach(async ({ page }) => {
	await expect.poll(() => page.evaluate(() => window.ashSessionsIntegration.errors)).toEqual([]);
});

test('Sessions navigation icons and surface controls follow the selected component', async ({ page }) => {
	const activityBar = page.locator('[data-part="activitybar"]');
	await expect(activityBar).toBeVisible();
	await expect(activityBar).toHaveClass(/ash-sessions-activitybar/u);
	await expect(page.locator('.ash-workbench-activitybar, .ash-activity-bar-content')).toHaveCount(0);
	const activityNavigation = page.locator('.ash-sessions-activity-content');
	await expectActivityIconSize(activityNavigation, 24);
	await expect(activityNavigation.getByRole('button', { name: 'Chat' }).locator('svg')).toHaveAttribute('data-ash-icon-id', 'chat-2-filled');
	await expect(activityNavigation.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page');
	await expect(activityNavigation.getByRole('button', { name: 'Code' }).locator('svg')).toHaveAttribute('data-ash-icon-id', 'code');
	await expect(activityNavigation.getByRole('button', { name: 'Code' })).not.toHaveAttribute('aria-current', 'page');
	await expect(page.locator('.ash-sessions-sidebar-tabs')).toHaveCount(0);
	await page.mouse.move(400, 180);
	await expect(page.getByRole('button', { name: 'Hide sidebar' })).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	await expect(activityBar.locator('.ash-sessions-activity-top button svg').first()).toHaveAttribute('data-ash-icon-id', 'chat-2-filled');
	const collaboration = activityBar.getByRole('button', { name: 'Collaboration' });
	const library = activityBar.getByRole('button', { name: 'Library' });
	const chat = activityBar.getByRole('button', { name: 'Chat' });
	await collaboration.click();
	await expect(collaboration.locator('svg')).toHaveAttribute('data-ash-icon-id', 'colab-filled');
	await expect(collaboration).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('.ash-sessions-list-controls')).toBeHidden();
	await expect(page.locator('.ash-sessions-surface-header')).toHaveCount(0);
	await expect(page.locator('[data-part="auxiliarybar"] h2')).toBeHidden();
	await library.click();
	await expect(library.locator('svg')).toHaveAttribute('data-ash-icon-id', 'projects-filled');
	await expect(library).toHaveAttribute('aria-current', 'page');
	await expect(collaboration.locator('svg')).toHaveAttribute('data-ash-icon-id', 'colab');
	await chat.click();
	await expect(chat).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('.ash-sessions-list-controls')).toBeVisible();
	await expect(page.locator('.ash-sessions-surface-header')).toHaveCount(0);
	await expect(chat).toHaveCSS('background-color', 'rgb(240, 240, 240)');
	await expect(page.locator('.ash-sessions-list-item.selected').first()).toHaveCSS('background-color', 'rgb(240, 240, 240)');
});

test('Creator canvas responds to wheel, drag and keyboard input', async ({ page }) => {
	const creator = page.locator('[data-part="activitybar"]').getByRole('button', { name: 'Creator', exact: true });
	await creator.click();
	await expect(creator.locator('svg')).toHaveAttribute('data-ash-icon-id', 'symbol-color-filled');
	await expect(creator).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('.ash-sessions-list-controls')).toBeHidden();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas' });
	await expect(canvas).toBeVisible();
	const world = canvas.locator('.ash-canvas-world');
	const worldTransform = () => world.evaluate(element => (element as HTMLElement).style.transform);
	await expect.poll(worldTransform).toBe('translate(0px, 0px) scale(1)');
	await page.mouse.move(700, 400);
	await page.mouse.wheel(0, 120);
	await expect.poll(worldTransform).toBe('translate(0px, -120px) scale(1)');
	await page.mouse.down();
	await page.mouse.move(760, 440, { steps: 2 });
	await page.mouse.up();
	await expect.poll(worldTransform).toBe('translate(60px, -80px) scale(1)');
	await canvas.click();
	await page.keyboard.press('0');
	await page.keyboard.press('ArrowLeft');
	await expect.poll(worldTransform).toBe('translate(60px, 0px) scale(1)');
	await page.getByRole('button', { name: 'Chat', exact: true }).click();
	await expect(canvas).toBeHidden();
});

test.describe('Sessions settings components', () => {
	test.beforeEach(async ({ page }) => {
		const accounts = page.getByRole('button', { name: 'Accounts', exact: true });
		await expect(accounts.locator('svg')).toHaveAttribute('data-ash-icon-id', 'account');
		await accounts.click();
		await expect(accounts).toHaveAttribute('aria-expanded', 'true');
		await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
	});

	test('modified settings refresh after configuration changes and reset without replacing search', async ({ page }) => {
		const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
		const search = settings.getByRole('searchbox', { name: 'Search settings' });
		const setting = settings.locator('[data-settings-item-id="sessions.activityBar.compact"]');
		const empty = settings.locator('.ash-sessions-settings-empty');
		await search.fill('@id:sessions.activityBar.compact');
		await setting.getByRole('switch').focus();
		await setting.getByRole('switch').press('Space');
		await settings.getByRole('button', { name: 'Filter Settings', exact: true }).click();
		await settings.getByRole('menuitem', { name: 'Modified', exact: true }).click();
		await expect(search).toHaveValue('@id:sessions.activityBar.compact @modified');
		await expect(search).toBeFocused();
		await expect(setting.getByRole('switch')).toBeChecked();
		await expect(settings.locator('.ash-sessions-customize')).toHaveCount(0);
		await page.evaluate(() => window.ashSessionsIntegration.updateConfiguration('sessions.activityBar.compact', undefined));
		await expect(setting).toHaveCount(0);
		await expect(empty).toBeVisible();
		await expect(search).toBeFocused();
		await page.evaluate(() => window.ashSessionsIntegration.updateConfiguration('sessions.activityBar.compact', true));
		await expect(setting.getByRole('switch')).toBeChecked();
		await expect(empty).toBeHidden();
		await expect(search).toBeFocused();
		await setting.hover();
		await setting.getByRole('button', { name: 'More actions for Compact Activity Bar', exact: true }).click();
		await settings.getByRole('menuitem', { name: 'Reset Setting', exact: true }).click();
		await expect(setting).toHaveCount(0);
		await expect(empty).toBeVisible();
		await expect(search).toHaveValue('@id:sessions.activityBar.compact @modified');
		await search.fill('@id:sessions.activityBar.compact');
		await expect(setting.getByRole('switch')).not.toBeChecked();
		await expect(empty).toBeHidden();
	});

	test('settings cards and responsive panes preserve their geometry', async ({ page }) => {
		const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
		await expect(settings).toBeVisible();
		await expect(settings.locator('.ash-dialog-title')).toBeHidden();
		await expect(settings).toHaveCSS('border-top-width', '1px');
		await expect(settings.locator('.ash-sessions-settings')).toHaveCSS('border-top-width', '0px');
		await expect(settings.locator('.ash-sessions-settings-list').first()).toHaveCSS('border-top-width', '0px');
		const settingsCard = settings.locator('.ash-sessions-settings-list.ash-settings-card');
		for (const card of await settingsCard.all()) { await expect(card).toHaveCSS('border-radius', '8px'); }
		for (const card of await settingsCard.all()) { await expect(card).toHaveCSS('background-color', /rgb\(/); }
		await expect(settingsCard.locator('.ash-configuration-setting').first()).toHaveCSS('border-top-left-radius', '8px');
		await expect(settingsCard.locator('.ash-configuration-setting').last()).toHaveCSS('border-bottom-right-radius', '8px');
		const sidebar = settings.locator('.ash-sessions-settings-sidebar');
		const settingsPage = settings.locator('.ash-sessions-settings-page');
		const sidebarBounds = await sidebar.boundingBox();
		const pageBounds = await settingsPage.boundingBox();
		expect(sidebarBounds).not.toBeNull();
		expect(pageBounds).not.toBeNull();
		expect(sidebarBounds!.x + sidebarBounds!.width).toBeLessThanOrEqual(pageBounds!.x + 1);
		expect(sidebarBounds!.y + sidebarBounds!.height).toBeGreaterThanOrEqual(pageBounds!.y + pageBounds!.height - 1);
		await expect(settings.locator('.ash-dialog-actions')).toHaveCount(0);
		const originalViewport = page.viewportSize();
		if (!originalViewport) throw new Error('Browser test requires a viewport');
		await page.setViewportSize({ width: 540, height: 500 });
		const narrowSidebarBounds = await sidebar.boundingBox();
		const narrowPageBounds = await settingsPage.boundingBox();
		expect(narrowSidebarBounds).not.toBeNull();
		expect(narrowPageBounds).not.toBeNull();
		expect(narrowSidebarBounds!.y + narrowSidebarBounds!.height).toBeLessThanOrEqual(narrowPageBounds!.y + 1);
		await expect(settings.getByRole('searchbox', { name: 'Search settings' })).toBeVisible();
		await page.setViewportSize(originalViewport);
	});

	test('settings categories, localization icons and search display their own contents', async ({ page }) => {
		const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
		const settingsPage = settings.locator('.ash-sessions-settings-page');
		const navigation = settings.getByRole('navigation', { name: 'Settings categories' });
		for (const [section, categories] of [
			['Basics', ['General', 'Account', 'Appearance', 'Customize']],
			['Development', ['Agents', 'Design', 'Models', 'Git & PRs', 'Worktree', 'Browser', 'Tab', 'Code Intelligence', 'Environment']],
			['Management', ['Keyboard Shortcuts', 'Archived Chats']],
		] as const) {
			const group = navigation.getByRole('group', { name: section });
			for (const category of categories) {
				await expect(group.getByRole('button', { name: category, exact: true }).locator('svg.ash-icon')).toHaveCount(1);
			}
		}
		await expect(navigation.getByRole('button', { name: 'Tab', exact: true }).locator('svg')).toHaveAttribute('data-ash-icon-id', 'keyboard-tab');
		await expect(navigation.getByRole('button', { name: 'Customize' }).locator('svg')).toHaveAttribute('data-ash-icon-id', 'briefcase');
		await expect(navigation.getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page');
		await expect(navigation.getByRole('button', { name: 'General' })).toHaveCSS('background-color', 'rgb(240, 240, 240)');
		await expect(settings.getByRole('heading', { name: 'General' })).toBeVisible();
		await expect(settings.locator('[data-configuration-key="accessibility.verbosity.sessionsActivityBar"]')).toBeVisible();
		await expect(settings.locator('[data-configuration-key="accessibility.verbosity.sessionsSettings"]')).toBeVisible();
		await navigation.getByRole('button', { name: 'Appearance' }).click();
		await expect(settings.getByRole('heading', { name: 'Appearance' })).toBeVisible();
		await expect(settings.locator('[data-configuration-key="sessions.layoutStyle"]')).toBeVisible();
		await expect(settings.locator('[data-configuration-key="sessions.activityBar.location"]')).toBeVisible();
		await expect(settings.locator('[data-configuration-key="sessions.activityBar.compact"]')).toBeVisible();
		await navigation.getByRole('button', { name: 'General' }).click();
		await expect(settings.getByRole('heading', { name: 'General' })).toBeVisible();
		await navigation.getByRole('button', { name: 'Archived Chats' }).click();
		await expect(settingsPage.getByRole('heading')).toHaveCount(0);
		await expect(settingsPage.locator('.ash-configuration-setting')).toHaveCount(0);
		await expect(settings.getByText('No settings found.')).toBeHidden();
		await navigation.getByRole('button', { name: 'Appearance' }).click();
		await expect(settings.getByRole('heading', { name: 'Appearance' })).toBeVisible();
		await expect(settings.locator('[data-configuration-key="workbench.layoutStyle"]')).toHaveCount(0);
		const searchSettings = settings.getByRole('searchbox', { name: 'Search settings' });
		await expect(settings.locator('.ash-sessions-settings-search svg[data-ash-icon-id="search"]')).toBeVisible();
		await searchSettings.fill('layout');
		await expect(settings.getByRole('heading', { name: 'Search results' })).toBeVisible();
		await expect(settings.locator('.ash-configuration-setting')).toHaveCount(1);
		await searchSettings.fill('unmatched-setting');
		await expect(settings.getByText('No settings found.')).toBeVisible();
		await navigation.getByRole('button', { name: 'Appearance' }).click();
	});

	test('dictation settings switch between local models and API connections', async ({ page }) => {
		const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
		const navigation = settings.getByRole('navigation', { name: 'Settings categories' });
		await expect(settings.locator('[data-configuration-key="dictation.backend"]')).toBeVisible();
		await expect(settings.getByRole('grid', { name: 'Local dictation models' })).toBeVisible();
		await expect(settings.locator('[data-configuration-key="dictation.cloudProvider"]')).toHaveCount(0);
		const dictationBackend = settings.locator('[data-configuration-key="dictation.backend"]').getByRole('combobox');
		const originalDictationBackend = (await dictationBackend.textContent())!.trim();
		const changedDictationBackend = originalDictationBackend === 'Local' ? 'Cloud' : 'Local';
		await dictationBackend.click();
		await page.getByRole('option', { name: changedDictationBackend }).click();
		await expect(dictationBackend).toHaveText(changedDictationBackend);
		await expect(settings.locator('[data-configuration-key="dictation.cloudProvider"]')).toBeVisible();
		await expect(settings.getByRole('grid', { name: 'Local dictation models' })).toHaveCount(0);
		await settings.getByRole('button', { name: 'Manage API connections' }).click();
		await expect(settings.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();
		await navigation.getByRole('button', { name: 'General' }).click();
		await dictationBackend.click();
		await page.getByRole('option', { name: originalDictationBackend }).click();
	});

	test('layout style retains icon sizes and closing settings restores Accounts focus', async ({ page }) => {
		const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
		const activityBar = page.locator('[data-part="activitybar"]');
		const activityNavigation = page.locator('.ash-sessions-activity-content');
		const accounts = page.getByRole('button', { name: 'Accounts', exact: true });
		await settings.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Appearance' }).click();
		const layoutStyle = settings.locator('[data-configuration-key="sessions.layoutStyle"]').getByRole('combobox');
		const originalLayoutStyle = (await layoutStyle.textContent())!.trim();
		const changedLayoutStyle = originalLayoutStyle === 'Flat' ? 'Modern' : 'Flat';
		await layoutStyle.click();
		await page.getByRole('option', { name: changedLayoutStyle }).click();
		await expect(layoutStyle).toHaveText(changedLayoutStyle);
		await expectActivityIconSize(activityNavigation, 24);
		await layoutStyle.click();
		await page.getByRole('option', { name: originalLayoutStyle }).click();
		await page.keyboard.press('Escape');
		await expect(settings).toHaveCount(0);
		await expect(accounts).toBeFocused();
	});

});

test('Activity Bar compact and horizontal menus preserve icon geometry and account ownership', async ({ page }) => {
	const activityBar = page.locator('[data-part="activitybar"]');
	const activityNavigation = page.locator('.ash-sessions-activity-content');
	const chatButton = activityBar.locator('button').first();
	const buttonBounds = await chatButton.boundingBox();
	const iconBounds = await chatButton.locator('svg').boundingBox();
	expect(buttonBounds).not.toBeNull();
	expect(iconBounds).not.toBeNull();
	expect(buttonBounds!.width).toBe(36);
	expect(buttonBounds!.height).toBe(36);
	expect(iconBounds!.width).toBe(24);
	expect(iconBounds!.height).toBe(24);
	const collaborationIcon = activityBar.locator('button svg[data-ash-icon-id="colab"]');
	await expect(collaborationIcon).toHaveCSS('width', '24px');
	expect(Math.abs(iconBounds!.x + iconBounds!.width / 2 - (buttonBounds!.x + buttonBounds!.width / 2))).toBeLessThanOrEqual(1);
	expect(Math.abs(iconBounds!.y + iconBounds!.height / 2 - (buttonBounds!.y + buttonBounds!.height / 2))).toBeLessThanOrEqual(1);
	await chatButton.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Size' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Compact' }).click();
	await expect.poll(() => chatButton.evaluate(button => button.getBoundingClientRect().width)).toBe(28);
	await expect(collaborationIcon).toHaveCSS('width', '16px');
	await expectActivityIconSize(activityNavigation, 16);
	await expect.poll(() => activityBar.evaluate(bar => bar.getBoundingClientRect().width)).toBe(36);
	await chatButton.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Top' }).click();
	await expect(activityBar).toBeHidden();
	const topHost = page.locator('.ash-sessions-activity-host.top');
	await expect(topHost).toBeVisible();
	await expectActivityIconSize(activityNavigation, 16, true);
	const titlebarAccounts = page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Accounts', exact: true });
	await titlebarAccounts.press('Enter');
	await expect(titlebarAccounts).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByRole('menuitem', { name: 'Settings', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(titlebarAccounts).toHaveAttribute('aria-expanded', 'false');
	await expect(topHost.locator('button').first()).toHaveAttribute('aria-label', /Chat/);
	await topHost.locator('button').first().click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Bottom' }).click();
	await expect(page.locator('.ash-sessions-activity-host.bottom')).toBeVisible();
	await expect(topHost).toBeHidden();
	await expectActivityIconSize(activityNavigation, 16, true);
	await page.locator('.ash-sessions-activity-host.bottom button').first().click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Default' }).click();
	await expect(activityBar).toBeVisible();
	await expect.poll(() => activityBar.evaluate(bar => bar.getBoundingClientRect().width)).toBe(36);
	await expectActivityIconSize(activityNavigation, 16);
	await chatButton.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Size' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Default' }).click();
	await expectActivityIconSize(activityNavigation, 24);
	await chatButton.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Top' }).click();
	await expect(topHost).toBeVisible();
	await expectActivityIconSize(activityNavigation, 16, true);
	await topHost.locator('button').first().click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Bottom' }).click();
	const bottomHost = page.locator('.ash-sessions-activity-host.bottom');
	await expect(bottomHost).toBeVisible();
	await expectActivityIconSize(activityNavigation, 16, true);
	await titlebarAccounts.press('Shift+F10');
	await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Default' }).click();
	await expectActivityIconSize(activityNavigation, 24);
	await chatButton.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Hidden' }).click();
	await expect(page.locator('.ash-sessions-activity-host.bottom')).toBeHidden();
	await expect(activityBar).toBeHidden();
});

test('Sessions titlebar reserves its dimensions and orders component actions', async ({ page }) => {
	const titlebar = page.locator("[data-part='titlebar']");
	await expect(titlebar).toBeVisible();
	await expect(titlebar.getByRole('button', { name: 'Return to Workbench' })).toHaveCount(0);
	await expect(titlebar.locator('.ash-sessions-titlebar-title, .ash-sessions-titlebar-avatar')).toHaveCount(0);
	const titlebarActions = titlebar.getByRole('toolbar', { name: 'Title bar left actions', exact: true });
	await expect(titlebarActions).toBeVisible();
	const titlebarButtons = titlebarActions.getByRole('button');
	const expectedTitlebarActions = ['Application menu', 'Hide sidebar', 'Back', 'Forward'];
	await expect(titlebarButtons).toHaveCount(expectedTitlebarActions.length);
	const activityNavigation = page.locator('.ash-sessions-activity-content');
	await expect(titlebar.getByRole('navigation', { name: 'Chat and Code' })).toHaveCount(0);
	await expect(activityNavigation.getByRole('button', { name: 'Chat' }).locator('svg')).toHaveAttribute('data-ash-icon-id', 'chat-2-filled');
	await expect(activityNavigation.getByRole('button', { name: 'Code' }).locator('svg')).toHaveAttribute('data-ash-icon-id', 'code');
	await expect(page.locator('.ash-sessions-sidebar-tabs')).toHaveCount(0);
	const titlebarActionNames = await titlebarButtons.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
	expect(titlebarActionNames).toEqual(expectedTitlebarActions);
	await expect(titlebar).toHaveCSS('height', '35px');
	await expect(titlebar).toHaveCSS('border-bottom-width', '0px');
	const titlebarBounds = await titlebar.boundingBox();
	const buttonBounds = await titlebarButtons.evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().toJSON()));
	expect(buttonBounds.every((button, index) => button.right < titlebarBounds!.x + titlebarBounds!.width / 2 && (index === 0 || button.left > buttonBounds[index - 1].left))).toBe(true);
});

test('Sessions titlebar colors resolve under light and dark themes', async ({ page }) => {
	for (const [id, color] of [['ash-dark', '#1e1e1e'], ['ash-light', '#ffffff']]) {
		await page.evaluate(id => window.ashSessionsIntegration.setTheme(id), id!);
		await expect.poll(() => page.locator('#app').evaluate(element => getComputedStyle(element).getPropertyValue('--ash-titleBar-background').trim())).toBe(color);
	}
});


test('Sessions navigation geometry centers icons and enables the component actions', async ({ page }) => {
	await expect(page.locator("[data-part='activitybar']")).toBeVisible();
	const activityButtons = page.locator("[data-part='activitybar'] button");
	expect(await activityButtons.locator('svg').evaluateAll(icons => icons.map(icon => icon.getAttribute('data-ash-icon-id')))).toEqual(['chat-2-filled', 'colab', 'projects', 'code', 'symbol-color', 'agent', 'account']);
	await expect(page.locator('.ash-sessions-activity-bottom button')).toHaveCount(1);
	const chatButton = activityButtons.first();
	const chatButtonBounds = await chatButton.boundingBox();
	const chatIconBounds = await chatButton.locator('svg').boundingBox();
	expect(chatButtonBounds).not.toBeNull();
	expect(chatIconBounds).not.toBeNull();
	expect(chatButtonBounds!.width).toBe(36);
	expect(chatButtonBounds!.height).toBe(36);
	expect(Math.abs(chatIconBounds!.x + chatIconBounds!.width / 2 - (chatButtonBounds!.x + chatButtonBounds!.width / 2))).toBeLessThanOrEqual(1);
	expect(Math.abs(chatIconBounds!.y + chatIconBounds!.height / 2 - (chatButtonBounds!.y + chatButtonBounds!.height / 2))).toBeLessThanOrEqual(1);
	await expect(activityButtons.nth(1)).toBeEnabled();
	await expect(activityButtons.nth(2)).toBeEnabled();
	await expect(activityButtons.nth(3)).toBeEnabled();
});
