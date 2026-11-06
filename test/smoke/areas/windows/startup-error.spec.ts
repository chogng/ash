import { expect, test } from '../../../automation/test.js';
import { launchBrowser } from '../../../automation/playwrightBrowser.js';

test('Electron renderer startup failure logs the complete error', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ application, workbench }) => {
	if (!('windows' in application)) throw new Error('An Electron application is required');
	const failure = 'Renderer startup IPC failed\nDeliberate second line of the startup diagnostic.';
	// The Main startup gate presents a system dialog before it opens a window.
	// Fail a renderer IPC call on reload, after the main process has opened the window.
	await application.evaluate(({ ipcMain }, failure) => {
		ipcMain.removeHandler('ash:ipc:window-id');
		ipcMain.handle('ash:ipc:window-id', () => { throw new Error(failure); });
	}, failure);
	const page = workbench.page;
	await Promise.all([
		page.waitForEvent('console', message => message.type() === 'error' && message.text().includes(failure)),
		page.reload(),
	]);
	await expect(page.locator('.ash-workbench')).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'Unable to start Ash' })).toHaveCount(0);
});

test('Web App Server startup failure shows a fallback and logs the error', { tag: ['@browser-app-server'] }, async ({ webAppServer }) => {
	if (!webAppServer) { throw new Error('The Web startup scenario requires its App Server'); }
	const browser = await launchBrowser({ appServerMode: 'required', baseURL: webAppServer.connection.endpoint, webSession: webAppServer.connection });
	try {
		const page = browser.driver.workbench.page;
		const url = new URL(page.url());
		url.searchParams.set('startup-error-test', '1');
		url.hash = new URLSearchParams({ 'ash-endpoint': 'http://127.0.0.1:1' }).toString();
		await Promise.all([
			page.waitForEvent('console', message => message.type() === 'error' && message.text().includes('Open the authenticated Web URL provided by the Ash launcher.')),
			page.goto(url.href),
		]);
		const fallback = page.getByRole('alert');
		await expect(fallback.getByRole('heading', { name: 'Unable to start Ash' })).toBeVisible();
		await expect(fallback.getByText('Check the browser developer tools console for details.')).toBeVisible();
	} finally {
		await browser.application.close();
	}
});
