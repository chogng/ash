import { expect, test } from '../../../automation/test.js';
import { QuickAccess } from '../../../automation/quickaccess.js';

for (const surface of ['IDE', 'Agent Window']) {
	test(`Model feedback opens an editable report and preserves both drafts in ${surface}`, { tag: ['@electron-app-server', '@browser-app-server'] }, async ({ target, workbench }) => {
		await expect(workbench.page.getByRole('tab', { name: /Welcome/u }).first()).toBeVisible();
		const page = surface === 'Agent Window' ? await workbench.openAgentsWindow(target.kind) : workbench.page;
		await page.bringToFront();
		if (surface === 'Agent Window') await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		const commands = new QuickAccess(page);
		await commands.runCommand('workbench.action.chat.newChat');
		const chat = page.locator(surface === 'Agent Window' ? '.ash-sessions-chat-slot.active:visible .ash-chat' : '.ash-chat-view-pane .ash-chat:visible').first();
		await expect(chat.locator('.stanza-editor-input')).toBeFocused();
		await page.keyboard.insertText('Unsent model feedback draft');
		await commands.runCommand('workbench.action.chat.openModelPicker');
		const automatic = page.getByRole('switch', { name: 'Auto', exact: true });
		await expect(page.locator('.ash-chat-model-picker-footer')).toBeVisible();
		await automatic.press('Space'); await expect(automatic).not.toBeChecked(); await automatic.press('Escape');
		await expect(chat.getByRole('button', { name: 'GPT-6.1 Sol', exact: true })).toBeVisible();
		await chat.locator('.stanza-editor-input').focus();
		await expect(chat.locator('.stanza-editor-input')).toBeFocused();
		await commands.runCommand('workbench.action.chat.openModelFeedbackSurvey');
		const title = page.getByRole('textbox', { name: 'Title', exact: true });
		const description = page.getByRole('textbox', { name: 'Description', exact: true });
		await expect(title).toHaveValue('Model feedback: gpt-6.1-sol');
		await expect(description).toHaveValue(/Connection: openai\nModel: gpt-6.1-sol/u);
		await description.fill('Keep my edited reproduction steps.');
		await commands.runCommand('workbench.action.chat.openModelFeedbackSurvey');
		await expect(title).toHaveValue('Model feedback: gpt-6.1-sol');
		await expect(description).toHaveValue('Keep my edited reproduction steps.');
		await expect(chat.locator('.stanza-editor-line-text')).toHaveText('Unsent model feedback draft');
		await expect(page.getByRole('button', { name: 'New report', exact: true })).toBeHidden();
	});
}
