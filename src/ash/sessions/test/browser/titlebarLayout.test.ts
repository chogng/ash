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
		const editorRegion = titlebar.locator('.ash-sessions-titlebar-editor-region');
		const conversationTitle = titlebar.locator('.ash-sessions-titlebar-session-content');
		await expect(editor).toBeVisible();
		await expect(editorRegion).toBeVisible();
		await expect.poll(async () => (await editorRegion.boundingBox())!.x - (await editor.boundingBox())!.x).toBeCloseTo(0, 0);
		const title = (await conversationTitle.boundingBox())!;
		expect(title.x + title.width).toBeLessThanOrEqual((await editor.boundingBox())!.x);
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`maximized Chat keeps the editor below the window titlebar in ${locale}`, async () => {
			const { page } = browser;
			await page.setViewportSize({ width: 1440, height: 900 });
			await page.goto(`/sessions.html?emptyEditorArea&locale=${locale}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.evaluate(() => window.ashSessionsIntegration.showEmptyEditorArea!(false));
			const titlebar = page.locator('[data-part="titlebar"]');
			const editor = page.locator('[data-part="editor"]');
			const editorRegion = titlebar.locator('.ash-sessions-titlebar-editor-region');
			const conversation = titlebar.locator('.ash-sessions-titlebar-session-content');
			const expectEditorBelowTitlebar = () => expect.poll(async () => {
				const bar = (await titlebar.boundingBox())!;
				return (await editor.boundingBox())!.y - bar.y - bar.height;
			}).toBeCloseTo(0, 0);
			await expect(conversation).toBeHidden();
			await expect(editorRegion).toBeHidden();
			await expectEditorBelowTitlebar();
			await page.evaluate(() => window.ashSessionsIntegration.updateConfiguration('sessions.activityBar.location', 'top'));
			const accounts = titlebar.locator('[data-action-id="sessions.activity.accounts"] button');
			await accounts.press('Shift+F10');
			await expect(page.getByRole('menuitemcheckbox', { name: locale === 'zh-CN' ? '隐藏侧边栏' : 'Hide sidebar', exact: true })).toBeVisible();
			await expect(page.getByRole('menuitem', { name: locale === 'zh-CN' ? '活动栏位置' : 'Activity Bar Position', exact: true })).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(accounts).toBeFocused();
			await page.evaluate(() => window.ashSessionsIntegration.updateConfiguration('sessions.activityBar.location', 'default'));
			await expectEditorBelowTitlebar();
			for (const width of [900, 640]) {
				await page.setViewportSize({ width, height: 900 });
				await expectEditorBelowTitlebar();
				await expect(editor).toBeInViewport({ ratio: 1 });
			}
			await page.evaluate(() => window.ashSessionsIntegration.showEmptyEditorArea!(true));
			await expect(conversation).toBeVisible();
			await expect(conversation.getByRole('toolbar', { name: locale === 'zh-CN' ? '会话标题' : 'Session title', exact: true })
				.locator('[data-action-id="sessions.showSessionsPicker"] .ash-sessions-titlebar-widget')).toBeVisible();
		});
	}

	async function expectCenteredTitlebarIcon(button: Locator): Promise<void> {
		await expect(button).toBeVisible();
		const bounds = (await button.boundingBox())!;
		expect(bounds.width).toBe(28);
		expect(bounds.height).toBe(28);
		const glyph = (await button.locator('.ash-icon:visible').boundingBox())!;
		expect(glyph.x + glyph.width / 2).toBeCloseTo(bounds.x + bounds.width / 2, 0);
		expect(glyph.y + glyph.height / 2).toBeCloseTo(bounds.y + bounds.height / 2, 0);
	}

	test('Chat and Code keep independent side panels with toggles at the trailing edge', async () => {
		const { page } = browser;
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto('/sessions.html?multiHost&locale=zh-CN');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		const mode = page.locator('.ash-window-mode-control');
		const titlebar = page.locator('[data-part="titlebar"]');
		const panel = titlebar.getByRole('toolbar', { name: '侧面板', exact: true });
		const toggle = panel.getByRole('button', { name: '切换侧面板', exact: true });
		const maximize = panel.getByRole('button', { name: '最大化侧面板', exact: true });
		const restore = panel.getByRole('button', { name: '还原侧面板大小', exact: true });
		const conversation = page.locator('[data-part="sessions"]');
		const editor = page.locator('[data-part="editor"]');
		const editorRegion = titlebar.locator('.ash-sessions-titlebar-editor-region');
		const newTabLabel = page.locator('.ash-editor-tab-strip:visible').getByRole('tab', { name: '新标签页', exact: true });
		const emptyFileSearch = editor.getByRole('textbox', { name: '搜索文件或输入 URL', exact: true });
		const addTab = page.locator('.ash-editor-tab-strip:visible').getByRole('button', { name: '添加标签页', exact: true });
		const expectEditorTab = async (): Promise<void> => {
			await expect(newTabLabel).toBeVisible();
			await expect(newTabLabel).toHaveAttribute('aria-selected', 'true');
			await expect(page.locator('.ash-editor-tab-strip:visible').getByRole('tab')).toHaveCount(1);
			await expect(addTab).toBeVisible();
			await expect.poll(async () => {
				const [tab, pane] = await Promise.all([newTabLabel.boundingBox(), editor.boundingBox()]);
				return !!tab && !!pane && tab.x >= pane.x;
			}).toBe(true);
		};
		await expectCenteredTitlebarIcon(toggle);
		await expect(toggle).toHaveCSS('border-radius', '8px');
		const chatBounds = (await toggle.boundingBox())!;
		const windowBar = (await titlebar.boundingBox())!;
		expect(windowBar.x + windowBar.width - chatBounds.x - chatBounds.width).toBe(8);
		await expect(editor).toBeHidden();
		await expect(maximize).toHaveCount(0);
		await toggle.press('Enter');
		await expect(editor).toBeVisible();
		await expectEditorTab();
		await expect(emptyFileSearch).toBeFocused();
		await expect(editor.getByRole('button', { name: '新建文件', exact: true })).toHaveCount(0);
		await expect(editor.getByRole('button', { name: '打开更改', exact: true })).toHaveCount(0);
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await page.mouse.move(16, 180);
		await expect(toggle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect.poll(() => toggle.boundingBox()).toEqual(chatBounds);
		await expectCenteredTitlebarIcon(maximize);
		const maxBounds = (await maximize.boundingBox())!;
		expect(maxBounds.x + maxBounds.width).toBeLessThanOrEqual(chatBounds.x);
		expect(maxBounds.y).toBe(chatBounds.y);
		await expect(editor.locator('[data-action-id="sessions.toggleSessionPart"]')).toHaveCount(0);
		await toggle.press('ArrowLeft');
		await expect(maximize).toBeFocused();
		await maximize.press('Enter');
		await expect(conversation).toBeHidden();
		await expectEditorTab();
		await expect(restore).toBeFocused();
		await expect(restore).toHaveAttribute('aria-pressed', 'true');
		await expect.poll(() => restore.boundingBox()).toEqual(maxBounds);
		await restore.press('Enter');
		await expect(conversation).toBeVisible();
		await expectEditorTab();
		await expect(maximize).toBeFocused();
		await mode.getByRole('button', { name: '代码', exact: true }).click();
		await expect(editor).toBeHidden();
		await expect(maximize).toHaveCount(0);
		await expectCenteredTitlebarIcon(toggle);
		await expect(toggle.locator('[data-ash-icon-id="layout-sidebar-right-off"]')).toBeVisible();
		const closedBounds = (await toggle.boundingBox())!;

		await toggle.press('Enter');
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await page.mouse.move(16, 180);
		await expect(toggle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(toggle.locator('[data-ash-icon-id="layout-sidebar-right"]')).toBeVisible();
		await toggle.hover();
		await expect(toggle).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await page.mouse.move(16, 180);
		await expect(toggle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(editor).toBeVisible();
		await expect(titlebar.locator('.ash-editor-group-header')).toHaveCount(0);
		await expectEditorTab();
		await expect(emptyFileSearch).toBeFocused();
		await expect(editor.getByRole('button', { name: '新建文件', exact: true })).toBeVisible();
		await expect(editor.getByRole('button', { name: '打开更改', exact: true })).toBeVisible();
		await expect(editor.locator('[data-action-id="ash.sessions.maximizeTool"]')).toHaveCount(0);
		await addTab.press('Shift+F10');
		await expect(page.getByRole('menuitem', { name: '打开文件', exact: true })).toBeVisible();
		await expect(page.getByRole('menuitem', { name: '打开更改', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(addTab).toBeFocused();
		await expect(editor.locator('[data-action-id="ash.sessions.hideTool"]')).toHaveCount(0);
		const originalWidth = (await editor.boundingBox())!.width;
		await expectCenteredTitlebarIcon(maximize);
		await maximize.press('Enter');
		await expect(conversation).toBeHidden();
		await expect(editor).toBeVisible();
		await expectEditorTab();
		await expect.poll(async () => (await editor.boundingBox())!.width).toBeGreaterThan(originalWidth);
		await restore.press('Enter');
		await expect(conversation).toBeVisible();
		await expectEditorTab();
		await expect.poll(async () => (await editor.boundingBox())!.width).toBeCloseTo(originalWidth, 0);
		await addTab.focus();
		for (const width of [1440, 1060, 480, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			await expectEditorTab();
			await expect(addTab).toBeFocused();
		}
		await expect(panel).toHaveCSS('-webkit-app-region', 'no-drag');
		await expect(toggle).toBeInViewport({ ratio: 1 });
		await expect.poll(() => toggle.boundingBox()).toEqual(closedBounds);
		await page.mouse.click(closedBounds.x + closedBounds.width / 2, closedBounds.y + closedBounds.height / 2);
		await expect(editor).toBeHidden();
		await expect(editorRegion).toBeHidden();
		await expect.poll(() => toggle.boundingBox()).toEqual(closedBounds);
		await toggle.press('Enter');
		await expectEditorTab();
		await expect.poll(async () => (await editor.boundingBox())!.width).toBeCloseTo(originalWidth, 0);

		const chat = mode.getByRole('button', { name: '聊天 / Agents', exact: true });
		const code = mode.getByRole('button', { name: '代码', exact: true });
		await chat.click();
		await expect(chat).toHaveAttribute('aria-pressed', 'true');
		await expectEditorTab();
		await expect(editor.getByRole('button', { name: '打开更改', exact: true })).toHaveCount(0);
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await maximize.click();
		await expect(conversation).toBeHidden();
		await toggle.click();
		await expect(editor).toBeHidden();
		await expect(conversation).toBeVisible();
		await expect(restore).toHaveCount(0);
		await code.click();
		await expectEditorTab();
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await chat.click();
		await expect(editor).toBeHidden();
		await expect(toggle).toHaveAttribute('aria-pressed', 'false');
		await expect.poll(() => toggle.boundingBox()).toEqual(chatBounds);
	});

	test('The empty Code editor area offers tools and commits only the chosen editor', async () => {
		const { page } = browser;
		await page.goto('/sessions.html?multiHost&locale=zh-CN');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.locator('.ash-window-mode-control').getByRole('button', { name: '代码', exact: true }).click();
		const titlebar = page.locator('[data-part="titlebar"]');
		const more = titlebar.locator('.ash-sessions-titlebar-right').getByRole('button', { name: '更多操作', exact: true });
		const sidePanel = titlebar.getByRole('button', { name: '切换侧面板', exact: true });
		const editor = page.locator('[data-part="editor"]');
		await page.locator('.ash-sessions-list:visible').getByRole('button', { name: 'Task from Host A', exact: true }).click();
		await page.evaluate(() => window.ashSessionsIntegration.setWorkspaceFolderCount(0));
		await sidePanel.press('Enter');
		const open = page.locator('.ash-sessions-new-tab:visible').getByRole('region', { name: '打开', exact: true });
		const searchButton = open.getByRole('button', { name: '搜索', exact: true });
		await expect(open.getByRole('button', { name: '侧边聊天', exact: true })).toBeEnabled();
		await expect(open.getByRole('button', { name: 'iOS 模拟器', exact: true })).toBeDisabled();
		await expect(searchButton).toHaveCount(0);
		await expect(page.getByRole('tab', { name: '新标签页', exact: true })).toHaveAttribute('aria-selected', 'true');
		await page.evaluate(() => window.ashSessionsIntegration.setWorkspaceFolderCount(1));
		await expect(more).toHaveCount(0);
		await searchButton.click();
		await expect(page.locator('[data-editor-tool="search"] .ash-search-editor:visible')).toBeVisible();
		await expect(open).toBeHidden();
		await expect(page.getByRole('tab', { name: '文件', exact: true })).toHaveCount(0);
		await expect(page.getByRole('tab', { name: '搜索编辑器', exact: true })).toHaveAttribute('aria-selected', 'true');
	});

	test('Code Add Tab replaces the selected launcher in place beside existing tabs', async () => {
		const { page } = browser;
		await page.goto('/sessions.html?multiHost&locale=zh-CN');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.locator('.ash-window-mode-control').getByRole('button', { name: '代码', exact: true }).click();
		const newSession = page.locator('[data-action-id="sessions.newSession"] button');
		await newSession.click();
		await expect(newSession).toHaveAttribute('aria-current', 'page');
		await page.evaluate(() => window.ashSessionsIntegration.setWorkspaceFolderCount(1));
		const titlebar = page.locator('[data-part="titlebar"]');
		const sidePanel = titlebar.getByRole('button', { name: '切换侧面板', exact: true });
		await expect(sidePanel).toHaveAttribute('aria-pressed', 'false');
		await sidePanel.press('Enter');
		const editor = page.locator('[data-part="editor"]');
		const filePicker = editor.getByRole('textbox', { name: '搜索文件或输入 URL', exact: true });
		await expect(filePicker).toBeFocused();
		await filePicker.click({ trial: true });
		const tabs = page.locator('.ash-editor-tab-strip:visible').getByRole('tab');
		await expect(tabs).toHaveText(['新标签页']);
		await editor.getByRole('button', { name: '新建文件', exact: true }).click();
		await expect(tabs).toHaveText(['Untitled-1']);
		const addTab = page.locator('.ash-editor-tab-strip:visible').getByRole('button', { name: '添加标签页', exact: true });
		await addTab.press('Enter');
		await expect(tabs).toHaveText(['Untitled-1', '新标签页']);
		await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
		await expect(filePicker).toBeFocused();
		await editor.getByRole('button', { name: '搜索', exact: true }).click();
		await expect(tabs).toHaveText(['Untitled-1', '搜索编辑器']);
		await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
		await expect(editor.locator('.ash-search-editor:visible')).toBeVisible();
		await addTab.click();
		await addTab.click();
		await expect(tabs).toHaveText(['Untitled-1', '搜索编辑器', '新标签页', '新标签页']);
		await expect(filePicker).toBeFocused();
		const launcher = tabs.last();
		await launcher.locator('..').locator('.ash-tab-close-action button').press('Enter');
		await expect(tabs).toHaveText(['Untitled-1', '搜索编辑器', '新标签页']);
		await expect(filePicker).toBeVisible();
		await launcher.locator('..').locator('.ash-tab-close-action button').press('Enter');
		await expect(tabs).toHaveText(['Untitled-1', '搜索编辑器']);
	});

	test('Session Rail follows the Code conversation while the tool area is maximized', async () => {
		const { page } = browser;
		await page.goto('/sessions.html?multiHost');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await page.locator('.ash-sessions-list:visible').getByRole('button', { name: 'Task from Host A', exact: true }).click();
		const titlebar = page.locator('[data-part="titlebar"]');
		const conversation = page.locator('[data-part="sessions"]');
		const infoName = { name: 'Toggle session information', exact: true };
		const info = titlebar.getByRole('toolbar', { name: 'Conversation actions', exact: true }).getByRole('button', infoName);
		await expect(titlebar.locator('.ash-sessions-titlebar-right').getByRole('button', infoName)).toHaveCount(0);
		await expectCenteredTitlebarIcon(info);
		await info.press('Enter');
		const rail = conversation.getByRole('complementary', { name: 'Session information', exact: true });
		await expect(rail).toBeVisible();
		const close = rail.getByRole('button', { name: 'Close session information', exact: true });
		await expect(close).toBeFocused();
		await close.press('Enter');
		await expect(rail).toBeHidden();
		await expect(info).toBeFocused();
		await titlebar.getByRole('button', { name: 'Toggle Side Panel', exact: true }).press('Enter');
		await expect(info).toBeVisible();
		const maximize = titlebar.getByRole('button', { name: 'Maximize Side Panel', exact: true });
		const restore = titlebar.getByRole('button', { name: 'Restore Side Panel Size', exact: true });
		await maximize.press('Enter');
		await expect(conversation).toBeHidden();
		await expect(titlebar.getByRole('button', infoName)).toHaveCount(0);
		await restore.press('Enter');
		await expect(conversation).toBeVisible();
		await expect(info).toBeVisible();
		await page.evaluate(() => window.ashSessionsIntegration.updateConfiguration('sessions.activityBar.location', 'top'));
		const account = page.locator('.ash-sessions-titlebar-right').getByRole('button', { name: 'Accounts', exact: true });
		await expectCenteredTitlebarIcon(account);
		await account.hover();
		await expectCenteredTitlebarIcon(account);
		await maximize.press('Enter');
		await page.locator('.ash-empty-file-editor:visible').getByRole('button', { name: 'Side Chat', exact: true }).press('Enter');
		await expect(page.locator('.ash-session-side-chat-editor:visible').getByRole('textbox')).toBeFocused();
		await expect(conversation).toBeHidden();
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
