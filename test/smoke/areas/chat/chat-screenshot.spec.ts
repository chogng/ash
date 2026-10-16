import { expect, test } from '../../../automation/test.js';
import type { ISandboxGlobals } from '../../../../src/ash/base/parts/sandbox/electron-browser/sandboxTypes.js';

test.use({ video: 'on' });

test('Desktop captures its window, previews a region and confirms an image into the draft', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ application, workbench }, testInfo) => {
	const page = workbench.page;
	if (!('browserWindow' in application)) throw new Error('Expected an Electron window');
	// Exercise the actual trusted sender route, including CSS coordinates under window zoom.
	const owner = await application.browserWindow(page);
	await owner.evaluate(window => window.webContents.setZoomFactor(1.25));
	try {
		const capture = await page.evaluate(async () => {
			const host = (globalThis as unknown as { ash: ISandboxGlobals; }).ash;
			const bytes = await host.ipcRenderer.invoke('ash:host:screenshot', { x: 20, y: 30, width: 160, height: 96 }) as Uint8Array;
			const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
			try { return { signature: [...bytes.slice(0, 8)], width: bitmap.width, height: bitmap.height, scale: devicePixelRatio }; }
			finally { bitmap.close(); }
		});
		expect(capture.signature).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
		expect(capture.width).toBe(Math.round(160 * capture.scale));
		expect(capture.height).toBe(Math.round(96 * capture.scale));
	} finally { await owner.evaluate(window => window.webContents.setZoomFactor(1)); }

	await workbench.quickaccess.runCommand('workbench.action.chat.open');
	await page.getByRole('button', { name: 'Add context', exact: true }).last().click();
	await page.getByRole('dialog').getByRole('option', { name: 'Screenshot Window', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Screenshot Preview' });
	const confirm = dialog.getByRole('button', { name: 'Add to Chat', exact: true });
	await expect(confirm).toBeFocused();
	await expect.poll(() => dialog.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(500);
	await dialog.getByRole('button', { name: 'Select Region' }).click();
	for (const [name, value] of [['X', '20'], ['Y', '60'], ['Width', '400'], ['Height', '240']]) {
		const field = dialog.getByLabel(name, { exact: true });
		await field.fill(value);
		await field.press('Tab');
	}
	await dialog.getByRole('button', { name: 'Preview Region' }).click();
	await expect(dialog.getByRole('status')).toHaveText('400 × 240 pixels');
	await expect(dialog.locator('img')).toHaveJSProperty('naturalWidth', 400);
	await expect(dialog.locator('img')).toHaveJSProperty('naturalHeight', 240);
	const previewPath = testInfo.outputPath('desktop-screenshot-preview.png');
	await page.screenshot({ path: previewPath });
	await testInfo.attach('desktop-screenshot-preview', { path: previewPath, contentType: 'image/png' });
	await confirm.click();
	await expect(dialog).toHaveCount(0);
	await expect(page.locator('.ash-chat-input-editor').getByRole('textbox').last()).toBeFocused();
	await expect(page.getByRole('button', { name: 'Preview Screenshot', exact: true })).toBeVisible();
});
