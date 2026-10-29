import { expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { suite, test, setup } from 'mocha';
import { useBrowserTests } from '../../../../../test/unit/browser/context.js';

suite('webWorkbench browser component', () => {
	const browserTests = useBrowserTests();
	setup(async function () {
		const { page } = browserTests;

		page.on('pageerror', error => console.error(error));
		await page.goto('/webWorkbench.html');
		await page.waitForFunction(() => !!window.ashWebWorkbenchIntegration);
	});

	test('Web titlebar reserves either side, follows Grid height and restores after fullscreen', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		await page.evaluate(() => {
			window.ashWebWorkbenchIntegration.setMode('window-controls-overlay');
			window.ashWebWorkbenchIntegration.setOverlay(0, innerWidth - 140, 48);
		});
		const bar = page.locator('[data-part="titlebar"]');
		await expect(bar).toHaveCSS('height', '48px');
		await expect(bar).toHaveCSS('padding-right', '152px');
		await expect(bar).toHaveCSS('padding-left', '12px');
		await expect(bar).toHaveCSS('-webkit-app-region', 'drag');
		await expect(page.locator('[data-part="editor"]')).toHaveCSS('height', `${(await page.viewportSize())!.height - 48}px`);
		for (const index of [0, 1, 2, 3]) {
			await page.evaluate(index => window.ashWebWorkbenchIntegration.setTheme(index), index);
			const button = page.getByRole('button', { name: 'Titlebar action', exact: true });
			await button.focus();
			await expect(button).toBeFocused();
			await expect(page.locator('.ash-titlebar-actions')).toHaveCSS('-webkit-app-region', 'no-drag');
			await button.press('Enter');
			const bounds = await button.boundingBox();
			expect(bounds!.x + bounds!.width).toBeLessThanOrEqual((await page.viewportSize())!.width - 140);
			await page.screenshot({ path: testInfo.outputPath(`web-titlebar-theme-${index}.png`) });
		}
		await page.evaluate(() => window.ashWebWorkbenchIntegration.setOverlay(90, innerWidth - 90, 40));
		await expect(bar).toHaveCSS('height', '40px');
		await expect(bar).toHaveCSS('padding-left', '102px');
		await expect(bar).toHaveCSS('padding-right', '12px');
		await page.evaluate(() => {
			window.ashWebWorkbenchIntegration.setMode('fullscreen');
			window.ashWebWorkbenchIntegration.setOverlay(0, 0, 0);
		});
		await expect(bar).toHaveCSS('height', '35px');
		await expect(bar).toHaveCSS('padding-left', '12px');
		expect(await page.evaluate(() => window.ashWebWorkbenchIntegration.state().installed)).toBe(true);
		await page.evaluate(() => window.ashWebWorkbenchIntegration.setMode('browser'));
		expect(await page.evaluate(() => window.ashWebWorkbenchIntegration.state().installed)).toBe(false);
		expect(await page.evaluate(() => window.ashWebWorkbenchIntegration.state().actionRuns)).toBe(4);
		await page.evaluate(() => window.ashWebWorkbenchIntegration.disposeTitlebar());
		expect(await page.evaluate(() => window.ashWebWorkbenchIntegration.state().overlayListeners)).toBe(0);
	});

	test('narrow installed windows keep titlebar actions within the browser safe area', async function () {
		const { page } = browserTests;

		await page.setViewportSize({ width: 360, height: 600 });
		await page.evaluate(() => {
			window.ashWebWorkbenchIntegration.setMode('window-controls-overlay');
			window.ashWebWorkbenchIntegration.setOverlay(0, 230, 35);
		});
		const buttons = page.locator('[data-part="titlebar"] button:visible');
		for (const button of await buttons.all()) {
			const bounds = await button.boundingBox();
			expect(bounds!.x).toBeGreaterThanOrEqual(0);
			expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(230);
		}
		await page.getByRole('button', { name: 'Titlebar action', exact: true }).click();
		expect(await page.evaluate(() => window.ashWebWorkbenchIntegration.state().actionRuns)).toBe(1);
	});

	test('Web update command presents a keyboard reload action and respects shutdown vetoes', async function () {
		const { page } = browserTests;

		await page.evaluate(async () => {
			window.ashWebWorkbenchIntegration.setUpdate('available');
			await window.ashWebWorkbenchIntegration.check();
		});
		const reload = page.getByRole('button', { name: 'Reload to Update', exact: true });
		await expect(reload).toBeVisible();
		await page.evaluate(() => window.ashWebWorkbenchIntegration.vetoReload(true));
		await reload.focus();
		await reload.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashWebWorkbenchIntegration.state().shutdowns)).toBe(1);
		await expect(reload).toBeVisible();
		await page.evaluate(() => window.ashWebWorkbenchIntegration.vetoReload(false));
		await Promise.all([
			page.waitForEvent('framenavigated', frame => frame === page.mainFrame()),
			reload.press('Enter'),
		]);
		await page.waitForFunction(() => !!window.ashWebWorkbenchIntegration);
		expect(await page.evaluate(() => sessionStorage.getItem('webUpdateShutdown'))).toBe('reload');
	});

	test('Web update failures recover and notifications use Chinese translations', async function () {
		const { page } = browserTests;

		await page.goto('/webWorkbench.html?chinese');
		await page.waitForFunction(() => !!window.ashWebWorkbenchIntegration);
		await page.evaluate(async () => {
			window.ashWebWorkbenchIntegration.setUpdate('error');
			await window.ashWebWorkbenchIntegration.check();
		});
		await expect(page.getByText('无法检查更新。', { exact: true })).toBeVisible();
		await page.evaluate(async () => {
			window.ashWebWorkbenchIntegration.setUpdate('available');
			await window.ashWebWorkbenchIntegration.check();
		});
		await expect(page.getByRole('button', { name: '重新加载以更新', exact: true })).toBeVisible();
		await expect(page.getByText('Ash build-2 已可更新。重新加载以更新。', { exact: true })).toBeVisible();
		await page.evaluate(async () => {
			window.ashWebWorkbenchIntegration.setUpdate('current');
			await window.ashWebWorkbenchIntegration.check();
		});
		await expect(page.getByText('Ash 已是最新版本。', { exact: true })).toBeVisible();
	});

	test('embedders without an update provider keep automatic checks and update commands disabled', async function () {
		const { page } = browserTests;

		await page.goto('/webWorkbench.html?noProvider');
		await page.waitForFunction(() => !!window.ashWebWorkbenchIntegration);
		const state = await page.evaluate(() => window.ashWebWorkbenchIntegration.state());
		expect(state.supported).toBe(false);
		expect(state.checks).toBe(0);
		expect(state.notifications).toEqual([]);
		await expect(page.getByRole('button', { name: 'Reload to Update', exact: true })).toHaveCount(0);
	});

	test('startup checks share one update prompt with manual checks and release it on disposal', async function () {
		const { page } = browserTests;

		await page.goto('/webWorkbench.html?available');
		await page.waitForFunction(() => !!window.ashWebWorkbenchIntegration);
		const reload = page.getByRole('button', { name: 'Reload to Update', exact: true });
		await expect(reload).toHaveCount(1);
		await page.evaluate(() => window.ashWebWorkbenchIntegration.check());
		await expect(reload).toHaveCount(1);
		await page.evaluate(() => window.ashWebWorkbenchIntegration.disposeUpdate());
		await expect(reload).toHaveCount(0);
		expect(await page.evaluate(() => window.ashWebWorkbenchIntegration.state().supported)).toBe(false);
	});
});
