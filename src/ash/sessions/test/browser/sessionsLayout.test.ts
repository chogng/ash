import { expect, type Locator, type Page } from '@playwright/test';
import { EditorGroup } from '../../../../../test/automation/editors.js';
import { QuickAccess } from '../../../../../test/automation/quickaccess.js';
import { StorageTarget } from '../../../platform/storage/common/storage.js';
import { suite, test, setup, teardown } from 'mocha';
import { useBrowserTests } from '../../../../../test/unit/browser/context.js';

suite('sessions browser component', () => {
	const browserTests = useBrowserTests();
	const runtimeErrors = new WeakMap<Page, string[]>();

	async function expandSidebarForHistory(page: Page): Promise<void> {
		const sidebar = (await page.locator('[data-part="sidebar"]').boundingBox())!;
		for (const sash of await page.getByRole('separator').all()) {
			const bounds = await sash.boundingBox();
			if (!bounds || bounds.height < 200 || Math.abs(bounds.x - sidebar.x - sidebar.width) > 8) continue;
			await sash.focus();
			for (let step = 0; step < 20; step++) await sash.press('ArrowRight');
			break;
		}
		await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
	}

	async function expectActivityIconSize(navigation: Locator, size: number, horizontal = false): Promise<void> {
		await expect.poll(() => navigation.evaluate(element => element.classList.contains('horizontal'))).toBe(horizontal);
		const labeled = await navigation.evaluate(element => element.classList.contains('labeled'));
		await expect(navigation).not.toHaveClass(/compact/);
		await expect(navigation).toHaveCSS('display', 'flex');
		await expect(navigation).toHaveCSS('justify-content', 'space-between');
		await expect.poll(() => navigation.evaluate(element => getComputedStyle(element).flexDirection === (element.classList.contains('horizontal') ? 'row' : 'column'))).toBe(true);
		const icons = navigation.locator('button .ash-icon-label-icon');
		const itemSize = horizontal ? 24 : 36;
		for (const item of await navigation.locator('.ash-composite-bar-navigation-item > button').all()) {
			if (labeled) { expect((await item.boundingBox())!.width).toBeGreaterThan(itemSize); }
			else { await expect(item).toHaveCSS('width', `${itemSize}px`); }
			await expect(item).toHaveCSS('height', `${itemSize}px`);
		}
		await expect(icons).toHaveCount(horizontal || labeled ? 3 : 4);
		const accounts = navigation.page().getByRole('button', { name: 'Accounts', exact: true });
		await expect(accounts).toHaveCount(1);
		const titlebarAccounts = navigation.page().locator('[data-part="titlebar"]').getByRole('button', { name: 'Accounts', exact: true });
		await expect(titlebarAccounts).toHaveCount(horizontal ? 1 : 0);
		if (horizontal) {
			await expect(navigation.getByRole('button', { name: 'Accounts', exact: true })).toHaveCount(0);
			await expect(titlebarAccounts.locator('.ash-icon')).toHaveCSS('width', '16px');
			await expect(titlebarAccounts.locator('.ash-icon')).toHaveCSS('height', '16px');
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
			if (!labeled) { expect(bounds.x).toBeLessThanOrEqual(1); }
			expect(bounds.y).toBeLessThanOrEqual(1);
		}
	}


	setup(async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		const consoleErrors: string[] = [];
		runtimeErrors.set(page, consoleErrors);
		page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/sessions.html');
		await expect.poll(async () => ({ ready: await page.locator('body').getAttribute('data-ready'), errors })).toEqual({ ready: 'true', errors: [] });
	});

	teardown(async function () {
		const { page } = browserTests;

		await expect.poll(() => page.evaluate(() => ({ errors: window.ashSessionsIntegration.errors, details: window.ashSessionsIntegration.errorDetails }))).toEqual({ errors: [], details: [] });
		expect(runtimeErrors.get(page)).toEqual([]);
	});

	test('Sessions navigation icons and surface controls follow the selected component', async function () {
		const { page } = browserTests;
		const activityBar = page.locator('[data-part="activitybar"]');
		await expect(activityBar).toHaveCount(0);
		await expect(page.locator('.ash-workbench-activitybar, .ash-activity-bar-content')).toHaveCount(0);
		const activityNavigation = page.locator('.ash-sessions-activity-content');
		await expectActivityIconSize(activityNavigation, 16);
		await expect(activityNavigation.getByRole('button', { name: 'New' }).locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'add');
		await expect(activityNavigation.getByRole('button', { name: 'New' })).toHaveAttribute('aria-current', 'page');
		await expect(page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code' }).locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'code');
		await expect(page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code' })).not.toHaveAttribute('aria-pressed', 'true');
		await expect(page.locator('.ash-sessions-sidebar-tabs')).toHaveCount(0);
		await page.mouse.move(400, 180);
		await expect(page.getByRole('button', { name: 'Hide sidebar' })).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(activityNavigation.locator('.ash-sessions-activity-top button .ash-icon').first()).toHaveAttribute('data-ash-icon-id', 'add');
		const collaboration = activityNavigation.getByRole('button', { name: 'Collab' });
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		const projects = activityNavigation.getByRole('button', { name: 'Projects' });
		const chat = activityNavigation.getByRole('button', { name: 'New' });
		await collaboration.click();
		await expect(collaboration.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'collab');
		await expect(collaboration).toHaveAttribute('aria-current', 'page');
		await expect(page.locator('.ash-sessions-list-controls')).toBeHidden();
		await expect(page.locator('.ash-sessions-surface-header')).toHaveCount(0);
		await expect(page.locator('[data-part="auxiliarybar"] h2')).toBeHidden();
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
		await expect(projects.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'projects');
		await projects.click();
		await expect(activityNavigation.locator('[data-action-id="sessions.open.projects"] button')).toHaveAttribute('aria-current', 'page');
		await expect(activityNavigation).toBeVisible();
		await expect(activityBar).toHaveCount(0);
		await expect(collaboration).toHaveCount(0);
		await expect(page.locator('.ash-window-mode-control')).toBeVisible();
		await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
		await expect(activityNavigation).toBeHidden();
		await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
		await expect(projects).toHaveAttribute('aria-current', 'page');
		await expect(page.locator('.ash-projects')).toBeVisible();
		await chat.click();
		await expect(chat).toHaveAttribute('aria-current', 'page');
		await expect(page.locator('.ash-sessions-list-controls')).toBeVisible();
		await expect(page.locator('.ash-sessions-surface-header')).toHaveCount(0);
		await expect(chat).toHaveCSS('background-color', 'rgb(240, 240, 240)');
		await expect(page.locator('.ash-sessions-list-item.selected').first()).toHaveCSS('background-color', 'rgb(240, 240, 240)');
		for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
			await page.evaluate(theme => window.ashSessionsIntegration.setTheme(theme), theme);
			await chat.click();
			await page.mouse.move(400, 180);
			const background = await chat.evaluate(button => getComputedStyle(button).backgroundColor);
			await chat.hover();
			await expect(chat).toHaveCSS('background-color', background);
			await projects.hover();
			await expect(projects).not.toHaveAttribute('aria-current');
			await chat.focus();
			await chat.press('ArrowDown');
			await expect(chat).not.toBeFocused();
			await expect(chat).toHaveAttribute('aria-current', 'page');
			if (theme.includes('high-contrast')) {
				await expect(chat).toHaveCSS('outline-style', 'solid');
				await expect(projects).toHaveCSS('outline-style', 'solid');
				await expect(activityNavigation.locator('button:focus')).toHaveCSS('outline-style', 'solid');
			}
			await projects.click();
			const surface = page.locator('.ash-projects');
			await expect(surface).toBeVisible();
			await expect(surface).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			expect(await surface.evaluate(element => getComputedStyle(element).color !== getComputedStyle(element).backgroundColor)).toBe(true);
			if (!await surface.getByRole('searchbox').isVisible()) {
				await surface.getByRole('button', { name: 'Search projects', exact: true }).click();
			}
			await surface.getByRole('searchbox').focus();
			await expect(surface.getByRole('searchbox')).toHaveCSS('outline-style', 'solid');
			await expect(activityNavigation).toBeVisible();
		}
	});

	suite('Sessions settings components', () => {
		setup(async function () {
			const { page } = browserTests;

			const accounts = page.getByRole('button', { name: 'Accounts', exact: true });
			await expect(accounts.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'account');
			await accounts.click();
			await expect(accounts).toHaveAttribute('aria-expanded', 'true');
			await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
		});

		test('layout scope uses the shared settings owner and persists through window recreation', async function () {
			const { page } = browserTests;
			const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
			await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
			const scope = settings.locator('[data-configuration-key="sessions.experimental.layoutScope"]').getByRole('combobox');
			await expect(scope).toHaveText('Session');
			await scope.click();
			await page.getByRole('option', { name: 'Chat', exact: true }).click();
			await expect(scope).toHaveText('Chat');
			await expect(scope).toBeEnabled();
			await page.evaluate(() => window.ashSessionsIntegration.updateConfiguration('sessions.experimental.layoutScope', 'chat-shared'));
			await expect(scope).toHaveText('Chat, shared visibility');
			await page.evaluate(() => window.ashSessionsIntegration.remountAfterDirectDispose());
			await page.getByRole('button', { name: 'Accounts', exact: true }).click();
			await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
			await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
			await expect(scope).toHaveText('Chat, shared visibility');
		});

		test('settings cards and responsive panes preserve their geometry', async function () {
			const { page } = browserTests;
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

		test('settings categories, localization icons and search display their own contents', async function () {
			const { page } = browserTests;
			const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
			const settingsPage = settings.locator('.ash-sessions-settings-page');
			const navigation = settings.getByRole('navigation', { name: 'Settings categories' });
			for (const [section, categories] of [
				['Basics', ['General', 'Account', 'Appearance', 'Customize']],
				['Development', ['Agents', 'Design', 'Models', 'Git & PRs', 'Browser', 'Tab', 'Code Intelligence', 'Environment']],
				['Management', ['Keyboard Shortcuts']],
			] as const) {
				const group = navigation.getByRole('group', { name: section });
				for (const category of categories) {
					await expect(group.getByRole('button', { name: category, exact: true }).locator('.ash-icon')).toHaveCount(1);
				}
			}
			await expect(navigation.getByRole('button', { name: 'Tab', exact: true }).locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'keyboard-tab');
			await expect(navigation.getByRole('button', { name: 'Customize' }).locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'briefcase');
			await expect(navigation.getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page');
			await expect(navigation.getByRole('button', { name: 'General' })).toHaveCSS('background-color', 'rgb(240, 240, 240)');
			await expect(settings.getByRole('heading', { name: 'General' })).toBeVisible();
			await expect(settings.locator('[data-configuration-key="accessibility.verbosity.sessionsActivityBar"]')).toBeVisible();
			await expect(settings.locator('[data-configuration-key="accessibility.verbosity.sessionsSettings"]')).toBeVisible();
			await navigation.getByRole('button', { name: 'Appearance' }).click();
			await expect(settings.getByRole('heading', { name: 'Appearance' })).toBeVisible();
			await expect(settings.locator('[data-configuration-key="sessions.layoutStyle"]')).toBeVisible();
			await expect(settings.locator('[data-configuration-key="sessions.activityBar.location"]')).toBeVisible();
			await expect(settings.locator('[data-configuration-key="sessions.activityBar.compact"]')).toHaveCount(0);
			await navigation.getByRole('button', { name: 'General' }).click();
			await expect(settings.getByRole('heading', { name: 'General' })).toBeVisible();
			await expect(navigation.getByRole('button', { name: 'Archived Chats', exact: true })).toHaveCount(0);
			await expect(navigation.getByRole('button', { name: 'Worktree', exact: true })).toHaveCount(0);
			await navigation.getByRole('button', { name: 'Keyboard Shortcuts', exact: true }).click();
			await expect(settingsPage.getByRole('heading', { name: 'Keyboard Shortcuts' }).first()).toBeVisible();
			await expect(settingsPage.getByRole('button', { name: 'Keyboard Shortcuts', exact: true })).toBeVisible();
			await expect(settingsPage.getByRole('button', { name: 'Preferences: Open Keyboard Shortcuts (JSON)', exact: true })).toBeVisible();
			await navigation.getByRole('button', { name: 'Appearance' }).click();
			await expect(settings.getByRole('heading', { name: 'Appearance' })).toBeVisible();
			await expect(settings.locator('[data-configuration-key="workbench.layoutStyle"]')).toHaveCount(0);
			const searchSettings = settings.getByRole('searchbox', { name: 'Search settings' });
			await expect(settings.locator('.ash-sessions-settings-search [data-ash-icon-id="search"]')).toBeVisible();
			await searchSettings.fill('layout');
			await expect(settings.getByRole('heading', { name: 'Search results' })).toBeVisible();
			await expect(settings.locator('.ash-configuration-setting')).toHaveCount(2);
			await expect(settings.locator('[data-settings-item-id="sessions.experimental.layoutScope"]')).toBeVisible();
			await searchSettings.fill('unmatched-setting');
			await expect(settings.getByText('No settings found.')).toBeVisible();
			await navigation.getByRole('button', { name: 'Appearance' }).click();
		});

		test('layout style retains icon sizes and closing settings restores Accounts focus', async function () {
			const { page } = browserTests;
			const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
			const activityNavigation = page.locator('.ash-sessions-activity-content');
			const accounts = page.getByRole('button', { name: 'Accounts', exact: true });
			await settings.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Appearance' }).click();
			const layoutStyle = settings.locator('[data-configuration-key="sessions.layoutStyle"]').getByRole('combobox');
			const originalLayoutStyle = (await layoutStyle.textContent())!.trim();
			const changedLayoutStyle = originalLayoutStyle === 'Flat' ? 'Modern' : 'Flat';
			await layoutStyle.click();
			await page.getByRole('option', { name: changedLayoutStyle }).click();
			await expect(layoutStyle).toHaveText(changedLayoutStyle);
			await expectActivityIconSize(activityNavigation, 16);
			await layoutStyle.click();
			await page.getByRole('option', { name: originalLayoutStyle }).click();
			await page.keyboard.press('Escape');
			await expect(settings).toHaveCount(0);
			await expect(accounts).toBeFocused();
		});

	});

	test('Activity Bar uses fixed sizes across positions and preserves account ownership', async function () {
		const { page } = browserTests;
		const activityBar = page.locator('[data-part="activitybar"]');
		const activityNavigation = page.locator('.ash-sessions-activity-content');
		const chatButton = activityNavigation.locator('button').first();
		const buttonBounds = await chatButton.boundingBox();
		const iconBounds = await chatButton.locator('.ash-icon-label-icon').boundingBox();
		expect(buttonBounds).not.toBeNull();
		expect(iconBounds).not.toBeNull();
		expect(buttonBounds!.width).toBeGreaterThan(36);
		expect(buttonBounds!.height).toBe(36);
		expect(iconBounds!.width).toBe(16);
		expect(iconBounds!.height).toBe(16);
		const projectsIcon = activityNavigation.locator('button .ash-icon-label-icon:has(> [data-ash-icon-id="projects"])');
		await expect(projectsIcon).toHaveCSS('width', '16px');
		expect(Math.abs(iconBounds!.y + iconBounds!.height / 2 - (buttonBounds!.y + buttonBounds!.height / 2))).toBeLessThanOrEqual(1);
		await chatButton.click({ button: 'right' });
		await expect(page.getByRole('menuitem', { name: 'Activity Bar Size' })).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expect(chatButton).toHaveCSS('height', '36px');
		await expect(projectsIcon).toHaveCSS('width', '16px');
		await expectActivityIconSize(activityNavigation, 16);
		await expect(activityBar).toHaveCount(0);
		await chatButton.click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
		await page.getByRole('menuitemcheckbox', { name: 'Top' }).click();
		await expect(activityBar).toHaveCount(0);
		const topHost = page.locator('.ash-sessions-activity-host.top');
		await expect(topHost).toBeVisible();
		await expectActivityIconSize(activityNavigation, 16, true);
		const titlebarAccounts = page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Accounts', exact: true });
		await titlebarAccounts.press('Enter');
		await expect(titlebarAccounts).toHaveAttribute('aria-expanded', 'true');
		await expect(page.getByRole('menuitem', { name: 'Settings', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(titlebarAccounts).toHaveAttribute('aria-expanded', 'false');
		await expect(topHost.locator('button').first()).toHaveAttribute('aria-label', /New/);
		await topHost.locator('button').first().click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
		await page.getByRole('menuitemcheckbox', { name: 'Bottom' }).click();
		await expect(page.locator('.ash-sessions-activity-host.bottom')).toBeVisible();
		await expect(topHost).toBeHidden();
		await expectActivityIconSize(activityNavigation, 16, true);
		await page.locator('.ash-sessions-activity-host.bottom button').first().click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
		await page.getByRole('menuitemcheckbox', { name: 'Default' }).click();
		await expect(activityBar).toHaveCount(0);
		await expectActivityIconSize(activityNavigation, 16);
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
		await expectActivityIconSize(activityNavigation, 16);
		await chatButton.click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
		await page.getByRole('menuitemcheckbox', { name: 'Hidden' }).click();
		await expect(page.locator('.ash-sessions-activity-host.bottom')).toBeHidden();
		await expect(activityBar).toHaveCount(0);
	});

	test('Sessions titlebar reserves its dimensions and orders component actions', async function () {
		const { page } = browserTests;
		await expandSidebarForHistory(page);
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
		await expect(activityNavigation.getByRole('button', { name: 'New' }).locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'add');
		await expect(page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code' }).locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'code');
		await expect(page.locator('.ash-sessions-sidebar-tabs')).toHaveCount(0);
		const titlebarActionNames = await titlebarButtons.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
		expect(titlebarActionNames).toEqual(expectedTitlebarActions);
		await expect(titlebar).toHaveCSS('height', '35px');
		await expect(titlebar).toHaveCSS('border-bottom-width', '0px');
		await expect(titlebar.locator('.ash-workbench-part-content')).toHaveCSS('padding-left', '8px');
		const titlebarBounds = await titlebar.boundingBox();
		const buttonBounds = await titlebarButtons.evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().toJSON()));
		expect(buttonBounds.every((button, index) => button.right < titlebarBounds!.x + titlebarBounds!.width / 2 && (index === 0 || button.left > buttonBounds[index - 1].left))).toBe(true);
	});

	test('Sessions titlebar colors resolve under light and dark themes', async function () {
		const { page } = browserTests;
		for (const [id, color] of [['ash-dark', '#1e1e1e'], ['ash-light', '#ffffff']]) {
			await page.evaluate(id => window.ashSessionsIntegration.setTheme(id), id!);
			await expect.poll(() => page.locator('#app').evaluate(element => getComputedStyle(element).getPropertyValue('--ash-titleBar-background').trim())).toBe(color);
		}
	});


	for (const locale of ['en', 'zh-CN']) test(`Sessions collapsed sidebar hides all navigation and gives its width to the conversation (${locale})`, async function () {
		const { page } = browserTests;
		await page.goto(`/sessions.html?locale=${locale}`);
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		const chinese = locale === 'zh-CN';
		const toggle = page.locator('[data-action-id="ash.sessions.toggleSidebar"] button');
		const sidebar = page.locator('[data-part="sidebar"]');
		const sessions = page.locator('[data-part="sessions"]');
		const navigation = page.locator('.ash-sessions-activity-content');
		const accounts = page.locator('.ash-sessions-activity-bottom');
		const modes = page.locator('.ash-window-mode-control');
		await expect(modes).toBeVisible();
		const sidebarWidth = (await sidebar.boundingBox())!.width;
		const expanded = (await sessions.boundingBox())!;
		await toggle.click();
		await expect(sidebar).toBeHidden();
		await expect(page.locator('[data-part="activitybar"]')).toHaveCount(0);
		await expect(navigation).toBeHidden();
		await expect(accounts).toBeHidden();
		await expect(modes).toBeHidden();
		await expect(page.getByRole('toolbar', { name: chinese ? '界面模式' : 'Workspace mode', exact: true })).toHaveCount(0);
		await expect(page.getByRole('button', { name: chinese ? '新建' : 'New', exact: true })).toHaveCount(0);
		await expect(page.getByRole('button', { name: chinese ? '账户' : 'Accounts', exact: true })).toHaveCount(0);
		await expect.poll(async () => Math.round((await sessions.boundingBox())!.width - expanded.width)).toBe(Math.round(sidebarWidth));
		await expect.poll(async () => Math.round((await sessions.boundingBox())!.x)).toBe(0);
		await expect(toggle).toHaveAttribute('aria-label', chinese ? '显示侧边栏' : 'Show sidebar');
		await toggle.focus();
		await toggle.press('Enter');
		await expect(sidebar).toBeVisible();
		await expect(navigation).toBeVisible();
		await expect(modes).toBeVisible();
		await expect(page.getByRole('button', { name: chinese ? '账户' : 'Accounts', exact: true })).toBeVisible();
		if (!chinese) { await expectActivityIconSize(navigation, 16); }
		await expect.poll(async () => Math.round((await sessions.boundingBox())!.width)).toBe(Math.round(expanded.width));
	});
});
