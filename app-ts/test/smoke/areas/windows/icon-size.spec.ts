import { expect, test } from '../../../automation/test.js';

test('Toolbar icons render at the standard 16px size', async ({ workbench }) => {
	const icon = workbench.page.locator('.ash-toolbar .ash-action-view-item.icon > .ash-button .ash-icon').first();
	await expect(icon).toBeVisible();
	await expect(icon).toHaveCSS('width', '16px');
	await expect(icon).toHaveCSS('height', '16px');
});

test('terminal split action joins both buttons with the shared control radius', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.getByRole('button', { name: 'Show Panel', exact: true }).click();
	const split = page.locator('[data-part="panel"] .ash-dropdown-with-primary-action-view-item');
	await expect(split).toBeVisible();
	await expect(split).toHaveCSS('gap', '0px');
	await expect(split).toHaveCSS('border-radius', '4px');
	const primary = split.locator('.ash-dropdown-with-primary-primary button');
	const dropdown = split.locator('.ash-dropdown-with-primary-dropdown button');
	await expect(primary).toHaveCSS('border-radius', '4px 0px 0px 4px');
	await expect(dropdown).toHaveCSS('border-radius', '0px 4px 4px 0px');
	const [left, right] = await Promise.all([primary.boundingBox(), dropdown.boundingBox()]);
	expect(left).not.toBeNull();
	expect(right).not.toBeNull();
	expect(right!.x).toBeCloseTo(left!.x + left!.width, 1);
	expect(right!.height).toBe(left!.height);
});
