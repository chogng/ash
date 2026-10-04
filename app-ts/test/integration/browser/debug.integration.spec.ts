import { expect, test } from '@playwright/test';

test('stopped debugging locates source and edits a nested variable with keyboard focus and theme support', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/debug.html');
	await expect.poll(() => page.evaluate(() => window.ashDebugIntegration.position())).toBe(2);
	const parent = page.locator('.ash-debug-variable').filter({ hasText: 'parent = Object' });
	await parent.dblclick();
	const parentValue = page.getByRole('textbox', { name: 'Value of parent', exact: true });
	await expect(parentValue).toBeFocused();
	await parentValue.press('Escape');
	await expect(parent).toHaveAttribute('aria-expanded', 'true');
	const child = page.locator('.ash-debug-variable').filter({ hasText: 'child = value' });
	await child.focus();
	await child.press('F2');
	const value = page.getByRole('textbox', { name: 'Value of child', exact: true });
	await expect(value).toBeFocused();
	await value.fill('cancelled');
	await value.press('Escape');
	await expect(child).toBeFocused();
	expect(await page.evaluate(() => window.ashDebugIntegration.assignments())).toEqual([]);
	await child.dblclick();
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
		await page.evaluate(theme => window.ashDebugIntegration.theme(theme), theme);
		await value.focus();
		const colors = await value.evaluate(element => {
			const style = getComputedStyle(element.closest('.ash-input-box')!);
			return { background: style.backgroundColor, border: style.borderColor, borderStyle: style.borderStyle };
		});
		expect(colors.borderStyle).toBe('solid');
		expect(colors.border).not.toBe(colors.background);
	}
	await page.evaluate(() => window.ashDebugIntegration.resize(220));
	const geometry = await value.evaluate(element => {
		const input = element.getBoundingClientRect();
		const pane = element.closest('.ash-debug')!.getBoundingClientRect();
		return { width: input.width, fits: input.left >= pane.left && input.right <= pane.right };
	});
	expect(geometry.width).toBeGreaterThan(0);
	expect(geometry.fits).toBe(true);
	await value.fill('43');
	await value.press('Enter');
	const updated = page.locator('.ash-debug-variable').filter({ hasText: 'child = 43' });
	await expect(updated).toBeFocused();
	await expect(page.locator('.ash-debug-watch-value')).toHaveText('answer = 43');
	expect(await page.evaluate(() => window.ashDebugIntegration.assignments())).toEqual([{ reference: 21, name: 'child', value: '43' }]);
	expect(errors).toEqual([]);
});

test('variable edits expose validation, discard replies after resume, and localize input instructions', async ({ page }) => {
	await page.goto('/debug.html?locale=zh-cn');
	const parent = page.locator('.ash-debug-variable').filter({ hasText: 'parent = Object' });
	await parent.focus();
	await parent.press('F2');
	const value = page.getByRole('textbox', { name: 'parent 的值', exact: true });
	await expect(value).toHaveAttribute('aria-description', '按 Enter 应用新值，按 Escape 取消。');
	await page.evaluate(() => window.ashDebugIntegration.failAssignment());
	await value.fill('invalid');
	await value.press('Enter');
	await expect(value).toHaveAttribute('aria-invalid', 'true');
	await expect(value).toBeFocused();
	await expect(page.getByRole('alert').filter({ hasText: 'Invalid value' })).toHaveText('Invalid value');
	await page.evaluate(() => window.ashDebugIntegration.holdAssignment());
	await value.fill('pending');
	await value.press('Enter');
	await expect(value).toHaveAttribute('readonly');
	await page.evaluate(() => window.ashDebugIntegration.resume());
	await expect(page.locator('.ash-debug-variable-edit')).toHaveCount(0);
	await page.evaluate(() => window.ashDebugIntegration.releaseAssignment());
	await expect(page.locator('.ash-debug-frame, .ash-debug-variable')).toHaveCount(0);
	await expect(page.getByRole('status')).toContainText('正在运行');
});
