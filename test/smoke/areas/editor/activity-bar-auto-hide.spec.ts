import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('Activity Bar auto hide follows view moves and persists through reload', async ({ workbench, application, reloadWorkbench }) => {
	let page = workbench.page;
	const sidebar = () => page.locator('[data-part="sidebar"]');
	const switcher = () => sidebar().locator('.ash-composite-bar');
	await page.getByRole('tab', { name: 'Explorer', exact: true }).first().click();
	await workbench.quickaccess.runCommand('workbench.action.activityBarLocation.top');
	await expect(switcher()).toBeVisible();
	await workbench.settingsEditor.openUserSettingsUI();
	const settings = workbench.settingsEditor.element;
	await settings.getByRole('searchbox').fill('@id:workbench.activityBar.autoHide');
	const setting = settings.locator('[data-settings-item-id="workbench.activityBar.autoHide"]');
	await expect(setting).toContainText('Auto Hide Activity Bar');
	const toggle = setting.getByRole('switch');
	await expect(toggle).not.toBeChecked();
	await toggle.press('Space');
	await expect(toggle).toBeChecked();
	await settings.locator('.ash-modal-editor-close').click();

	// Keep Explorer active while moving every other selector through the product menu.
	const explorer = switcher().getByRole('tab', { name: 'Explorer', exact: true });
	const otherIds = await switcher().getByRole('tab').evaluateAll(tabs => tabs
		.filter(tab => tab.getAttribute('aria-selected') !== 'true')
		.map(tab => (tab as HTMLElement).dataset.actionId!));
	expect(otherIds.length).toBeGreaterThan(0);
	for (const id of otherIds) {
		const tab = switcher().locator(`[data-action-id="${id}"]`);
		await workbench.menus.select(application, () => tab.click({ button: 'right' }), ['Move To', 'Panel']);
	}
	await expect(switcher()).toBeHidden();
	await expect(sidebar()).toBeVisible();
	await expect(sidebar().getByRole('tabpanel', { name: 'Explorer', exact: true })).toBeVisible();
	({ workbench, application } = await reloadWorkbench());
	page = workbench.page;
	await expect(switcher()).toBeHidden();
	await expect(sidebar().getByRole('tabpanel', { name: 'Explorer', exact: true })).toBeVisible();
	// Rehosting must clear auto-hide's DOM state without changing the saved preference.
	await workbench.quickaccess.runCommand('workbench.action.activityBarLocation.default');
	await expect(page.locator('[data-part="activitybar"]').getByRole('tab', { name: 'Explorer', exact: true })).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.activityBarLocation.top');
	await expect(switcher()).toBeHidden();
	const moved = page.locator('[data-part="panel"]').locator(`[data-action-id="${otherIds[0]}"]`);
	await moved.click();
	await workbench.menus.select(application, () => moved.click({ button: 'right' }), ['Move To', 'Primary Side Bar']);
	await expect(switcher()).toBeVisible();
	await expect(explorer).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.activityBarLocation.bottom');
	await expect(sidebar().locator('.ash-sidebar-composite-bar-bottom .ash-composite-bar')).toBeVisible();
	({ workbench, application } = await reloadWorkbench());
	page = workbench.page;
	await expect(sidebar().locator('.ash-sidebar-composite-bar-bottom .ash-composite-bar')).toBeVisible();
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.element.getByRole('searchbox').fill('@id:workbench.activityBar.autoHide');
	await expect(workbench.settingsEditor.element.locator('[data-settings-item-id="workbench.activityBar.autoHide"]').getByRole('switch')).toBeChecked();
	await workbench.settingsEditor.element.locator('.ash-modal-editor-close').click();
	await workbench.quickaccess.runCommand('workbench.action.toggleAuxiliaryBar');
	const auxiliary = () => page.locator('[data-part="auxiliarybar"]');
	const auxiliarySelector = () => auxiliary().locator('.ash-composite-bar');
	await expect(auxiliary()).toBeVisible();
	await expect(auxiliarySelector()).toBeHidden();
	await workbench.menus.select(application, () => switcher().locator(`[data-action-id="${otherIds[0]}"]`).click({ button: 'right' }), ['Move To', 'Secondary Side Bar']);
	await expect(auxiliarySelector()).toBeVisible();
	await expect(auxiliarySelector().locator(`[data-action-id="${otherIds[0]}"]`)).toBeVisible();
	await workbench.menus.select(application, () => auxiliarySelector().locator(`[data-action-id="${otherIds[0]}"]`).press('Shift+F10'), ['Move To', 'Primary Side Bar']);
	await expect(auxiliarySelector()).toBeHidden();
	await expect(switcher()).toBeVisible();
	({ workbench, application } = await reloadWorkbench());
	page = workbench.page;
	await expect(auxiliary()).toBeVisible();
	await expect(auxiliarySelector()).toBeHidden();
	await expect(switcher()).toBeVisible();
});
