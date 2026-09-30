import { _electron, expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { appServerDaemonExecutablePath } from '../../../../src/ash/platform/app-server-daemon/node/appServerDaemonPackage.js';
import { resolveElectronConfiguration } from '../../../automation/electron.js';
import { launchBrowser } from '../../../automation/playwrightBrowser.js';

test('Electron startup failure copies the complete error before the Workbench exists', async ({}, testInfo) => {
	test.skip(testInfo.project.name !== 'electron-app-server', 'Requires the desktop App Server.');
	const userDataDirectory = testInfo.outputPath('user-data');
	await mkdir(userDataDirectory, { recursive: true });
	const productServicesPath = join(userDataDirectory, 'invalid-product-services.json');
	await writeFile(productServicesPath, '{}');
	const configuration = resolveElectronConfiguration({ appServerMode: 'required', userDataDirectory });
	const environment = { ...configuration.env, ASH_PRODUCT_SERVICES_PATH: productServicesPath };
	const application = await _electron.launch({
		args: [...configuration.args],
		cwd: configuration.cwd,
		env: environment,
		executablePath: configuration.executablePath,
	});
	try {
		const page = await application.firstWindow();
		const details = page.getByRole('textbox', { name: 'Error details' });
		await expect.poll(() => details.inputValue()).toContain('product services configuration is invalid');
		await page.getByRole('button', { name: 'Copy details' }).click();
		await expect(page.getByRole('status')).toHaveText('Error details copied.');
		expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(await details.inputValue());
	} finally {
		const daemon = appServerDaemonExecutablePath({ appPath: configuration.cwd, isPackaged: false, platform: process.platform, resourcesPath: '' });
		try {
			await promisify(execFile)(daemon, ['stop'], { env: environment, windowsHide: true, timeout: 30_000 });
		} finally {
			await application.close();
		}
	}
});

test('Web startup failure copies its details and keeps them selectable', async ({ baseURL }, testInfo) => {
	test.skip(testInfo.project.name !== 'browser-app-server', 'Requires the connected Web product.');
	const browser = await launchBrowser({ appServerMode: 'required', baseURL: baseURL! });
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
