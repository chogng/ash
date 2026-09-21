import { expect, test } from '../../../automation/test.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchElectron } from '../../../automation/playwrightElectron.js';

test.use({ openWorkspace: false });

test('Calls validate the server address before opening microphone devices', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Calls require an authorized product backend.');
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.getByPlaceholder('Type the name of a command to run').fill('Open Calls');
	await page.keyboard.press('Enter');
	const view = page.locator('.ash-call');
	await expect(view).toBeVisible();
	await expect(view.getByRole('status')).toContainText('microphone stays off');
	await expect(view.getByRole('button', { name: 'Unmute microphone', exact: true })).toBeDisabled();
	await view.getByLabel('Call', { exact: true }).focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.getByRole('dialog', { name: 'Calls help' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(view.getByLabel('Call', { exact: true })).toBeFocused();
	await view.getByLabel('Call', { exact: true }).selectOption('server');
	await view.getByLabel('Server address', { exact: true }).fill('http://example.com');
	await view.getByLabel('Administrator key or invitation key', { exact: true }).fill('invalid-test-key');
	await view.getByRole('button', { name: 'Join call', exact: true }).focus();
	await page.keyboard.press('Enter');
	await expect(view.getByRole('status')).toContainText('invalid call input');
	await expect(view.getByRole('button', { name: 'Join call', exact: true })).toBeEnabled();
	await expect(view.getByRole('button', { name: 'Unmute microphone', exact: true })).toBeDisabled();
});

test('Windows calls share a selected window, receive video, and clear it after stopping', async ({ target, workbench, application }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || process.platform !== 'win32', 'Requires Windows capture and two connected Electron windows.');
	if (!('windows' in application)) { return; }
	test.setTimeout(120_000);
	const page = workbench.page;
	await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.restore(); window.show(); window.setTitle('Ash screen share test'); });
	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.getByPlaceholder('Type the name of a command to run').fill('Open Calls');
	await page.keyboard.press('Enter');
	const view = page.locator('.ash-call');
	await view.getByRole('button', { name: 'Join call', exact: true }).click();
	await expect(view.getByRole('status')).toContainText('connected', { timeout: 30_000 });
	const directory = await mkdtemp(join(tmpdir(), 'ash-'));
	let peer: Awaited<ReturnType<typeof launchElectron>> | undefined;
	try {
		peer = await launchElectron({ appServerMode: 'required', userDataDirectory: directory });
		await view.getByRole('button', { name: 'Invite speaker', exact: true }).click();
		const invitation = view.getByLabel('Invitation server address and key');
		await expect(invitation).toHaveValue(/^https?:\/\/.+\n.+$/);
		const [url, credential] = (await invitation.inputValue()).split('\n');
		const second = peer.driver.workbench.page;
		await second.bringToFront();
		await second.keyboard.press('ControlOrMeta+Shift+P');
		await second.getByPlaceholder('Type the name of a command to run').fill('Open Calls');
		await second.keyboard.press('Enter');
		const receiver = second.locator('.ash-call');
		await receiver.getByLabel('Call', { exact: true }).selectOption('invitation');
		await receiver.getByLabel('Server address', { exact: true }).fill(url!);
		await receiver.getByLabel('Administrator key or invitation key', { exact: true }).fill(credential!);
		await receiver.getByRole('button', { name: 'Join call', exact: true }).click();
		await expect(receiver.getByRole('status')).toContainText('connected', { timeout: 30_000 });
		await page.bringToFront();
		await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.restore(); window.show(); window.setTitle('Ash screen share test'); });
		await view.getByRole('button', { name: 'Share screen', exact: true }).focus();
		await page.keyboard.press('Enter');
		const selector = view.getByLabel('Display or window to share');
		await expect(selector).toBeFocused();
		const option = await selector.locator('option').evaluateAll(options => options.find(option => option.textContent?.startsWith('Window:') && option.textContent.includes('Ash screen share test'))?.getAttribute('value'));
		expect(option).toBeTruthy();
		await selector.selectOption(option!);
		await view.getByRole('button', { name: 'Start sharing', exact: true }).click();
		await expect(view.getByRole('button', { name: 'Stop sharing', exact: true })).toBeFocused();
		const image = receiver.locator('.call-screen img').first();
		await expect(image).toBeVisible({ timeout: 30_000 });
		await expect.poll(() => image.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
		await view.getByRole('button', { name: 'Stop sharing', exact: true }).click();
		await expect(receiver.locator('.call-screen')).toHaveCount(0);
		await expect(view.getByRole('button', { name: 'Share screen', exact: true })).toBeFocused();
		await receiver.getByRole('button', { name: 'Leave call', exact: true }).click();
		await expect(receiver.getByRole('status')).toContainText('ended');
		await view.getByRole('button', { name: 'End for everyone', exact: true }).click();
		await expect(view.getByRole('status')).toContainText('ended');
	} finally {
		await peer?.close();
		await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test('Calls remain unavailable when the host has no call backend', async ({ target, workbench }) => {
	test.skip(target.appServerMode === 'required', 'This scenario covers the UI without an App Server.');
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.getByPlaceholder('Type the name of a command to run').fill('Open Calls');
	await expect(page.getByRole('option', { name: 'Open Calls', exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(page.locator('.ash-call')).toHaveCount(0);
});
