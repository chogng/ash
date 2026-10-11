import { expect, test } from '../../../automation/test.js';

test('Chat input history persists across renderer reload and search confirmation never sends', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, reloadWorkbench }) => {
	let page = workbench.page;
	const showChat = async (): Promise<void> => {
		if (!await page.locator('.ash-chat-view-pane').isVisible()) {
			await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
		}
	};
	await showChat();
	let editor = page.locator('.ash-chat-view-pane .ash-chat:visible .stanza-editor');
	await editor.click();
	await page.keyboard.insertText('/config');
	await page.locator('.ash-chat-view-pane .ash-chat:visible [data-action-id="ash.chat.input.send"] button').click();
	await expect(editor.locator('.stanza-editor-line-text')).toHaveText('');
	await editor.click();
	await page.keyboard.press('Control+r');
	let search = page.getByRole('combobox', { name: 'Search input history' });
	await expect(page.locator('.ash-quick-pick-row-label').getByText('/config', { exact: true })).toBeVisible();
	await search.press('Escape');
	const reloaded = await reloadWorkbench();
	page = reloaded.workbench.page;
	await showChat();
	editor = page.locator('.ash-chat-view-pane .ash-chat:visible .stanza-editor');
	await editor.click();
	await page.keyboard.press('Control+r');
	search = page.getByRole('combobox', { name: 'Search input history' });
	await page.locator('.ash-quick-pick-row-label').getByText('/config', { exact: true }).click();
	await expect(search).toBeHidden();
	await expect(editor.locator('.stanza-editor-line-text')).toHaveText('/config');
	await expect(page.locator('.ash-chat:visible')).toHaveClass(/empty/u);
	await page.keyboard.press('Escape');
	await expect(editor.locator('.stanza-editor-line-text')).toHaveText('');
	await reloaded.workbench.quickaccess.runCommand('workbench.action.chat.clearInputHistory');
	await editor.click();
	await page.keyboard.press('Control+r');
	await expect(search).toBeVisible();
	await expect(page.locator('.ash-quick-pick-row-label').getByText('/config', { exact: true })).toHaveCount(0);
	await search.press('Escape');
});
