import type { Page } from '@playwright/test';
import type { IPartsSplash } from '../../../../src/ash/platform/theme/common/themeService.js';
import { test, expect } from '../../../automation/test.js';

test('startup colors survive reload and the decorative splash retires before the Workbench is ready', async ({ application, workbench, target }, testInfo) => {
	const page = workbench.page;
	await workbench.setAppearance(application, 'dark');
	await expect(workbench.element).toHaveAttribute('data-color-theme', 'ash-dark');
	await expect.poll(async () => (await readSplash(page))?.baseTheme).toBe('dark');
	await expect.poll(async () => (await readSplash(page))?.layoutInfo?.partBounds.length ?? 0).toBeGreaterThan(0);
	await expect.poll(async () => {
		const snapshot = (await readSplash(page))!;
		const live = await page.locator('.ash-workbench-part:visible').evaluateAll(parts => parts.map(part => {
			const rect = part.getBoundingClientRect();
			return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
		}));
		return snapshot.layoutInfo!.partBounds.map(({ left, top, width, height }) => ({ left, top, width, height })).every((bounds, index) => JSON.stringify(bounds) === JSON.stringify(live[index])) && live.length === snapshot.layoutInfo!.partBounds.length;
	}).toBe(true);
	const cached = (await readSplash(page))!;
	const expectedParts = await page.evaluate(splash => splash.layoutInfo!.partBounds.map(part => {
		const probe = document.createElement('div');
		probe.style.backgroundColor = part.background;
		return { left: part.left, top: part.top, width: part.width, height: part.height, background: probe.style.backgroundColor };
	}), cached);
	await page.addInitScript(() => {
		const observations: { background: string; hidden: string | null; inert: boolean; pointerEvents: string; parts: unknown[]; }[] = [];
		Object.assign(window, { ashSplashObservations: observations });
		const observer = new MutationObserver(records => {
			for (const record of records) for (const node of record.addedNodes) {
				if (node instanceof HTMLElement && node.id === 'ash-parts-splash') observations.push({ background: node.style.backgroundColor, hidden: node.getAttribute('aria-hidden'), inert: node.inert, pointerEvents: node.style.pointerEvents, parts: Array.from(node.children, child => { const style = (child as HTMLElement).style; return { left: Number.parseFloat(style.left), top: Number.parseFloat(style.top), width: Number.parseFloat(style.width), height: Number.parseFloat(style.height), background: style.backgroundColor }; }) });
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
		{ background: 'rgb(30, 30, 30)', hidden: 'true', inert: true, pointerEvents: 'none', parts: expectedParts },
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

async function readSplash(page: Page): Promise<IPartsSplash | undefined> {
	return page.evaluate(async () => {
		const bridge = (window as unknown as { ash?: { ipcRenderer: { invoke(channel: string): Promise<unknown>; }; }; }).ash;
		if (bridge) return await bridge.ipcRenderer.invoke('ash:theme:readWindowSplash') as IPartsSplash;
		const raw = Object.entries(localStorage).find(([key]) => key.startsWith(`ash.partsSplash:${location.pathname}:`))?.[1];
		return raw ? JSON.parse(raw) as IPartsSplash : undefined;
	});
}

test('a cache from a different viewport renders colors until the current layout takes over', { tag: '@browser-ui' }, async ({ workbench }, testInfo) => {
	const page = workbench.page;
	await expect.poll(async () => (await readSplash(page))?.layoutInfo?.partBounds.length ?? 0).toBeGreaterThan(0);
	const cached = (await readSplash(page))!;
	await page.addInitScript(splash => {
		const key = Object.keys(localStorage).find(key => key.startsWith(`ash.partsSplash:${location.pathname}:`))!;
		localStorage.setItem(key, JSON.stringify({ ...splash, layoutInfo: { ...splash.layoutInfo, width: splash.layoutInfo!.width + 100 } }));
	}, cached);
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	await page.route('**/assets/workbench.web.main-*.js', async route => { await gate; await route.continue(); });
	try {
		await page.reload({ waitUntil: 'commit' });
		await expect(page.locator('#ash-parts-splash')).toBeVisible();
		await expect(page.locator('#ash-parts-splash > div')).toHaveCount(0);
		await page.screenshot({ path: testInfo.outputPath('viewport-fallback.png') });
	} finally { release(); }
	await workbench.waitForReady();
	await expect(page.locator('#ash-parts-splash')).toHaveCount(0);
	await expect.poll(async () => (await readSplash(page))?.layoutInfo?.width).toBe(await page.evaluate(() => innerWidth));
});

test('Sessions captures its own layout and removes its splash after reload', async ({ application, workbench, target }) => {
	const workbenchPage = workbench.page;
	await expect.poll(async () => (await readSplash(workbenchPage))?.layoutInfo?.partBounds.length ?? 0).toBeGreaterThan(0);
	const previous = (await readSplash(workbenchPage))!;
	const actionId = target.kind === 'electron' ? 'workbench.action.chat.openAgentsWindow.titleBar' : 'ash.code.open-sessions';
	let sessionPage: Page;
	if ('windows' in application) {
		const opened = application.waitForEvent('window');
		await workbenchPage.locator(`[data-action-id="${actionId}"] button`).click();
		sessionPage = await opened;
	} else {
		await workbenchPage.locator(`[data-action-id="${actionId}"] button`).click();
		sessionPage = workbenchPage;
	}
	await expect(sessionPage.locator('.ash-sessions-window')).toBeVisible();
	await expect.poll(async () => (await readSplash(sessionPage))?.layoutInfo?.partBounds.length ?? 0).toBeGreaterThan(0);
	const snapshot = (await readSplash(sessionPage))!;
	expect(snapshot.layoutInfo!.width).toBe(await sessionPage.evaluate(() => innerWidth));
	expect(snapshot.layoutInfo!.height).toBe(await sessionPage.evaluate(() => innerHeight));
	if (target.kind === 'electron') expect(await readSplash(workbenchPage)).toEqual(previous);
	await sessionPage.reload();
	await expect(sessionPage.locator('.ash-sessions-window')).toBeVisible();
	await expect(sessionPage.locator('#ash-parts-splash')).toHaveCount(0);
	await expect(sessionPage.locator('.ash-initial-shell-colors')).toHaveCount(0);
	const marks = await sessionPage.evaluate(() => ({ shown: performance.getEntriesByName('ash.splash.shown')[0]?.startTime, removed: performance.getEntriesByName('ash.splash.removed')[0]?.startTime }));
	expect(marks.shown).toBeDefined();
	expect(marks.removed).toBeGreaterThanOrEqual(marks.shown!);
});
