import { expect, test } from '@playwright/test';

test('dictation inserts at the rich editor selection and preserves undo', async ({ page }) => {
	await page.goto('/table.html');
	const editor = page.getByRole('textbox', { name: 'Dictation draft' });
	await editor.focus();
	await page.keyboard.type('before old after');
	await page.keyboard.press('Home');
	for (let index = 0; index < 7; index++) { await page.keyboard.press('ArrowRight'); }
	for (let index = 0; index < 3; index++) { await page.keyboard.press('Shift+ArrowRight'); }
	await page.evaluate(() => window.ashTableIntegration.startDictation());
	await page.evaluate(() => window.ashTableIntegration.transcript('partial', false));
	await expect(page.locator('#dictation-preview')).toHaveText('partial');
	expect(await page.evaluate(() => window.ashTableIntegration.draft)).toBe('before old after');
	await page.evaluate(() => window.ashTableIntegration.transcript('replacement', true));
	expect(await page.evaluate(() => window.ashTableIntegration.draft)).toBe('before replacement after');
	await page.keyboard.press('ControlOrMeta+z');
	expect(await page.evaluate(() => window.ashTableIntegration.draft)).toBe('before old after');
});

test('shared dictation disables other inputs and routes text to its current editor', async ({ page }) => {
	await page.goto('/table.html');
	const second = page.locator('#second-input');
	const microphone = second.locator('[data-action-id="ash.chat.input.mic"] button');
	await expect(microphone).toBeEnabled();
	await page.evaluate(() => window.ashTableIntegration.startDictation());
	await expect(microphone).toBeDisabled();
	await page.evaluate(() => window.ashTableIntegration.transcript('first editor', true));
	expect(await page.evaluate(() => window.ashTableIntegration.draft)).toBe('first editor');
	expect(await page.evaluate(() => window.ashTableIntegration.secondDraft())).toBe('');
	await page.evaluate(() => window.ashTableIntegration.stopDictation());
	await expect(microphone).toBeEnabled();
	await microphone.focus();
	await page.keyboard.press('Space');
	await expect(microphone).toHaveAttribute('aria-pressed', 'true');
	await page.evaluate(() => window.ashTableIntegration.transcript('second editor', true));
	expect(await page.evaluate(() => window.ashTableIntegration.secondDraft())).toBe('second editor');
	expect(await page.evaluate(() => window.ashTableIntegration.draft)).toBe('first editor');
	await page.evaluate(() => window.ashTableIntegration.hideSecondInput());
	await page.evaluate(() => window.ashTableIntegration.transcript('late text', true));
	expect(await page.evaluate(() => window.ashTableIntegration.secondDraft())).toBe('second editor');
});

test('model table installs, preserves progress focus, cancels and selects installed models', async ({ page }) => {
	await page.goto('/table.html');
	const grid = page.getByRole('grid', { name: 'Local dictation models' });
	await expect(grid.getByRole('columnheader')).toHaveText(['Model', 'Size', 'Status', 'Actions']);
	const missing = grid.getByRole('row').filter({ hasText: 'paraformer-large-online' });
	const installed = grid.getByRole('row').filter({ hasText: 'imported-model' });
	await expect(missing.getByRole('button', { name: 'Install', exact: true })).toBeEnabled();
	await expect(installed.getByRole('button', { name: 'Use model', exact: true })).toBeEnabled();
	await missing.getByRole('button', { name: 'Install', exact: true }).click();
	const cancel = missing.getByRole('button', { name: 'Cancel', exact: true });
	await cancel.focus();
	await page.evaluate(() => window.ashTableIntegration.progress());
	await expect(missing).toContainText('Downloading encoder.onnx: 1.0 MiB');
	await expect(cancel).toBeFocused();
	await cancel.click();
	await expect(missing.getByRole('button', { name: 'Install', exact: true })).toBeEnabled();
	await installed.getByRole('button', { name: 'Use model', exact: true }).click();
	await expect(installed.getByRole('button', { name: 'Current', exact: true })).toBeDisabled();
	await installed.getByRole('button', { name: 'Uninstall', exact: true }).click();
	await installed.getByRole('button', { name: 'Confirm uninstall', exact: true }).click();
	await expect(installed).toContainText('Not installed');
	expect(await page.evaluate(() => window.ashTableIntegration.operations)).toEqual([
		'install:paraformer-large-online-ec6a3c64', 'cancel:paraformer-large-online-ec6a3c64', 'uninstall:imported-model',
	]);
});

test('table columns align through resizing and remain keyboard accessible in every theme', async ({ page }) => {
	await page.goto('/table.html');
	const grid = page.getByRole('grid');
	const rows = grid.getByRole('row');
	await rows.nth(1).focus();
	await page.keyboard.press('ArrowDown');
	await expect(rows.nth(2)).toBeFocused();
	await page.keyboard.press('ArrowRight');
	await expect(rows.nth(2).getByRole('gridcell').first()).toBeFocused();
	for (const theme of ['light', 'dark', 'hcLight', 'hcDark']) {
		await page.evaluate(name => window.ashTableIntegration.theme(name), theme);
		expect(await rows.nth(2).getByRole('gridcell').first().evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
	}
	const separator = grid.getByRole('separator').first();
	await separator.focus();
	const before = await grid.getByRole('columnheader').first().boundingBox();
	await page.keyboard.press('ArrowRight');
	await expect.poll(async () => (await grid.getByRole('columnheader').first().boundingBox())!.width).not.toBe(before!.width);
	const widths = await grid.evaluate(element => {
		const headers = [...element.querySelectorAll('[role="columnheader"]')].map(node => node.getBoundingClientRect().width);
		const cells = [...element.querySelectorAll('.ash-table-row')][0]!.querySelectorAll('[role="gridcell"]');
		return [headers, [...cells].map(node => node.getBoundingClientRect().width)];
	});
	expect(widths[1]).toEqual(widths[0]);
	await page.evaluate(() => { document.getElementById('models')!.style.width = '340px'; });
	await expect.poll(() => grid.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
	await page.evaluate(() => window.ashTableIntegration.locale());
	await expect(page.getByRole('grid', { name: '本地听写模型' }).getByRole('columnheader')).toHaveText(['模型', '大小', '状态', '操作']);
	await page.evaluate(() => window.ashTableIntegration.dispose());
	await expect(page.getByRole('grid')).toHaveCount(0);
});
