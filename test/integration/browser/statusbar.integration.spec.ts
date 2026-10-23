import { expect, test } from '@playwright/test';

test('status bar hides a presentation while retaining its live entry and restores profile visibility after reload', async ({ page }) => {
	await page.goto('/statusbar.html');
	const branch = page.locator('[data-statusbar-item-id="fixture.branch"]');
	await expect(branch).toHaveText('main');
	await page.evaluate(() => window.ashStatusbarIntegration.setVisibility('fixture.branch', false));
	await expect(branch).toHaveCount(0);
	await page.evaluate(() => window.ashStatusbarIntegration.updateBranch('updated while hidden'));
	expect(await page.evaluate(() => window.ashStatusbarIntegration.entries())).toEqual([{ id: 'fixture.branch', text: 'updated while hidden' }]);
	await page.reload();
	await expect(page.locator('[data-part="statusbar"]')).toBeVisible();
	await expect(branch).toHaveCount(0);
	await page.evaluate(() => window.ashStatusbarIntegration.setVisibility('fixture.branch', true));
	await expect(branch).toHaveText('main');
	await page.reload();
	await expect(branch).toHaveText('main');
});

test('status bar context menu hides, restores and persists entries with checked state and keyboard focus', async ({ page }) => {
	await page.goto('/statusbar.html');
	const bar = page.locator('[data-part="statusbar"]');
	const branch = page.getByRole('button', { name: 'Branch main', exact: true });
	await branch.click({ button: 'right' });
	await page.getByRole('menuitem', { name: "Hide 'Branch main'", exact: true }).click();
	await expect(branch).toHaveCount(0);
	await expect(bar).toBeFocused();
	await page.reload();
	await expect(bar).toBeVisible();
	await expect(branch).toHaveCount(0);
	await bar.focus();
	await page.keyboard.press('Shift+F10');
	const toggle = page.getByRole('menuitemcheckbox', { name: 'Branch main', exact: true });
	await expect(toggle).toHaveAttribute('aria-checked', 'false');
	await toggle.click();
	await expect(branch).toBeVisible();
	await expect(bar).toBeFocused();
	await branch.focus();
	await page.keyboard.press('Shift+F10');
	await expect(page.getByRole('menuitemcheckbox', { name: 'Branch main', exact: true })).toHaveAttribute('aria-checked', 'true');
	await page.keyboard.press('Escape');
	await expect(branch).toBeFocused();
	await page.reload();
	await expect(branch).toBeVisible();
});

test('status bar commands use real keybindings, visual order, hidden filtering, activation and two-stage Escape', async ({ page }) => {
	await page.goto('/statusbar.html');
	const bar = page.locator('[data-part="statusbar"]');
	const branch = page.getByRole('button', { name: 'Branch main', exact: true });
	const cursor = page.getByRole('button', { name: 'Cursor', exact: true });
	const language = page.getByRole('button', { name: 'Language', exact: true });
	const editor = page.getByRole('textbox', { name: 'Editor input' });
	await page.evaluate(() => window.ashStatusbarIntegration.command('workbench.action.focusStatusBar'));
	await expect(bar).toBeFocused();
	await page.keyboard.press('ArrowRight');
	await expect(branch).toBeFocused();
	await page.keyboard.press('Enter');
	expect(await page.evaluate(() => window.ashStatusbarIntegration.activations)).toBe(1);
	await page.keyboard.press('ArrowDown');
	await expect(cursor).toBeFocused();
	await page.keyboard.press('End');
	await expect(language).toBeFocused();
	await page.keyboard.press('Home');
	await expect(branch).toBeFocused();
	await page.evaluate(() => window.ashStatusbarIntegration.setVisibility('fixture.cursor', false));
	await page.keyboard.press('ArrowRight');
	await expect(language).toBeFocused();
	await page.keyboard.press('ArrowUp');
	await expect(branch).toBeFocused();
	await editor.focus();
	await page.evaluate(() => window.ashStatusbarIntegration.command('workbench.action.focusStatusBar'));
	await expect(branch).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(bar).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(editor).toBeFocused();
	await editor.fill('input');
	await page.keyboard.press('Home');
	await expect(editor).toBeFocused();
});

test('Chinese status bar labels and menu actions retain theme focus indicators', async ({ page }, testInfo) => {
	await page.goto('/statusbar.html?zh');
	const bar = page.getByRole('status', { name: '状态栏', exact: true });
	await expect(bar).toBeVisible();
	const branch = page.getByRole('button', { name: 'Branch main', exact: true });
	for (let theme = 0; theme < 4; theme++) {
		await page.evaluate(index => window.ashStatusbarIntegration.theme(index), theme);
		await page.evaluate(() => window.ashStatusbarIntegration.command('workbench.action.focusStatusBar'));
		await page.keyboard.press('Home');
		await expect(branch).toBeFocused();
		await expect(branch).toHaveCSS('outline-style', 'solid');
		await expect(branch).toHaveCSS('outline-width', '1px');
		await page.keyboard.press('Shift+F10');
		await expect(page.getByRole('menuitem', { name: '隐藏“Branch main”', exact: true })).toBeVisible();
		await testInfo.attach(`statusbar-zh-theme-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
		await page.keyboard.press('Escape');
		await expect(branch).toBeFocused();
	}
});
