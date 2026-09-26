import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('editor tab uses the editor surface and shares its pin and close slot', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.getByRole('button', { name: 'Application menu' }).click();
	await page.getByRole('menu').first().getByRole('menuitem', { name: 'File' }).hover();
	await page.getByRole('menu').last().getByRole('menuitem', { name: 'New Untitled Text Editor' }).click();

	const ordinary = page.locator('.ash-ordinary-editor-tabs-row .ash-tab.checked');
	await expect(ordinary).toHaveCount(1);
	const untitledName = await ordinary.getByRole('tab').getAttribute('aria-label');
	expect(untitledName).toMatch(/^Untitled-/u);
	await expect(ordinary.locator('.ash-tab-close-action')).toHaveCount(1);
	await expect(ordinary.locator('.ash-tab-close-indicator')).toHaveCount(0);
	await expect(ordinary.getByRole('tab')).toHaveAttribute('aria-description', /Alt\+Enter to pin/u);
	const colors = await ordinary.evaluate(element => {
		const reference = document.createElement('span');
		reference.style.background = 'var(--ash-editor-background)';
		element.append(reference);
		const editor = getComputedStyle(reference).backgroundColor;
		reference.remove();
		return { tab: getComputedStyle(element).backgroundColor, editor };
	});
	expect(colors.tab).toBe(colors.editor);

	await ordinary.getByRole('tab').dblclick();
	const sticky = page.locator('.ash-sticky-editor-tabs-row .ash-tab.checked');
	await expect(sticky).toHaveCount(1);
	const close = sticky.locator('.ash-tab-close-action');
	await expect(close).toHaveCount(1);
	await expect(close.locator('button > .ash-tab-close-indicator')).toHaveCount(1);
	await expect(sticky.getByRole('tab')).toHaveAttribute('aria-description', /Alt\+Enter to unpin/u);
	await page.mouse.move(0, 0);
	await sticky.getByRole('tab').blur();
	await expect(close.locator('.ash-tab-close-indicator')).toBeVisible();
	await sticky.getByRole('tab').hover();
	await expect(close.locator('.ash-tab-close-indicator')).toBeHidden();
	await expect(close.locator('button')).toBeVisible();
	await sticky.getByRole('tab').press('Alt+Enter');
	await expect(page.locator('.ash-sticky-editor-tabs-row .ash-tab')).toHaveCount(0);
	await ordinary.locator('.ash-tab-close-action button').click();
	await expect(page.getByRole('tab', { name: untitledName! })).toHaveCount(0);
});
