import { expect, test } from '../../../automation/test.js';

test('Calls validate the server address before opening microphone devices', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Calls require an authorized product backend.');
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.getByPlaceholder('Type the name of a command to run').fill('Open Calls');
	await page.keyboard.press('Enter');
	const view = page.locator('.ash-call');
	await expect(view).toBeVisible();
	await expect(view.getByRole('status')).toContainText('microphone stays off');
	await expect(view.getByRole('button', { name: 'Unmute microphone', exact: true })).toBeDisabled();
	await view.getByLabel('Call', { exact: true }).focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.getByRole('dialog', { name: 'Calls help' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(view.getByLabel('Call', { exact: true })).toBeFocused();
	await view.getByLabel('Call', { exact: true }).selectOption('server');
	await view.getByLabel('Server address', { exact: true }).fill('http://example.com');
	await view.getByLabel('Administrator key or invitation key', { exact: true }).fill('invalid-test-key');
	await view.getByRole('button', { name: 'Join call', exact: true }).focus();
	await page.keyboard.press('Enter');
	await expect(view.getByRole('status')).toContainText('invalid call input');
	await expect(view.getByRole('button', { name: 'Join call', exact: true })).toBeEnabled();
	await expect(view.getByRole('button', { name: 'Unmute microphone', exact: true })).toBeDisabled();
});

test('Calls remain unavailable when the host has no call backend', async ({ target, workbench }) => {
	test.skip(target.appServerMode === 'required', 'This scenario covers the UI without an App Server.');
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.getByPlaceholder('Type the name of a command to run').fill('Open Calls');
	await expect(page.getByRole('option', { name: 'Open Calls', exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(page.locator('.ash-call')).toHaveCount(0);
});
