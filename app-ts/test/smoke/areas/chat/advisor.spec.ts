import { expect, test } from '../../../automation/test.js';

test('Advisor settings and direct questions use one chat command', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'required', 'Advisor configuration requires the product backend.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	await expect(page.locator('.ash-chat-status')).not.toHaveText('Loading chat...');
	const input = page.locator('.ash-chat-input-editor .stanza-editor-input');
	const command = async (text: string): Promise<void> => {
		await input.focus();
		await page.keyboard.press('ControlOrMeta+A');
		await page.keyboard.insertText(text);
		await page.keyboard.press('Escape');
		await page.keyboard.press('Enter');
	};
	await command('/advisor');
	const picker = page.getByRole('dialog', { name: 'Chat settings and advisor model' });
	await expect(picker).toBeVisible();
	await expect(picker.getByPlaceholder('Configure a provider in Chat Settings to choose an advisor model')).toBeVisible();
	await expect(picker.getByText('Manage Model API Keys')).toBeVisible();
	await expect(picker.locator('.ash-list-row')).toHaveCount(2);
	await expect(page.locator('.ash-chat-item-userMessage')).toHaveCount(0);
	await page.keyboard.press('Escape');
	await command('/advisor Check cancellation');
	const status = page.locator('.ash-chat:visible .ash-chat-status');
	await expect(status).toHaveText('Configure an advisor model in Chat Settings before asking for a second opinion');
	await expect(page.locator('.ash-chat-item-userMessage')).toHaveCount(0);
});

test('Model provider key entry uses the App Server and shows only saved status', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'required', 'Model provider keys require the product backend.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	await expect(page.locator('.ash-chat-status')).not.toHaveText('Loading chat...');
	const chatInput = page.locator('.ash-chat-input-editor .stanza-editor-input');
	await chatInput.focus();
	await page.keyboard.insertText('/config');
	await page.keyboard.press('Escape');
	await page.keyboard.press('Enter');
	const settings = page.getByRole('dialog', { name: 'Chat settings and advisor model' });
	await settings.locator('input').fill('Manage Model API Keys');
	await settings.locator('input').press('Enter');

	const providers = page.getByRole('dialog', { name: 'Model provider API keys' });
	await expect(providers).toBeVisible();
	await providers.locator('input').fill('OpenAI');
	await providers.locator('input').press('Enter');
	const keyEntry = page.getByRole('dialog', { name: 'API key for OpenAI' });
	const keyInput = keyEntry.locator('input[type="password"]');
	await expect(keyInput).toBeVisible();
	await keyInput.fill('ash-smoke-test-key');
	await keyInput.press('Enter');
	await expect(keyEntry).toBeHidden();
	await expect(page.locator('body')).not.toContainText('ash-smoke-test-key');
	await page.getByRole('button', { name: 'OK', exact: true }).click();

	await chatInput.focus();
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.insertText('/config');
	await page.keyboard.press('Escape');
	await page.keyboard.press('Enter');
	const reopened = page.getByRole('dialog', { name: 'Chat settings and advisor model' });
	await reopened.locator('input').fill('Manage Model API Keys');
	await reopened.locator('input').press('Enter');
	const savedProviders = page.getByRole('dialog', { name: 'Model provider API keys' });
	await savedProviders.locator('input').fill('OpenAI');
	await expect(savedProviders.getByRole('option', { name: 'OpenAI API key saved', exact: true })).toBeVisible();
});
