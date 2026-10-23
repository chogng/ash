import { expect, test } from '@playwright/test';

test('built-in WOFF2 glyphs preserve the IDE weight, icon cell and theme color', async ({ page }) => {
	const fonts: string[] = [];
	page.on('request', request => { if (/\/lxicon[^/]*\.woff2(?:\?|$)/.test(request.url())) fonts.push(request.url()); });
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const icon = page.locator('#product-icon span.ash-icon');
	const glyph = icon;
	const mounted = await icon.elementHandle();
	await expect(icon).toHaveClass(/ash-icon-font-ready/);
	await expect(glyph).toHaveAttribute('data-ash-icon-character', '\ue001');
	await expect(icon).toHaveAttribute('aria-hidden', 'true');
	await expect(icon).not.toHaveAttribute('tabindex');
	expect(await glyph.evaluate(() => document.fonts.check('400 16px "Ash UI Icons"', '\ue001'))).toBe(true);
	for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-light', 'ash-high-contrast-dark']) {
		await page.evaluate(id => window.selectColorTheme(id), theme);
		await expect(glyph).toHaveCSS('font-family', '"Ash UI Icons"');
		await expect(glyph).toHaveCSS('font-weight', '400');
		await expect(glyph).toHaveCSS('font-synthesis', 'none');
		await expect(icon).toHaveCSS('width', '16px');
		await expect(icon.locator('svg')).toHaveCount(0);
		expect(await glyph.evaluate(element => getComputedStyle(element, '::before').visibility)).toBe('visible');
		expect(await glyph.evaluate(element => getComputedStyle(element, '::before').color === getComputedStyle(element.parentElement!).color)).toBe(true);
	}
	expect(await mounted!.evaluate(element => element === document.querySelector('#product-icon .ash-icon'))).toBe(true);
	expect(fonts.some(url => url.includes('lxicon-variable'))).toBe(false);
	for (const size of [12, 16, 24]) {
		await icon.evaluate((element, value) => { element.style.fontSize = `${value}px`; }, size);
		await expect(icon).toHaveCSS('width', `${size}px`);
		await expect(icon).toHaveCSS('height', `${size}px`);
		expect(await icon.evaluate(element => element.childElementCount)).toBe(0);
	}
	await icon.evaluate(element => { element.style.visibility = 'hidden'; });
	expect(await icon.evaluate(element => getComputedStyle(element, '::before').visibility)).toBe('hidden');
	await icon.evaluate(element => { element.style.removeProperty('visibility'); });
	expect(await icon.evaluate(element => getComputedStyle(element, '::before').visibility)).toBe('visible');
});

test('a failed built-in font load leaves the original SVG visible', async ({ page }) => {
	await page.route(/\/lxicon(?:-[\w-]+)?\.woff2(?:\?.*)?$/, route => route.abort());
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const icon = page.locator('#product-icon span.ash-icon');
	await expect(icon).not.toHaveClass(/ash-icon-font-ready/);
	await expect(icon.locator('path')).toHaveCSS('visibility', 'visible');
	expect(await icon.evaluate(element => getComputedStyle(element, '::before').visibility)).toBe('hidden');
	expect(await icon.evaluate(async () => {
		await document.fonts.ready;
		return document.fonts.check('400 16px "Ash UI Icons"', '\ue001');
	})).toBe(false);
});

test('Sessions loads its full WOFF2 profile without changing the IDE window', async ({ page, context }) => {
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const ide = page.locator('#product-icon span.ash-icon');
	await expect(ide).toHaveClass(/ash-icon-font-ready/);
	const agents = await context.newPage();
	const fonts: string[] = [];
	agents.on('request', request => { if (/\/lxicon[^/]*\.woff2(?:\?|$)/.test(request.url())) fonts.push(request.url()); });
	try {
		await agents.goto('/sessions.html?automations');
		await expect(agents.locator('body')).toHaveAttribute('data-ready', 'true');
		const navigation = agents.locator('.ash-sessions-activity-content');
		const icon = navigation.getByRole('button', { name: 'New', exact: true }).locator('span.ash-icon');
		await expect(icon).toHaveClass(/ash-icon-font-ready/);
		const glyph = icon;
		await expect(glyph).toHaveCSS('font-family', '"Ash UI Variable"');
		await expect(glyph).toHaveCSS('font-weight', '550');
		expect(await glyph.evaluate(async () => (await document.fonts.load('550 16px "Ash UI Variable"', '\ue001')).length)).toBe(1);
		await expect(ide).toHaveCSS('font-family', '"Ash UI Icons"');
		await expect(ide).toHaveCSS('font-weight', '400');
		expect(fonts.some(url => url.includes('lxicon-variable'))).toBe(true);
		// The search glyph used to fall back to the original 1px face. Render its
		// actual character in both faces to prove that Sessions now owns its outline.
		const search = agents.locator('span[data-ash-icon-id="search"]').first();
		await expect(search).toBeVisible();
		const ratio = await search.evaluate(async element => {
			const character = element.getAttribute('data-ash-icon-character')!;
			await document.fonts.load('550 64px "Ash UI Variable"', character);
			await document.fonts.load('400 64px "Ash UI Icons"', character);
			const canvas = document.createElement('canvas');
			canvas.width = canvas.height = 64;
			const context = canvas.getContext('2d')!;
			const ink = (font: string): number => {
				context.clearRect(0, 0, 64, 64);
				context.font = font;
				context.fillText(character, 0, 64);
				const pixels = context.getImageData(0, 0, 64, 64).data;
				let alpha = 0;
				for (let index = 3; index < pixels.length; index += 4) alpha += pixels[index]!;
				return alpha;
			};
			return ink('550 64px "Ash UI Variable"') / ink('400 64px "Ash UI Icons"');
		});
		expect(ratio).toBeGreaterThan(1.18);
		expect(ratio).toBeLessThan(1.35);
		const account = agents.locator('span[data-ash-icon-id="account"]').first();
		expect(await account.evaluate(async element => {
			const character = element.getAttribute('data-ash-icon-character')!;
			await document.fonts.load('550 64px "Ash UI Variable"', character);
			await document.fonts.load('400 64px "Ash UI Icons"', character);
			const canvas = document.createElement('canvas');
			canvas.width = canvas.height = 64;
			const context = canvas.getContext('2d')!;
			const headCenter = (font: string): number => {
				context.clearRect(0, 0, 64, 64);
				context.font = font;
				context.fillText(character, 0, 64);
				return context.getImageData(32, 28, 1, 1).data[3]!;
			};
			return { sessions: headCenter('550 64px "Ash UI Variable"'), ide: headCenter('400 64px "Ash UI Icons"') };
		})).toEqual({ sessions: 0, ide: 255 });
		const projects = navigation.getByRole('button', { name: 'Projects', exact: true });
		await projects.click();
		await expect(projects).toHaveAttribute('aria-current', 'page');
		await expect(projects.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'projects');
		const creator = navigation.getByRole('button', { name: 'Creator', exact: true });
		await creator.click();
		await expect(creator).toHaveAttribute('aria-current', 'page');
		await expect(creator.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'symbol-color');
	} finally {
		await agents.close();
	}
});
