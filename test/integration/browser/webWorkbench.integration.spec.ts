import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

test.beforeEach(async ({ page }) => {
	page.on('pageerror', error => console.error(error));
	await page.goto('/webWorkbench.html');
	await page.waitForFunction(() => !!window.ashWebWorkbenchIntegration);
});

test('Web titlebar reserves either side, follows Grid height and restores after fullscreen', async ({ page }, testInfo) => {
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

test('narrow installed windows keep titlebar actions within the browser safe area', async ({ page }) => {
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

test('Web update command presents a keyboard reload action and respects shutdown vetoes', async ({ page }) => {
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

test('Web update failures recover and notifications use Chinese translations', async ({ page }) => {
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

test('embedders without an update provider keep automatic checks and update commands disabled', async ({ page }) => {
	await page.goto('/webWorkbench.html?noProvider');
	await page.waitForFunction(() => !!window.ashWebWorkbenchIntegration);
	const state = await page.evaluate(() => window.ashWebWorkbenchIntegration.state());
	expect(state.supported).toBe(false);
	expect(state.checks).toBe(0);
	expect(state.notifications).toEqual([]);
	await expect(page.getByRole('button', { name: 'Reload to Update', exact: true })).toHaveCount(0);
});

test('startup checks share one update prompt with manual checks and release it on disposal', async ({ page }) => {
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

test('the built-in provider checks real HTTP deployments under a prefix and reloads into the new build', async ({ page, baseURL }) => {
	const source = new URL(baseURL!);
	const html = await (await fetch(new URL('/webWorkbench.html', source))).text();
	const original: { version: string; } = await (await fetch(new URL('/web-version.json', source))).json();
	let deployment = original.version;
	let broken = false;
	let probes = 0;
	// Model publishing a new static directory; the provider and HTTP requests are production code.
	const server = createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url!, source);
			if (url.pathname === '/prefix/web-version.json') {
				probes++;
				response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' });
				response.end(JSON.stringify(broken ? { version: 42 } : { version: deployment }));
			} else if (url.pathname === '/prefix/webWorkbench.html') {
				response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
				response.end(html.replaceAll(original.version, deployment));
			} else {
				url.pathname = url.pathname.replace(/^\/prefix\//u, '/');
				const upstream = await fetch(url);
				response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/octet-stream' });
				response.end(Buffer.from(await upstream.arrayBuffer()));
			}
		})().catch(error => { response.writeHead(500); response.end(String(error)); });
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Expected an HTTP fixture port');
		await page.goto(`http://127.0.0.1:${address.port}/prefix/webWorkbench.html?deployed`);
		await page.waitForFunction(() => !!window.ashWebWorkbenchIntegration);
		await expect.poll(() => probes).toBe(1);
		expect(await page.evaluate(() => window.ashWebWorkbenchIntegration.state().supported)).toBe(true);
		await page.evaluate(() => window.ashWebWorkbenchIntegration.check());
		await expect(page.getByText('Ash is up to date.', { exact: true })).toBeVisible();
		const before = probes;
		deployment = createHash('sha256').update(`${deployment}:next-deployment`).digest('hex');
		await page.evaluate(() => window.ashWebWorkbenchIntegration.check());
		expect(probes).toBeGreaterThan(before); // A long-lived cache response must not hide the deployment change.
		const reload = page.getByRole('button', { name: 'Reload to Update', exact: true });
		await expect(reload).toBeVisible();
		await Promise.all([page.waitForEvent('framenavigated', frame => frame === page.mainFrame()), reload.click()]);
		await page.waitForFunction(() => !!window.ashWebWorkbenchIntegration);
		expect(await page.evaluate(() => window.ashWebWorkbenchIntegration.state().build)).toBe(deployment);
		await expect(reload).toHaveCount(0);
		broken = true;
		await page.evaluate(() => window.ashWebWorkbenchIntegration.check());
		await expect(page.getByText('Could not check for updates.', { exact: true })).toBeVisible();
		broken = false;
		await page.evaluate(() => window.ashWebWorkbenchIntegration.check());
		await expect(page.getByText('Ash is up to date.', { exact: true })).toBeVisible();
	} finally {
		const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		server.closeAllConnections();
		await stopped;
	}
});
