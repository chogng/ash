import { expect, test } from '../../../automation/test.js';

test('AI status supports keyboard navigation, cancellation and model settings', { tag: ['@electron-ui', '@browser-ui'] }, async ({ workbench }) => {
	const page = workbench.page;
	const entry = page.getByRole('button', { name: /^AI · / });
	await expect(entry).toBeVisible();
	await entry.focus();
	await page.keyboard.press('Enter');
	const picker = page.getByRole('combobox', { name: 'AI status — account status is separate from API model access', exact: true });
	await expect(picker).toBeFocused();
	await expect(page.getByRole('option', { name: /Manage Accounts/ })).toBeVisible();
	await expect(page.getByRole('option', { name: /View Chat Usage/ })).toBeVisible();
	await expect(page.getByRole('option', { name: 'Refresh Account Status and Limits', exact: true })).toBeVisible();
	await picker.press('Escape');
	await expect(picker).toHaveCount(0);
	await expect(entry).toBeFocused();
	await page.keyboard.press('Space');
	await expect(picker).toBeFocused();
	await picker.fill('Configure Model Connections');
	await picker.press('Enter');
	await expect(workbench.settingsEditor.element.locator('.ash-chat-models-catalog')).toBeVisible();
});
