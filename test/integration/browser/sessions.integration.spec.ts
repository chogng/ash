import { expect, test, type Locator, type Page } from '@playwright/test';
import { EditorGroup } from '../../automation/editors.js';
import { QuickAccess } from '../../automation/quickaccess.js';
import { StorageTarget } from '../../../src/ash/platform/storage/common/storage.js';

const runtimeErrors = new WeakMap<Page, string[]>();

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
	await expect(icons).toHaveCount(horizontal || labeled ? 4 : 5);
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


test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	const consoleErrors: string[] = [];
	runtimeErrors.set(page, consoleErrors);
	page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/sessions.html');
	await expect.poll(async () => ({ ready: await page.locator('body').getAttribute('data-ready'), errors })).toEqual({ ready: 'true', errors: [] });
});

test.afterEach(async ({ page }) => {
	await expect.poll(() => page.evaluate(() => ({ errors: window.ashSessionsIntegration.errors, details: window.ashSessionsIntegration.errorDetails }))).toEqual({ errors: [], details: [] });
	expect(runtimeErrors.get(page)).toEqual([]);
});

for (const locale of ['en', 'zh-CN']) test(`Sessions Search filters host sessions and restores navigation focus (${locale})`, async ({ page }, testInfo) => {
	await page.goto(`/sessions.html?multiHost&search&locale=${locale}`);
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const search = page.locator('[data-action-id="sessions.search"] button');
	const navigation = page.locator('.ash-sessions-navigation [data-action-id]');
	expect((await navigation.evaluateAll(items => items.map(item => item.getAttribute('data-action-id')))).slice(0, 2)).toEqual(['sessions.newSession', 'sessions.search']);
	await expect(search).toHaveAccessibleName(locale === 'en' ? 'Search' : '搜索');
	await search.focus();
	await search.press('Enter');
	const picker = page.locator('.ash-sessions-search-dialog');
	const input = picker.getByRole('combobox');
	await expect(input).toBeFocused();
	await expect(picker).toHaveAttribute('aria-modal', 'true');
	await expect(page.locator('.ash-quick-input-host:not([hidden])')).toHaveCount(0);
	if (locale === 'en') {
		await input.press('Alt+F1');
		const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
		await expect(help.getByRole('textbox')).toHaveValue(/Search finds saved sessions/);
		await help.press('Escape');
		await expect(help).toHaveCount(0);
		await expect(input).toBeFocused();
	}
	const initialBounds = (await picker.boundingBox())!;
	const viewport = page.viewportSize()!;
	expect(Math.abs(initialBounds.x + initialBounds.width / 2 - viewport.width / 2)).toBeLessThan(2);
	expect(Math.abs(initialBounds.y + initialBounds.height / 2 - viewport.height / 2)).toBeLessThan(2);
	for (let step = 0; step < 10; step++) {
		await page.keyboard.press('Tab');
		expect(await picker.evaluate(element => element.contains(document.activeElement))).toBe(true);
	}
	await input.focus();
	await expect(picker.getByRole('tab')).toHaveText(locale === 'en' ? ['All', 'Sessions', 'Projects', 'Scheduled'] : ['全部', '会话', '项目', '计划']);
	await expect(picker.getByRole('option', { name: /Search project fixture/ })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath(`sessions-search-full-${locale}.png`) });
	await input.fill('Task from Host B');
	await expect(picker.getByRole('option')).toHaveCount(1);
	await expect(picker.getByRole('option')).toContainText('Task from Host B');
	await picker.getByRole('tab', { name: locale === 'en' ? 'Projects' : '项目', exact: true }).click();
	await expect(picker.getByRole('option')).toHaveCount(0);
	await expect(input).toHaveValue('Task from Host B');
	await page.keyboard.press('ArrowLeft');
	await page.keyboard.press('Enter');
	await expect(picker.getByRole('tab', { name: locale === 'en' ? 'Sessions' : '会话', exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(picker.getByRole('option')).toHaveCount(1);
	await page.keyboard.press('ArrowDown');
	await expect(input).toBeFocused();
	await input.press('Enter');
	await expect(picker).toHaveCount(0);
	await expect(page.locator('.ash-sessions-chat-slot.active > [role="region"]')).toHaveAccessibleName('Task from Host B');
	await expect.poll(() => page.evaluate(() => window.ashSessionsIntegration.multiHost!.calls.some(call => call.host === 'Host B' && call.method === 'subscribe'))).toBe(true);
	await search.click();
	await input.fill('missing_search_result');
	await expect(picker.locator('.ash-sessions-search-empty')).toBeVisible();
	await input.press('Escape');
	await expect(picker).toHaveCount(0);
	await expect(search).toBeFocused();
	await search.click();
	await input.fill('Daily search fixture');
	await picker.getByRole('tab', { name: locale === 'en' ? 'Scheduled' : '计划', exact: true }).click();
	await expect(picker.getByRole('option')).toHaveCount(1);
	await picker.getByRole('option').click();
	const scheduleDialog = page.getByRole('dialog', { name: locale === 'en' ? 'Edit automation' : '编辑自动化', exact: true });
	await expect(scheduleDialog).toBeVisible();
	await expect(scheduleDialog.locator('input').first()).toHaveValue('Daily search fixture');
	await scheduleDialog.press('Escape');
	await expect(scheduleDialog).toHaveCount(0);
	await search.click();
	await input.fill('Search project fixture');
	await expect(picker.getByRole('option')).toHaveCount(1);
	await input.press('Enter');
	await expect(page.locator('.ash-projects h1')).toHaveText('Search project fixture');
	if (!await search.isVisible()) { await page.getByRole('button', { name: locale === 'en' ? 'Show sidebar' : '显示侧栏', exact: true }).click(); }
	for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
		await page.evaluate(theme => window.ashSessionsIntegration.setTheme(theme), theme);
		await search.click();
		expect(await picker.evaluate(element => getComputedStyle(element).color !== getComputedStyle(element).backgroundColor)).toBe(true);
		await input.press('Escape');
	}
	await page.evaluate(() => window.ashSessionsIntegration.setTheme('ash-light'));
	await page.setViewportSize({ width: 700, height: 650 });
	await search.click();
	const bounds = (await picker.boundingBox())!;
	expect(bounds.x).toBeGreaterThanOrEqual(0);
	expect(bounds.x + bounds.width).toBeLessThanOrEqual(700);
	await page.screenshot({ path: testInfo.outputPath(`sessions-search-${locale}.png`) });
	await picker.getByRole('button', { name: locale === 'en' ? 'Close' : '关闭', exact: true }).click();
	await expect(picker).toHaveCount(0);
	await expect(search).toBeFocused();
	await search.click();
	await page.mouse.click(4, 4);
	await expect(picker).toHaveCount(0);
	await expect(search).toBeFocused();
});

for (const locale of ['en', 'zh-CN']) test(`Workspace mode control aligns with the sidebar and supports keyboard navigation (${locale})`, async ({ page }, testInfo) => {
	if (locale === 'zh-CN') await page.goto('/sessions.html?locale=zh-CN');
	const modes = page.getByRole('toolbar', { name: locale === 'zh-CN' ? '界面模式' : 'Workspace mode', exact: true });
	const chat = modes.getByRole('button', { name: locale === 'zh-CN' ? '聊天 / Agents' : 'Chat / Agents', exact: true });
	const code = modes.getByRole('button', { name: locale === 'zh-CN' ? '代码' : 'Code', exact: true });
	await expect(chat).toHaveAttribute('aria-pressed', 'true');
	await expect(code).toHaveAttribute('aria-pressed', 'false');
	const sidebar = await page.locator('[data-part="sidebar"]').boundingBox();
	const bounds = await modes.boundingBox();
	expect(bounds!.x + bounds!.width).toBeCloseTo(sidebar!.x + sidebar!.width - 16, 0);
	const history = page.locator('[data-action-id="ash.sessions.back"] button');
	const forward = page.locator('[data-action-id="ash.sessions.forward"] button');
	await expect(history).toBeVisible();
	await expect(forward).toBeVisible();
	await expect(history).toHaveAccessibleName(locale === 'zh-CN' ? '后退' : 'Back');
	await expect(forward).toHaveAccessibleName(locale === 'zh-CN' ? '前进' : 'Forward');
	await expect(history.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'chevron-left');
	await expect(forward.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'chevron-right');
	await expect(history).toBeDisabled();
	await expect(forward).toBeDisabled();
	const sashes = await page.getByRole('separator').all();
	let resized = false;
	for (const sash of sashes) {
		const box = await sash.boundingBox();
		if (!box || box.height < 200 || Math.abs(box.x - sidebar!.x - sidebar!.width) > 8) continue;
		await sash.focus();
		for (let i = 0; i < 16; i++) await sash.press('ArrowRight');
		resized = true;
		break;
	}
	expect(resized).toBe(true);
	await expect(history).toBeVisible();
	const expandedSidebar = await page.locator('[data-part="sidebar"]').boundingBox();
	const expandedModes = await modes.boundingBox();
	expect(expandedModes!.x + expandedModes!.width).toBeCloseTo(expandedSidebar!.x + expandedSidebar!.width - 16, 0);
	await chat.focus();
	await chat.press('ArrowRight');
	await expect(code).toBeFocused();
	await expect(chat).toHaveAttribute('aria-pressed', 'true');
	await code.press('Home');
	await expect(chat).toBeFocused();
	await chat.press('End');
	await expect(code).toBeFocused();
	await code.press('ArrowLeft');
	await chat.press('Enter');
	await expect(page.locator('.ash-sessions-chat-view:visible .ash-chat-input-editor').getByRole('textbox')).toBeFocused();
	for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
		await page.evaluate(theme => window.ashSessionsIntegration.setTheme(theme), theme);
		await expect(chat).toHaveCSS('width', '32px');
		await expect(chat).toHaveCSS('height', '28px');
		await expect(chat.locator('.ash-icon')).toHaveCSS('width', '16px');
		if (theme.includes('high-contrast')) {
			await expect(chat).not.toHaveCSS('border-color', 'rgba(0, 0, 0, 0)');
		}
		await page.screenshot({ path: testInfo.outputPath(`window-mode-${theme}.png`) });
	}
	await page.setViewportSize({ width: 600, height: 700 });
	await expect(modes).toBeVisible();
	await expect(history).toBeVisible();
	await expect(forward).toBeVisible();
	const narrow = await modes.boundingBox();
	expect(narrow!.x).toBeGreaterThanOrEqual(0);
	expect(narrow!.x + narrow!.width).toBeLessThanOrEqual(600);
	const forwardBounds = (await forward.boundingBox())!;
	expect(forwardBounds.x + forwardBounds.width).toBeLessThanOrEqual(narrow!.x);
	await page.locator('[data-action-id="ash.sessions.toggleSidebar"] button').click();
	await expect(modes).toBeHidden();
	await expect(history).toBeVisible();
	await expect(forward).toBeVisible();
});

for (const locale of ['en', 'zh-CN']) test(`Workspace mode switches Chat and Code pages in this window and retains the draft (${locale})`, async ({ page }, testInfo) => {
	await page.goto(`/sessions.html?locale=${locale}`);
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const modes = page.getByRole('toolbar', { name: locale === 'zh-CN' ? '界面模式' : 'Workspace mode', exact: true });
	const chat = modes.getByRole('button', { name: locale === 'zh-CN' ? '聊天 / Agents' : 'Chat / Agents', exact: true });
	const code = modes.getByRole('button', { name: locale === 'zh-CN' ? '代码' : 'Code', exact: true });
	const pane = page.locator('.ash-sessions-chat-view:visible .ash-sessions-chat-slot > [role="region"]');
	const root = await page.locator('.ash-sessions-window').elementHandle();
	const url = page.url();
	const pageCount = page.context().pages().length;
	const draft = 'A retained draft across workspace pages';
	await pane.locator('.ash-chat-input-editor').getByRole('textbox').focus();
	await page.keyboard.insertText(draft);
	const session = await pane.getAttribute('data-untitled-session-id');
	await expect(chat.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'chat-1');
	for (const mode of [code, chat]) {
		await mode.click();
		await expect(mode).toHaveAttribute('aria-pressed', 'true');
		await expect(pane.locator(mode === code ? '.ash-sessions-chat-input' : '.ash-sessions-cowork-input')).toBeVisible();
		const sidebar = await page.locator('[data-part="sidebar"]').boundingBox();
		const bounds = await modes.boundingBox();
		expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(sidebar!.x + sidebar!.width);
		await expect(pane.locator('.ash-chat-input-editor')).toContainText(draft);
		await expect(pane).toHaveAttribute('data-untitled-session-id', session!);
		expect(page.url()).toBe(url);
		expect(page.context().pages()).toHaveLength(pageCount);
		expect(await root!.evaluate(element => element === document.querySelector('.ash-sessions-window'))).toBe(true);
	}
	await code.click();
	await expect(code).toHaveAttribute('aria-pressed', 'true');
	await page.screenshot({ path: testInfo.outputPath(`code-page-${locale}.png`) });
	await chat.click();
	await expect(chat).toHaveAttribute('aria-pressed', 'true');
	await expect(pane.locator('.ash-chat-input-editor')).toContainText(draft);
});

for (const locale of ['en', 'zh-CN']) test(`Code workspace owns New, Automations, Collab, Agent Teams and Symphony navigation (${locale})`, async ({ page }, testInfo) => {
	await page.goto(`/sessions.html?automations=1&locale=${locale}`);
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const chinese = locale === 'zh-CN';
	const modes = page.locator('.ash-window-mode-control');
	const code = modes.getByRole('button', { name: chinese ? '代码' : 'Code', exact: true });
	const chat = modes.getByRole('button', { name: 'Chat / Agents', exact: true }).or(modes.getByRole('button', { name: '聊天 / Agents', exact: true }));
	const navigation = page.locator('.ash-sessions-navigation');
	await expect(navigation.getByRole('button').locator('.ash-icon-label-text')).toHaveText(chinese ? ['新建', '搜索', '项目', 'Creator'] : ['New', 'Search', 'Projects', 'Creator']);
	await expect(navigation.locator('[data-action-id="sessions.open.code"]')).toHaveCount(0);
	await code.click();
	await expect(page.locator('.ash-sessions-activity-content')).toHaveAttribute('data-workspace-mode', 'code');
	const expected = chinese ? ['新建', '搜索', '自动化', 'Collab', 'Agent 团队', 'Symphony'] : ['New', 'Search', 'Automations', 'Collab', 'Agent Teams', 'Symphony'];
	await expect(navigation.getByRole('button').locator('.ash-icon-label-text')).toHaveText(expected);
	await expect(page.locator('.ash-sessions-list[data-mode=code]')).toBeVisible();
	await expect(page.locator('.ash-sessions-list:visible')).toHaveCount(1);
	await navigation.getByRole('button', { name: chinese ? '新建' : 'New', exact: true }).click();
	await expect(code).toHaveAttribute('aria-pressed', 'true');
	await expect(page.locator('.ash-sessions-chat-view:visible .ash-sessions-chat-input')).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath(`code-navigation-${locale}.png`) });
	await navigation.getByRole('button', { name: 'Collab', exact: true }).click();
	await expect(navigation.getByRole('button', { name: 'Collab', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(code).toHaveAttribute('aria-pressed', 'true');
	await expect(navigation.getByRole('button').locator('.ash-icon-label-text')).toHaveText(expected);
	const teams = navigation.getByRole('button', { name: chinese ? 'Agent 团队' : 'Agent Teams', exact: true });
	await teams.click();
	await expect(page.locator('.ash-teams-panel')).toBeVisible();
	await expect(teams).toHaveAttribute('aria-current', 'page');
	await expect(code).toHaveAttribute('aria-pressed', 'true');
	await page.evaluate(() => window.ashSessionsIntegration.remountAfterDirectDispose());
	await expect(page.locator('.ash-teams-panel')).toBeVisible();
	await expect(teams).toHaveAttribute('aria-current', 'page');
	await expect(code).toHaveAttribute('aria-pressed', 'true');
	await expect(navigation.getByRole('button').locator('.ash-icon-label-text')).toHaveText(expected);
	await navigation.getByRole('button', { name: 'Symphony', exact: true }).click();
	await expect(page.locator('.ash-symphony-monitor')).toBeVisible();
	await expect(code).toHaveAttribute('aria-pressed', 'true');
	await navigation.getByRole('button', { name: chinese ? '自动化' : 'Automations', exact: true }).click();
	await expect(page.locator('[data-part="customview"]')).toBeVisible();
	await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
	await expect(code).toHaveAttribute('aria-pressed', 'true');
	await expect(navigation.getByRole('button').locator('.ash-icon-label-text')).toHaveText(expected);
	await page.evaluate(() => window.ashSessionsIntegration.remountAfterDirectDispose());
	await expect(page.locator('[data-part="customview"]')).toBeVisible();
	await expect(code).toHaveAttribute('aria-pressed', 'true');
	await expect(navigation.getByRole('button').locator('.ash-icon-label-text')).toHaveText(expected);
	await expect(page.locator('.ash-sessions-list[data-mode=code]')).toBeVisible();
	await chat.click();
	await expect(page.locator('[data-part="customview"]')).toBeHidden();
	await expect(page.locator('.ash-sessions-list')).toBeVisible();
	await expect(navigation.getByRole('button').locator('.ash-icon-label-text')).toHaveText(chinese ? ['新建', '搜索', '项目', 'Creator'] : ['New', 'Search', 'Projects', 'Creator']);
});

test('Sessions reports browser errors and rejected promises once without rethrowing', async ({ page }) => {
	const messages: string[] = [];
	page.on('console', message => {
		if (message.type() === 'error' && message.text().includes('sessions-runtime-probe')) messages.push(message.text());
	});
	await page.evaluate(() => {
		setTimeout(() => { throw new Error('sessions-runtime-probe exception'); }, 0);
		void Promise.reject(new Error('sessions-runtime-probe rejection'));
	});
	await expect.poll(() => page.evaluate(() => [...window.ashSessionsIntegration.errors].sort())).toEqual([
		'Error: sessions-runtime-probe exception',
		'Error: sessions-runtime-probe rejection',
	]);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await expect(page.locator('.ash-editor-title-control').getByRole('tab', { name: 'Changes', exact: true })).toBeVisible();
	expect(messages).toHaveLength(2);
	expect(runtimeErrors.get(page)).toEqual(messages);
	runtimeErrors.get(page)!.splice(0);
	expect(await page.evaluate(() => window.ashSessionsIntegration.takeErrors().length)).toBe(2);
	expect(await page.evaluate(() => window.ashSessionsIntegration.disposeAndCheckErrorHandler())).toBe(true);
});

for (const locale of ['en', 'zh-CN']) test(`Projects keeps global navigation, width and window expansion state (${locale})`, async ({ page }, testInfo) => {
	if (locale === 'zh-CN') await page.goto('/sessions.html?locale=zh-CN');
	const chinese = locale === 'zh-CN';
	const sidebar = page.locator('[data-part="sidebar"]');
	const navigation = page.locator('.ash-sessions-activity-content');
	const projects = navigation.getByRole('button', { name: chinese ? '项目' : 'Projects', exact: true });
	const toggle = page.locator('[data-action-id="ash.sessions.toggleSidebar"] button');
	const width = (await sidebar.boundingBox())!.width;
	await projects.click();
	const surface = page.locator('.ash-projects');
	await expect(surface).toBeVisible();
	await expect(projects).toHaveAttribute('aria-current', 'page');
	await expect(sidebar).toBeVisible();
	expect((await sidebar.boundingBox())!.width).toBeCloseTo(width, 0);
	await toggle.focus();
	await page.keyboard.press('Enter');
	await expect(sidebar).toBeHidden();
	await expect(surface).toBeVisible();
	await expect(toggle).toHaveAccessibleName(chinese ? '显示侧边栏' : 'Show sidebar');
	await toggle.focus();
	await page.keyboard.press('Space');
	await expect(sidebar).toBeVisible();
	await expect(projects).toHaveAttribute('aria-current', 'page');
	await expect(surface).toBeVisible();
	expect((await sidebar.boundingBox())!.width).toBeCloseTo(width, 0);
	await page.keyboard.press('Enter');
	await page.evaluate(() => window.ashSessionsIntegration.openChat());
	await expect(surface).toBeHidden();
	await expect(sidebar).toBeHidden();
	await toggle.focus();
	await page.keyboard.press('Space');
	await expect(sidebar).toBeVisible();
	await projects.click();
	await expect(surface).toBeVisible();
	await expect(projects).toHaveAttribute('aria-current', 'page');
	expect((await sidebar.boundingBox())!.width).toBeCloseTo(width, 0);
	await page.screenshot({ path: testInfo.outputPath(`projects-navigation-${locale}.png`) });
	const create = surface.getByRole('button', { name: chinese ? '新建项目' : 'New project', exact: true }).first();
	await expect(create).toHaveCSS('border-radius', '8px');
	await create.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(chinese ? /侧栏开关可隐藏或显示全局导航/ : /sidebar toggle hides or shows global navigation without leaving Projects/);
	await page.keyboard.press('Escape');
	await expect(create).toBeFocused();
});

test('New navigation creates distinct sessions in Code and preserves the previous draft', async ({ page }) => {
	const navigation = page.locator('.ash-sessions-activity-content');
	const pane = page.locator('.ash-sessions-chat-slot.active > [role="region"]');
	const draft = 'Retained draft before New';
	const original = await pane.getAttribute('data-untitled-session-id');
	await pane.locator('.ash-chat-input-editor').getByRole('textbox').focus();
	await page.keyboard.type(draft);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await navigation.getByRole('button', { name: 'New', exact: true }).click();
	await expect(page.locator('.ash-sessions-list-add')).toHaveCount(0);
	await expect(pane).not.toHaveAttribute('data-untitled-session-id', original!);
	const first = await pane.getAttribute('data-untitled-session-id');
	await expect(pane.locator('.chat-composer')).toBeVisible();
	await expect(pane.locator('.ash-chat-input-editor').getByRole('textbox')).toBeFocused();
	await expect(pane.locator('.ash-chat-input-editor')).not.toContainText(draft);
	await navigation.getByRole('button', { name: 'New', exact: true }).click();
	await expect(pane).not.toHaveAttribute('data-untitled-session-id', first!);
	await page.getByRole('button', { name: 'Back', exact: true }).click();
	await expect(pane).toHaveAttribute('data-untitled-session-id', first!);
	await page.getByRole('button', { name: 'Back', exact: true }).click();
	await expect(pane).toHaveAttribute('data-untitled-session-id', original!);
	await expect(pane.locator('.ash-chat-input-editor')).toContainText(draft);
	await page.getByRole('button', { name: 'Forward', exact: true }).click();
	await expect(pane).toHaveAttribute('data-untitled-session-id', first!);
});

test('Sessions can directly dispose and recreate a restored window without capturing released editor grids', async ({ page }) => {
	const navigation = page.locator('.ash-sessions-activity-content');
	for (let attempt = 0; attempt < 2; attempt++) {
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await expect(page.locator('[data-part="editor"] .ash-editor-title-control').getByRole('tab', { name: 'Changes', exact: true })).toBeVisible();
		await page.evaluate(() => window.ashSessionsIntegration.remountAfterDirectDispose());
		await expect(page.locator('.ash-sessions-window')).toHaveCount(1);
		await expect(page.locator('[data-action-id="sessions.newSession"] button')).toBeVisible();
	}
});

for (const locale of ['en', 'zh-CN']) test(`Automations management stays selected through window restoration and yields to explicit navigation (${locale})`, async ({ page }) => {
	await expect(page.getByRole('button', { name: 'Automations', exact: true })).toHaveCount(0);
	await page.goto(`/sessions.html?automations=1&locale=${locale}`);
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const chinese = locale === 'zh-CN';
	if (chinese) await page.evaluate(() => window.ashSessionsIntegration.setTheme('ash-high-contrast-dark'));
	const activity = page.locator('.ash-sessions-activity-content');
	const manage = activity.getByRole('button', { name: chinese ? '自动化' : 'Automations', exact: true });
	const custom = page.locator('[data-part="customview"]');
	const code = page.locator('.ash-window-mode-control').getByRole('button', { name: chinese ? '代码' : 'Code', exact: true });
	await code.click();
	await expect(manage.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'clockface');
	await expect(page.locator('.ash-sessions-list-navigation').getByRole('button', { name: chinese ? '自动化' : 'Automations', exact: true })).toHaveCount(0);
	await manage.focus();
	await manage.press('Enter');
	await expect(custom).toBeVisible();
	await expect(manage).toHaveAttribute('aria-current', 'page');
	await expect(manage.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'clockface');
	for (const part of ['sessions', 'editor', 'auxiliarybar', 'panel']) await expect(page.locator(`[data-part="${part}"]:visible`)).toHaveCount(0);
	await page.screenshot({ path: test.info().outputPath('automations-independent-page.png') });
	await expect(code).toHaveAttribute('aria-pressed', 'true');
	await expect(page.locator('.ash-sessions-list-item.selected')).toHaveCount(0);
	for (let attempt = 0; attempt < 2; attempt++) {
		await page.evaluate(() => window.ashSessionsIntegration.remountAfterDirectDispose());
		await expect(custom).toBeVisible();
		await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
		await expect(manage).toHaveAttribute('aria-current', 'page');
		await expect(code).toHaveAttribute('aria-pressed', 'true');
		await expect(page.locator('[data-part="auxiliarybar"]')).toBeHidden();
		await activity.getByRole('button', { name: chinese ? '新建' : 'New', exact: true }).click();
		await expect(custom).toBeHidden();
		await expect(code).toHaveAttribute('aria-pressed', 'true');
		await expect(manage.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'clockface');
		await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
		await expect(page.locator('[data-part="editor"] .ash-editor-title-control').getByRole('tab', { name: chinese ? '更改' : 'Changes', exact: true })).toBeVisible();
		await manage.click();
	}
	await activity.getByRole('button', { name: chinese ? '新建' : 'New', exact: true }).click();
	await expect(custom).toBeHidden();
	await expect(manage).not.toHaveAttribute('aria-current', 'page');
	await page.locator('.ash-window-mode-control').getByRole('button', { name: chinese ? '聊天 / Agents' : 'Chat / Agents', exact: true }).click();
	await page.locator('.ash-sessions-list-item').first().click();
	await expect(page.locator('.ash-sessions-list-item.selected')).toHaveCount(1);
});

test('Sessions owns shared panel placement across window layouts', async ({ page }) => {
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	const quick = new QuickAccess(page);
	await quick.runCommand('workbench.action.togglePanel');
	const panel = page.locator('[data-part="panel"]');
	await expect(panel).toBeVisible();
	for (const layout of ['flat', 'modern']) {
		await page.evaluate(layout => window.ashSessionsIntegration.updateConfiguration('sessions.layoutStyle', layout), layout);
		for (const [position, suffix, edge] of [['left', 'Left', 'right'], ['right', 'Right', 'left'], ['top', 'Top', 'bottom'], ['bottom', 'Bottom', 'top']] as const) {
			await quick.runCommand(`workbench.action.positionPanel${suffix}`);
			await expect(page.locator('.ash-sessions-workbench-layout')).toHaveAttribute('data-panel-position', position);
			await expect(panel).toBeVisible();
			await expect(panel).toHaveCSS(`border-${edge}-width`, '1px');
			const bounds = await panel.boundingBox();
			expect(bounds!.width).toBeGreaterThan(0);
			expect(bounds!.height).toBeGreaterThan(0);
		}
	}
});

test('Code defaults stay in document groups after opening the Trace editor', async ({ page }) => {
	await new QuickAccess(page).runCommand('sessions.trace.import');
	await expect(page.locator('.ash-agent-trace')).toBeVisible();
	const navigation = page.locator('.ash-sessions-activity-content');
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	const tabs = page.locator('[data-part="editor"] .ash-editor-title-control');
	await expect(tabs.getByRole('tab', { name: 'Files', exact: true })).toBeVisible();
	await expect(tabs.getByRole('tab', { name: 'Changes', exact: true })).toBeVisible();
	await expect(page.locator('[data-part="auxiliarybar"] [data-view-id="sessions.files.explorer.empty"]')).toBeFocused();
	await expect(navigation.getByRole('button', { name: 'Trace', exact: true })).toHaveCount(0);
	await new QuickAccess(page).runCommand('sessions.open.trace');
	await expect(page.locator('.ash-agent-trace')).toBeVisible();
	await expect(page.locator('.ash-agent-trace').locator('.ash-editor-title-control')).toHaveCount(0);
});

for (const locale of ['en', 'zh-CN']) test(`Chat and Code show sidebar conversations without editor tabs (${locale})`, async ({ page }, testInfo) => {
	await page.goto(`/sessions.html?locale=${locale}`);
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const chinese = locale === 'zh-CN';
	const navigation = page.locator('.ash-sessions-activity-content');
	const conversations = page.locator('.ash-sessions-chat-view:visible');
	const pane = conversations.locator('.ash-sessions-chat-slot > [role="region"]');
	const input = pane.locator('.ash-chat-input-editor').getByRole('textbox');
	const draft = 'Synthetic retained conversation draft';
	const selectedTitle = await page.locator('.ash-sessions-list-item.selected .ash-sessions-list-label').textContent();
	const retainedGrid = await conversations.locator('.ash-sessions-chat-grid').elementHandle();
	const retainedSession = await conversations.locator('.ash-sessions-chat-slot').elementHandle();
	await expect(pane).toHaveCount(1);
	await input.focus();
	await page.keyboard.type(draft);

	for (const entry of [chinese ? '代码' : 'Code', chinese ? '新建' : 'New']) {
		if (entry === (chinese ? '新建' : 'New')) { await page.evaluate(() => window.ashSessionsIntegration.openChat()); }
		else { await page.locator('.ash-window-mode-control').getByRole('button', { name: entry, exact: true }).press('Enter'); }
		await expect(pane).toHaveCount(1);
		await expect(conversations.getByRole('tab')).toHaveCount(0);
		await expect(conversations.locator('.ash-editor-group, .ash-editor-title-control')).toHaveCount(0);
		await expect(pane).not.toHaveAttribute('aria-labelledby');
		expect(await retainedGrid!.evaluate(element => element.isConnected && element === document.querySelector('.ash-sessions-chat-grid'))).toBe(true);
		expect(await retainedSession!.evaluate(element => element.isConnected && element === document.querySelector('.ash-sessions-chat-slot'))).toBe(true);

		await expect(pane).toHaveAttribute('aria-label', selectedTitle!);
		await expect(pane.locator('.ash-chat-input-editor')).toContainText(draft);
		await input.focus();
		await expect(input).toBeFocused();
		const bounds = await conversations.evaluate(element => {
			const group = element.querySelector('.ash-sessions-chat-grid')!.getBoundingClientRect();
			const chat = element.querySelector('.ash-sessions-chat-slot')!.getBoundingClientRect();
			return { topInset: chat.top - group.top, heightDifference: group.height - chat.height };
		});
		expect(bounds).toEqual({ topInset: 0, heightDifference: 0 });
		await page.screenshot({ path: testInfo.outputPath(`conversation-${entry}-${locale}.png`) });
	}
	await page.evaluate(() => window.ashSessionsIntegration.setTheme('ash-high-contrast-dark'));
	await page.setViewportSize({ width: 900, height: 700 });
	await expect(conversations.getByRole('tab')).toHaveCount(0);
	await expect(input).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath(`conversation-without-tabs-${locale}.png`) });
	const closedIdentity = await pane.getAttribute('data-untitled-session-id');
	const quickAccess = new QuickAccess(page);
	await quickAccess.open('>sessionsViewPane.closeSession');
	await quickAccess.select(chinese ? '关闭会话' : 'Close Session');
	await expect(pane).not.toHaveAttribute('data-untitled-session-id', closedIdentity!);
	await expect(pane.locator('.ash-chat-input-editor')).not.toContainText(draft);
	await expect.poll(() => page.evaluate(identity => {
		const state = JSON.parse(localStorage.getItem('ash.storage.workspace.sessions')!);
		return state.entries[`sessions.inputDraft:untitled:${identity}`];
	}, closedIdentity)).toBeUndefined();
});

test('a corrupt legacy draft reports its failure while other drafts and startup survive', async ({ page }) => {
	await page.addInitScript(target => {
		localStorage.setItem('ash.storage.workspace.sessions', JSON.stringify({
			version: 1, entries: {
				'sessions.draftState:broken': { value: '{broken', target },
				'sessions.codeDraftState:untitled:saved': { value: JSON.stringify({ mode: 'agent', text: 'synthetic preserved draft', contexts: [] }), target },
			}
		}));
	}, StorageTarget.MACHINE);
	await page.evaluate(() => window.ashSessionsIntegration.disposeAndCheckErrorHandler());
	await page.reload();
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await expect(page.getByRole('region', { name: 'Notifications', exact: true }).getByText(/^Could not restore the Chat draft:/u)).toBeVisible();
	const feedback = page.locator('.ash-sessions-window > .ash-feedback-host');
	await expect(feedback).toHaveCSS('position', 'absolute');
	await expect(feedback).toHaveCSS('bottom', '40px');
	const placement = await feedback.evaluate(element => {
		const host = element.parentElement!.getBoundingClientRect();
		const bounds = element.getBoundingClientRect();
		return { right: host.right - bounds.right, bottom: host.bottom - bounds.bottom };
	});
	expect(placement).toEqual({ right: 12, bottom: 40 });
	await expect(page.locator('[data-action-id="sessions.newSession"] button')).toBeVisible();
	expect(await page.evaluate(() => window.ashSessionsIntegration.disposeAndCheckErrorHandler())).toBe(true);
	const entries = await page.evaluate(() => JSON.parse(localStorage.getItem('ash.storage.workspace.sessions')!).entries);
	expect(entries['sessions.draftState:broken'].value).toBe('{broken');
	expect(entries['sessions.codeDraftState:untitled:saved']).toBeUndefined();
	expect(JSON.parse(entries['sessions.inputDraft:untitled:saved'].value)).toEqual({ mode: 'agent', text: 'synthetic preserved draft', contexts: [] });
});

test('Creator canvas responds to wheel, drag and keyboard input', async ({ page }) => {
	const creator = page.locator('.ash-sessions-navigation').getByRole('button', { name: 'Creator', exact: true });
	await creator.click();
	await expect(creator.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'symbol-color');
	await expect(creator).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('.ash-sessions-list:visible')).toBeHidden();
	await page.locator('.ash-creator').getByRole('button', { name: 'Design', exact: true }).click();
	const canvas = page.getByRole('region', { name: 'Design canvas' });
	await expect(canvas).toBeVisible();
	const tools = page.locator('.ash-design-tools-widget');
	const split = tools.locator('.ash-dropdown-with-primary-dropdown > .ash-button').first();
	await expect(split).toHaveCSS('width', '20px');
	await expect(split).toHaveCSS('height', '32px');
	await expect(split).toHaveCSS('padding', '0px');
	const tool = tools.locator('.ash-button').first();
	await expect(tool).toHaveCSS('width', '32px');
	await tool.hover();
	await expect(tool).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
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
	await page.getByRole('button', { name: 'New', exact: true }).click();
	await expect(canvas).toBeHidden();
});










test('multiple Agent hosts keep equal backend IDs, model scopes and retained Code/Cowork drafts isolated', async ({ page }) => {
	await page.goto('/sessions.html?multiHost');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const sidebar = page.locator('.ash-sessions-list');
	await expect(sidebar.locator('.ash-sessions-list-subgroup')).toHaveCount(0);
	await expect(sidebar.locator('[data-section=recent] > h3 button')).toHaveAccessibleName('Chats');
	await sidebar.getByRole('button', { name: 'Task from Host A', exact: true }).click();
	await sidebar.getByRole('button', { name: 'Task from Host B', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashSessionsIntegration.multiHost!.calls.filter(call => call.method === 'subscribe').map(call => call.host))).toEqual(expect.arrayContaining(['Host A', 'Host B']));
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await expect(sidebar.getByRole('heading', { name: 'Host A', exact: true })).toBeVisible();
	await expect(sidebar.getByRole('heading', { name: 'Host B', exact: true })).toBeVisible();
	await page.evaluate(() => window.ashSessionsIntegration.multiHost!.open('Host A', true));
	const active = page.locator('.ash-sessions-chat-slot.active');
	await active.locator('.stanza-editor-input').focus();
	await page.keyboard.insertText('Private Host A draft');
	await page.evaluate(() => window.ashSessionsIntegration.multiHost!.open('Host B', true));
	await active.locator('.stanza-editor-input').focus();
	await page.keyboard.insertText('Private Host B draft');
	await expect(active).toContainText('Host B model');
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	await sidebar.getByRole('button', { name: 'Host A draft', exact: true }).click();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await expect(active.locator('.stanza-editor-line-text')).toContainText('Private Host A draft');
	await expect(active).toContainText('Host A model');
	await page.evaluate(() => window.ashSessionsIntegration.openChat());
	await expect(active.locator('.stanza-editor-line-text')).toContainText('Private Host A draft');
	// Cowork has its own model preference; choose from the captured host's real catalog.
	await active.locator('.ash-chat-input-model-action').click();
	const modelPicker = page.locator('.ash-chat-model-picker');
	const automaticModel = modelPicker.getByRole('switch', { name: 'Auto', exact: true });
	await expect(automaticModel).toHaveAttribute('aria-checked', 'true');
	await automaticModel.focus();
	await automaticModel.press('Space');
	await expect(automaticModel).toHaveAttribute('aria-checked', 'false');
	await expect(modelPicker.getByRole('menuitemradio')).toHaveCount(1);
	await modelPicker.getByRole('menuitemradio', { name: 'Host A model', exact: true }).click();
	await expect(active).toContainText('Host A model');
	await sidebar.getByRole('button', { name: 'Host B draft', exact: true }).click();
	await expect(active.locator('.stanza-editor-line-text')).toContainText('Private Host B draft');
	await active.locator('.ash-chat-input-model-action').click();
	await expect(automaticModel).toHaveAttribute('aria-checked', 'true');
	await automaticModel.focus();
	await automaticModel.press('Space');
	await expect(automaticModel).toHaveAttribute('aria-checked', 'false');
	await expect(modelPicker.getByRole('menuitemradio')).toHaveCount(1);
	await modelPicker.getByRole('menuitemradio', { name: 'Host B model', exact: true }).click();
	await expect(active).toContainText('Host B model');
	await page.evaluate(() => window.ashSessionsIntegration.multiHost!.disconnect('Host A'));
	await expect(sidebar.getByRole('button', { name: 'Task from Host A', exact: true })).toHaveCount(0);
	await expect(sidebar.getByRole('button', { name: 'Task from Host B', exact: true })).toBeVisible();
	await expect.poll(() => page.evaluate(() => window.ashSessionsIntegration.multiHost!.calls.every(call => call.sessionId === 'same' && call.threadId === 'same'))).toBe(true);
});


for (const locale of ['en', 'zh-CN']) {
	test(`new Session host chooser preserves keyboard selection and scope in ${locale}`, async ({ page }) => {
		await page.goto(`/sessions.html?multiHost&locale=${locale}`);
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.locator('[data-action-id="sessions.newSession"] button').click();
		const picker = page.getByPlaceholder(locale === 'en' ? 'Choose a host for the new session' : '选择新会话的宿主');
		await expect(picker).toBeFocused();
		await picker.fill('Host B');
		await page.keyboard.press('Enter');
		await expect(picker).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => window.ashSessionsIntegration.multiHost!.activeProvider())).toBe('Host B');
		const active = page.locator('.ash-sessions-chat-slot.active');
		await active.locator('.ash-chat-input-model-action').click();
		const modelPicker = page.locator('.ash-chat-model-picker');
		const automaticModel = modelPicker.getByRole('switch', { name: locale === 'en' ? 'Auto' : '自动', exact: true });
		await expect(automaticModel).toHaveAttribute('aria-checked', 'true');
		await automaticModel.focus();
		await automaticModel.press('Space');
		await expect(automaticModel).toHaveAttribute('aria-checked', 'false');
		await expect(modelPicker.getByRole('menuitemradio')).toHaveCount(1);
		await modelPicker.getByRole('menuitemradio', { name: 'Host B model', exact: true }).click();
		await expect(page.locator('.ash-sessions-chat-slot.active')).toContainText('Host B model');
		const previous = await page.locator('.ash-sessions-chat-slot.active [data-untitled-session-id]').getAttribute('data-untitled-session-id');
		const code = page.locator('.ash-window-mode-control').getByRole('button', { name: locale === 'en' ? 'Code' : '代码', exact: true });
		await code.click();
		await page.locator('[data-action-id="sessions.newSession"] button').click();
		await expect(picker).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(picker).toHaveCount(0);
		await expect(code).toHaveAttribute('aria-pressed', 'true');
		await expect(page.locator('.ash-sessions-chat-slot.active [data-untitled-session-id]')).toHaveAttribute('data-untitled-session-id', previous!);
		expect(await page.evaluate(() => window.ashSessionsIntegration.multiHost!.activeProvider())).toBe('Host B');
	});
}

for (const locale of ['en', 'zh-CN']) test(`Sidebar groups retain pins and separate Chat and Code expansion (${locale})`, async ({ page }, testInfo) => {
	await page.goto(`/sessions.html?multiHost&sidebarGroups&locale=${locale}`);
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const chinese = locale === 'zh-CN';
	const list = page.locator('.ash-sessions-list:visible');
	const mode = page.locator('.ash-window-mode-control');
	const groups = list.locator(':scope > .ash-sessions-list-items > .ash-sessions-list-section > h3 > button');
	const recent = list.locator('[data-section=recent] > h3 button');
	const pinned = list.locator('[data-section=pinned]');
	const projects = list.locator('[data-section=projects]');
	await expect(list.locator('input')).toHaveCount(0);
	await expect(groups).toHaveText(chinese ? ['项目', '聊天'] : ['Projects', 'Chats']);
	await expect(pinned).toHaveCount(0);
	await expect(list.locator('.ash-sessions-list-subgroup')).toHaveCount(0);
	await expect(projects.getByRole('button', { name: 'Search project fixture', exact: true })).toBeVisible();
	const taskB = list.getByRole('button', { name: 'Task from Host B', exact: true });
	await taskB.focus();
	await taskB.press('Shift+F10');
	await page.getByRole('menuitem', { name: chinese ? '置顶聊天' : 'Pin chat', exact: true }).click();
	await expect(pinned.getByRole('button', { name: 'Task from Host B', exact: true })).toBeVisible();
	await expect(list.getByRole('button', { name: 'Task from Host B', exact: true })).toHaveCount(1);
	await expect(groups).toHaveText(chinese ? ['置顶', '项目', '聊天'] : ['Pinned', 'Projects', 'Chats']);
	for (const heading of await groups.all()) {
		expect(await heading.evaluate(element => {
			const label = element.querySelector('.ash-sessions-list-section-label')!.getBoundingClientRect();
			const icon = element.querySelector('.ash-sessions-list-section-icon')!.getBoundingClientRect();
			return icon.left >= label.right && icon.left - label.right <= 10;
		})).toBe(true);
	}

	await recent.focus();
	await recent.press('ArrowLeft');
	await expect(recent).toHaveAttribute('aria-expanded', 'false');
	await expect(recent.locator('[data-ash-icon-id=chevron-right]')).toBeVisible();
	await recent.press('ArrowDown');
	await expect(recent).toBeFocused();
	await mode.getByRole('button', { name: chinese ? '代码' : 'Code', exact: true }).click();
	await expect(groups).toHaveText(chinese ? ['置顶', '项目', '最近使用'] : ['Pinned', 'Projects', 'Recents']);
	await expect(recent).toHaveAttribute('aria-expanded', 'true');
	await expect(pinned.getByRole('button', { name: 'Task from Host B', exact: true })).toBeVisible();
	const project = projects.locator('.ash-sessions-list-subgroup');
	const projectToggle = project.locator('h3 button');
	await expect(projectToggle).toHaveAccessibleName('Search project fixture');
	await expect(project.getByRole('button', { name: 'Task from Host A', exact: true })).toBeVisible();
	await expect(projectToggle.locator('[data-ash-icon-id=folder-open]')).toBeVisible();
	await projectToggle.focus();
	await projectToggle.press('ArrowLeft');
	await expect(projectToggle).toHaveAttribute('aria-expanded', 'false');
	await expect(projectToggle.locator('[data-ash-icon-id=folder]')).toBeVisible();
	await expect(project.getByRole('button', { name: 'Task from Host A', exact: true })).toBeHidden();
	await projectToggle.press('ArrowDown');
	await expect(recent).toBeFocused();
	await projectToggle.press('ArrowRight');
	await expect(projectToggle).toHaveAttribute('aria-expanded', 'true');
	const taskA = project.getByRole('button', { name: 'Task from Host A', exact: true });
	await expect(taskA.locator(':scope > [data-ash-icon-id=chat-4]')).toBeVisible();
	await taskA.click();
	await expect.poll(() => page.evaluate(() => window.ashSessionsIntegration.multiHost!.calls.some(call => call.host === 'Host A' && call.method === 'subscribe'))).toBe(true);
	await taskA.press('Shift+F10');
	await page.getByRole('menuitem', { name: chinese ? '置顶聊天' : 'Pin chat', exact: true }).click();
	const pinnedA = pinned.getByRole('button', { name: 'Task from Host A', exact: true });
	await expect(pinnedA).toBeVisible();
	await expect(project.locator('.ash-sessions-list-item')).toHaveCount(0);
	await pinnedA.press('Shift+F10');
	await page.getByRole('menuitem', { name: chinese ? '取消置顶聊天' : 'Unpin chat', exact: true }).click();
	await expect(taskA).toBeVisible();
	for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
		await page.evaluate(theme => window.ashSessionsIntegration.setTheme(theme), theme);
		await projectToggle.focus();
		await projectToggle.press('ArrowRight');
		await expect(projectToggle).toBeFocused();
		expect(await projectToggle.evaluate(element => {
			const style = getComputedStyle(element);
			return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 && element.scrollWidth <= element.clientWidth;
		})).toBe(true);
		expect(await taskA.locator(':scope > .ash-icon').evaluate(element => {
			const bounds = element.getBoundingClientRect();
			return bounds.width === 16 && bounds.height === 16 && getComputedStyle(element).fontFamily.includes('Ash UI Variable');
		})).toBe(true);
	}
	await page.evaluate(() => window.ashSessionsIntegration.setTheme('ash-light'));
	await page.screenshot({ path: testInfo.outputPath(`sidebar-code-groups-${locale}.png`) });
	await projectToggle.click();
	await page.evaluate(() => window.ashSessionsIntegration.remountAfterDirectDispose());
	await expect(projectToggle).toHaveAttribute('aria-expanded', 'false');
	await mode.getByRole('button', { name: chinese ? '聊天 / Agents' : 'Chat / Agents', exact: true }).click();
	await expect(recent).toHaveAttribute('aria-expanded', 'false');
	await expect(pinned.getByRole('button', { name: 'Task from Host B', exact: true })).toBeVisible();
	await pinned.getByRole('button', { name: 'Task from Host B', exact: true }).click({ button: 'right' });
	await page.getByRole('menuitem', { name: chinese ? '取消置顶聊天' : 'Unpin chat', exact: true }).click();
	await expect(pinned).toHaveCount(0);
	await expect(recent).toBeFocused();
	await recent.press('ArrowRight');
	await expect(taskB).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath(`sidebar-chat-groups-${locale}.png`) });
	await projects.getByRole('button', { name: 'Search project fixture', exact: true }).click();
	await expect(page.locator('.ash-projects h1')).toHaveText('Search project fixture');
});

test.describe('Sessions settings components', () => {
	test.beforeEach(async ({ page }) => {
		const accounts = page.getByRole('button', { name: 'Accounts', exact: true });
		await expect(accounts.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'account');
		await accounts.click();
		await expect(accounts).toHaveAttribute('aria-expanded', 'true');
		await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
	});

	test('modified settings refresh after configuration changes and reset without replacing search', async ({ page }) => {
		const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
		const search = settings.getByRole('searchbox', { name: 'Search settings' });
		const setting = settings.locator('[data-settings-item-id="chat.disableAIFeatures"]');
		const empty = settings.locator('.ash-sessions-settings-empty');
		await search.fill('@id:chat.disableAIFeatures');
		await setting.getByRole('switch').focus();
		await setting.getByRole('switch').press('Space');
		await settings.getByRole('button', { name: 'Filter Settings', exact: true }).click();
		await settings.getByRole('menuitem', { name: 'Modified', exact: true }).click();
		await expect(search).toHaveValue('@id:chat.disableAIFeatures @modified');
		await expect(search).toBeFocused();
		await expect(setting.getByRole('switch')).toBeChecked();
		await expect(settings.locator('.ash-sessions-customize')).toHaveCount(0);
		await page.evaluate(() => window.ashSessionsIntegration.updateConfiguration('chat.disableAIFeatures', undefined));
		await expect(setting).toHaveCount(0);
		await expect(empty).toBeVisible();
		await expect(search).toBeFocused();
		await page.evaluate(() => window.ashSessionsIntegration.updateConfiguration('chat.disableAIFeatures', true));
		await expect(setting.getByRole('switch')).toBeChecked();
		await expect(empty).toBeHidden();
		await expect(search).toBeFocused();
		await setting.hover();
		const more = setting.getByRole('button', { name: 'More actions for Disable AI features', exact: true });
		const actionBounds = await more.boundingBox();
		expect(actionBounds).toMatchObject({ width: 22, height: 22 });
		await expect(more.locator('.ash-icon')).toHaveCSS('width', '16px');
		await more.click();
		await settings.getByRole('menuitem', { name: 'Reset Setting', exact: true }).click();
		await expect(setting).toHaveCount(0);
		await expect(empty).toBeVisible();
		await expect(search).toHaveValue('@id:chat.disableAIFeatures @modified');
		await search.fill('@id:chat.disableAIFeatures');
		await expect(setting.getByRole('switch')).not.toBeChecked();
		await expect(empty).toBeHidden();
	});







	test('preferences keyboard navigation clears search before handing off to shared shortcuts', async ({ page }, testInfo) => {
		const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
		const search = settings.getByRole('searchbox');
		await search.fill('compact');
		await search.press('Escape');
		await expect(search).toHaveValue('');
		await expect(search).toBeFocused();
		await expect(settings).toBeVisible();
		const general = settings.locator('[data-settings-category-id="general"]');
		await general.focus();
		await general.press('End');
		const shortcutsCategory = settings.locator('[data-settings-category-id="keyboard-shortcuts"]');
		await expect(shortcutsCategory).toBeFocused();
		await expect(shortcutsCategory).toHaveAttribute('aria-current', 'page');
		await shortcutsCategory.press('ArrowDown');
		await expect(general).toBeFocused();
		await expect(general).toHaveAttribute('aria-current', 'page');
		await search.fill('shortcuts');
		await search.press('ArrowDown');
		const openShortcuts = settings.locator('.ash-sessions-settings-page').getByRole('button', { name: 'Keyboard Shortcuts', exact: true });
		await expect(openShortcuts).toBeFocused();
		await openShortcuts.press('Enter');
		await expect(settings).toHaveCount(0);
		const sharedEditor = page.locator('.ash-keybindings-editor');
		await expect(sharedEditor).toBeVisible();
		const chat = page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'New', exact: true });
		await expect(chat).toHaveAttribute('aria-current', 'page');
		await expect(sharedEditor.getByRole('searchbox')).toBeFocused();
		await sharedEditor.getByRole('searchbox').fill('workbench.action.openSettings');
		await expect(sharedEditor.locator('.ash-keybindings-command-id').filter({ hasText: /^workbench\.action\.openSettings$/u })).toBeVisible();
		const shortcut = sharedEditor.locator('.ash-keybindings-key .ash-keybinding-label').first();
		await expect(shortcut.locator('kbd')).toHaveCount(2);
		for (const cap of await shortcut.locator('kbd').all()) {
			await expect(cap).toHaveCSS('height', '20px');
			await expect(cap).toHaveCSS('border-radius', '4px');
		}
		await sharedEditor.screenshot({ path: testInfo.outputPath('settings-keycaps.png') });
		await page.locator('.ash-modal-editor-close').click();
		await expect(sharedEditor).toBeHidden();
		await expect(chat).toHaveAttribute('aria-current', 'page');
	});

	test('Customize settings and feature links open the actual Workbench settings owner', async ({ page }, testInfo) => {
		let settings = page.getByRole('dialog', { name: 'Sessions Settings' });
		await settings.locator('[data-settings-category-id="customize"]').click();
		await settings.getByRole('button', { name: 'Open Workbench Settings', exact: true }).click();
		await expect(settings).toHaveCount(0);
		const sharedSettings = page.locator('.ash-settings-editor');
		await expect(sharedSettings).toBeVisible();
		await expect(sharedSettings.getByRole('searchbox')).toBeFocused();
		await sharedSettings.getByRole('searchbox').fill('cowork.defaultmodel');
		await expect(sharedSettings.locator('[data-settings-item-id="cowork.defaultmodel"]').getByRole('textbox')).toBeVisible();
		await sharedSettings.getByRole('searchbox').fill('');
		const chat = page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'New', exact: true });
		await expect(chat).toHaveAttribute('aria-current', 'page');
		await testInfo.attach('shared-settings-preserves-chat', { body: await page.screenshot(), contentType: 'image/png' });
		await page.getByRole('button', { name: 'Close Ash Settings', exact: true }).click();
		await expect(chat).toHaveAttribute('aria-current', 'page');
		for (const [category, label, target] of [
			['browser', 'Open Browser settings', 'browser'],
			['tab', 'Open Tab settings', 'editor-opening'],
			['code-intelligence', 'Language servers', 'editor-language'],
			['environment', 'Open Environment settings', 'terminal'],
		] as const) {
			await page.getByRole('button', { name: 'Accounts', exact: true }).click();
			await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
			settings = page.getByRole('dialog', { name: 'Sessions Settings' });
			await settings.locator(`[data-settings-category-id="${category}"]`).click();
			await settings.getByRole('button', { name: label, exact: true }).click();
			await expect(settings).toHaveCount(0);
			await expect(sharedSettings).toBeVisible();
			await expect(sharedSettings.locator('[data-active-settings-category]')).toHaveAttribute('data-active-settings-category', target);
			await page.getByRole('button', { name: 'Close Ash Settings', exact: true }).click();
		}
	});

	test('preferences JSON actions reveal ordinary Code editors with their shared configuration resources', async ({ page }) => {
		for (const [category, command, title, contents] of [
			['customize', 'Preferences: Open User Settings (JSON)', 'User Settings (JSON)', '{}'],
			['keyboard-shortcuts', 'Preferences: Open Keyboard Shortcuts (JSON)', 'Keyboard Shortcuts (JSON)', '[]'],
		] as const) {
			const settings = page.getByRole('dialog', { name: 'Sessions Settings' });
			await settings.locator(`[data-settings-category-id="${category}"]`).click();
			await settings.getByRole('button', { name: command, exact: true }).click();
			await expect(settings).toHaveCount(0);
			const group = new EditorGroup(page.locator('.ash-editor-group:visible').filter({ has: page.getByRole('tab', { name: title, exact: true }) }));
			await expect(group.tabs.getByText(title, { exact: true })).toBeVisible();
			await group.editor.waitForEditorContents(source => source.replace(/\s/gu, '') === contents);
			await expect(page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true })).toHaveAttribute('aria-pressed', 'true');
			if (category === 'customize') {
				await page.getByRole('button', { name: 'Accounts', exact: true }).click();
				await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
			}
		}
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



});
