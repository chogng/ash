import { expect, test } from '../../../automation/test.js';

declare global {
	interface Window {
		ashTitlebarTestControls: {
			update(x: number, width: number, height: number, mode?: string, visible?: boolean): void;
		};
	}
}

for (const entry of ['workbench', 'sessions'] as const) {
	test(`the production ${entry} Web titlebar follows browser window controls`, { tag: ['@browser-ui', '@browser-app-server'] }, async ({ workbench }, testInfo) => {
		const page = workbench.page;
		await page.setViewportSize({ width: 1_200, height: 800 });
		// Simulate only the installed browser's OS boundary; load the real product and layout.
		await page.addInitScript((installed: boolean) => {
			let mode = installed ? 'window-controls-overlay' : 'browser';
			let visible = installed;
			let area = installed ? new DOMRect(0, 0, innerWidth - 140, 48) : new DOMRect();
			const overlay = Object.assign(new EventTarget(), { getTitlebarAreaRect: () => area });
			Object.defineProperty(overlay, 'visible', { get: () => visible });
			Object.defineProperty(navigator, 'windowControlsOverlay', { configurable: true, value: overlay });
			const matchMedia = window.matchMedia.bind(window);
			const queries = new Map<string, MediaQueryList>();
			window.matchMedia = query => {
				const modes = query.split(',').map(value => /^\(display-mode: (.+)\)$/u.exec(value.trim())?.[1]);
				if (modes.some(value => !value)) return matchMedia(query);
				let result = queries.get(query);
				if (!result) {
					result = Object.assign(new EventTarget(), { media: query, onchange: null }) as MediaQueryList;
					Object.defineProperty(result, 'matches', { get: () => modes.includes(mode) });
					queries.set(query, result);
				}
				return result;
			};
			window.ashTitlebarTestControls = {
				update(x, width, height, displayMode = 'window-controls-overlay', enabled = true) {
					mode = displayMode;
					visible = enabled;
					area = new DOMRect(x, 0, width, height);
					for (const query of queries.values()) query.dispatchEvent(new Event('change'));
					overlay.dispatchEvent(new Event('geometrychange'));
				},
			};
		}, entry === 'sessions');
		if (entry === 'sessions') await page.goto(new URL('../sessions/sessions.html', page.url()).href);
		else await page.reload();
		const bar = page.locator('[data-part="titlebar"]');
		const padding = entry === 'sessions' ? 0 : 12;
		await expect(bar).toBeVisible();
		const manifestUrl = await page.locator('link[rel="manifest"]').evaluate(element => (element as HTMLLinkElement).href);
		const manifestResponse = await page.request.get(manifestUrl);
		expect(manifestResponse.ok()).toBe(true);
		expect(await manifestResponse.json()).toMatchObject({ display: 'standalone', display_override: ['window-controls-overlay'] });
		if (entry === 'sessions') {
			await expect(bar).toHaveCSS('height', '48px');
			await expect(page.locator('.ash-sessions-content-card')).toHaveCSS('top', '48px');
			await expect(bar).toHaveCSS('padding-right', '140px');
			await page.evaluate(() => window.ashTitlebarTestControls.update(0, 0, 0, 'browser', false));
		}
		await expect(bar).toHaveCSS('height', '35px');
		await expect(bar).not.toHaveClass(/ash-web-titlebar-overlay/u);
		const verifyButtons = async (left: number, right: number): Promise<void> => {
			const buttons = await bar.locator('button:visible').all();
			expect(buttons.length).toBeGreaterThan(0);
			for (const button of buttons) {
				const bounds = (await button.boundingBox())!;
				const label = await button.getAttribute('aria-label') ?? '';
				expect(bounds.x, label).toBeGreaterThanOrEqual(left);
				expect(bounds.x + bounds.width, label).toBeLessThanOrEqual(right);
			}
		};
		const verifyHeight = async (height: number): Promise<void> => {
			await expect(bar).toHaveCSS('height', `${height}px`);
			if (entry === 'sessions') {
				await expect(page.locator('.ash-sessions-content-card')).toHaveCSS('top', `${height}px`);
				const body = await page.locator('[data-part="sessions"]').boundingBox();
				expect(body!.y).toBeGreaterThanOrEqual(height);
			}
		};
		await page.evaluate(() => window.ashTitlebarTestControls.update(0, innerWidth - 140, 48));
		await verifyHeight(48);
		await expect(bar).toHaveCSS('padding-right', `${140 + padding}px`);
		await expect(bar).toHaveCSS('-webkit-app-region', 'drag');
		await verifyButtons(0, 1_060);
		const menu = bar.locator('[data-action-id="ash.applicationMenu"] button');
		await expect(bar.locator('.ash-menubar')).toHaveCSS('-webkit-app-region', 'no-drag');
		await menu.focus();
		await expect(menu).toBeFocused();
		await menu.press('Enter');
		await expect(menu).toHaveAttribute('aria-expanded', 'true');
		await page.keyboard.press('Escape');
		await expect(menu).toHaveAttribute('aria-expanded', 'false');
		await page.screenshot({ path: testInfo.outputPath(`${entry}-right-controls.png`) });
		await page.evaluate(() => window.ashTitlebarTestControls.update(90, innerWidth - 90, 40));
		await verifyHeight(40);
		await expect(bar).toHaveCSS('padding-left', `${90 + padding}px`);
		await expect(bar).toHaveCSS('padding-right', `${padding}px`);
		await verifyButtons(90, 1_200);
		await page.evaluate(() => window.ashTitlebarTestControls.update(0, 0, 0, 'fullscreen'));
		await verifyHeight(35);
		await expect(bar).toHaveClass(/ash-web-titlebar-standalone/u);
		await expect(bar).not.toHaveClass(/ash-web-titlebar-overlay/u);
		await expect(bar).toHaveCSS('padding-left', `${padding}px`);
		await page.evaluate(() => window.ashTitlebarTestControls.update(0, innerWidth - 140, 48));
		await verifyHeight(48);
		await page.setViewportSize({ width: 360, height: 600 });
		await page.evaluate(() => window.ashTitlebarTestControls.update(0, 230, 35));
		await verifyHeight(35);
		await verifyButtons(0, 230);
		await page.screenshot({ path: testInfo.outputPath(`${entry}-narrow-controls.png`) });
		await page.evaluate(() => window.ashTitlebarTestControls.update(0, 0, 0, 'browser', false));
		await verifyHeight(35);
		await expect(bar).not.toHaveClass(/ash-web-titlebar-(overlay|standalone)/u);
		await expect(bar).toHaveCSS('padding-right', `${padding}px`);
	});
}
