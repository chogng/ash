import { expect, test } from '../../../automation/test.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

test.use({ openWorkspace: false });

test('desktop window commands update zoom and open the window switcher', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'This scenario requires the Code desktop');
	if (target.kind !== 'electron' || !('windows' in application)) return;
	const page = workbench.page;
	const zoom = page.locator('[data-statusbar-item-id="ash.status.zoom"]');
	await expect(zoom).toContainText('100%');

	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('Zoom In');
	await page.keyboard.press('Enter');
	await expect(zoom).toContainText('120%');
	const profileRoot = await application.evaluate(() => process.env.ASH_HOME);
	if (!profileRoot) throw new Error('Test profile is unavailable');
	await expect.poll(async () => {
		const document = JSON.parse(await readFile(join(profileRoot, 'configuration.json'), 'utf8')) as { source: string };
		return (JSON.parse(document.source) as Record<string, unknown>)['window.zoomLevel'];
	}).toBe(1);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await expect(page.locator('.ash-workbench')).toBeVisible();
	await expect(zoom).toContainText('120%');

	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('Reset Zoom');
	await page.keyboard.press('Enter');
	await expect(zoom).toContainText('100%');

	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('Switch Window');
	await page.keyboard.press('Enter');
	const picker = page.locator('.ash-quick-pick');
	await expect(picker.getByRole('combobox')).toHaveAttribute('aria-label', 'Select a window');
	await expect(picker.locator('.ash-window-switch-current')).toHaveCount(1);
	await page.keyboard.press('Escape');
	await expect(picker).toHaveCount(0);
});
