import { expect, test } from '../../../automation/test.js';

test('Code exposes editor view actions in the command palette', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');

	await workbench.page.keyboard.press('F1');
	const picker = workbench.page.locator('.ash-quick-pick');
	const colors = await picker.evaluate(element => {
		const initial = getComputedStyle(element).backgroundColor;
		(element as HTMLElement).style.setProperty('--ash-quick-input-background', '#123456');
		const overridden = getComputedStyle(element).backgroundColor;
		(element as HTMLElement).style.removeProperty('--ash-quick-input-background');
		return { initial, overridden, restored: getComputedStyle(element).backgroundColor };
	});
	expect(colors.initial).not.toBe('rgba(0, 0, 0, 0)');
	expect(colors.overridden).toBe('rgb(18, 52, 86)');
	expect(colors.restored).toBe(colors.initial);
	const query = picker.getByRole('combobox');
	for (const label of ['Toggle Minimap', 'Toggle Render Whitespace', 'Toggle Control Characters', 'View: Toggle Word Wrap', 'Go to Line/Column...']) {
		await query.fill(label);
		await expect(picker.locator('.ash-quick-pick-row-label').filter({ hasText: label })).toBeVisible();
	}
});
