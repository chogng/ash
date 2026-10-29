import { expect, test } from '../../../automation/test.js';

test('status bar command, keyboard menu and entry visibility survive a Workbench restart', async ({
	workbench,
	reloadWorkbench,
}) => {
	let page = workbench.page;
	let bar = page.locator('[data-part="statusbar"]');
	let bell = bar.locator('[data-statusbar-item-id="ash.status.notifications"] [role="button"]');
	await expect(bell).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.focusStatusBar');
	await expect(bar).toBeFocused();
	await page.keyboard.press('End');
	await expect(bell).toBeFocused();
	const label = await bell.getAttribute('aria-label');
	await page.keyboard.press('Shift+F10');
	await page.getByRole('menuitem', { name: `Hide '${label}'`, exact: true }).click();
	await expect(bell).toHaveCount(0);
	await expect(bar).toBeFocused();
	const reloaded = await reloadWorkbench();
	page = reloaded.workbench.page;
	bar = page.locator('[data-part="statusbar"]');
	bell = bar.locator('[data-statusbar-item-id="ash.status.notifications"] [role="button"]');
	await expect(bar).toBeVisible();
	await expect(bell).toHaveCount(0);
	await reloaded.workbench.quickaccess.runCommand('workbench.action.focusStatusBar');
	await page.keyboard.press('Shift+F10');
	const toggle = page.locator('[data-action-id="ash.status.notifications"] [role="menuitemcheckbox"]');
	await expect(toggle).toHaveAttribute('aria-checked', 'false');
	await toggle.click();
	await expect(bell).toBeVisible();
	await page.keyboard.press('End');
	await expect(bell).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(bar).toBeFocused();
	await page.keyboard.press('Escape');
	expect(await bar.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(false);
});
