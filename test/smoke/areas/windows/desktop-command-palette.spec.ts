import { expect, test } from '../../../automation/test.js';
import { launchElectron, type ElectronLaunchResult } from '../../../automation/playwrightElectron.js';
import { waitForElectronWindowState } from '../../../automation/electronDriver.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test(
	'Desktop F1 opens the command palette in an active native window and restores focus',
	{ tag: '@electron-ui' },
	async ({}, testInfo) => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-desktop-f1-'));
		let desktop: ElectronLaunchResult | undefined;
		try {
			desktop = await launchElectron({
				appServerMode: 'disabled',
				windowMode: 'active',
				userDataDirectory: directory,
				recordVideo: { directory: testInfo.outputPath('videos'), size: { width: 1440, height: 900 } },
			});
			const page = desktop.driver.workbench.page;
			const window = await desktop.application.browserWindow(page);
			try {
				await desktop.application.evaluate(({ app }) => app.focus({ steal: true }));
				await window.evaluate(window => {
					window.show();
					window.focus();
				});
				await page.bringToFront();
				await waitForElectronWindowState(desktop.application, page, { focused: true });
				await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
				const previousFocus = await page.evaluateHandle(() => document.activeElement);
				try {
					const quickaccess = desktop.driver.workbench.quickaccess;
					await expect(quickaccess.element).toBeHidden();
					await page.keyboard.press('F1');
					await expect(quickaccess.input).toBeFocused();
					await expect(quickaccess.input).toHaveValue('>');
					await expect(quickaccess.items.first()).toBeVisible();
					await testInfo.attach('f1-command-palette', {
						body: await page.screenshot(),
						contentType: 'image/png',
					});
					await quickaccess.input.press('Escape');
					await expect(quickaccess.element).toBeHidden();
					await expect
						.poll(() => previousFocus.evaluate(element => element === document.activeElement))
						.toBe(true);
				} finally {
					await previousFocus.dispose();
				}
			} finally {
				await window.dispose();
			}
		} finally {
			try {
				await desktop?.close();
			} finally {
				await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		}
	},
);
