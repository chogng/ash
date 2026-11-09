import { expect, type Locator, type Page } from '@playwright/test';
import { EditorGroup } from '../../../../../test/automation/editors.js';
import { QuickAccess } from '../../../../../test/automation/quickaccess.js';
import { Color } from '../../../base/common/color.js';
import { StorageTarget } from '../../../platform/storage/common/storage.js';
import { lightColorTheme } from '../../../platform/theme/common/colorTheme.js';
import { menuHoverBackground } from '../../../platform/theme/common/colors/menuColors.js';
import { suite, test, setup, teardown } from 'mocha';
import { useBrowserTests } from '../../../../../test/unit/browser/context.js';
import { DOCS_EDITOR_SETTING } from '../../contrib/artifacts/common/creator.js';

suite('sessions browser component', () => {
	const browserTests = useBrowserTests();
	const runtimeErrors = new WeakMap<Page, string[]>();

	for (const locale of ['en', 'zh-CN']) test(`conversation drops stay on their owning host in ${locale}`, async () => {
		const { page } = browserTests;
		await page.goto(`/sessions.html?multiHost&sideThreads&locale=${locale}`);
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		const sidebar = page.locator('.ash-sessions-list:visible');
		const source = (name: string) => sidebar.getByRole('button', { name, exact: true });
		await source('Task from Host A').click();
		const composer = page.locator('.ash-sessions-chat-slot.active form.ash-chat-input-container');
		const input = composer.getByRole('textbox');
		await expect(input).toBeVisible();
		const references = composer.locator('.ash-chat-reference-attachment');
		const otherChat = sidebar.getByRole('treeitem', { name: 'Task from Host A', exact: true })
			.locator('xpath=following-sibling::*[1]')
			.getByRole('button', { name: 'Follow-up chat', exact: true });

		await source('Task from Host A').dragTo(composer);
		await source('Task from Host B').dragTo(composer);
		await expect(references).toHaveCount(0);
		const reads = () => page.evaluate(() => window.ashSessionsIntegration.multiHost!.calls.filter(call => call.method === 'read' && call.threadId === 'side').map(call => call.host));
		expect(await reads()).toEqual([]);

		await otherChat.dragTo(composer);
		const reference = composer.getByRole('button', { name: `${locale === 'zh-CN' ? '打开' : 'Open'} Follow-up chat`, exact: true });
		await expect(reference).toBeVisible();
		await expect(input).toBeFocused();
		expect(await reads()).toEqual(['Host A']);
		await input.press('ControlOrMeta+z');
		await expect(reference).toHaveCount(0);
		await input.press('ControlOrMeta+Shift+z');
		await expect(reference).toBeVisible();
		expect(await reads()).toEqual(['Host A']);

		await input.press('ControlOrMeta+z');
		await composer.getByRole('button', { name: locale === 'zh-CN' ? '添加上下文' : 'Add context', exact: true }).press('Enter');
		const searchLabel = locale === 'zh-CN' ? '搜索附件' : 'Search attachments';
		await page.getByRole('menuitem', { name: searchLabel, exact: true }).click();
		const search = page.getByRole('dialog').getByRole('combobox');
		await expect(search).toHaveAttribute('placeholder', searchLabel);
		await search.fill(locale === 'zh-CN' ? '会话' : 'Sessions');
		await search.press('Enter');
		const picker = page.getByRole('dialog', { name: locale === 'zh-CN' ? '选择会话' : 'Select a session', exact: true });
		await expect(picker.getByRole('option', { name: /Follow-up chat/u })).toHaveCount(1);
		await picker.getByRole('combobox').press('Enter');
		await expect(reference).toBeVisible();
		expect(await reads()).toEqual(['Host A', 'Host A']);
	});


	async function expectActivityIconSize(navigation: Locator, size: number, position: 'default' | 'top' | 'bottom' = 'default'): Promise<void> {
		const horizontal = position !== 'default';
		await expect.poll(() => navigation.evaluate(element => element.classList.contains('horizontal'))).toBe(horizontal);
		const labeled = await navigation.evaluate(element => element.classList.contains('labeled'));
		await expect(navigation).not.toHaveClass(/compact/);
		await expect(navigation).toHaveCSS('display', 'flex');
		await expect(navigation).toHaveCSS('justify-content', 'space-between');
		await expect.poll(() => navigation.evaluate(element => getComputedStyle(element).flexDirection === (element.classList.contains('horizontal') ? 'row' : 'column'))).toBe(true);
		const icons = navigation.locator('.ash-sessions-activity-item > .ash-button-content > .ash-icon-label-icon > .ash-icon');
		const itemWidth = horizontal ? 24 : 36;
		const itemHeight = horizontal ? 24 : 32;
		for (const item of await navigation.locator('.ash-composite-bar-navigation-item > .ash-sessions-activity-item').all()) {
			if (labeled) { expect((await item.boundingBox())!.width).toBeGreaterThan(itemWidth); }
			else { await expect(item).toHaveCSS('width', `${itemWidth}px`); }
			await expect(item).toHaveCSS('height', `${itemHeight}px`);
		}
		await expect(icons).toHaveCount(6);
		const accounts = navigation.page().getByRole('button', { name: 'Accounts', exact: true });
		await expect(accounts).toHaveCount(1);
		const titlebarAccounts = navigation.page().locator('[data-part="titlebar"]').getByRole('button', { name: 'Accounts', exact: true });
		await expect(titlebarAccounts).toHaveCount(position === 'top' ? 1 : 0);
		if (position === 'top') {
			await expect(titlebarAccounts.locator('.ash-icon')).toHaveCSS('width', '18px');
			await expect(titlebarAccounts.locator('.ash-icon')).toHaveCSS('height', '18px');
			await expect(titlebarAccounts).toHaveAttribute('aria-haspopup', 'menu');
		} else {
			await expect(navigation.page().locator('[data-part="sidebar"]').getByRole('button', { name: 'Accounts', exact: true })).toBeVisible();
		}
		for (const icon of await icons.all()) {
			await expect(icon).toHaveCSS('width', `${size}px`);
			await expect(icon).toHaveCSS('height', `${size}px`);
			await expect(icon).toHaveCSS('font-size', `${size}px`);
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
		await page.goto('/sessions.html?catalog');
		await expect.poll(async () => ({ ready: await page.locator('body').getAttribute('data-ready'), errors })).toEqual({ ready: 'true', errors: [] });
	});

	teardown(async function () {
		const { page } = browserTests;

		await expect.poll(() => page.evaluate(() => ({ errors: window.ashSessionsIntegration.errors, details: window.ashSessionsIntegration.errorDetails }))).toEqual({ errors: [], details: [] });
		expect(runtimeErrors.get(page)).toEqual([]);
	});

	test('Artifacts ownership uses navigation tabs and updates the localized results panel', async function () {
		const { page, info } = browserTests;
		await page.goto('/sessions.html?creator&locale=zh-CN');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.evaluate(() => window.ashSessionsIntegration.setTheme('ash-light'));
		await page.locator('.ash-sessions-navigation').getByRole('button', { name: 'Artifacts', exact: true }).click();
		const creator = page.locator('.ash-creator');
		const navigation = creator.locator('.ash-tab-list-navigation');
		const tabs = navigation.getByRole('tablist', { name: '作品归属' });
		const all = tabs.getByRole('tab', { name: '全部', exact: true });
		const yours = tabs.getByRole('tab', { name: '我的', exact: true });
		const shared = tabs.getByRole('tab', { name: '与你共享', exact: true });
		const panel = creator.getByRole('tabpanel');
		await expect(all).toHaveAttribute('aria-selected', 'true');
		await expect(panel).toHaveAccessibleName('全部');
		await expect(shared).toHaveAttribute('aria-controls', (await panel.getAttribute('id'))!);
		await expect(navigation).toHaveCSS('height', '28px');
		await creator.screenshot({ path: info.outputPath('artifacts-filters-zh-CN.png') });

		await all.focus();
		await page.keyboard.press('ArrowRight');
		await expect(yours).toBeFocused();
		await page.keyboard.press('ArrowRight');
		await expect(shared).toBeFocused();
		await expect(all).toHaveAttribute('aria-selected', 'true');
		await page.keyboard.press('Enter');
		await expect(shared).toHaveAttribute('aria-selected', 'true');
		await expect(panel).toHaveAccessibleName('与你共享');
		await expect(panel).toHaveText('暂无与你共享的作品。');
		await yours.click();
		await expect(yours).toHaveAttribute('aria-selected', 'true');
		await expect(panel).toHaveAccessibleName('我的');
	});

	test('Artifacts ActionBar searches, sorts and switches the work results between grid and list', async function () {
		const { page, info } = browserTests;
		await page.goto('/sessions.html?creator&locale=zh-CN');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.evaluate(async setting => {
			await window.ashSessionsIntegration.setTheme('ash-light');
			await window.ashSessionsIntegration.updateConfiguration(setting, 'markdown');
		}, DOCS_EDITOR_SETTING);
		const home = page.locator('.ash-sessions-navigation').getByRole('button', { name: 'Artifacts', exact: true });
		await home.click();
		const creator = page.locator('.ash-creator');
		const actions = creator.getByRole('toolbar', { name: '作品操作' });
		const search = actions.getByRole('button', { name: '搜索作品' });
		const sort = actions.getByRole('button', { name: '反转标题排序' });
		const layout = actions.getByRole('button', { name: '网格布局' });
		const searchInput = actions.getByRole('searchbox', { name: '搜索作品' });
		const closeSearch = actions.getByRole('button', { name: '关闭作品搜索' });
		const panel = creator.getByRole('tabpanel');
		const createTiles = creator.locator('.ash-creator-modes');
		await expect(layout).toHaveAttribute('aria-controls', (await panel.getAttribute('id'))!);
		await expect(layout.locator('[data-ash-icon-id="layout-grid"]')).toBeVisible();
		await layout.hover();
		await expect(page.getByRole('tooltip')).toHaveText('网格布局');
		const empty = panel.getByText(/你的作品将显示在这里/u);
		await expect(empty).toBeVisible();
		expect((await panel.boundingBox())!.height).toBeGreaterThan((await empty.boundingBox())!.height);

		for (let count = 0; count < 2; count++) {
			await createTiles.getByRole('button', { name: '文档', exact: true }).click();
			await expect(creator).toBeHidden();
			await home.click();
		}
		const cards = panel.getByRole('button', { name: '未命名文档' });
		await expect(cards).toHaveCount(2);
		await search.focus();
		await page.keyboard.press('ArrowRight');
		await expect(sort).toBeFocused();
		await sort.press('Enter');
		await expect(sort).toHaveAttribute('aria-pressed', 'true');
		await page.keyboard.press('ArrowRight');
		await expect(layout).toBeFocused();
		await search.click();
		await expect(searchInput).toBeFocused();
		await expect(search).toBeHidden();
		await expect(actions.locator('.ash-toolbar-search-field')).toBeVisible();
		await expect(closeSearch.locator('[data-ash-icon-id="close"]')).toBeVisible();
		await creator.screenshot({ path: info.outputPath('artifacts-search-zh-CN.png') });
		await searchInput.fill('no match');
		await expect(cards).toHaveCount(0);
		await closeSearch.click();
		await expect(search).toHaveAttribute('aria-expanded', 'false');
		await expect(search).toBeFocused();
		await expect(searchInput).toBeHidden();
		await expect(cards).toHaveCount(2);
		await search.press('Enter');
		await expect(searchInput).toHaveValue('');
		await searchInput.press('Escape');
		await expect(search).toBeFocused();
		await expect(layout).toHaveAttribute('aria-pressed', 'true');
		const gridFirst = (await cards.nth(0).boundingBox())!;
		const gridSecond = (await cards.nth(1).boundingBox())!;
		expect(gridFirst.y).toBe(gridSecond.y);
		expect(gridSecond.x).toBeGreaterThan(gridFirst.x);
		const createBounds = await createTiles.boundingBox();
		await creator.screenshot({ path: info.outputPath('artifacts-grid-zh-CN.png') });

		await layout.press('Space');
		await expect(layout).toHaveAttribute('aria-pressed', 'false');
		const listFirst = (await cards.nth(0).boundingBox())!;
		const listSecond = (await cards.nth(1).boundingBox())!;
		expect(listFirst.x).toBe(listSecond.x);
		expect(listSecond.y).toBeGreaterThan(listFirst.y);
		expect(await createTiles.boundingBox()).toEqual(createBounds);
		await creator.screenshot({ path: info.outputPath('artifacts-list-zh-CN.png') });
		await layout.click();
		await expect(layout).toHaveAttribute('aria-pressed', 'true');
		await expect(cards.nth(1)).toHaveCSS('flex-direction', 'column');
	});

	test('update download becomes Restart to Update above Accounts and supports retry', async function () {
		const { page } = browserTests;
		await page.goto('/sessions.html?update&locale=zh-CN');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		const download = page.locator('.ash-sessions-update-status');
		const spinner = download.locator('.ash-loading-spinner');
		const account = page.locator('.ash-sessions-activity-host.bottom');
		await expect(download).toBeHidden();
		await page.evaluate(() => window.ashSessionsIntegration.setUpdateState('downloading'));
		await expect(download.locator('.ash-sessions-update-row')).toHaveText('正在下载更新...');
		await expect(download).toHaveAttribute('role', 'status');
		await expect(spinner).toHaveCSS('inline-size', '18px');
		const statusBounds = (await download.boundingBox())!;
		const accountBounds = (await account.boundingBox())!;
		expect(Math.abs(statusBounds.y + statusBounds.height - accountBounds.y)).toBeLessThan(1);
		expect(Math.abs(statusBounds.x - accountBounds.x)).toBeLessThan(1);
		expect(Math.abs(statusBounds.width - accountBounds.width)).toBeLessThan(1);
		await page.evaluate(() => window.ashSessionsIntegration.updateConfiguration('workbench.reduceMotion', 'on'));
		await expect(spinner).toHaveCSS('animation-name', 'none');
		await page.evaluate(() => window.ashSessionsIntegration.setTheme('ash-high-contrast-dark'));
		await expect(download).toBeVisible();
		await page.evaluate(() => window.ashSessionsIntegration.setUpdateState('ready'));
		const restart = download.getByRole('button', { name: '重启更新', exact: true });
		await expect(restart).toBeEnabled();
		await expect(download.locator('.ash-sessions-update-row')).toBeHidden();
		expect(await download.boundingBox()).toEqual(statusBounds);
		await restart.focus();
		await restart.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashSessionsIntegration.getUpdateInstallCount())).toBe(1);
		await expect(download.getByRole('button', { name: '正在重启...' })).toBeDisabled();
		await page.evaluate(() => window.ashSessionsIntegration.finishUpdateInstall(true));
		await expect(page.locator('.ash-notification-message:visible').filter({ hasText: '无法安装更新。' })).toBeVisible();
		await expect(restart).toBeEnabled();
		await expect(restart).toBeFocused();
		await restart.press('Space');
		await expect.poll(() => page.evaluate(() => window.ashSessionsIntegration.getUpdateInstallCount())).toBe(2);
		await page.evaluate(() => window.ashSessionsIntegration.finishUpdateInstall(false));
		await expect(download.getByRole('button', { name: '正在重启...' })).toBeDisabled();
		await expect(download).toBeVisible();
		await expect(account).toBeVisible();
	});

	test('a newly opened window retains Restart to Update when the update is ready', async function () {
		const { page } = browserTests;
		await page.goto('/sessions.html?update=ready');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await expect(page.getByRole('button', { name: 'Restart to Update', exact: true })).toBeEnabled();
		await expect(page.locator('.ash-sessions-update-status .ash-loading-spinner')).toBeHidden();
	});

	test('Code New hides the draft title and hands off selection to an existing conversation in Chinese', async function () {
		const { page } = browserTests;
		await page.goto('/sessions.html?multiHost&locale=zh-CN&inheritWorkspace');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		const newSession = page.locator('[data-action-id="sessions.newSession"] button');
		const tree = page.locator('.ash-sessions-list:visible').getByRole('tree');
		const row = tree.getByRole('treeitem', { name: 'Task from Host A', exact: true });
		const conversation = row.getByRole('button', { name: 'Task from Host A', exact: true });
		const sessionTitle = page.locator('.ash-sessions-titlebar-widget');
		await page.locator('.ash-window-mode-control').getByRole('button', { name: '代码', exact: true }).click();
		await expect(newSession).toHaveText('新建');
		await newSession.click();
		await expect(newSession).toHaveAttribute('aria-current', 'page');
		await expect(sessionTitle).toBeHidden();
		await row.hover({ position: { x: 2, y: 16 } });
		const transparent = 'rgba(0, 0, 0, 0)';
		await expect(row).not.toHaveCSS('background-color', transparent);
		await expect(conversation).toHaveCSS('background-color', transparent);
		const rowBounds = (await row.boundingBox())!;
		const treeBounds = (await tree.boundingBox())!;
		const trailingInset = await row.evaluate(element => parseFloat(getComputedStyle(element).marginInlineEnd));
		expect(rowBounds.x + rowBounds.width + trailingInset).toBeCloseTo(treeBounds.x + treeBounds.width);
		await row.click({ position: { x: 2, y: 16 } });
		await expect(row).not.toHaveCSS('background-color', transparent);
		await conversation.click();
		await expect(conversation).toHaveAttribute('aria-current', 'page');
		await expect(row).toHaveAttribute('aria-selected', 'true');
		await expect(newSession).not.toHaveAttribute('aria-current');
		await expect(sessionTitle.getByRole('button', { name: '重命名会话（Task from Host A）' })).toBeVisible();
		await expect(sessionTitle.getByRole('button', { name: '更多会话操作' })).toBeVisible();
		await newSession.click();
		await expect(page.locator('.ash-sessions-chat-slot.active .ash-sessions-environment-picker')).toContainText('Host A');
		await expect(page.locator('.ash-sessions-chat-slot.active .ash-sessions-workspace-picker')).toContainText('inherited-project');
	});

	test('Sessions navigation icons and surface controls follow the selected component', async function () {
		const { page } = browserTests;
		const activityBar = page.locator('[data-part="activitybar"]');
		await expect(activityBar).toHaveCount(0);
		await expect(page.locator('.ash-workbench-activitybar, .ash-activity-bar-content')).toHaveCount(0);
		const activityNavigation = page.locator('.ash-sessions-activity-content');
		await expectActivityIconSize(activityNavigation, 18);
		await expect(activityNavigation.getByRole('button', { name: 'New' }).locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'add');
		await expect(activityNavigation.getByRole('button', { name: 'New' })).toHaveAttribute('aria-current', 'page');
		await expect(page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code' }).locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'code');
		await expect(page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code' })).not.toHaveAttribute('aria-pressed', 'true');
		await expect(page.locator('.ash-sessions-sidebar-tabs')).toHaveCount(0);
		await page.mouse.move(400, 180);
		await expect(page.getByRole('button', { name: 'Hide sidebar' })).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(activityNavigation.locator('.ash-sessions-navigation button .ash-icon').first()).toHaveAttribute('data-ash-icon-id', 'add');
		const more = activityNavigation.getByRole('button', { name: 'More', exact: true });
		const collaboration = page.getByRole('menuitemradio', { name: 'Collab', exact: true });
		const codeMode = page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true });
		const chatMode = page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true });
		const buttons = activityNavigation.locator('.ash-sessions-navigation .ash-sessions-activity-item');
		const chatNavigation = ['New', 'Search', 'Projects', 'Artifacts', 'Customize', 'More'];
		await expect(buttons).toHaveText(chatNavigation);
		await codeMode.click();
		await expect(codeMode).toHaveAttribute('aria-pressed', 'true');
		await expect(buttons).toHaveText(['New', 'Search', 'Customize', 'More']);
		await more.press('Enter');
		await expect(page.getByRole('menuitemradio', { name: 'Symphony', exact: true })).toBeVisible();
		await expect(collaboration).toHaveCount(0);
		await page.keyboard.press('Escape');
		await chatMode.click();
		await expect(buttons).toHaveText(chatNavigation);
		const projects = activityNavigation.getByRole('button', { name: 'Projects' });
		const chat = activityNavigation.getByRole('button', { name: 'New' });
		await more.press('Enter');
		await expect(collaboration.locator('[data-ash-icon-id="collab"]')).toBeVisible();
		const menu = page.getByRole('menu').filter({ has: collaboration });
		expect((await menu.boundingBox())!.x).toBeGreaterThanOrEqual((await more.boundingBox())!.x + (await more.boundingBox())!.width);
		await expect(collaboration).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(more).toBeFocused();
		await more.click();
		await expect(menu).toBeFocused();
		await expect(menu.locator('.focused')).toHaveCount(0);
		await page.keyboard.press('ArrowDown');
		await expect(collaboration).toBeFocused();
		await collaboration.click();
		await more.click();
		await expect(collaboration).toHaveAttribute('aria-checked', 'true');
		await expect(collaboration.locator('.ash-menu-leading-slot [data-ash-icon-id="collab"]')).toBeVisible();
		await expect(collaboration.locator('.ash-menu-trailing-check > [data-ash-icon-id="check"]')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.locator('.ash-sessions-list:visible')).toBeHidden();
		await expect(page.locator('.ash-sessions-surface-header')).toHaveCount(0);
		await expect(page.locator('[data-part="auxiliarybar"] h2')).toBeHidden();
		await projects.click();
		await expect(page.locator('.ash-projects')).toBeVisible();
		await expect(chatMode).toHaveAttribute('aria-pressed', 'true');
		await expect(projects.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'projects');
		await projects.click();
		await expect(activityNavigation.locator('[data-action-id="sessions.open.projects"] > .ash-sessions-activity-item')).toHaveAttribute('aria-current', 'page');
		await expect(activityNavigation).toBeVisible();
		await expect(activityBar).toHaveCount(0);
		await expect(more).toBeVisible();
		await expect(page.locator('.ash-window-mode-control')).toBeVisible();
		await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
		await expect(activityNavigation).toBeHidden();
		await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
		await expect(projects).toHaveAttribute('aria-current', 'page');
		await expect(page.locator('.ash-projects')).toBeVisible();
		await chat.click();
		await expect(chat).toHaveAttribute('aria-current', 'page');
		await expect(page.locator('.ash-sessions-list:visible')).toBeVisible();
		await expect(page.locator('.ash-sessions-surface-header')).toHaveCount(0);
		await page.mouse.move(400, 180);
		await expect(chat).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(page.locator('.ash-sessions-list [data-item^="untitled:"]')).toHaveCount(0);
		await page.locator('.ash-sessions-chat-slot.active .ash-chat-input-editor .stanza-editor').getByRole('textbox').focus();
		await page.keyboard.insertText('Navigation draft');
		await expect(chat).not.toHaveAttribute('aria-current');
		const selectedBackground = Color.Format.CSS.formatRGB(lightColorTheme.getColor(menuHoverBackground)!);
		await expect(page.locator('.ash-sessions-list-row.selected:has(> .ash-sessions-list-item[aria-current="page"])').first()).toHaveCSS('background-color', selectedBackground);
		for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
			await page.evaluate(theme => window.ashSessionsIntegration.setTheme(theme), theme);
			await chat.click();
			await page.mouse.move(400, 180);
			const selectedBackground = await chat.evaluate(element => getComputedStyle(element).backgroundColor);
			expect(selectedBackground).not.toBe('rgba(0, 0, 0, 0)');
			if (theme.includes('high-contrast')) await expect(chat).toHaveCSS('outline-style', 'solid');
			await chat.hover();
			await expect(chat).toHaveCSS('background-color', selectedBackground);
			await projects.hover();
			await expect(projects).not.toHaveAttribute('aria-current');
			await chat.focus();
			await chat.press('ArrowDown');
			await expect(chat).not.toBeFocused();
			await expect(chat).toHaveAttribute('aria-current', 'page');
			if (theme.includes('high-contrast')) {
				await expect(projects).toHaveCSS('outline-style', 'solid');
				await expect(activityNavigation.locator('button:focus')).toHaveCSS('outline-style', 'solid');
			}
			await projects.click();
			const surface = page.locator('.ash-projects');
			await expect(surface).toBeVisible();
			if (!await surface.getByRole('searchbox').isVisible()) {
				await surface.getByRole('button', { name: 'Search projects', exact: true }).click();
			}
			await surface.getByRole('searchbox').focus();
			await expect(surface.getByRole('searchbox')).toBeFocused();
			await expect(surface.locator('.ash-toolbar-search-field')).toHaveCSS('border-top-style', 'solid');
			await expect(activityNavigation).toBeVisible();
		}
	});

	test('Product pages show the shared editor area background', async function () {
		const { page } = browserTests;
		const navigation = page.locator('.ash-sessions-activity-content');
		const editorArea = page.locator('.ash-desktop-editor-area');
		const modes = page.locator('.ash-window-mode-control');
		const assertSurface = async (selector: string, theme: string) => {
			const pageSurface = editorArea.locator(selector);
			await expect(pageSurface).toBeVisible();
			const backgroundOwner = await pageSurface.evaluate(element => {
				for (let current: Element | null = element; current; current = current.parentElement) {
					if (getComputedStyle(current).backgroundColor !== 'rgba(0, 0, 0, 0)') {
						return current.classList.contains('ash-desktop-editor-area');
					}
				}
				return false;
			});
			expect(backgroundOwner, `${selector} uses the editor area background in ${theme}`).toBe(true);
			await expect(pageSurface).not.toHaveCSS('color', await editorArea.evaluate(element => getComputedStyle(element).backgroundColor));
		};
		for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
			await page.evaluate(theme => window.ashSessionsIntegration.setTheme(theme), theme);
			for (const [label, selector] of [['Projects', '.ash-projects'], ['Artifacts', '.ash-creator'], ['Customize', '.ash-customize']]) {
				await navigation.getByRole('button', { name: label, exact: true }).click();
				await assertSurface(selector, theme);
			}
			await modes.getByRole('button', { name: 'Code', exact: true }).click();
			await navigation.getByRole('button', { name: 'Bots', exact: true }).click();
			await assertSurface('.ash-bots-page', theme);
			await expect(editorArea.locator('.ash-bots-header')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			if (theme === 'ash-light') {
				const titlebar = await page.locator('.ash-sessions-titlebar').evaluate(element =>
					getComputedStyle(element).getPropertyValue('--ash-sessions-titlebar-background').trim());
				await expect(editorArea).toHaveCSS('background-color', Color.Format.CSS.formatRGB(Color.fromHex(titlebar)));
			}
			await page.locator('.ash-bots-sidebar').getByRole('button', { name: 'Back', exact: true }).click();
			await modes.getByRole('button', { name: 'Chat / Agents', exact: true }).click();
		}
	});

	for (const locale of ['en', 'zh-CN']) test(`Agent Window shortcuts open from Accounts and Settings (${locale})`, async function () {
		const { page, info } = browserTests;
		const chinese = locale === 'zh-CN';
		if (chinese) await page.goto('/sessions.html?catalog&locale=zh-CN');
		const accounts = page.getByRole('button', { name: chinese ? '账户' : 'Accounts', exact: true });
		const label = chinese ? '快捷键' : 'Keyboard Shortcuts';
		await accounts.press('Enter');
		const footer = page.locator('.ash-sessions-sidebar-footer');
		const menu = page.locator('.ash-sessions-sidebar-account-menu');
		const shell = menu.locator('..');
		const expectMenuInsets = async () => {
			await expect(menu).toBeVisible();
			const bounds = (await shell.boundingBox())!;
			const sidebar = (await footer.boundingBox())!;
			expect(Math.round(bounds.x - sidebar.x)).toBe(12);
			expect(Math.round(sidebar.x + sidebar.width - bounds.x - bounds.width)).toBe(12);
			expect(bounds.y + bounds.height).toBeLessThan((await accounts.boundingBox())!.y);
		};
		await expectMenuInsets();
		await page.keyboard.press('Escape');
		await expect(accounts).toBeFocused();
		const width = (await footer.boundingBox())!.width;
		await page.locator('.ash-primary-sidebar-sash').press('ArrowRight');
		await expect.poll(async () => (await footer.boundingBox())!.width).toBeGreaterThan(width);
		await accounts.click();
		await expectMenuInsets();
		await page.screenshot({ path: info.outputPath('sessions-sidebar-account-menu.png') });
		const menuItem = page.getByRole('menuitem', { name: label, exact: true });
		await expect(menuItem.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'record-keys');
		await menuItem.press('Enter');
		const modal = page.getByRole('dialog', { name: chinese ? 'Agent 窗口快捷键' : 'Agent Window Keyboard Shortcuts' });
		const shortcuts = modal.getByRole('region');
		const search = modal.getByRole('searchbox', { name: chinese ? '搜索 Agent 窗口快捷键' : 'Search Agent Window shortcuts' });
		await expect(search).toBeFocused();
		await expect(shortcuts).toHaveCSS('overflow-y', 'auto');
		const headings = shortcuts.getByRole('heading');
		const [left, right] = await Promise.all([headings.nth(0).boundingBox(), headings.nth(1).boundingBox()]);
		expect(right!.x).toBeGreaterThan(left!.x);
		expect(right!.y).toBe(left!.y);
		const viewport = page.viewportSize()!;
		await page.setViewportSize({ width: 600, height: viewport.height });
		const [first, second] = await Promise.all([headings.nth(0).boundingBox(), headings.nth(1).boundingBox()]);
		expect(second!.x).toBe(first!.x);
		expect(second!.y).toBeGreaterThan(first!.y);
		await page.setViewportSize(viewport);
		await expect(shortcuts.getByRole('heading', { name: chinese ? '新建 Code 会话' : 'New Code Conversation' })).toBeVisible();
		const picker = shortcuts.getByRole('listitem').filter({ hasText: chinese ? '聚焦项目选择器' : 'Focus Project Picker' });
		await expect(picker.locator('kbd')).toHaveCount(4);
		for (const [heading, command, keyCount] of chinese ? [
			['会话', '在侧栏中搜索会话', 2],
			['Code 终端', '切换终端', 2],
			['设计画布', '切换到钢笔工具', 1],
			['设计图层', '移动选中的图层 10 像素', 8],
			['设计矢量编辑', '联集', 3],
			['设计文本编辑', '结束文本编辑', 3],
			['设计原型预览', '按页滚动原型预览', 2],
		] as const : [
			['Conversations', 'Search sessions in the sidebar', 2],
			['Terminal in Code', 'Toggle terminal', 2],
			['Design Canvas', 'Switch to the pen tool', 1],
			['Design Layers', 'Move selected layers by ten pixels', 8],
			['Design Vector Editing', 'Union selection', 3],
			['Design Text Editing', 'Finish editing text', 3],
			['Design Prototype Preview', 'Scroll the prototype preview by a page', 2],
		] as const) {
			const group = shortcuts.getByRole('heading', { name: heading, exact: true }).locator('+ ul');
			await expect(group.getByRole('listitem').filter({ hasText: command }).locator('kbd')).toHaveCount(keyCount);
		}
		const designCanvas = shortcuts.getByRole('heading', { name: chinese ? '设计画布' : 'Design Canvas', exact: true }).locator('+ ul');
		await expect(designCanvas.getByRole('listitem').filter({ hasText: chinese ? '保存设计' : 'Save design' }).locator('kbd')).toHaveCount(2);
		await expect(shortcuts.getByText(chinese ? '保存' : 'Save', { exact: true })).toHaveCount(0);
		await shortcuts.getByRole('heading', { name: chinese ? '设计原型预览' : 'Design Prototype Preview' }).scrollIntoViewIfNeeded();
		await expect(search).toBeInViewport();
		await search.fill(chinese ? '切换终端' : 'toggle terminal');
		await expect(shortcuts.getByRole('heading')).toHaveText(chinese ? 'Code 终端' : 'Terminal in Code');
		await expect(shortcuts.getByRole('listitem')).toHaveCount(1);
		await search.fill('primary+k');
		await expect(shortcuts.getByRole('listitem')).toHaveCount(2);
		await search.fill('primary + k primary + f');
		await expect(shortcuts.getByRole('heading')).toHaveText(chinese ? '新建 Code 会话' : 'New Code Conversation');
		await expect(shortcuts.getByRole('listitem')).toHaveCount(1);
		await expect(picker).toBeVisible();
		if ((await picker.locator('kbd').allTextContents()).includes('⌘')) {
			await search.fill('⌘ K ⌘ F');
			await expect(shortcuts.getByRole('listitem')).toHaveCount(1);
			await expect(picker).toBeVisible();
		}
		await search.fill(chinese ? '设计原型预览' : 'design prototype preview');
		await expect(shortcuts.getByRole('heading')).toHaveText(chinese ? '设计原型预览' : 'Design Prototype Preview');
		await expect(shortcuts.getByRole('listitem')).toHaveCount(3);
		await search.fill('Page Up');
		await expect(shortcuts.getByRole('listitem')).toHaveCount(1);
		await search.fill('+');
		await expect(shortcuts.getByRole('listitem')).toHaveCount(1);
		await expect(shortcuts.getByRole('listitem').filter({ hasText: chinese ? '放大' : 'Zoom in' })).toBeVisible();
		await search.fill(chinese ? '拆分编辑器' : 'split editor');
		await expect(shortcuts.getByRole('heading')).toHaveCount(0);
		await expect(shortcuts.getByText(chinese ? '没有符合搜索条件的 Agent 窗口快捷键。' : 'No Agent Window shortcuts match your search.')).toBeVisible();
		await search.press('Escape');
		await expect(search).toBeFocused();
		await expect(search).toHaveValue('');
		await expect(shortcuts.getByRole('heading')).toHaveCount(9);
		await page.keyboard.press('Escape');
		await expect(modal).toHaveCount(0);
		await expect(accounts).toBeFocused();
		await accounts.click();
		await page.getByRole('menuitem', { name: chinese ? '设置' : 'Settings', exact: true }).click();
		const settings = page.locator('.ash-sessions-settings');
		await settings.getByRole('navigation').getByRole('button', { name: label, exact: true }).click();
		await settings.locator('.ash-sessions-settings-page').getByRole('button', { name: label, exact: true }).click();
		await expect(modal).toBeVisible();
		await expect(search).toBeFocused();
		await expect(settings).toHaveCount(0);
		await modal.getByRole('button', { name: chinese ? '关闭' : 'Close', exact: true }).click();
		await expect(modal).toHaveCount(0);
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
			const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
			await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
			const scope = settings.locator('[data-configuration-key="sessions.experimental.layoutScope"]').getByRole('combobox');
			await expect(scope).toHaveText('Session');
			await scope.click();
			await page.getByRole('option', { name: 'Chat', exact: true }).click();
			await expect(scope).toHaveText('Chat');
			await expect(scope).toBeEnabled();
			await expect(settings.locator('[data-settings-item-id="sessions.experimental.layoutScope"] .ash-settings-configured-marker')).toHaveCSS('display', 'none');
			await page.evaluate(() => window.ashSessionsIntegration.updateConfiguration('sessions.experimental.layoutScope', 'chat-shared'));
			await expect(scope).toHaveText('Chat, shared visibility');
			await page.evaluate(() => window.ashSessionsIntegration.remountAfterDirectDispose());
			await page.getByRole('button', { name: 'Accounts', exact: true }).click();
			await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
			await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
			await expect(scope).toHaveText('Chat, shared visibility');
		});

		test('settings header and responsive panes preserve their geometry', async function () {
			const { page } = browserTests;
			const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
			await expect(settings).toBeVisible();
			// A later-loaded base widget must preserve the Settings presentation.
			await page.addStyleTag({ path: 'src/ash/base/browser/ui/dialog/dialog.css' });
			const viewport = page.viewportSize();
			if (!viewport) throw new Error('Browser test requires a viewport');
			await page.setViewportSize({ width: 1440, height: 900 });
			await expect(settings).toHaveCSS('width', '960px');
			await expect(settings).toHaveCSS('height', '640px');
			await expect(settings).toHaveCSS('border-radius', '12px');
			await expect(settings).toHaveCSS('padding', '0px');
			await expect(settings.locator('.ash-dialog-header')).toHaveCSS('padding', '12px');
			await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
			await expect(settings.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
			const close = settings.getByRole('button', { name: 'Close Dialog', exact: true });
			await expect(close).toBeVisible();
			await expect(settings).toHaveCSS('border-top-width', '1px');
			await expect(settings.locator('.ash-sessions-settings')).toHaveCSS('border-top-width', '0px');
			await expect(settings.locator('.ash-sessions-settings-list').first()).toHaveCSS('border-top-width', '0px');
			const settingsRows = settings.locator('.ash-sessions-settings-list.ash-settings-card:has(> .ash-configuration-setting)');
			await expect(settingsRows).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			const row = settingsRows.locator('.ash-configuration-setting').first();
			const title = row.locator('.ash-configuration-setting-title');
			await expect(title).toHaveCSS('font-weight', '400');
			await title.hover();
			await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(row.getByRole('button', { name: 'More actions for Layout scope' })).toHaveCSS('opacity', '0');
			await title.click({ button: 'right' });
			const menu = settings.getByRole('menu');
			await expect(menu.getByRole('menuitem', { name: 'Copy Setting as JSON' })).toBeVisible();
			await expect(menu.getByRole('menuitem', { name: 'Copy Setting as JSON' }).locator('.ash-menu-leading-slot')).toHaveCSS('display', 'none');
			await page.keyboard.press('Escape');
			await expect(menu).toHaveCount(0);
			await expect(title).toHaveCSS('color', 'rgb(59, 59, 59)');
			await expect(row.locator('.ash-configuration-setting-description:not([hidden])')).toHaveCSS('color', 'rgb(118, 118, 118)');
			const sidebar = settings.locator('.ash-sessions-settings-sidebar');
			const settingsPage = settings.locator('.ash-sessions-settings-page');
			const sidebarBounds = await sidebar.boundingBox();
			const pageBounds = await settingsPage.boundingBox();
			expect(sidebarBounds).not.toBeNull();
			expect(pageBounds).not.toBeNull();
			expect(sidebarBounds!.x + sidebarBounds!.width).toBeLessThanOrEqual(pageBounds!.x + 1);
			expect(sidebarBounds!.y + sidebarBounds!.height).toBeGreaterThanOrEqual(pageBounds!.y + pageBounds!.height - 1);
			await expect(settings.locator('.ash-dialog-actions')).toHaveCount(0);
			await page.setViewportSize({ width: 540, height: 500 });
			await expect(settings).toHaveCSS('width', '508px');
			await expect(settings).toHaveCSS('height', '410px');
			const narrowSidebarBounds = await sidebar.boundingBox();
			const narrowPageBounds = await settingsPage.boundingBox();
			expect(narrowSidebarBounds).not.toBeNull();
			expect(narrowPageBounds).not.toBeNull();
			expect(narrowSidebarBounds!.y + narrowSidebarBounds!.height).toBeLessThanOrEqual(narrowPageBounds!.y + 1);
			await expect(settings.getByRole('searchbox', { name: 'Search settings' })).toBeVisible();
			await page.setViewportSize(viewport);
			await expect(page.getByRole('button', { name: 'Accounts', exact: true })).toBeVisible();
			await close.click();
			await expect(settings).toHaveCount(0);
			await expect(page.getByRole('button', { name: 'Accounts', exact: true })).toBeFocused();
		});

		test('settings categories, localization icons and search display their own contents', async function () {
			const { page } = browserTests;
			const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
			const settingsPage = settings.locator('.ash-sessions-settings-page');
			const navigation = settings.getByRole('navigation', { name: 'Settings categories' });
			for (const [section, categories] of [
				['Basics', ['General', 'Account', 'Appearance', 'Customize', 'Voice']],
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
			await expect(navigation.getByRole('button', { name: 'Voice', exact: true }).locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'voice-mode');
			await expect(navigation.getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page');
			await expect(navigation.getByRole('button', { name: 'General' })).toHaveCSS('background-color', 'rgb(240, 240, 240)');
			await expect(settings.locator('.ash-local-transcription-model-controls')).toHaveCount(0);
			await expect(settings.locator('[data-configuration-key="accessibility.verbosity.sessionsActivityBar"]')).toHaveCount(0);
			await expect(settings.locator('[data-configuration-key="accessibility.verbosity.sessionsSettings"]')).toHaveCount(0);
			const chatTips = settings.locator('[data-settings-item-id="chat.tips.enabled"]');
			const chatTipsSwitch = chatTips.getByRole('switch', { name: 'Show Chat tips', exact: true });
			await expect(chatTipsSwitch).toBeChecked();
			await chatTips.getByText('Show Chat tips', { exact: true }).click();
			await expect(chatTipsSwitch).toBeChecked();
			await chatTips.locator('.ash-switch-track').click();
			await expect(chatTipsSwitch).not.toBeChecked();
			await navigation.getByRole('button', { name: 'Voice', exact: true }).click();
			await expect(settings.getByRole('heading', { name: 'Voice', exact: true })).toBeVisible();
			await expect(settings.locator('[data-configuration-key="dictation.backend"]')).toBeVisible();
			await expect(settings.locator('.ash-local-transcription-model-controls')).toBeVisible();
			await navigation.getByRole('button', { name: 'Appearance' }).click();
			await expect(settings.getByRole('heading', { name: 'Appearance' })).toBeVisible();
			await expect(settings.locator('[data-configuration-key="sessions.layoutStyle"]')).toBeVisible();
			await expect(settings.locator('[data-configuration-key="sessions.activityBar.location"]')).toBeVisible();
			await expect(settings.locator('[data-configuration-key="sessions.activityBar.compact"]')).toHaveCount(0);
			await navigation.getByRole('button', { name: 'General' }).click();
			await expect(settings.locator('.ash-local-transcription-model-controls')).toHaveCount(0);
			await expect(navigation.getByRole('button', { name: 'Archived Chats', exact: true })).toHaveCount(0);
			await expect(navigation.getByRole('button', { name: 'Worktree', exact: true })).toHaveCount(0);
			await navigation.getByRole('button', { name: 'Keyboard Shortcuts', exact: true }).click();
			await expect(settingsPage.getByRole('heading', { name: 'Keyboard Shortcuts' }).first()).toBeVisible();
			await expect(settingsPage.getByRole('button', { name: 'Keyboard Shortcuts', exact: true })).toBeVisible();
			await expect(settingsPage.getByRole('button', { name: 'Preferences: Open Keyboard Shortcuts (JSON)', exact: true })).toHaveCount(0);
			await navigation.getByRole('button', { name: 'Appearance' }).click();
			await expect(settings.getByRole('heading', { name: 'Appearance' })).toBeVisible();
			await expect(settings.locator('[data-configuration-key="workbench.layoutStyle"]')).toHaveCount(0);
			const searchSettings = settings.getByRole('searchbox', { name: 'Search settings' });
			await expect(searchSettings).toHaveAttribute('placeholder', 'Search');
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
			const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
			const activityNavigation = page.locator('.ash-sessions-activity-content');
			const accounts = page.getByRole('button', { name: 'Accounts', exact: true });
			await settings.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Appearance' }).click();
			const layoutStyle = settings.locator('[data-configuration-key="sessions.layoutStyle"]').getByRole('combobox');
			const originalLayoutStyle = (await layoutStyle.textContent())!.trim();
			const changedLayoutStyle = originalLayoutStyle === 'Flat' ? 'Modern' : 'Flat';
			await layoutStyle.click();
			await page.getByRole('option', { name: changedLayoutStyle }).click();
			await expect(layoutStyle).toHaveText(changedLayoutStyle);
			await expectActivityIconSize(activityNavigation, 18);
			await layoutStyle.click();
			await page.getByRole('option', { name: originalLayoutStyle }).click();
			await page.keyboard.press('Escape');
			await expect(settings).toHaveCount(0);
			await expect(accounts).toBeFocused();
		});

	});

	test('Inbox follows the workspace mode and keeps unanswered requests after opening them', async function () {
		const { page, info } = browserTests;
		await page.goto('/sessions.html?multiHost&inbox&locale=zh-CN');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		const modes = page.locator('.ash-window-mode-control');
		const code = modes.getByRole('button', { name: '代码', exact: true });
		const chat = modes.getByRole('button').first();
		const inbox = page.getByRole('button', { name: /^收件箱/u });
		const panel = page.getByRole('dialog', { name: '收件箱', exact: true });
		const footer = page.locator('.ash-sessions-sidebar-footer');
		const expectEvenInsets = () => expect.poll(async () => {
			const bounds = (await panel.locator('..').boundingBox())!;
			const sidebar = (await footer.boundingBox())!;
			return [Math.round(bounds.x - sidebar.x), Math.round(sidebar.x + sidebar.width - bounds.x - bounds.width)];
		}).toEqual([12, 12]);
		const icon = inbox.locator('[data-ash-icon-id="inbox"]');
		await expect(icon).toHaveCSS('font-family', '"Ash UI Variable"');
		await expect(icon).toHaveCSS('font-size', '18px');
		await inbox.hover();
		const sidebarToggle = page.locator('[data-action-id="ash.sessions.toggleSidebar"] button');
		for (const button of [inbox, sidebarToggle]) {
			await expect(button).toHaveCSS('width', '28px');
			await expect(button).toHaveCSS('height', '28px');
		}
		await chat.click();
		await expect(inbox).toHaveAccessibleName('收件箱');
		await inbox.press('Enter');
		await expect(panel).toContainText('没有需要关注的会话。');
		await expectEvenInsets();
		await page.keyboard.press('Escape');
		await expect(inbox).toBeFocused();
		await inbox.press('Alt+F1');
		await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/使用 Tab 聚焦侧栏底部的收件箱/u);
		await page.keyboard.press('Escape');
		await expect(inbox).toBeFocused();

		await code.click();
		await expect(inbox).toHaveAccessibleName('收件箱，2 项需要关注');
		await expect(inbox.locator('.ash-sessions-inbox-dot')).toBeVisible();
		const accounts = page.locator('.ash-sessions-sidebar-accounts button');
		const accountBounds = (await accounts.boundingBox())!;
		const inboxBounds = (await inbox.boundingBox())!;
		expect(accountBounds.x + accountBounds.width).toBeLessThanOrEqual(inboxBounds.x);
		expect(inboxBounds.y + inboxBounds.height / 2).toBeCloseTo(accountBounds.y + accountBounds.height / 2);
		await inbox.press('Enter');
		const waiting = panel.getByRole('button', { name: 'Task from Host B 等待你的输入' });
		const unread = panel.getByRole('button', { name: 'Task from Host A 未读回复' });
		await expect(waiting).toBeVisible();
		await expect(unread).toBeVisible();
		await expectEvenInsets();
		const panelBounds = (await panel.boundingBox())!;
		expect(panelBounds.y + panelBounds.height).toBeLessThan(inboxBounds.y);
		await page.screenshot({ path: info.outputPath('sessions-inbox-zh-CN.png') });
		await expect(waiting).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(unread).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await page.keyboard.press('Enter');
		await expect(panel).toBeHidden();
		await expect(inbox).toHaveAccessibleName('收件箱，2 项需要关注');

		await inbox.press('Enter');
		await unread.press('Enter');
		await expect(inbox).toHaveAccessibleName('收件箱，1 项需要关注');
		await expect(page.locator('.ash-sessions-chat-slot.active form.ash-chat-input-container').getByRole('textbox')).toBeFocused();
		await chat.click();
		await expect(inbox).toHaveAccessibleName('收件箱');
		await code.click();
		await expect(inbox).toHaveAccessibleName('收件箱，1 项需要关注');

		await inbox.click();
		const previousWidth = (await footer.boundingBox())!.width;
		await page.locator('.ash-primary-sidebar-sash').press('ArrowRight');
		await expect.poll(async () => (await footer.boundingBox())!.width).toBeGreaterThan(previousWidth);
		await expectEvenInsets();
		await inbox.click();
		await expect(panel).toBeHidden();
	});

	test('Inbox marks a review reply read when its visible Bots conversation receives focus', async () => {
		const { page } = browserTests;
		await page.goto('/sessions.html?multiHost&sideThreads&inbox&botsInbox');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		const code = page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true });
		await code.click();
		const inbox = page.getByRole('button', { name: /^Inbox/ });
		await expect(inbox).toHaveAccessibleName('Inbox, items needing attention: 2');

		await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Bots', exact: true }).click();
		const bots = page.locator('.ash-bots-page');
		await expect(bots.getByRole('heading', { name: 'Follow-up chat' })).toBeVisible();
		await expect(bots.getByText('I reviewed the change.', { exact: true })).toBeVisible();
		await expect(inbox).toHaveAccessibleName('Inbox, items needing attention: 2');

		const conversation = bots.getByRole('textbox');
		await conversation.focus();
		await expect(conversation).toBeFocused();
		await expect(inbox).toHaveAccessibleName('Inbox, items needing attention: 1');
		await page.locator('.ash-bots-sidebar').getByRole('button', { name: 'Back', exact: true }).click();
		await inbox.press('Enter');
		const panel = page.getByRole('dialog', { name: 'Inbox', exact: true });
		await expect(panel.getByRole('button', { name: 'Task from Host B Needs your input' })).toBeVisible();
		await expect(panel.getByRole('button', { name: /Follow-up chat/ })).toHaveCount(0);
	});

	test('Activity Bar uses fixed sizes across positions and preserves account ownership', async function () {
		const { page } = browserTests;
		const activityBar = page.locator('[data-part="activitybar"]');
		const activityNavigation = page.locator('.ash-sessions-activity-content');
		const chatButton = activityNavigation.locator('button').first();
		const buttonBounds = await chatButton.boundingBox();
		const iconSlot = chatButton.locator('.ash-icon-label-icon');
		const iconBounds = await iconSlot.boundingBox();
		expect(buttonBounds).not.toBeNull();
		expect(iconBounds).not.toBeNull();
		expect(buttonBounds!.width).toBeGreaterThan(36);
		expect(buttonBounds!.height).toBe(32);
		expect(iconBounds!.width).toBe(24);
		expect(iconBounds!.height).toBe(24);
		const projectsIcon = activityNavigation.locator('button .ash-icon-label-icon > [data-ash-icon-id="projects"]');
		await expect(projectsIcon).toHaveCSS('width', '18px');
		expect(Math.abs(iconBounds!.y + iconBounds!.height / 2 - (buttonBounds!.y + buttonBounds!.height / 2))).toBeLessThanOrEqual(1);
		const sidebar = page.locator('[data-part="sidebar"]');
		const accountSlot = page.getByRole('button', { name: 'Accounts', exact: true }).locator('.ash-icon-label-icon');
		await sidebar.evaluate(element => (element as HTMLElement).style.setProperty('--ash-toolbar-actionSize', '32px'));
		await expect(iconSlot).toHaveCSS('width', '32px');
		await expect(accountSlot).toHaveCSS('width', '32px');
		await expect(chatButton).toHaveCSS('height', '40px');
		await sidebar.evaluate(element => (element as HTMLElement).style.removeProperty('--ash-toolbar-actionSize'));
		await chatButton.click({ button: 'right' });
		await expect(page.getByRole('menuitem', { name: 'Activity Bar Size' })).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expect(chatButton).toHaveCSS('height', '32px');
		await expect(projectsIcon).toHaveCSS('width', '18px');
		await expectActivityIconSize(activityNavigation, 18);
		await expect(activityBar).toHaveCount(0);
		await chatButton.click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
		await page.getByRole('menuitemradio', { name: 'Top' }).click();
		await expect(activityBar).toHaveCount(0);
		const topHost = page.locator('.ash-sessions-activity-host.top');
		await expect(topHost).toBeVisible();
		await expectActivityIconSize(activityNavigation, 18, 'top');
		const createProject = activityNavigation.getByRole('button', { name: 'Create project', exact: true });
		await expect(createProject).toHaveCount(0);
		const titlebarAccounts = page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Accounts', exact: true });
		await titlebarAccounts.press('Enter');
		await expect(titlebarAccounts).toHaveAttribute('aria-expanded', 'true');
		await expect(page.getByRole('menuitem', { name: 'Settings', exact: true })).toBeVisible();
		await expect(page.locator('.ash-sessions-account-menu')).not.toHaveClass(/ash-sessions-sidebar-account-menu/);
		await page.keyboard.press('Escape');
		await expect(titlebarAccounts).toHaveAttribute('aria-expanded', 'false');
		await expect(topHost.locator('button').first()).toHaveAttribute('aria-label', /New/);
		await topHost.locator('button').first().click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
		await page.getByRole('menuitemradio', { name: 'Bottom' }).click();
		await expect(page.locator('.ash-sessions-activity-host.bottom')).toBeVisible();
		await expect(topHost).toBeHidden();
		await expectActivityIconSize(activityNavigation, 18, 'bottom');
		await page.locator('.ash-sessions-activity-host.bottom button').first().click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
		await page.getByRole('menuitemradio', { name: 'Default' }).click();
		await expect(activityBar).toHaveCount(0);
		await expectActivityIconSize(activityNavigation, 18);
		await expect(createProject).toHaveCount(1);
		await chatButton.click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
		await page.getByRole('menuitemradio', { name: 'Top' }).click();
		await expect(topHost).toBeVisible();
		await expectActivityIconSize(activityNavigation, 18, 'top');
		await topHost.locator('button').first().click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
		await page.getByRole('menuitemradio', { name: 'Bottom' }).click();
		const bottomHost = page.locator('.ash-sessions-activity-host.bottom');
		await expect(bottomHost).toBeVisible();
		await expectActivityIconSize(activityNavigation, 18, 'bottom');
		await expect(titlebarAccounts).toHaveCount(0);
		const sidebarAccounts = page.locator('[data-part="sidebar"]').getByRole('button', { name: 'Accounts', exact: true });
		await sidebarAccounts.press('Shift+F10');
		await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
		await page.getByRole('menuitemradio', { name: 'Default' }).click();
		await expectActivityIconSize(activityNavigation, 18);
		await chatButton.click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
		await expect(page.getByRole('menuitemradio')).toHaveText(['Default', 'Top', 'Bottom']);
		await expect(page.getByRole('menuitemradio', { name: 'Default' })).toHaveAttribute('aria-checked', 'true');
		await page.keyboard.press('Escape');
		await expect(topHost.locator('.ash-sessions-activity-content')).toBeVisible();
		await expect(activityBar).toHaveCount(0);
	});

	test('Sessions titlebar reserves its dimensions and orders component actions', async function () {
		const { page } = browserTests;
		const titlebar = page.locator("[data-part='titlebar']");
		await expect(titlebar).toBeVisible();
		await expect(titlebar.getByRole('button', { name: 'Return to Workbench' })).toHaveCount(0);
		await expect(titlebar.getByRole('button', { name: 'Rename session (New Chat)', exact: true })).toBeVisible();
		const titlebarActions = titlebar.getByRole('toolbar', { name: 'Title bar left actions', exact: true });
		await expect(titlebarActions).toBeVisible();
		await expect(titlebarActions.getByRole('menuitem', { name: 'Application menu', exact: true })).toBeVisible();
		const titlebarButtons = titlebarActions.locator('button');
		const expectedTitlebarActions = ['Application menu', 'Hide sidebar', 'Back', 'Forward'];
		await expect(titlebarButtons).toHaveCount(expectedTitlebarActions.length);
		await expect(titlebarActions).toHaveCSS('gap', '2px');
		for (const button of await titlebarButtons.all()) {
			await expect(button).toHaveCSS('border-radius', '8px');
		}
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
		const sidebar = page.locator('[data-part="sidebar"]');
		const mode = titlebar.locator('.ash-window-mode-control');
		const newSession = activityNavigation.getByRole('button', { name: 'New', exact: true });
		let sidebarWidth = (await sidebar.boundingBox())!.width;
		expect(sidebarWidth).toBeGreaterThan(270);
		for (const delta of [0, -110, -50, 120]) {
			if (delta) {
				const sash = sidebar.locator('xpath=../../..').locator(':scope > .ash-sash').first();
				const bounds = (await sash.boundingBox())!;
				const x = bounds.x + bounds.width / 2;
				const y = bounds.y + 100;
				await page.mouse.move(x, y);
				await page.mouse.down();
				await page.mouse.move(x + delta, y, { steps: 5 });
				await page.mouse.up();
			}
			// The browser sidebar's 270px minimum can leave more than the titlebar's 8px gap.
			sidebarWidth = Math.max(270, sidebarWidth + delta);
			await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeCloseTo(sidebarWidth, 1);
			const modeBounds = (await mode.boundingBox())!;
			const navigationBounds = (await newSession.boundingBox())!;
			expect(modeBounds.x + modeBounds.width).toBeCloseTo(navigationBounds.x + navigationBounds.width, 1);
			if (delta < 0) {
				expect(sidebarWidth).toBe(270);
				const forwardBounds = (await titlebarButtons.last().boundingBox())!;
				expect(modeBounds.x - forwardBounds.x - forwardBounds.width).toBeGreaterThanOrEqual(8);
			}
		}
	});

	test('Code window actions and card headers follow opposite sides of the tool divider', async function () {
		const { page } = browserTests;
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto('/sessions.html?multiHost');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await page.locator('.ash-sessions-list:visible').getByRole('button', { name: 'Task from Host A', exact: true }).click();

		const titlebar = page.locator('[data-part="titlebar"]');
		const titleMenu = titlebar.locator('.ash-sessions-titlebar-menu');
		const tools = titlebar.getByRole('toolbar', { name: 'Code layout', exact: true });
		const toolHeaders = titlebar.locator('.ash-sessions-titlebar-tool-headers');
		const filesHeader = toolHeaders.locator('[data-editor-tool="files"] > .ash-editor-group-header');
		const editor = page.locator('[data-part="editor"]');
		const conversation = page.locator('[data-part="sessions"]');
		await expect(titleMenu).toBeVisible();
		await tools.locator('[data-action-id="ash.sessions.toggleFiles"] button').click();
		await expect(editor).toBeVisible();
		await expect(filesHeader).toBeVisible();
		await expect(filesHeader.locator('.ash-sessions-tool-header-label')).toBeVisible();
		await expect(editor.locator('.ash-editor-group-header:visible')).toHaveCount(0);

		const sash = conversation.locator('xpath=../../..').locator(':scope > .ash-sash-vertical[aria-disabled="false"]:not(.ash-primary-sidebar-sash)').first();
		const header = (await titlebar.boundingBox())!;
		const split = (await sash.boundingBox())!;
		const toolArea = (await editor.boundingBox())!;
		const actionBar = (await tools.boundingBox())!;
		const menu = (await titleMenu.boundingBox())!;
		expect(split.y).toBe(header.y + header.height);
		expect(toolArea.y).toBe(split.y);
		expect(split.x + split.width / 2).toBeCloseTo(toolArea.x, 0);
		expect(await sash.evaluate(element => parseFloat(getComputedStyle(element, '::after').top))).toBeCloseTo(split.height / 2, 0);
		expect(menu.x + menu.width).toBeLessThan(actionBar.x);
		expect(actionBar.x + actionBar.width).toBeLessThan(toolArea.x);
		expect((await toolHeaders.boundingBox())!.x).toBeCloseTo(toolArea.x, 0);
		expect((await filesHeader.boundingBox())!.y).toBe(header.y);

		await sash.press('ArrowLeft');
		await expect.poll(async () => (await editor.boundingBox())!.width).toBeGreaterThan(toolArea.width);
		await expect.poll(async () => (await tools.boundingBox())!.x).toBeLessThan(actionBar.x);
		expect((await toolHeaders.boundingBox())!.x).toBeCloseTo((await editor.boundingBox())!.x, 0);
		expect(await titleMenu.boundingBox()).toEqual(menu);

		await tools.locator('[data-action-id="ash.sessions.toggleChanges"] button').click();
		const changesHeader = toolHeaders.locator('[data-editor-tool="changes"] > .ash-editor-group-header');
		await expect(changesHeader).toBeVisible();
		await expect(filesHeader).toBeVisible();
		await expect(editor.locator('.ash-editor-group-header:visible')).toHaveCount(0);
		const changesLabel = changesHeader.locator('.ash-sessions-tool-header-label');
		await expect(changesLabel).toHaveText('Changes');
		await expect(changesLabel).toBeVisible();
		await expect(changesHeader).not.toHaveAttribute('draggable', 'true');
		await expect(changesHeader).not.toHaveCSS('-webkit-app-region', 'no-drag');
		await expect(changesHeader.locator('.ash-editor-header-layout > .ash-toolbar')).toHaveCSS('-webkit-app-region', 'no-drag');
		await filesHeader.locator('[data-action-id="ash.sessions.hideTool"] button').focus();
		// A mouse activation need not focus the clicked toolbar before running its command.
		await changesHeader.locator('[data-action-id="ash.sessions.hideTool"] button').evaluate((button: HTMLButtonElement) => button.click());
		await expect(changesHeader).toHaveCount(0);
		await expect(filesHeader).toBeVisible();

		await titlebar.locator('[data-action-id="ash.sessions.toggleSidebar"] button').click();
		await expect(page.locator('[data-part="sidebar"]')).toBeHidden();
		const dividerX = (await editor.boundingBox())!.x;
		const dragY = header.y + header.height + 80;
		await page.mouse.move(dividerX, dragY);
		await page.mouse.down();
		try {
			await page.mouse.move(90, dragY, { steps: 8 });
		} finally {
			await page.mouse.up();
		}
		await expect(toolHeaders).toBeHidden();
		await expect(editor.locator('[data-editor-tool="files"] .ash-editor-group-header:visible')).toHaveCount(1);
	});

	test('Sessions titlebar colors resolve under light and dark themes', async function () {
		const { page } = browserTests;
		for (const [id, color] of [['ash-dark', '#1e1e1e'], ['ash-light', '#ffffff']]) {
			await page.evaluate(id => window.ashSessionsIntegration.setTheme(id), id!);
			await expect.poll(() => page.locator('#app').evaluate(element => getComputedStyle(element).getPropertyValue('--ash-titleBar-background').trim())).toBe(color);
		}
	});


	for (const locale of ['en', 'zh-CN']) test(`Workspace mode selection slides behind stationary icons (${locale})`, async function () {
		const { page } = browserTests;
		if (locale === 'zh-CN') await page.goto('/sessions.html?catalog&locale=zh-CN');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		const control = page.locator('.ash-window-mode-control');
		const buttons = control.getByRole('button');
		const chat = buttons.nth(0);
		const code = buttons.nth(1);
		const iconBounds = () => control.locator('.ash-icon').evaluateAll(icons => icons.map(icon => icon.getBoundingClientRect().toJSON()));
		const initialBounds = await iconBounds();
		const initialSize = await control.boundingBox();
		const slider = () => control.evaluate(element => {
			const style = getComputedStyle(element, '::before');
			return { translate: style.translate, duration: style.transitionDuration, border: style.borderTopColor, width: Number.parseFloat(style.width) };
		});
		expect((await slider()).translate).toBe('0%');
		const motion = await control.evaluate(element => new Promise<{ translate: number; width: number; }>((resolve, reject) => {
			const timeout = setTimeout(() => { element.removeEventListener('transitionrun', onRun); reject(new Error('Selection slider did not start moving')); }, 5000);
			function onRun(event: Event): void {
				const transition = event as TransitionEvent;
				if (transition.propertyName !== 'translate' || transition.pseudoElement !== '::before') return;
				element.removeEventListener('transitionrun', onRun);
				clearTimeout(timeout);
				const animation = element.getAnimations({ subtree: true }).find(animation => animation instanceof CSSTransition && animation.transitionProperty === 'translate')!;
				animation.pause();
				animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
				const style = getComputedStyle(element, '::before');
				const result = { translate: Number.parseFloat(style.translate), width: Number.parseFloat(style.width) };
				animation.finish();
				resolve(result);
			}
			element.addEventListener('transitionrun', onRun);
			element.querySelectorAll<HTMLButtonElement>('button')[1]!.click();
		}));
		expect(motion.translate).toBeGreaterThan(0);
		expect(motion.translate).toBeLessThan(100);
		expect(motion.width).toBeCloseTo(initialSize!.width / 2, 1);
		await expect(code).toHaveAttribute('aria-pressed', 'true');
		expect((await slider()).translate).toBe('100%');
		expect(await iconBounds()).toEqual(initialBounds);
		await code.press('ArrowLeft');
		await expect(chat).toBeFocused();
		await expect(code).toHaveAttribute('aria-pressed', 'true');
		await chat.press('Enter');
		await expect(chat).toHaveAttribute('aria-pressed', 'true');
		await page.emulateMedia({ reducedMotion: 'reduce' });
		for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
			await page.evaluate(theme => window.ashSessionsIntegration.setTheme(theme), theme);
			await code.click();
			await expect(code).toHaveAttribute('aria-pressed', 'true');
			expect(await slider()).toMatchObject({ translate: '100%', duration: '0s' });
			await code.press('ArrowLeft');
			await expect(chat).toHaveCSS('outline-style', 'solid');
			if (theme.includes('high-contrast')) {
				expect((await slider()).border).toBe(await chat.evaluate(element => getComputedStyle(element).outlineColor));
			}
			await chat.press('Enter');
			await expect(chat).toHaveAttribute('aria-pressed', 'true');
			expect(await slider()).toMatchObject({ translate: '0%', duration: '0s' });
			expect(await iconBounds()).toEqual(initialBounds);
			expect(await control.boundingBox()).toEqual(initialSize);
		}
		await control.evaluate(element => element.setAttribute('dir', 'rtl'));
		await code.click();
		await expect(code).toHaveAttribute('aria-pressed', 'true');
		expect((await slider()).translate).toBe('-100%');
	});

	for (const locale of ['en', 'zh-CN']) test(`Sidebar boundaries follow the theme without changing resize or hide behavior (${locale})`, async function () {
		const { page } = browserTests;
		await page.goto(`/sessions.html?locale=${locale}`);
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.locator('[data-action-id="sessions.open.projects"]').click();
		await expect(page.locator('.ash-projects')).toBeVisible();
		const sidebar = page.locator('[data-part="sidebar"]');
		const auxiliarybar = page.locator('[data-part="auxiliarybar"]');
		const initialWidth = (await sidebar.boundingBox())!.width;
		const expectSharedBoundary = async (): Promise<void> => {
			const boundary = await page.evaluate(() => {
				const titlebar = document.querySelector<HTMLElement>('[data-part="titlebar"]')!;
				const sidebar = document.querySelector<HTMLElement>('[data-part="sidebar"]')!;
				const divider = getComputedStyle(titlebar, '::after');
				const border = getComputedStyle(sidebar);
				const sash = document.querySelector<HTMLElement>('.ash-primary-sidebar-sash')!;
				const feedback = getComputedStyle(sash, '::after');
				const transform = new DOMMatrix(feedback.transform);
				return {
					content: divider.content,
					color: divider.borderRightColor,
					borderColor: border.borderRightColor,
					dividerRight: titlebar.getBoundingClientRect().left + parseFloat(divider.left) + parseFloat(divider.width),
					sidebarRight: sidebar.getBoundingClientRect().right,
					borderCenter: sidebar.getBoundingClientRect().right - parseFloat(border.borderRightWidth) / 2,
					feedbackCenter: sash.getBoundingClientRect().left + parseFloat(feedback.left) + transform.m41 + parseFloat(feedback.width) / 2,
					width: divider.width,
					borderWidth: border.borderRightWidth,
					leadingSeparators: [...document.querySelectorAll('[data-part="editor"] .ash-split-view-separator-border')].map(split => {
						const first = [...split.children].find(child => child.classList.contains('ash-split-view-pane') && !(child as HTMLElement).hidden);
						return first ? getComputedStyle(first, '::before').content : 'none';
					}),
				};
			});
			expect(boundary.content).toBe('""');
			expect(boundary.color).toBe(boundary.borderColor);
			expect(boundary.width).toBe(boundary.borderWidth);
			expect(boundary.dividerRight).toBeCloseTo(boundary.sidebarRight, 3);
			expect(boundary.feedbackCenter).toBeCloseTo(boundary.borderCenter, 3);
			expect(boundary.leadingSeparators.every(content => content === 'none')).toBe(true);
		};
		for (const [theme, color, auxiliaryColor] of [
			['ash-light', 'rgb(229, 229, 229)', 'rgba(0, 0, 0, 0)'],
			['ash-dark', 'rgb(43, 43, 43)', 'rgba(0, 0, 0, 0)'],
			['ash-high-contrast-dark', 'rgb(255, 255, 255)', 'rgb(255, 255, 255)'],
			['ash-high-contrast-light', 'rgb(0, 0, 0)', 'rgb(0, 0, 0)'],
		] as const) {
			await page.evaluate(theme => window.ashSessionsIntegration.setTheme(theme), theme);
			await expect(sidebar).toHaveCSS('border-right-color', color);
			await expect(auxiliarybar).toHaveCSS('border-left-color', auxiliaryColor);
			expect((await sidebar.boundingBox())!.width).toBe(initialWidth);
			await expectSharedBoundary();
		}
		await page.evaluate(async () => {
			await window.ashSessionsIntegration.setTheme('ash-light');
			await window.ashSessionsIntegration.updateConfiguration('workbench.colorCustomizations', { 'sideBar.border': '#123456' });
		});
		await expect(sidebar).toHaveCSS('border-right-color', 'rgb(18, 52, 86)');
		await expect(auxiliarybar).toHaveCSS('border-left-color', 'rgb(18, 52, 86)');
		await expectSharedBoundary();
		const sash = page.locator('.ash-primary-sidebar-sash');
		await expect(page.locator('.ash-sessions-window')).toHaveClass(/ash-sash-handle-scope/);
		await sash.focus();
		await sash.press('ArrowRight');
		await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeGreaterThan(initialWidth);
		await expect(sidebar).toHaveCSS('border-right-color', 'rgb(18, 52, 86)');
		await expectSharedBoundary();
		const bounds = (await sash.boundingBox())!;
		const x = bounds.x + bounds.width / 2;
		const y = bounds.y + bounds.height / 2;
		const dragWidth = (await sidebar.boundingBox())!.width;
		await page.mouse.move(x, y);
		await page.mouse.down();
		try {
			for (const delta of [12, 48, 24, 72]) {
				await page.mouse.move(x + delta, y);
				expect((await sidebar.boundingBox())!.width).toBeCloseTo(dragWidth + delta, 1);
				await expectSharedBoundary();
			}
		} finally {
			await page.mouse.up();
		}
		const toggle = page.locator('[data-action-id="ash.sessions.toggleSidebar"] button');
		await toggle.click();
		await expect(sidebar).toBeHidden();
		await expect.poll(async () => (await page.locator('[data-part="editor"]').boundingBox())!.x).toBe(0);
		await toggle.click();
		await expect(sidebar).toBeVisible();
		await expectSharedBoundary();
		await page.evaluate(() => window.ashSessionsIntegration.updateConfiguration('workbench.colorCustomizations', {}));
		await expect(sidebar).toHaveCSS('border-right-color', 'rgb(229, 229, 229)');
		await expectSharedBoundary();
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
		if (!chinese) { await expectActivityIconSize(navigation, 18); }
		await expect.poll(async () => Math.round((await sessions.boundingBox())!.width)).toBe(Math.round(expanded.width));
	});

	for (const locale of ['en', 'zh-CN']) test(`Sessions owns button presentations without changing shared defaults (${locale})`, async function () {
		const { page, info: testInfo } = browserTests;
		const chinese = locale === 'zh-CN';
		await page.goto(`/sessions.html?search${chinese ? '&locale=zh-CN' : ''}`);
		await page.locator('[data-action-id="sessions.open.projects"] > .ash-sessions-activity-item').click();
		const projects = page.locator('.ash-projects');
		await projects.getByRole('button', { name: chinese ? '搜索项目' : 'Search projects', exact: true }).click();
		await projects.getByRole('searchbox').fill('No matching synthetic project');
		const primary = projects.locator('.ash-projects-tools').getByRole('button', { name: chinese ? '新建项目' : 'New project', exact: true });
		const secondary = projects.locator('.ash-projects-empty .ash-button-secondary');
		await expect(primary).toBeVisible();
		await expect(secondary).toBeVisible();
		// The same button outside the window must keep shared defaults even
		// when the Sessions stylesheet is loaded in the same document.
		await primary.evaluate(element => {
			const reference = element.cloneNode(true) as HTMLButtonElement;
			reference.id = 'outside-sessions-button';
			document.body.append(reference);
		});
		const outside = page.locator('#outside-sessions-button');
		try {
			await expect(outside).toHaveCSS('min-height', '28px');
			await expect(outside).toHaveCSS('border-radius', '4px');
			for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
				await page.evaluate(theme => window.ashSessionsIntegration.setTheme(theme), theme);
				await page.mouse.move(0, 0);
				for (const button of [primary, secondary]) {
					await expect(button).toHaveCSS('padding', button === primary ? '0px 8px' : '4px 8px');
					expect((await button.boundingBox())!.height).toBeLessThan(36);
					await expect(button).toHaveCSS('border-radius', '8px');
					await expect(button).toHaveCSS('font-size', '14px');
				}
				await expect(secondary).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				const colors = await primary.evaluate(element => {
					const style = getComputedStyle(element);
					return { background: style.backgroundColor, foreground: style.color, expected: getComputedStyle(element.closest('.ash-projects')!).color };
				});
				expect(colors.background).not.toBe(colors.foreground);
				await expect(primary).toHaveCSS('background-color', colors.expected);
				if (!theme.includes('high-contrast')) await expect(primary).not.toHaveCSS('background-color', await outside.evaluate(element => getComputedStyle(element).backgroundColor));
				const search = projects.getByRole('button', { name: chinese ? '关闭项目搜索' : 'Close project search', exact: true });
				await search.hover();
				await expect(search).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				await expect(search).toHaveCSS('height', '28px');
				await primary.hover();
				await page.mouse.down();
				if (!theme.includes('high-contrast')) await expect(primary).not.toHaveCSS('background-color', colors.background);
				await page.mouse.move(0, 0);
				await page.mouse.up();
				await primary.focus();
				await page.keyboard.press('Tab');
				await page.keyboard.press('Shift+Tab');
				await expect(primary).toBeFocused();
				await expect(primary).toHaveCSS('outline-style', 'solid');
				if (theme.includes('high-contrast')) {
					await expect(primary).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
					await expect(primary).toHaveCSS('outline-offset', '2px');
				}
			}
			await page.setViewportSize({ width: 640, height: 720 });
			await expect(primary).toBeInViewport();
			await expect(secondary).toBeInViewport();
			await primary.press('Enter');
			await expect(page.locator('.ash-projects-dialog')).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(primary).toBeFocused();
			await page.screenshot({ path: testInfo.outputPath(`sessions-buttons-${locale}.png`) });
		} finally {
			await outside.evaluate(element => element.remove());
		}
	});

	for (const locale of ['en', 'zh-CN']) test(`Sessions icon roles stay independent of IDE defaults (${locale})`, async function () {
		const { page, context, info: testInfo } = browserTests;
		await page.goto(`/sessions.html?catalog&search&locale=${locale}`);
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await expect(page.locator('.ash-sessions-chat-slot.active :is(.ash-chat-input-send-action, .ash-chat-input-voice-action) .ash-icon')).toHaveCount(1);
		const primary = page.locator('[data-part="titlebar"] .ash-icon-label-icon > .ash-icon, .ash-window-mode-control .ash-segmented-control-option > .ash-icon, .ash-sessions-activity-item .ash-icon, :is(.ash-chat-input-send-action, .ash-chat-input-voice-action) .ash-icon');
		const inline = page.locator('.ash-sessions-list:visible [data-project-id="search-project"] [data-ash-icon-id="projects"]');
		const accounts = page.locator('[data-action-id="sessions.activity.accounts"] button');
		await page.locator('.ash-sessions-window').evaluate(element => {
			const icon = element.querySelector('.ash-icon')!.cloneNode(true) as HTMLElement;
			icon.dataset.iconSizeProbe = 'base';
			icon.style.position = 'absolute';
			icon.style.left = '-10000px';
			element.append(icon);
		});
		const baseIcon = page.locator('[data-icon-size-probe="base"]');
		for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
			await page.evaluate(theme => window.ashSessionsIntegration.setTheme(theme), theme);
			await expect(baseIcon).toHaveCSS('font-size', '16px');
			expect(await primary.count()).toBeGreaterThan(5);
			for (const icon of await primary.all()) {
				await expect(icon).toHaveCSS('font-size', '18px');
				await expect(icon).toHaveCSS('width', '18px');
				await expect(icon).toHaveCSS('height', '18px');
			}
			await expect(inline).toHaveCSS('width', '18px');
			await expect(inline).toHaveCSS('font-size', '18px');
			await expect(page.getByRole('note').locator('.ash-icon')).toHaveCSS('font-size', '18px');
			await page.locator('[data-action-id="sessions.newSession"] button').click({ button: 'right' });
			const auxiliary = page.locator('.ash-menu .ash-submenu-indicator > .ash-icon').first();
			await expect(auxiliary).toHaveCSS('font-size', '16px');
			await expect(auxiliary).toHaveCSS('width', '16px');
			await page.keyboard.press('Escape');
			await accounts.press('Enter');
			const menuIcons = page.locator('.ash-menu .ash-icon');
			expect(await menuIcons.count()).toBeGreaterThan(0);
			for (const icon of await menuIcons.all()) {
				await expect(icon).toHaveCSS('font-size', '18px');
				await expect(icon).toHaveCSS('width', '18px');
			}
			await page.keyboard.press('Escape');
			await expect(accounts).toBeFocused();
		}
		await page.locator('.ash-sessions-window').evaluate(element => (element as HTMLElement).style.setProperty('--ash-lxiconFontSize-large', '20px'));
		for (const icon of await primary.all()) {
			await expect(icon).toHaveCSS('font-size', '20px');
			await expect(icon).toHaveCSS('width', '20px');
		}
		await expect(baseIcon).toHaveCSS('font-size', '16px');
		await page.locator('[data-action-id="sessions.newSession"] button').click({ button: 'right' });
		await expect(page.locator('.ash-menu .ash-submenu-indicator > .ash-icon').first()).toHaveCSS('font-size', '16px');
		await page.keyboard.press('Escape');
		await page.locator('.ash-sessions-window').evaluate(element => (element as HTMLElement).style.removeProperty('--ash-lxiconFontSize-large'));
		await baseIcon.evaluate(element => element.remove());
		await page.evaluate(() => window.ashSessionsIntegration.setTheme('ash-light'));
		await page.locator('.ash-sessions-chat-slot.active .ash-chat-input-editor .stanza-editor').getByRole('textbox').focus();
		await page.keyboard.insertText('Icon sizing draft');
		await expect(page.locator('.ash-sessions-chat-slot.active .ash-chat-input-send-action .ash-icon')).toHaveCSS('font-size', '18px');
		await page.screenshot({ path: testInfo.outputPath(`sessions-icon-roles-${locale}.png`) });
		const ide = await context.newPage();
		try {
			await ide.goto('/chatInput.html?inlineCode=1');
			const ideIcon = ide.locator(':is(.ash-chat-input-send-action, .ash-chat-input-voice-action) .ash-icon').first();
			await expect(ideIcon).toHaveCSS('font-size', '16px');
			await expect(ideIcon).toHaveCSS('width', '16px');
		} finally { await ide.close(); }
	});

	for (const locale of ['en', 'zh-CN']) test(`Sessions sidebar places its actions beside Projects in both modes (${locale})`, async function () {
		const { page } = browserTests;
		const chinese = locale === 'zh-CN';
		const list = page.locator('.ash-sessions-list:visible');
		const modes = page.locator('.ash-window-mode-control').getByRole('button');
		const projects = list.locator('[data-section="projects"]');
		const heading = projects.getByRole('heading', { level: 3, name: chinese ? '项目' : 'Projects', exact: true });
		const more = projects.getByRole('button', { name: chinese ? '更多会话操作' : 'More Sessions Actions', exact: true });
		const create = projects.getByRole('button', { name: chinese ? '创建项目' : 'Create project', exact: true });
		const toolbar = projects.getByRole('toolbar');
		const treeRow = list.getByRole('treeitem').filter({ has: page.locator('[data-section="projects"]') });
		const newSession = page.locator('[data-action-id="sessions.newSession"] button');
		await page.goto(`/sessions.html?catalog&search&locale=${locale}`);
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		if (chinese) await page.evaluate(() => window.ashSessionsIntegration.setTheme('ash-high-contrast-dark'));
		for (const code of [false, true]) {
			await modes.nth(code ? 1 : 0).click();
			const toggle = projects.getByRole('button', { name: chinese ? '项目' : 'Projects', exact: true });
			const projectRow = list.locator('[data-project-id="search-project"]');
			await expect(list.getByRole('heading', { level: 2 })).toHaveCount(0);
			await expect(heading).toBeVisible();
			await expect(toolbar.getByRole('button')).toHaveCount(code ? 2 : 1);
			await expect(toolbar).toHaveCSS('opacity', '0');
			await expect(projects.locator('[data-ash-icon-id="list-filter"]')).toBeVisible();
			await expect(more.locator('.ash-dropdown-menu-indicator')).toBeHidden();
			await expect(projectRow).toBeVisible();
			await toggle.press('ControlOrMeta+f');
			const search = list.getByRole('searchbox');
			await search.fill('No matching project');
			await expect(projectRow).toHaveCount(0);
			await expect(heading).toBeVisible();
			await expect(toggle).toHaveCount(0);
			await expect(more).toBeVisible();
			const emptyTitleBounds = (await heading.boundingBox())!;
			const emptyActionBounds = (await more.boundingBox())!;
			expect(emptyTitleBounds.x + emptyTitleBounds.width).toBeLessThan(emptyActionBounds.x);
			expect(emptyTitleBounds.y + emptyTitleBounds.height / 2).toBeCloseTo(emptyActionBounds.y + emptyActionBounds.height / 2, 0);
			await search.press('Escape');
			await expect(toggle).toBeFocused();
			await toggle.press('ArrowLeft');
			await expect(toggle).toHaveAttribute('aria-expanded', 'false');
			await expect(projectRow).toHaveCount(0);
			const titleBounds = (await toggle.boundingBox())!;
			const actionBounds = (await more.boundingBox())!;
			expect(actionBounds.width).toBe(24);
			expect(actionBounds.height).toBe(24);
			const rowBounds = (await treeRow.boundingBox())!;
			const navBounds = (await newSession.boundingBox())!;
			expect(rowBounds.x).toBeCloseTo(navBounds.x);
			expect(rowBounds.width).toBeCloseTo(navBounds.width);
			expect(rowBounds.height).toBe(32);
			await expect(treeRow).toHaveCSS('padding-left', '0px');
			expect((await projects.boundingBox())!.width).toBeCloseTo(rowBounds.width);
			await expect(projects).toHaveCSS('padding-inline-end', '4px');
			expect(rowBounds.x + rowBounds.width - (actionBounds.x + actionBounds.width)).toBeCloseTo(4);
			await expect(toggle).toHaveCSS('font-weight', '400');
			expect(titleBounds.x + titleBounds.width).toBeLessThan(actionBounds.x);
			expect(titleBounds.y + titleBounds.height / 2).toBeCloseTo(actionBounds.y + actionBounds.height / 2, 0);
			const transparent = 'rgba(0, 0, 0, 0)';
			await toggle.hover();
			await expect(toolbar).toHaveCSS('opacity', '1');
			await expect(projects).toHaveCSS('background-color', transparent);
			const hoverBackground = await treeRow.evaluate(element => getComputedStyle(element).backgroundColor);
			expect(hoverBackground).not.toBe(transparent);
			await expect(toggle).toHaveCSS('background-color', transparent);
			await more.hover();
			await expect(treeRow).toHaveCSS('background-color', hoverBackground);
			await expect(more).not.toHaveCSS('background-color', transparent);
			await expect(more).toHaveCSS('border-width', '0px');
			await page.mouse.move(0, 0);
			await expect(treeRow).toHaveCSS('background-color', transparent);
			await expect(toolbar).toHaveCSS('opacity', '1');
			await page.keyboard.press('Tab');
			if (code) {
				await expect(create).toBeFocused();
				await page.keyboard.press('ArrowRight');
			}
			await expect(more).toBeFocused();
			await expect(more).toHaveCSS('outline-style', 'solid');
			await page.keyboard.press('Enter');
			await expect(more).toHaveAttribute('aria-expanded', 'true');
			await expect(toolbar).toHaveCSS('opacity', '1');
			const filterMenu = page.locator('.ash-sessions-list-menu');
			await expect(filterMenu.getByRole('menuitem')).toContainText(chinese
				? ['分组方式', '排序方式', '显示']
				: ['Group By', 'Sort By', 'Show']);
			await expect(filterMenu.getByRole('menuitem', { name: chinese ? '在侧栏中搜索会话' : 'Search sessions in the sidebar', exact: true })).toHaveCount(0);
			const group = page.getByRole('menuitem', { name: chinese ? '分组方式' : 'Group By', exact: true });
			await expect(group).toBeFocused();
			await group.press('ArrowRight');
			await expect(page.getByRole('menuitemradio', { name: chinese ? '状态' : 'Status', exact: true })).toBeVisible();
			const selected = page.getByRole('menuitemradio', { checked: true });
			await expect(selected).toBeVisible();
			const label = (await selected.locator('.ash-button-label').boundingBox())!;
			const check = (await selected.locator('.ash-menu-trailing-slot [data-ash-icon-id="check"]').boundingBox())!;
			const inset = await selected.evaluate(row => parseFloat(getComputedStyle(row).paddingInlineStart));
			expect(label.x - (await selected.boundingBox())!.x).toBeCloseTo(inset);
			expect(check.x).toBeGreaterThan(label.x + label.width);
			await page.keyboard.press('ArrowLeft');
			await expect(group).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(more).toHaveAttribute('aria-expanded', 'false');
			await expect(more).toBeFocused();
			await expect(toggle).toHaveAttribute('aria-expanded', 'false');
		}
	});

	for (const locale of ['en', 'zh-CN']) test(`Code creates a project from local source folders (${locale})`, async function () {
		const { page, info: testInfo } = browserTests;
		const chinese = locale === 'zh-CN';
		await page.goto(`/sessions.html?projectCreation&codeProjectCreation&locale=${locale}`);
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		if (chinese) await page.evaluate(() => window.ashSessionsIntegration.setTheme('ash-high-contrast-dark'));
		await page.locator('.ash-window-mode-control').getByRole('button').nth(1).click();
		const list = page.locator('.ash-sessions-list[data-mode="code"]:visible');
		const create = list.getByRole('button', { name: chinese ? '创建项目' : 'Create project', exact: true });
		const dialog = page.getByRole('dialog', { name: chinese ? '创建项目' : 'Create a project', exact: true });
		const nameLabel = chinese ? '你正在做什么？' : 'What are you working on?';
		const name = dialog.getByRole('textbox', { name: nameLabel, exact: true });
		const add = dialog.getByRole('button', { name: chinese ? '添加源文件夹' : 'Add source folder', exact: true });
		const source = dialog.getByRole('group', { name: chinese ? '源文件夹' : 'Source folders', exact: true });
		const submit = dialog.getByRole('button', { name: chinese ? '创建' : 'Create', exact: true });
		await create.focus();
		await create.press('Enter');
		await expect(name).toBeFocused();
		await expect(name).toHaveAttribute('placeholder', nameLabel);
		await expect(dialog.getByRole('textbox')).toHaveCount(1);
		await expect(source).toContainText(chinese ? '添加此电脑上的文件夹' : 'Add a folder on this computer');
		await expect(submit).toBeDisabled();
		const nameBounds = (await name.boundingBox())!;
		const sourceBounds = (await source.boundingBox())!;
		const addBounds = (await add.boundingBox())!;
		const dialogBounds = (await dialog.boundingBox())!;
		const submitBounds = (await submit.boundingBox())!;
		expect(sourceBounds.y).toBeGreaterThan(nameBounds.y + nameBounds.height);
		expect(addBounds.x + addBounds.width / 2).toBeCloseTo(sourceBounds.x + sourceBounds.width / 2, 0);
		expect(dialogBounds.y + dialogBounds.height - submitBounds.y - submitBounds.height).toBeLessThan(24);
		await dialog.screenshot({ path: testInfo.outputPath(`code-project-${locale}.png`) });
		await name.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect(create).toBeFocused();
		await create.press('Enter');
		await add.press('Enter');
		await expect(add).toBeFocused();
		const paths = source.getByRole('listitem').locator(':scope > span');
		await expect(paths).toHaveText(['/workspace/first']);
		await add.press('Enter');
		await expect(paths).toHaveText(['/workspace/first', '/workspace/second']);
		await source.getByRole('button', { name: chinese ? '移除 /workspace/first' : 'Remove /workspace/first' }).press('Enter');
		await expect(add).toBeFocused();
		await expect(paths).toHaveText(['/workspace/second']);
		await name.fill('New Code project');
		const appearanceLabel = chinese ? '更改项目外观' : 'Change project appearance';
		const appearance = dialog.getByRole('button', { name: appearanceLabel });
		await appearance.press('Enter');
		const picker = page.getByRole('dialog', { name: appearanceLabel, exact: true });
		const search = picker.getByRole('combobox', { name: chinese ? '搜索图标' : 'Search icons' });
		await expect(search).toBeFocused();
		await search.fill('clockface');
		await search.press('Enter');
		const blue = picker.getByRole('button', { name: chinese ? '蓝色' : 'Blue', exact: true });
		await blue.press('Enter');
		await expect(blue).toHaveAttribute('aria-pressed', 'true');
		await expect(appearance.locator('[data-ash-icon-id="clockface"]')).toBeVisible();
		const previewColor = await appearance.evaluate(element => getComputedStyle(element).color);
		await search.fill('');
		await page.screenshot({ path: testInfo.outputPath(`project-appearance-${locale}.png`) });
		await blue.press('Escape');
		await expect(picker).toHaveCount(0);
		await expect(appearance).toBeFocused();
		await submit.click();
		await expect(dialog.getByRole('alert')).toHaveText('Synthetic save failure');
		await expect(name).toHaveValue('New Code project');
		await expect(paths).toHaveText(['/workspace/second']);
		await submit.click();
		await expect(dialog).toHaveCount(0);
		await expect(create).toBeFocused();
		const created = list.getByRole('button', { name: 'New Code project', exact: true });
		await expect(created.locator('[data-ash-icon-id="clockface"]')).toHaveCSS('color', previewColor);
	});

	for (const locale of ['en', 'zh-CN']) test(`Projects navigation opens the project creation dialog (${locale})`, async function () {
		const { page } = browserTests;
		const chinese = locale === 'zh-CN';
		await page.goto(`/sessions.html?catalog&search&locale=${locale}`);
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		const row = page.locator('.ash-sessions-navigation [data-action-id="sessions.open.projects"]');
		const projects = row.getByRole('button', { name: chinese ? '项目' : 'Projects', exact: true });
		const create = row.getByRole('button', { name: chinese ? '创建项目' : 'Create project', exact: true });
		const dialog = page.getByRole('dialog', { name: chinese ? '创建项目' : 'Create a project', exact: true });
		const name = dialog.getByRole('textbox', { name: chinese ? '你正在做什么？' : 'What are you working on?', exact: true });
		await expect(create).toHaveCSS('opacity', '0');
		await projects.focus();
		await page.keyboard.press('Tab');
		await expect(create).toBeFocused();
		await expect(create.locator('[data-ash-icon-id="add"]')).toBeVisible();
		await create.press('Enter');
		await expect(name).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect(create).toBeFocused();
		await expect(projects).toHaveAttribute('aria-current', 'page');
		await create.hover();
		await expect(create).toHaveCSS('background-color', 'rgba(90, 93, 94, 0.16)');
		const rowBounds = (await projects.boundingBox())!;
		const createBounds = (await create.boundingBox())!;
		expect(createBounds.width).toBe(24);
		expect(createBounds.height).toBe(24);
		expect(rowBounds.x + rowBounds.width - createBounds.x - createBounds.width).toBeCloseTo(4);
		expect(createBounds.y - rowBounds.y).toBeCloseTo(4);
		await create.click();
		await expect(name).toBeFocused();
		await expect(dialog).not.toHaveAttribute('aria-modal', 'true');
		const backdrop = () => dialog.evaluate(element => getComputedStyle(element, '::backdrop').backgroundColor);
		const formBackdrop = await backdrop();
		expect(formBackdrop).not.toBe('rgba(0, 0, 0, 0)');
		const backdropWithAnotherModal = await dialog.evaluate(element => {
			const modal = element.ownerDocument.createElement('dialog');
			element.after(modal);
			modal.showModal();
			try {
				return getComputedStyle(element, '::backdrop').backgroundColor;
			} finally {
				modal.close();
				modal.remove();
			}
		});
		expect(backdropWithAnotherModal).toBe(formBackdrop);
		await name.fill('Reverted draft');
		await name.clear();
		await page.mouse.click(8, 100);
		await expect(dialog).toHaveCount(0);
		await expect(create).toBeFocused();

		await create.press('Enter');
		await name.fill('Project draft');
		await page.mouse.click(8, 100);
		const confirmation = page.getByRole('dialog', {
			name: chinese ? '放弃未保存的更改？' : 'Discard unsaved changes?',
			exact: true,
		});
		const keep = confirmation.getByRole('button', { name: chinese ? '继续编辑' : 'Keep editing', exact: true });
		const discard = confirmation.getByRole('button', { name: chinese ? '放弃更改' : 'Discard', exact: true });
		await expect(confirmation).toHaveAttribute('aria-modal', 'true');
		expect(await backdrop()).toBe('rgba(0, 0, 0, 0)');
		await expect(keep).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(discard).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(keep).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(confirmation).toHaveCount(0);
		await expect(name).toBeFocused();
		await expect(name).toHaveValue('Project draft');
		expect(await backdrop()).toBe(formBackdrop);
		await dialog.getByRole('button', { name: chinese ? '取消' : 'Cancel', exact: true }).click();
		await discard.click();
		await expect(dialog).toHaveCount(0);
		await expect(create).toBeFocused();
	});

	for (const locale of ['en', 'zh-CN']) test(`Code opens and creates an environment from the new conversation (${locale})`, async () => {
		const { page, info: testInfo } = browserTests;
		const chinese = locale === 'zh-CN';
		await page.goto(`/sessions.html?multiHost&catalog&search&projectPicker&environmentSetup&locale=${locale}`);
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		if (chinese) await page.evaluate(() => window.ashSessionsIntegration.setTheme('ash-high-contrast-dark'));
		await page.locator('.ash-window-mode-control').getByRole('button', { name: chinese ? '代码' : 'Code', exact: true }).click();
		await page.locator('[data-action-id="sessions.newSession"] button').click();
		const chat = page.locator('.ash-sessions-chat-slot.active .ash-chat');
		const card = chat.locator('.ash-sessions-environment-card');
		const trigger = card.getByRole('button', { name: chinese ? '选择环境' : 'Choose environment', exact: true });
		const project = chat.locator('.ash-sessions-workspace-picker');
		const host = chat.locator('.ash-sessions-environment-picker');
		const dialog = page.getByRole('dialog', { name: chinese ? '新建环境' : 'New Environment', exact: true });
		const name = dialog.getByRole('textbox', { name: chinese ? '名称' : 'Name', exact: true });
		await expect(trigger).toBeVisible();
		await host.press('Enter');
		const environmentMenu = page.locator('.ash-sessions-environment-menu');
		const localEnvironment = environmentMenu.getByRole('menuitemradio', { name: chinese ? '此电脑' : 'This Computer', checked: true, exact: true });
		const localLabel = localEnvironment.locator('.ash-button-label');
		const localCheck = localEnvironment.locator('.ash-menu-trailing-slot [data-ash-icon-id="check"]');
		await expect(localEnvironment.locator('.ash-menu-leading-slot [data-ash-icon-id="local"]')).toBeVisible();
		await expect(localCheck).toBeVisible();
		const labelBounds = (await localLabel.boundingBox())!;
		const checkBounds = (await localCheck.boundingBox())!;
		expect(checkBounds.x).toBeGreaterThanOrEqual(labelBounds.x + labelBounds.width);
		await page.keyboard.press('Escape');
		await expect(environmentMenu).toBeHidden();
		await expect(host).toBeFocused();
		const recentProjects = card.getByRole('group', { name: chinese ? '最近打开的项目' : 'Recent projects', exact: true });
		const recentProject = recentProjects.getByRole('button', { name: 'host-a', exact: true });
		await expect(project).toHaveText(chinese ? '选择项目' : 'Choose project');
		await recentProject.press('Enter');
		await expect(project).toHaveText('Code project fixture');
		await expect(recentProject).toHaveAttribute('aria-pressed', 'true');
		await expect(card).toHaveCSS('border-style', 'solid');
		const bounds = (await card.boundingBox())!;
		const chatBounds = (await chat.boundingBox())!;
		const composerBounds = (await chat.locator('.ash-chat-input-part').boundingBox())!;
		expect(bounds.x + bounds.width / 2).toBeCloseTo(chatBounds.x + chatBounds.width / 2, 0);
		expect(bounds.y + bounds.height).toBeLessThan(composerBounds.y);
		await page.screenshot({ path: testInfo.outputPath(`new-chat-environment-${locale}.png`) });
		await trigger.press('Enter');
		await expect(dialog).not.toHaveAttribute('aria-modal', 'true');
		await expect(name).toBeFocused();
		await expect(name).toHaveValue('host-a');
		const runInLabel = chinese ? '运行位置' : 'Run in';
		const runIn = dialog.getByRole('button', { name: runInLabel, exact: true });
		const hosts = dialog.getByRole('menu', { name: runInLabel, exact: true });
		const thisComputer = hosts.getByRole('menuitemradio', { name: chinese ? '此电脑' : 'This Computer', exact: true });
		await expect(runIn).toBeVisible();
		const worktreeLabel = chinese ? '/workspace/host-a 的工作树' : 'Worktree for /workspace/host-a';
		const worktree = dialog.getByRole('button', { name: worktreeLabel, exact: true });
		await expect(worktree).toBeVisible();
		await expect(dialog.getByRole('button', { name: chinese ? '环境变量' : 'Environment variables', exact: true })).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath(`new-environment-dialog-${locale}.png`) });
		await runIn.press('ArrowDown');
		await expect(hosts).toBeVisible();
		await expect(thisComputer).toHaveAttribute('aria-checked', 'true');
		await expect(hosts.getByRole('menuitem', { name: chinese ? '云端（不可用）' : 'Cloud (unavailable)', exact: true })).toBeDisabled();
		const hostPopup = dialog.locator('.ash-action-widget').filter({ has: page.getByRole('menu', { name: runInLabel, exact: true }) });
		const expectHostMenuAligned = () => expect.poll(async () => {
			const triggerBounds = (await runIn.boundingBox())!;
			const popupBounds = (await hostPopup.boundingBox())!;
			return Math.max(Math.abs(popupBounds.x - triggerBounds.x), Math.abs(popupBounds.x + popupBounds.width - triggerBounds.x - triggerBounds.width));
		}).toBeLessThan(0.5);
		await expectHostMenuAligned();
		await page.screenshot({ path: testInfo.outputPath(`new-environment-host-menu-${locale}.png`) });
		const viewport = page.viewportSize()!;
		const initialTriggerWidth = (await runIn.boundingBox())!.width;
		await page.setViewportSize({ width: 450, height: viewport.height });
		await expect.poll(async () => (await runIn.boundingBox())!.width).toBeLessThan(initialTriggerWidth);
		await expectHostMenuAligned();
		await page.setViewportSize(viewport);
		await expectHostMenuAligned();
		await page.keyboard.press('Escape');
		await expect(hosts).toHaveCount(0);
		await expect(runIn).toBeFocused();
		await worktree.press('Enter');
		const worktrees = dialog.getByRole('menu', { name: worktreeLabel, exact: true });
		await expect(worktrees.getByRole('menuitemradio', { name: chinese ? '原始文件夹' : 'Original folder', exact: true })).toHaveAttribute('aria-checked', 'true');
		await page.keyboard.press('Escape');
		await expect(worktrees).toHaveCount(0);
		await expect(worktree).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect(trigger).toBeFocused();
		await trigger.press('Space');
		await name.fill('Fixture environment');
		await dialog.getByRole('button', { name: chinese ? '关闭对话框' : 'Close Dialog', exact: true }).click();
		const confirmation = page.getByRole('dialog', { name: chinese ? '放弃未保存的更改？' : 'Discard unsaved changes?', exact: true });
		await confirmation.getByRole('button', { name: chinese ? '继续编辑' : 'Keep editing', exact: true }).click();
		await expect(name).toHaveValue('Fixture environment');
		await dialog.getByRole('button', { name: chinese ? '创建环境' : 'Create environment', exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expect(host).toHaveText('Fixture environment');
		await expect(project).toHaveText('Code project fixture');
		await expect(trigger).toBeFocused();
		await page.locator('.ash-sessions-list').getByRole('button', { name: 'Task from Host A', exact: true }).click();
		await expect(trigger).toHaveCount(0);
		await page.locator('[data-action-id="sessions.newSession"] button').click();
		await trigger.press('Enter');
		await runIn.click();
		await hosts.getByRole('menuitemradio', { name: 'Host A', exact: true }).click();
		await expect(runIn).toHaveText('Host A');
		await expect(runIn).toBeFocused();
		await runIn.click();
		await thisComputer.click();
		await expect(runIn).toHaveText(chinese ? '此电脑' : 'This Computer');
		await dialog.getByRole('button', { name: chinese ? '+ 添加' : '+ Add', exact: true }).click();
		await dialog.getByRole('button', { name: 'host-a', exact: true }).click();
		await name.fill('Local folder environment');
		await dialog.getByRole('button', { name: chinese ? '创建环境' : 'Create environment', exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expect(host).toHaveText('Local folder environment');
		await expect(project).toHaveText('Code project fixture');
	});

	for (const locale of ['en', 'zh-CN']) test(`Sessions typography stays independent of IDE defaults (${locale})`, async function () {
		const { page, context, info: testInfo } = browserTests;
		const chinese = locale === 'zh-CN';
		if (chinese) await page.goto('/sessions.html?catalog&locale=zh-CN');
		const sessionsWindow = page.locator('.ash-sessions-window');
		const input = page.locator('.ash-sessions-chat-slot.active .ash-chat-input-editor .stanza-editor');
		await expect(sessionsWindow).toHaveCSS('font-size', '14px');
		await expect(page.locator('.ash-sessions-list-label')).toHaveCount(0);
		await input.getByRole('textbox').focus();
		await page.keyboard.insertText('Typography draft');
		await expect(page.locator('.ash-sessions-list-label').first()).toHaveCSS('font-size', '14px');
		await expect(page.getByRole('note')).toHaveCSS('font-size', '14px');
		await expect(page.getByRole('note').locator('p').first()).toHaveCSS('font-size', '14px');
		await expect(input).toHaveCSS('font-size', '14px');
		await expect(input).toHaveCSS('line-height', '21px');
		const accounts = page.getByRole('button', { name: chinese ? '账户' : 'Accounts', exact: true });
		const settingsAction = page.getByRole('menuitem', { name: chinese ? '设置' : 'Settings', exact: true });
		const settings = page.locator('.ash-sessions-settings');
		await accounts.click();
		await settingsAction.click();
		await settings.getByRole('button', { name: chinese ? '外观' : 'Appearance', exact: true }).click();
		const follow = settings.getByRole('switch', { name: chinese ? '自动跟随新回复' : 'Automatically follow new replies', exact: true });
		await expect(follow).toHaveAttribute('aria-checked', 'true');
		await follow.press('Space');
		await expect(follow).toHaveAttribute('aria-checked', 'false');
		await expect(follow).toBeEnabled();
		await follow.press('Space');
		await expect(follow).toHaveAttribute('aria-checked', 'true');
		await expect(follow).toBeEnabled();
		await settings.getByRole('searchbox').fill('@id:chat.input.fontSize');
		const fontSize = settings.locator('[data-settings-item-id="chat.input.fontSize"]').getByRole('spinbutton');
		await expect(fontSize).toHaveValue('14');
		await fontSize.fill('18');
		await fontSize.press('Tab');
		const search = settings.getByRole('searchbox');
		await search.fill('');
		await search.press('Escape');
		await expect(settings).toBeHidden();
		await expect(input).toHaveCSS('font-size', '18px');
		await expect(input).toHaveCSS('line-height', '27px');
		await page.evaluate(() => window.ashSessionsIntegration.updateConfiguration('chat.input.fontSize', undefined));
		await expect(input).toHaveCSS('font-size', '14px');
		await expect(input).toContainText('Typography draft');
		for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
			await page.evaluate(theme => window.ashSessionsIntegration.setTheme(theme), theme);
			await expect(sessionsWindow).toHaveCSS('font-size', '14px');
			await expect(page.locator('.ash-sessions-list-item').first()).toHaveCSS('height', '32px');
			await expect(page.locator('.ash-sessions-list-section-toggle').first()).toHaveCSS('height', '32px');
			await expect(input).toHaveCSS('font-size', '14px');
			await expect(page.locator('[data-action-id="sessions.newSession"] button')).toHaveCSS('font-size', '14px');
		}
		await page.evaluate(() => window.ashSessionsIntegration.setTheme('ash-light'));
		await page.screenshot({ path: testInfo.outputPath(`sessions-typography-${locale}.png`) });
		await page.locator('[data-action-id="sessions.open.projects"] > .ash-sessions-activity-item').click();
		await expect(page.locator('.ash-projects')).toHaveCSS('font-size', '14px');
		await expect(page.locator('.ash-projects').getByRole('button', { name: chinese ? '新建项目' : 'New project', exact: true }).first()).toHaveCSS('font-size', '14px');
		await accounts.click();
		await expect(settingsAction).toHaveCSS('font-size', '14px');
		await settingsAction.click();
		await expect(settings.getByRole('searchbox')).toHaveCSS('font-size', '14px');
		await settings.getByRole('searchbox').fill('@id:sessions.experimental.layoutScope');
		await expect(settings.locator('[data-settings-item-id="sessions.experimental.layoutScope"] .ash-configuration-setting-description:not([hidden])')).toHaveCSS('font-size', '14px');
		await page.screenshot({ path: testInfo.outputPath(`sessions-typography-settings-${locale}.png`) });
		const ide = await context.newPage();
		try {
			await ide.goto('/chatInput.html?inlineCode=1');
			await expect(ide.locator('.ash-chat-input-editor .stanza-editor')).toHaveCSS('font-size', '13px');
			await expect(ide.locator('.ash-chat-input-mode-action')).toHaveCSS('font-size', '12px');
		} finally {
			await ide.close();
		}
	});
});
