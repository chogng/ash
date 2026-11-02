import { expect, test } from '../../../automation/test.js';

test('Chat setup preserves the keyboard draft and opens the existing model settings', { tag: ['@electron-ui', '@browser-ui'] }, async ({ workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const input = page.locator('.ash-chat-view-pane .ash-chat-input-editor .stanza-editor-input');
	await input.focus();
	await page.keyboard.insertText('Keep this unsent setup draft');
	const draft = page.locator('.ash-chat-view-pane .ash-chat-input-editor .stanza-editor-line-text');
	await expect(draft).toHaveText('Keep this unsent setup draft');
	await workbench.quickaccess.runCommand('workbench.action.chat.triggerSetup');
	const setup = page.getByRole('combobox', { name: 'Choose how to set up Chat', exact: true });
	await expect(setup).toBeFocused();
	await expect(page.getByRole('option', { name: /Configure Model Connections/ })).toBeVisible();
	await expect(page.getByRole('option', { name: /Manage Accounts/ })).toBeVisible();
	await setup.press('Escape');
	await expect(setup).toHaveCount(0);
	await expect(input).toBeFocused();
	await expect(draft).toHaveText('Keep this unsent setup draft');
	await workbench.quickaccess.runCommand('workbench.action.chat.triggerSetup');
	await setup.fill('Configure Model Connections');
	await setup.press('Enter');
	await expect(workbench.settingsEditor.element).toBeVisible();
	await expect(workbench.settingsEditor.element.locator('.ash-chat-models-catalog')).toBeVisible();
	await expect(draft).toHaveText('Keep this unsent setup draft');
});
