import { expect, test } from '@playwright/test';

test('a short dialog detail stays keyboard-accessible while it scrolls', async ({ page }) => {
	await page.setViewportSize({ width: 800, height: 300 });
	await page.goto('/dialog.html');
	const text = Array.from({ length: 26 }, (_, index) => `Line ${index + 1}`).join('\n');
	expect(text.length).toBeLessThan(1_025);
	await page.evaluate(detail => window.ashDialogIntegration.show(detail), text);

	const detail = page.locator('.ash-dialog-detail');
	await expect(detail).toBeVisible();
	await expect(detail).toHaveAttribute('tabindex', '0');
	expect(await detail.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
	const confirm = page.getByRole('button', { name: 'Confirm' });
	await confirm.focus();
	await page.keyboard.press('Shift+Tab');
	await expect(detail).toBeFocused();
	expect(await detail.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
	await page.keyboard.press('PageDown');
	await expect.poll(() => detail.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

	await page.setViewportSize({ width: 800, height: 1_200 });
	await expect.poll(() => detail.evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
	await expect(detail).not.toHaveAttribute('tabindex');
	await confirm.focus();
	await page.keyboard.press('Shift+Tab');
	await expect(detail).not.toBeFocused();
	await page.getByRole('button', { name: 'Cancel' }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('dialog buttons and Escape return their result and restore focus', async ({ page }) => {
	await page.goto('/dialog.html');
	await page.evaluate(() => {
		const trigger = document.createElement('button');
		trigger.id = 'dialog-trigger';
		trigger.textContent = 'Open dialog';
		document.body.append(trigger);
		trigger.focus();
		window.ashDialogIntegration.showPrompt();
	});

	const dialog = page.getByRole('dialog', { name: 'Save changes' });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Save' })).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(dialog.getByRole('button', { name: 'Save' })).toBeFocused();
	await dialog.getByRole('button', { name: 'Discard' }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.locator('#dialog-trigger')).toBeFocused();
	await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastResult)).toBe('secondary');

	await page.evaluate(() => window.ashDialogIntegration.showPrompt());
	await expect(dialog).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(page.locator('#dialog-trigger')).toBeFocused();
	await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastResult)).toBe('cancel');
});

test('aborting a dialog settles it as cancelled and removes its modal', async ({ page }) => {
	await page.goto('/dialog.html');
	await page.evaluate(() => window.ashDialogIntegration.show('Details'));
	await expect(page.getByRole('dialog')).toBeVisible();
	await page.evaluate(() => window.ashDialogIntegration.abort());
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastResult)).toBe('cancel');
});

test('disposing a dialog without buttons resolves it and restores focus', async ({ page }) => {
	await page.goto('/dialog.html');
	await page.evaluate(() => {
		const trigger = document.createElement('button');
		trigger.id = 'dialog-trigger';
		document.body.append(trigger);
		trigger.focus();
		window.ashDialogIntegration.showBare();
	});
	const dialog = page.getByRole('dialog', { name: 'Plain dialog' });
	await expect(dialog).toBeFocused();
	await page.evaluate(() => window.ashDialogIntegration.disposeBare());
	await expect(dialog).toHaveCount(0);
	await expect(page.locator('#dialog-trigger')).toBeFocused();
	await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastResult)).toBe('');
});

test('input dialog returns typed values and checkbox state', async ({ page }) => {
	await page.goto('/dialog.html');
	await page.evaluate(() => window.ashDialogIntegration.showInput());
	const dialog = page.getByRole('dialog', { name: 'Connect' });
	const input = dialog.getByRole('textbox', { name: 'Server address' });
	await expect(input).toBeFocused();
	await input.fill('https://example.test');
	await dialog.getByRole('checkbox', { name: 'Remember server' }).check();
	await input.press('Enter');
	await expect(dialog).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastOutcome)).toEqual({
		button: 'primary',
		checkboxChecked: true,
		values: ['https://example.test'],
	});
});

test('confirmation returns the checkbox state after the primary action', async ({ page }) => {
	await page.goto('/dialog.html');
	await page.evaluate(() => window.ashDialogIntegration.showCheckboxConfirmation());
	const dialog = page.getByRole('dialog', { name: 'Remove server' });
	await dialog.getByRole('checkbox', { name: 'Also remove credentials' }).check();
	await dialog.getByRole('button', { name: 'Confirm' }).click();
	await expect(dialog).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastOutcome)).toEqual({
		button: 'primary', checkboxChecked: true, values: undefined,
	});
});
