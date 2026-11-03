import { expect, test } from '../../../automation/test.js';

for (const locale of ['en', 'zh-CN'] as const) test.describe(`Chat tab transfers (${locale})`, () => {
	test.use({ openWorkspace: false, electronUserSettings: { 'workbench.locale': locale } });

	test('individual Chat tabs move between the side bar and editor with their original drafts', { tag: ['@electron-ui', '@browser-ui'] }, async ({ workbench, application }, testInfo) => {
		const page = workbench.page;
		await workbench.quickaccess.runCommand('workbench.action.chat.newChat');
		const sidebar = page.locator('[data-part="auxiliarybar"]');
		const first = sidebar.locator('.ash-chat:visible');
		const firstId = await first.getAttribute('id');
		const original = await first.locator('.stanza-editor-input').elementHandle();
		await first.locator('.stanza-editor-input').focus();
		await page.keyboard.insertText('First independent Chat draft');
		await workbench.quickaccess.runCommand('workbench.action.chat.newChat');
		const second = sidebar.locator('.ash-chat:visible');
		const secondId = await second.getAttribute('id');
		await second.locator('.stanza-editor-input').focus();
		await page.keyboard.insertText('Second sidebar draft');
		const tabs = sidebar.locator('.ash-chat-view-tabs');
		const source = tabs.locator('.ash-tab').filter({ has: page.locator(`[aria-controls="${firstId}"]`) });
		await source.dragTo(page.locator('[data-part="editor"] .ash-tab').first(), { targetPosition: { x: 8, y: 12 } });
		const editorChat = page.locator(`.ash-chat-editor #${firstId}`);
		await expect(editorChat).toBeVisible();
		await expect(editorChat.locator('.stanza-editor-line-text')).toHaveText('First independent Chat draft');
		expect(await editorChat.locator('.stanza-editor-input').evaluate((element, retained) => element === retained, original)).toBe(true);
		await expect(sidebar.locator(`#${secondId}`)).toBeVisible();
		await expect(sidebar.locator(`#${secondId} .stanza-editor-line-text`)).toHaveText('Second sidebar draft');
		await expect(editorChat.locator('.ash-chat-view-tabs')).toHaveCount(0);
		await editorChat.locator('.stanza-editor-input').press('Alt+F1');
		const help = page.locator('.ash-accessible-view-content');
		await expect(help).toHaveValue(locale === 'en' ? /individual Chat tab/u : /单个聊天标签/u);
		await help.press('Escape');
		await expect(editorChat.locator('.stanza-editor-input')).toBeFocused();
		await testInfo.attach('independent-chat-beside-sidebar', { body: await page.screenshot(), contentType: 'image/png' });
		await tabs.locator('.ash-tab').filter({ has: page.locator(`[aria-controls="${secondId}"]`) }).dragTo(editorChat);
		const secondEditorChat = page.locator(`.ash-chat-editor #${secondId}`);
		await expect(secondEditorChat).toBeVisible();
		await expect(secondEditorChat.locator('.stanza-editor-line-text')).toHaveText('Second sidebar draft');
		await expect(editorChat).toBeHidden();
		const editorTabs = page.locator('.ash-editor-group:has(.ash-chat-editor) .ash-tab');
		const secondTabId = await editorTabs.filter({ has: page.locator('[aria-selected="true"]') }).getAttribute('data-action-id');
		await editorTabs.first().getByRole('tab').click();
		await expect(editorChat).toBeVisible();
		await workbench.menus.select(application, () => page.locator(`.ash-editor-group .ash-tab[data-action-id="${secondTabId}"]`).getByRole('tab').press('Shift+F10'),
			[locale === 'en' ? 'Move Chat to Side Bar' : '将聊天移到侧边栏']);
		await expect(sidebar.locator(`#${secondId}`)).toBeVisible();
		await expect(editorChat).toBeVisible();
		const editorTab = page.locator('.ash-editor-group:has(.ash-chat-editor) .ash-tab.checked');
		await editorTab.dragTo(tabs, { targetPosition: { x: 8, y: 12 } });
		const returned = sidebar.locator(`#${firstId}`);
		await expect(returned).toBeVisible();
		await expect(returned.locator('.stanza-editor-input')).toBeFocused();
		await expect(returned.locator('.stanza-editor-line-text')).toHaveText('First independent Chat draft');
		expect(await returned.locator('.stanza-editor-input').evaluate((element, retained) => element === retained, original)).toBe(true);
		await expect(page.locator('.ash-chat-editor')).toHaveCount(0);
		await expect(sidebar.locator(`#${secondId} .stanza-editor-line-text`)).toHaveText('Second sidebar draft');
		await workbench.menus.select(application, () => tabs.locator('.ash-tab.checked [role="tab"]').press('Shift+F10'),
			[locale === 'en' ? 'Move Chat to Editor Area' : '将聊天移至编辑器区域']);
		await expect(editorChat).toBeVisible();
		await workbench.quickaccess.runCommand('workbench.action.chat.moveToSideBar');
		await expect(returned).toBeVisible();
		await expect(returned.locator('.stanza-editor-line-text')).toHaveText('First independent Chat draft');
		await workbench.quickaccess.runCommand('workbench.action.chat.setAgentSessionsPresentationList');
		await expect(tabs).toBeHidden();
		await expect(returned.locator('.stanza-editor-line-text')).toHaveText('First independent Chat draft');
		await expect(returned.locator('.ash-chat-item')).toHaveCount(0);
		await original?.dispose();
	});

	test('independent draft editor tabs restore beside the remaining sidebar conversation', { tag: ['@electron-ui'] }, async ({ workbench, application, reloadWorkbench }) => {
		let page = workbench.page;
		await workbench.quickaccess.runCommand('workbench.action.chat.newChat');
		const draft = page.locator('[data-part="auxiliarybar"] .ash-chat:visible');
		const draftId = await draft.getAttribute('data-untitled-session-id');
		await draft.locator('.stanza-editor-input').focus();
		await page.keyboard.insertText('Restore this independent draft');
		await workbench.menus.select(application, () => page.locator('[data-part="auxiliarybar"] .ash-tab.checked [role="tab"]').press('Shift+F10'),
			[locale === 'en' ? 'Move Chat to Editor Area' : '将聊天移至编辑器区域']);
		await expect(page.locator('.ash-chat-editor')).toContainText('Restore this independent draft');
		await workbench.quickaccess.runCommand('workbench.action.chat.newChat');
		await page.locator('[data-part="auxiliarybar"] .ash-chat:visible .stanza-editor-input').focus();
		await page.keyboard.insertText('Restore this sidebar draft');
		({ workbench } = await reloadWorkbench());
		page = workbench.page;
		const restored = page.locator(`.ash-chat-editor .ash-chat[data-untitled-session-id="${draftId}"]`);
		await expect(restored).toBeVisible();
		await expect(restored.locator('.stanza-editor-line-text')).toHaveText('Restore this independent draft');
		await expect(page.locator('[data-part="auxiliarybar"] .ash-chat:visible .stanza-editor-line-text')).toHaveText('Restore this sidebar draft');
		await expect(restored.locator('.ash-chat-item')).toHaveCount(0);
	});
});
