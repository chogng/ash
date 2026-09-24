import { expect, test } from '../../../automation/test.js';

test('Toolbar icons render at the standard 16px size', async ({ workbench }) => {
	const icon = workbench.page.locator('.ash-toolbar .ash-action-view-item.icon > .ash-button .ash-icon').first();
	await expect(icon).toBeVisible();
	await expect(icon).toHaveCSS('width', '16px');
	await expect(icon).toHaveCSS('height', '16px');
});
