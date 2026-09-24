import { expect, test } from '../../../automation/test.js';

test('Code exposes editor view actions in the command palette', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');

	await workbench.page.keyboard.press('F1');
	const picker = workbench.page.locator('.ash-quick-pick');
	const query = picker.getByRole('combobox');
	for (const label of ['Toggle Minimap', 'Toggle Render Whitespace', 'Toggle Control Characters', 'Go to Line/Column...']) {
		await query.fill(label);
		await expect(picker.locator('.ash-quick-pick-row-label').filter({ hasText: label })).toBeVisible();
	}
});
