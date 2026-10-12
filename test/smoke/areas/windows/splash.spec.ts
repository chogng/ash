import { test, expect } from '../../../automation/test.js';

test('startup colors survive reload and the decorative splash retires before the Workbench is ready', async ({ application, workbench, target }, testInfo) => {
	const page = workbench.page;
	await workbench.setAppearance(application, 'dark');
	await expect(workbench.element).toHaveAttribute('data-color-theme', 'ash-dark');
	await expect.poll(() => page.evaluate(async () => {
		const bridge = (window as unknown as { ash?: { ipcRenderer: { invoke(channel: string): Promise<unknown>; }; }; }).ash;
		if (bridge) return (await bridge.ipcRenderer.invoke('ash:theme:readWindowSplash') as { baseTheme: string; }).baseTheme;
		const raw = Object.entries(localStorage).find(([key]) => key.startsWith('ash.partsSplash:'))?.[1];
		return raw ? (JSON.parse(raw) as { baseTheme: string; }).baseTheme : undefined;
	})).toBe('dark');
	await page.addInitScript(() => {
		const observations: { background: string; hidden: string | null; inert: boolean; pointerEvents: string; }[] = [];
		Object.assign(window, { ashSplashObservations: observations });
		const observer = new MutationObserver(records => {
			for (const record of records) for (const node of record.addedNodes) {
				if (node instanceof HTMLElement && node.id === 'ash-parts-splash') observations.push({ background: node.style.backgroundColor, hidden: node.getAttribute('aria-hidden'), inert: node.inert, pointerEvents: node.style.pointerEvents });
			}
		});
		observer.observe(document, { childList: true, subtree: true });
		window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
	});
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	if (target.kind === 'browser') await page.route('**/assets/workbench.web.main-*.js', async route => { await gate; await route.continue(); });
	try {
		await page.reload({ waitUntil: 'commit' });
		if (target.kind === 'browser') {
			await expect(page.locator('#ash-parts-splash')).toBeVisible();
			await expect(page.locator('#ash-parts-splash')).toHaveCSS('background-color', 'rgb(30, 30, 30)');
			await page.screenshot({ path: testInfo.outputPath('startup-colors.png') });
		}
	} finally { release(); }
	await workbench.waitForReady();
	await expect(page.locator('#ash-parts-splash')).toHaveCount(0);
	await expect(page.locator('.ash-initial-shell-colors')).toHaveCount(0);
	expect(await page.evaluate(() => (window as unknown as { ashSplashObservations: unknown[]; }).ashSplashObservations)).toEqual([
		{ background: 'rgb(30, 30, 30)', hidden: 'true', inert: true, pointerEvents: 'none' },
	]);
	const order = await page.evaluate(() => ({
		shown: performance.getEntriesByName('ash.splash.shown')[0]?.startTime,
		created: performance.getEntriesByName('ash.workbench.constructor-start')[0]?.startTime,
	}));
	expect(order.shown).toBeDefined();
	expect(order.created).toBeGreaterThanOrEqual(order.shown!);
	await expect(workbench.element).toHaveAttribute('data-color-theme', 'ash-dark');
});

test('a failed startup hands the page to the error view and Retry can reopen the Workbench', { tag: '@browser-ui' }, async ({ workbench }) => {
	const page = workbench.page;
	await page.route('**/assets/workbench.web.main-*.js', route => route.abort('failed'));
	await page.reload();
	await expect(page.getByRole('alert')).toHaveText('Unable to start Ash');
	await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeFocused();
	await expect(page.locator('#ash-parts-splash')).toHaveCount(0);
	await expect(page.locator('.ash-initial-shell-colors')).toHaveCount(0);
	await page.unroute('**/assets/workbench.web.main-*.js');
	await page.getByRole('button', { name: 'Retry', exact: true }).click();
	await workbench.waitForReady();
});
