import { expect, test } from '../../../automation/test.js';

test('clearing one notification toast updates the center while hiding toasts retains other records', async ({ workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('notifications.clearAll');
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	const buttons = page.locator('.ash-notification-host').getByRole('button', { name: 'Remove notification', exact: true });
	await expect(buttons).toHaveCount(2);
	const removedId = await buttons.first().getAttribute('data-notification-close');
	const retainedId = await buttons.last().getAttribute('data-notification-close');
	await buttons.first().click();
	await expect(page.locator(`[data-notification-close="${removedId}"]`)).toHaveCount(0);
	await expect(page.locator(`[data-notification-close="${retainedId}"]`)).toBeVisible();

	await workbench.quickaccess.runCommand('notifications.showList');
	const center = page.getByRole('region', { name: 'Notification Center', exact: true });
	await expect(center.locator(`[data-notification-id="${removedId}"]`)).toHaveCount(0);
	await expect(center.locator(`[data-notification-id="${retainedId}"]`)).toBeVisible();
	await workbench.quickaccess.runCommand('notifications.hideList');
	await expect(buttons).toHaveCount(0);
	await workbench.quickaccess.runCommand('notifications.showList');
	await expect(center.locator(`[data-notification-id="${retainedId}"]`)).toBeVisible();
	await center.getByRole('button', { name: 'Clear All', exact: true }).click();
	await expect(center.getByText('No notifications', { exact: true })).toBeVisible();
});

test('keyboard clearing moves between notification toasts and restores focus after the last record', async ({ workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('notifications.clearAll');
	for (let index = 0; index < 3; index++) {
		await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	}
	const buttons = page.locator('.ash-notification-host').getByRole('button', { name: 'Remove notification', exact: true });
	await expect(buttons).toHaveCount(3);
	const ids = await buttons.evaluateAll(elements => elements.map(element => (element as HTMLButtonElement).dataset.notificationClose!));
	const close = (index: number) => page.locator(`[data-notification-close="${ids[index]}"]`);
	const origin = page.getByRole('button', { name: 'Show Notification Center', exact: true });
	await origin.focus();
	await close(1).focus();
	await page.keyboard.press('Enter');
	await expect(close(1)).toHaveCount(0);
	await expect(close(2)).toBeFocused();
	await page.keyboard.press('Space');
	await expect(close(2)).toHaveCount(0);
	await expect(close(0)).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(buttons).toHaveCount(0);
	await expect(origin).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('region', { name: 'Notification Center', exact: true }).getByText('No notifications', { exact: true })).toBeVisible();
});

test('notification toast removal uses the Chinese label and clears the localized center', async ({ workbench, restartWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language', exact: true });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	({ workbench } = await restartWorkbench());
	const page = workbench.page;
	await workbench.quickaccess.runCommand('notifications.clearAll');
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	const toast = page.locator('.ash-notification-host').getByRole('button', { name: '移除通知', exact: true });
	await expect(toast).toBeVisible();
	await toast.click();
	await expect(toast).toHaveCount(0);
	await workbench.quickaccess.runCommand('notifications.showList');
	await expect(page.getByRole('region', { name: '通知中心', exact: true }).getByText('没有通知', { exact: true })).toBeVisible();
});
