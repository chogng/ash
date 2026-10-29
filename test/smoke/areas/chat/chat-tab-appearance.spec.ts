import { expect, test } from '../../../automation/test.js';

test('Chat conversation title uses toolbar colors and exposes keyboard focus', { tag: ['@browser-ui', '@electron-ui'] }, async ({ workbench }) => {
	const page = workbench.page;
	if (!(await page.locator('.ash-chat-view-pane').isVisible())) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const title = page.locator('.ash-chat-view-title-button');
	await expect(title).toHaveAttribute('aria-haspopup', 'dialog');
	await expect(title).toHaveAttribute('aria-expanded', 'false');
	await page.mouse.move(0, 0);
	await expect(title).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	await title.hover();
	const colors = await title.evaluate(element => {
		const reference = document.createElement('span');
		reference.style.background = 'var(--ash-toolbar-hoverBackground)';
		reference.style.color = 'var(--ash-focusBorder)';
		element.append(reference);
		const hover = getComputedStyle(reference).backgroundColor;
		const focus = getComputedStyle(reference).color;
		reference.style.background = 'var(--ash-list-activeSelectionBackground)';
		const listSelection = getComputedStyle(reference).backgroundColor;
		reference.remove();
		return { actual: getComputedStyle(element).backgroundColor, hover, focus, listSelection };
	});
	expect(colors.actual).toBe(colors.hover);
	expect(colors.actual).not.toBe(colors.listSelection);
	await page.keyboard.press('Tab');
	await title.focus();
	await expect(title).toHaveCSS('outline-style', 'solid');
	await expect(title).toHaveCSS('outline-color', colors.focus);
	await title.press('Enter');
	await expect(title).toHaveAttribute('aria-expanded', 'true');
	await expect(page.locator('.ash-quick-pick:visible')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(title).toHaveAttribute('aria-expanded', 'false');
	await expect(title).toBeFocused();
});
