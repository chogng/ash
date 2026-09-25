import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('titlebar command center opens command search and restores focus', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const commandCenter = page.getByRole('button', { name: 'Search commands' });
	await expect(commandCenter).toBeVisible();

	const titlebar = page.locator('.ash-workbench-titlebar');
	const [titlebarBounds, controlBounds] = await Promise.all([titlebar.boundingBox(), commandCenter.boundingBox()]);
	expect(titlebarBounds).not.toBeNull();
	expect(controlBounds).not.toBeNull();
	expect(controlBounds!.width).toBeGreaterThan(300);
	expect(titlebarBounds!.height).toBe(35);
	expect(controlBounds!.height).toBe(24);
	expect(Math.abs(controlBounds!.x + controlBounds!.width / 2 - titlebarBounds!.x - titlebarBounds!.width / 2)).toBeLessThan(2);
	expect(Math.abs(controlBounds!.y + controlBounds!.height / 2 - titlebarBounds!.y - titlebarBounds!.height / 2)).toBeLessThan(0.6);
	const contentBounds = await commandCenter.locator('.ash-button-content').boundingBox();
	expect(contentBounds).not.toBeNull();
	expect(Math.abs(contentBounds!.x + contentBounds!.width / 2 - controlBounds!.x - controlBounds!.width / 2)).toBeLessThan(1);
	await expect(commandCenter).toHaveCSS('background-color', 'rgb(246, 246, 246)');
	await expect(commandCenter).toHaveCSS('border-color', 'rgb(208, 208, 208)');
	await commandCenter.hover();
	await expect(commandCenter).toHaveCSS('background-color', 'rgb(235, 235, 235)');

	await commandCenter.click();
	await expect(commandCenter).toHaveAttribute('aria-expanded', 'true');
	await expect(commandCenter).toHaveClass(/active/);
	const picker = page.locator('.ash-quick-pick');
	const query = picker.getByRole('combobox');
	await expect(query).toBeFocused();
	await expect(query).toHaveAttribute('placeholder', 'Search commands (type >, @, or ? for modes)');
	const initialPicker = await picker.elementHandle();
	await query.fill('?');
	await expect(query).toHaveAttribute('placeholder', 'Select a search mode');
	await expect(picker.locator('.ash-quick-pick-row-label', { hasText: '> Commands' })).toBeVisible();
	await query.fill('@');
	await expect(query).toHaveAttribute('placeholder', 'Type the name of a symbol in the workspace');
	await query.fill('?');
	await picker.locator('.ash-quick-pick-row-label', { hasText: '> Commands' }).click();
	await expect(query).toHaveValue('>');
	await expect(query).toHaveAttribute('placeholder', 'Type the name of a command to run');
	expect(await query.evaluate(input => (input as HTMLInputElement).selectionStart)).toBe(1);
	expect(await page.evaluate(element => element === document.querySelector('.ash-quick-pick'), initialPicker)).toBe(true);
	await query.pressSequentially('Toggle Minimap');
	await expect(query).toHaveValue('>Toggle Minimap');
	await expect(picker.locator('.ash-quick-pick-row-label', { hasText: 'Toggle Minimap' })).toBeVisible();
	await query.press('Escape');
	await expect(picker).toHaveCount(0);
	await expect(commandCenter).toHaveAttribute('aria-expanded', 'false');
	await expect(commandCenter).toBeFocused();

	await commandCenter.press('Enter');
	await expect(picker.getByRole('combobox')).toBeFocused();
	await picker.getByRole('combobox').press('Escape');

	for (const width of [801, 700]) {
		await page.setViewportSize({ width, height: 800 });
		await expect(commandCenter).toBeVisible();
		const [left, control, right] = await Promise.all([
			titlebar.locator('.ash-workbench-part-title').boundingBox(),
			commandCenter.boundingBox(),
			titlebar.locator('.ash-workbench-part-content').boundingBox(),
		]);
		expect(left!.x + left!.width).toBeLessThanOrEqual(control!.x);
		expect(control!.x + control!.width).toBeLessThanOrEqual(right!.x);
		if (width === 700) expect(control!.width).toBe(32);
	}
	await commandCenter.click();
	await expect(picker.getByRole('combobox')).toBeFocused();
});
