import { expect, type Locator } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../test/unit/browser/context.js';
import type { } from '../../../../../test/fixtures/browser/sessions.page.js';

suite('Sessions native titlebar layout', () => {
	const browser = useBrowserTests();
	test('Chat reserves the editor side of the titlebar without moving conversation content across its divider', async () => {
		const { page } = browser;
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto('/sessions.html?emptyEditorArea');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.evaluate(() => window.ashSessionsIntegration.showEmptyEditorArea!());
		const editor = page.locator('[data-part="editor"]');
		const titlebar = page.locator('[data-part="titlebar"]');
		const editorHeaders = titlebar.locator('.ash-sessions-titlebar-editor-headers');
		const conversationTitle = titlebar.locator('.ash-sessions-titlebar-session-content');
		await expect(editor).toBeVisible();
		await expect(editorHeaders).toBeVisible();
		await expect.poll(async () => (await editorHeaders.boundingBox())!.x - (await editor.boundingBox())!.x).toBeCloseTo(0, 0);
		const title = (await conversationTitle.boundingBox())!;
		expect(title.x + title.width).toBeLessThanOrEqual((await editor.boundingBox())!.x);
	});

	async function expectCenteredTitlebarIcon(button: Locator): Promise<void> {
		await expect(button).toBeVisible();
		const bounds = (await button.boundingBox())!;
		expect(bounds.width).toBe(28);
		expect(bounds.height).toBe(28);
		const glyph = (await button.locator('.ash-icon:visible').boundingBox())!;
		expect(glyph.x + glyph.width / 2).toBeCloseTo(bounds.x + bounds.width / 2, 0);
		expect(glyph.y + glyph.height / 2).toBeCloseTo(bounds.y + bounds.height / 2, 0);
	}

	test('Code tools move into More Actions when narrow and return when widened', async () => {
		const { page } = browser;
		await page.goto('/sessions.html?multiHost');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await page.locator('.ash-sessions-list:visible').getByRole('button', { name: 'Task from Host A', exact: true }).click();
		const tools = page.getByRole('toolbar', { name: 'Code layout', exact: true });
		const files = tools.getByRole('button', { name: 'Toggle files', exact: true });
		const more = tools.getByRole('button', { name: 'More Actions', exact: true });
		await expect(files).toBeInViewport({ ratio: 1 });
		await expectCenteredTitlebarIcon(files);
		await files.focus();
		const viewport = page.viewportSize()!;
		await page.setViewportSize({ width: 240, height: viewport.height });
		await expect(files).toHaveCount(0);
		await expect(more).toBeInViewport({ ratio: 1 });
		await expectCenteredTitlebarIcon(more);
		await expect(more).toBeFocused();
		await more.press('Enter');
		await expect(page.getByRole('menuitemcheckbox', { name: 'Toggle files', exact: true })).toBeVisible();
		await expect(page.getByRole('menuitem', { name: 'Side Chat', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(more).toBeFocused();
		await page.setViewportSize(viewport);
		await expect(files).toBeInViewport({ ratio: 1 });
		await page.evaluate(() => window.ashSessionsIntegration.updateConfiguration('sessions.activityBar.location', 'top'));
		const account = page.locator('.ash-sessions-titlebar-right').getByRole('button', { name: 'Accounts', exact: true });
		await expectCenteredTitlebarIcon(account);
		await account.hover();
		await expectCenteredTitlebarIcon(account);
	});

	test('mouse side buttons traverse the Sessions navigation history', async () => {
		const { page } = browser;
		await page.goto('/sessions.html?multiHost');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.evaluate(async () => {
			const host = window.ashSessionsIntegration.multiHost!;
			await host.open('Host A');
			await host.open('Host B');
		});
		const selected = page.locator('.ash-sessions-list-item[aria-current="page"]');
		await expect(selected).toContainText('Task from Host B');
		await selected.focus();
		await selected.dispatchEvent('mousedown', { button: 3, bubbles: true, cancelable: true });
		await expect(selected).toContainText('Task from Host A');
		await selected.focus();
		await selected.dispatchEvent('mousedown', { button: 4, bubbles: true, cancelable: true });
		await expect(selected).toContainText('Task from Host B');
	});

	test('ignoring an attention alert survives reloading the Sessions window', async () => {
		const { page } = browser;
		await page.goto('/sessions.html?multiHost&blockedTitlebar');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.evaluate(() => window.ashSessionsIntegration.multiHost!.showAttentionDraft());
		const attention = page.getByRole('button', { name: '1 session requires attention' });
		await attention.press('Enter');
		await page.getByRole('button', { name: 'Ignore all current alerts' }).click();
		await expect(attention).toHaveCount(0);
		await page.reload();
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.evaluate(() => window.ashSessionsIntegration.multiHost!.showAttentionDraft());
		await expect(page.locator('.ash-sessions-titlebar-title').getByRole('button', { name: 'Chat actions (New Chat)', exact: true })).toBeVisible();
		await expect(attention).toHaveCount(0);
	});

	test('the attention list opens the blocked session on its host and clears the visible item', async () => {
		const { page } = browser;
		await page.goto('/sessions.html?multiHost&blockedTitlebar');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.evaluate(() => window.ashSessionsIntegration.multiHost!.showAttentionDraft());
		const widget = page.locator('.ash-sessions-titlebar-widget');
		const attention = widget.getByRole('button', { name: '1 session requires attention' });
		await expect(attention).toBeVisible();
		await attention.press('Enter');
		const picker = page.locator('.ash-quick-input-host:visible');
		await expect(picker.getByText('Task from Host B', { exact: true })).toBeVisible();
		await expect(picker.getByText('Needs input', { exact: true })).toBeVisible();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect(page.locator('.ash-sessions-list-item[aria-current="page"]').filter({ hasText: 'Task from Host B' })).toBeVisible();
		await expect(attention).toHaveCount(0);
	});

	test('the titlebar renames the active session in Chinese', async () => {
		const { page } = browser;
		await page.goto('/sessions.html?multiHost&locale=zh-CN');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.evaluate(() => window.ashSessionsIntegration.multiHost!.open('Host B'));
		const widget = page.locator('.ash-sessions-titlebar-widget');
		const button = widget.getByRole('button', { name: '聊天操作（Task from Host B）' });
		const rename = page.getByRole('menuitem', { name: '重命名', exact: true });
		const input = widget.getByRole('textbox', { name: '会话名称' });
		const titlebarContent = page.locator('.ash-sessions-titlebar-session-content');
		await expect(button).toBeVisible();
		const leftInset = (await button.boundingBox())!.x - (await titlebarContent.boundingBox())!.x;
		expect(leftInset).toBeCloseTo(4, 0);
		await expect(button.locator('.ash-dropdown-menu-indicator')).toBeVisible();
		await button.hover();
		await expect(button).toHaveCSS('padding', '2px 4px');
		const titleRadius = await button.evaluate(element => getComputedStyle(element).borderTopLeftRadius);
		const titleTextLeft = await button.locator('.ash-button-label').evaluate(label => label.getBoundingClientRect().left);
		await button.press('Enter');
		await expect(button).toHaveAttribute('aria-expanded', 'true');
		await rename.press('Enter');
		await expect(input).toHaveValue('Task from Host B');
		await expect(input).toHaveCSS('padding', '2px 4px');
		await expect(input).toHaveCSS('border-top-left-radius', titleRadius);
		const inputTextLeft = await input.evaluate(element => {
			const style = getComputedStyle(element);
			return element.getBoundingClientRect().left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
		});
		expect(inputTextLeft).toBeCloseTo(titleTextLeft, 0);
		await expect(input).toBeFocused();
		await expect(page.locator('.ash-quick-input-host:visible')).toHaveCount(0);
		expect((await input.boundingBox())!.x - (await titlebarContent.boundingBox())!.x).toBe(leftInset);
		const initialWidth = (await input.boundingBox())!.width;
		await input.fill('短');
		expect((await input.boundingBox())!.width).toBeLessThan(initialWidth);
		await input.fill('取消此名称'.repeat(40));
		const expandedBounds = (await input.boundingBox())!;
		const availableBounds = (await titlebarContent.boundingBox())!;
		expect(expandedBounds.width).toBeGreaterThan(initialWidth);
		expect(expandedBounds.x + expandedBounds.width).toBeLessThanOrEqual(availableBounds.x + availableBounds.width);
		await input.fill('取消此名称');
		await input.press('Escape');
		await expect(button).toBeFocused();
		await button.press('ArrowDown');
		await rename.press('Enter');
		await input.fill('失焦时取消此名称');
		const mode = page.locator('.ash-window-mode-control').getByRole('button', { name: '代码', exact: true });
		await mode.focus();
		await expect(input).toBeHidden();
		await expect(button).toHaveText('Task from Host B');
		await button.getByText('Task from Host B', { exact: true }).dblclick();
		await expect(rename).toBeHidden();
		await expect(input).toBeFocused();
		await expect(input).toHaveValue('Task from Host B');
		const longTitle = '新的会话名称'.repeat(35);
		await input.fill(longTitle);
		const renameHosts = () => page.evaluate(() => window.ashSessionsIntegration.multiHost!.calls
			.filter(call => call.method === 'rename').map(call => call.host));
		await page.evaluate(() => window.ashSessionsIntegration.multiHost!.pauseNextRename());
		await input.press('Enter');
		await expect.poll(renameHosts).toEqual(['Host B']);
		await expect(input).not.toBeEditable();
		await input.press('Enter');
		expect(await renameHosts()).toEqual(['Host B']);
		await expect(input).toHaveValue(longTitle);
		await expect(input).not.toBeEditable();
		await page.evaluate(() => window.ashSessionsIntegration.multiHost!.rejectPausedRename());
		await expect(input).toBeEditable();
		await expect(input).toHaveValue(longTitle);
		await input.press('Enter');
		const renamedButton = widget.getByRole('button', { name: `聊天操作（${longTitle}）` });
		await expect(renamedButton).toBeVisible();
		await expect(renamedButton).toBeFocused();
		await expect(page.locator('.ash-sessions-list-item[aria-current="page"]')).toContainText(longTitle);
		const titleLabel = renamedButton.locator('.ash-button-label');
		expect(await titleLabel.evaluate(label => label.scrollWidth > label.clientWidth)).toBe(true);
		await renamedButton.hover();
		const tooltip = page.getByRole('tooltip').filter({ hasText: longTitle });
		await expect(tooltip).toBeVisible();
		await expect(tooltip).toHaveCSS('overflow-wrap', 'anywhere');
		expect(await renameHosts()).toEqual(['Host B', 'Host B']);
	});

	for (const os of ['windows', 'mac']) {
		test(`${os} sidebar minimum contains navigation and mode controls as native insets change`, async () => {
			const { page } = browser;
			await page.goto(`/sessionsTitlebar.html?os=${os}`);
			await page.waitForFunction(() => !!window.ashSessionsTitlebarFixture);
			await page.setViewportSize({ width: 640, height: 720 });
			for (const leftInset of os === 'mac' ? [90, 110, 0, 90] : [0]) {
				await page.evaluate(() => window.ashSessionsTitlebarFixture.setSidebarWidth(0));
				await page.evaluate(left => window.ashSessionsTitlebarFixture.setInsets(left, 0), leftInset);
				await expect.poll(() =>
					page.locator('.ash-sessions-titlebar-left').evaluate(element => {
						const mode = element.querySelector('.ash-sessions-workspace-mode')!.getBoundingClientRect();
						const inset = Number.parseFloat(getComputedStyle(element).paddingRight);
						return Math.ceil(mode.right + inset) - window.ashSessionsTitlebarFixture.minimumSidebarWidth;
					}),
				).toBe(0);
				await page.evaluate(() => window.ashSessionsTitlebarFixture.setSidebarWidth(window.ashSessionsTitlebarFixture.minimumSidebarWidth));
				const navigation = (await page.locator('.ash-titlebar-left-actions.ash-sessions-titlebar-actions').boundingBox())!;
				const mode = (await page.locator('.ash-sessions-workspace-mode').boundingBox())!;
				expect(navigation.x).toBeGreaterThanOrEqual(leftInset);
				expect(mode.x).toBeGreaterThanOrEqual(navigation.x + navigation.width);
			}
		});

		test(`${os} keeps actions inside the native control area through resize and fullscreen`, async () => {
			const { page } = browser;
			await page.goto(`/sessionsTitlebar.html?os=${os}`);
			await page.waitForFunction(() => !!window.ashSessionsTitlebarFixture);
			const button = page.getByRole('button', { name: 'Session information', exact: true });
			const leftInset = os === 'mac' ? 90 : 0;
			const rightInset = os === 'windows' ? 140 : 0;
			await page.evaluate(({ left, right }) => window.ashSessionsTitlebarFixture.setInsets(left, right), { left: leftInset, right: rightInset });
			for (const width of [1280, 640]) {
				await page.setViewportSize({ width, height: 720 });
				for (let theme = 0; theme < 4; theme++) {
					await page.evaluate(index => window.ashSessionsTitlebarFixture.setTheme(index), theme);
					for (const action of await page.locator('[data-part="titlebar"] button:visible').all()) {
						const bounds = (await action.boundingBox())!;
						expect(bounds.x).toBeGreaterThanOrEqual(leftInset);
						expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - rightInset);
					}
					const mode = (await page.locator('.ash-sessions-workspace-mode').boundingBox())!;
					expect(mode.x + mode.width).toBeLessThanOrEqual(260);
					await expect(page.locator('.ash-sessions-titlebar-right')).toHaveCSS('-webkit-app-region', 'no-drag');
					const bounds = (await button.boundingBox())!;
					const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
					expect(await button.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), center)).toBe(true);
				}
			}
			await button.focus();
			await button.press('Enter');
			expect(await page.evaluate(() => window.ashSessionsTitlebarFixture.runs)).toBe(1);
			await browser.info.attach(`${os}-native-titlebar`, { body: await page.screenshot(), contentType: 'image/png' });
			await page.evaluate(() => window.ashSessionsTitlebarFixture.setFullscreen(true));
			await expect(page.locator('[data-part="titlebar"]')).toHaveCSS('padding-left', '0px');
			await expect(page.locator('[data-part="titlebar"]')).toHaveCSS('padding-right', '0px');
			const bounds = (await button.boundingBox())!;
			expect(bounds.x + bounds.width).toBeGreaterThan(640 - 40);
			await page.evaluate(() => window.ashSessionsTitlebarFixture.setFullscreen(false));
			await expect(page.locator('[data-part="titlebar"]')).toHaveCSS('padding-left', `${leftInset}px`);
			await expect(page.locator('[data-part="titlebar"]')).toHaveCSS('padding-right', `${rightInset}px`);
		});
	}
});
