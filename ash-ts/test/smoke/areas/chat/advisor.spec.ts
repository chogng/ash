import { expect, test } from '../../../automation/test.js';

test('Advisor selection persists through the product backend without starting a worker Turn', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'required', 'Advisor configuration requires the product backend.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const input = page.locator('.ash-chat-input-editor .stanza-editor-input');
	const command = async (text: string): Promise<void> => {
		await input.focus();
		await page.keyboard.press('ControlOrMeta+A');
		await page.keyboard.insertText(text);
		await page.keyboard.press('Escape');
		await page.keyboard.press('Enter');
	};
	await command('/advisor');
	await expect(page.getByPlaceholder('Advisor (default) — consultations use additional tokens')).toBeVisible();
	await page.getByText('No advisor', { exact: true }).click();
	await expect(input).toBeFocused();
	await command('/advisor');
	await expect(page.getByPlaceholder('Advisor (off) — consultations use additional tokens')).toBeVisible();
	await page.keyboard.press('Escape');
	await command('/advisor ask Check cancellation');
	await expect(page.getByText('Select an advisor model with /advisor before asking for a second opinion', { exact: true })).toBeVisible();
	await expect(page.locator('.ash-chat-item-userMessage')).toHaveCount(0);
});
