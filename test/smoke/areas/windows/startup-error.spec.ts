import { expect, test } from '../../../automation/test.js';
import { launchBrowser } from '../../../automation/playwrightBrowser.js';

test('Electron renderer startup failure copies the complete error before the Workbench exists', async ({ application, workbench }, testInfo) => {
	test.skip(testInfo.project.name !== 'electron-app-server', 'Requires the desktop App Server.');
	if (!('windows' in application)) throw new Error('An Electron application is required');
	const failure = 'Renderer startup IPC failed\nThe complete diagnostic remains selectable and copyable.';
	// The Main startup gate presents a system dialog before it opens a window.
	// Fail the renderer's first real IPC call on reload to exercise its error view.
	await application.evaluate(({ ipcMain }, failure) => {
		ipcMain.removeHandler('ash:ipc:window-id');
		ipcMain.handle('ash:ipc:window-id', () => { throw new Error(failure); });
	}, failure);
	const page = workbench.page;
	await page.reload();
	const details = page.getByRole('textbox', { name: 'Error details' });
	await expect.poll(() => details.inputValue()).toContain(failure);
	await expect(page.locator('.ash-workbench')).toHaveCount(0);
	await page.getByRole('button', { name: 'Copy details' }).click();
	await expect(page.getByRole('status')).toHaveText('Error details copied.');
	expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(await details.inputValue());
});

test('Web startup failure copies its details and keeps them selectable', async ({ webAppServer }, testInfo) => {
	test.skip(testInfo.project.name !== 'browser-app-server', 'Requires the connected Web product.');
	if (!webAppServer) { throw new Error('The Web startup scenario requires its App Server'); }
	const browser = await launchBrowser({ appServerMode: 'required', baseURL: webAppServer.connection.endpoint, webSession: webAppServer.connection });
	try {
		const page = browser.driver.workbench.page;
		await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.goto('/#ash-endpoint=http%3A%2F%2F127.0.0.1%3A1');
		const details = page.getByRole('textbox', { name: 'Error details' });
		await expect(details).toBeVisible();
		await expect(details).not.toBeEmpty();
		await page.getByRole('button', { name: 'Copy details' }).click();
		await expect(page.getByRole('status')).toHaveText('Error details copied.');
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await details.inputValue());
		await details.selectText();
		expect(await details.evaluate(element => (element as HTMLTextAreaElement).selectionEnd)).toBe((await details.inputValue()).length);
	} finally {
		await browser.application.close();
	}
});
