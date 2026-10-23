import { expectIconFontLoaded } from '../../automation/iconFonts.js';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('the nine brand font layers preserve the complete glyph and staggered reduced-motion-aware animation', async ({ page }) => {
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const button = page.getByRole('button', { name: 'Brand mark', exact: true });
	const icon = button.locator('.ash-icon');
	await expectIconFontLoaded(icon);
	await expect(icon.locator('.ash-icon-font-layer')).toHaveCount(9);
	await expect(icon.locator('svg')).toHaveCount(0);
	const errors = await icon.evaluate(async (element, source) => {
		const characters = [...element.querySelectorAll<HTMLElement>('.ash-icon-font-layer')].map(layer => layer.dataset.ashIconCharacter!);
		const font = `400 512px ${getComputedStyle(element).fontFamily}`;
		await document.fonts.load(font, characters.join(''));
		const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
		const context = canvas.getContext('2d')!; context.font = font;
		context.fillText(element.getAttribute('data-ash-icon-character')!, 0, 512);
		const expected = context.getImageData(0, 0, 512, 512).data;
		context.clearRect(0, 0, 512, 512);
		for (const character of characters) context.fillText(character, 0, 512);
		const actual = context.getImageData(0, 0, 512, 512).data;
		let difference = 0;
		for (let index = 3; index < actual.length; index += 4) difference += Math.abs(actual[index]! - expected[index]!);
		const original = new Image(); original.src = 'data:image/svg+xml,' + encodeURIComponent(source); await original.decode();
		context.clearRect(0, 0, 512, 512); context.drawImage(original, 0, 0, 512, 512);
		const reference = context.getImageData(0, 0, 512, 512).data;
		let sourceDifference = 0;
		for (let index = 3; index < actual.length; index += 4) sourceDifference += Math.abs(actual[index]! - reference[index]!);
		return { layers: difference / (512 * 512 * 255), source: sourceDifference / (512 * 512 * 255) };
	}, readFileSync(new URL('../../../resources/icons/ash-mark.svg', import.meta.url), 'utf8'));
	expect(errors.layers).toBeLessThan(0.005);
	expect(errors.source).toBeLessThan(0.01);
	await button.hover();
	const north = icon.locator('[data-ash-icon-layer="petal-north"]');
	await expect(north).toHaveCSS('animation-name', 'ash-titlebar-mark-bloom');
	await expect(north).toHaveCSS('animation-delay', '0.32s');
	await expect(icon.locator('[data-ash-icon-layer="petal-center"]')).toHaveCSS('animation-delay', '0.17s');
	await expect(icon.locator('[data-ash-icon-layer="petal-west"]')).toHaveCSS('animation-delay', '0.56s');
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect(north).toHaveCSS('animation-name', 'none');
});

test('built-in WOFF2 glyphs preserve the IDE weight, icon cell and theme color', async ({ page }) => {
	const fonts: string[] = [];
	page.on('request', request => { if (/\/lxicon[^/]*\.woff2(?:\?|$)/.test(request.url())) fonts.push(request.url()); });
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const icon = page.locator('#product-icon span.ash-icon');
	const glyph = icon;
	const mounted = await icon.elementHandle();
	await expectIconFontLoaded(icon);
	await expect(glyph).toHaveAttribute('data-ash-icon-character', '\ue001');
	await expect(icon).toHaveAttribute('aria-hidden', 'true');
	await expect(icon).not.toHaveAttribute('tabindex');
	expect(await glyph.evaluate(async () => {
		await document.fonts.ready;
		return document.fonts.check('400 16px "Ash UI Icons"', '\ue001');
	})).toBe(true);
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

test('a failed built-in font load keeps the native glyph node without an SVG fallback', async ({ page }) => {
	await page.route(/\/lxicon(?:-[\w-]+)?\.woff2(?:\?.*)?$/, route => route.request().resourceType() === 'font' ? route.abort() : route.continue());
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const icon = page.locator('#product-icon span.ash-icon');
	await expect(icon).toHaveClass(/ash-icon-font/);
	await expect(icon).toHaveAttribute('data-ash-icon-character', '\ue001');
	expect(await icon.evaluate(element => ({ children: element.childElementCount, text: element.textContent }))).toEqual({ children: 0, text: '' });
	expect(await icon.evaluate(async () => {
		await document.fonts.ready;
		return document.fonts.check('400 16px "Ash UI Icons"', '\ue001');
	})).toBe(false);
});

test('WOFF2 glyphs preserve source shapes, paints and theme foreground without SVG DOM', async ({ page }, testInfo) => {
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const references = page.locator('#color-glyphs .ash-icon');
	await expect(references).toHaveCount(16);
	for (const profile of ['IDE', 'Sessions'] as const) {
		const icons = profile === 'Sessions' ? page.locator('#color-glyphs .ash-icon[data-comparison-profiles="both"]') : references;
		await icons.evaluateAll((elements, profile) => {
			for (const element of elements) {
				(element as HTMLElement).style.setProperty('--ash-icon-font-family', profile === 'Sessions' ? '"Ash UI Variable"' : '"Ash UI Icons"');
				(element as HTMLElement).style.setProperty('--ash-icon-font-weight', profile === 'Sessions' ? '550' : '400');
			}
		}, profile);
		for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-light', 'ash-high-contrast-dark']) {
			await page.evaluate(id => window.selectColorTheme(id), theme);
			for (const icon of await icons.all()) {
				await expectIconFontLoaded(icon);
				const comparison = await icon.evaluate(async (element, profile) => {
					const style = getComputedStyle(element);
					// Compare geometry above UI size so SVG and font rasterizers' edge
					// antialiasing does not dominate the source-fidelity measurement.
					const size = 256;
					const canvas = document.createElement('canvas');
					canvas.width = canvas.height = size;
					const context = canvas.getContext('2d')!;
					context.font = `${style.fontStyle} ${style.fontWeight} ${size}px ${style.fontFamily}`;
					context.fillStyle = style.color;
					context.fillText(element.getAttribute('data-ash-icon-character')!, 0, size);
					const actual = context.getImageData(0, 0, size, size).data;
					let source = element.getAttribute('data-svg-reference')!.replace(/(fill|stroke)="(?:#000(?:000)?|black|currentColor)"/giu, `$1="${style.color}"`);
					if (profile === 'Sessions') {
						const document = new DOMParser().parseFromString(source, 'image/svg+xml');
						for (const shape of document.querySelectorAll('[stroke]')) {
							shape.setAttribute('stroke-width', shape.hasAttribute('mask') ? '2.5' : '1.25');
						}
						source = new XMLSerializer().serializeToString(document);
					}
					const image = new Image();
					image.src = 'data:image/svg+xml,' + encodeURIComponent(source);
					await image.decode();
					context.clearRect(0, 0, size, size);
					context.drawImage(image, 0, 0, size, size);
					const expected = context.getImageData(0, 0, size, size).data;
					let difference = 0;
					for (let pixel = 0; pixel < actual.length; pixel += 4) {
						for (let channel = 0; channel < 3; channel++) {
							difference += Math.abs(actual[pixel + channel]! * actual[pixel + 3]! / 255 - expected[pixel + channel]! * expected[pixel + 3]! / 255);
						}
						difference += Math.abs(actual[pixel + 3]! - expected[pixel + 3]!);
					}
					const error = difference / (size * size * 4 * 255);
					let expectedImage: string | undefined;
					let actualImage: string | undefined;
					if (error >= 0.015) {
						expectedImage = canvas.toDataURL();
						context.putImageData(new ImageData(actual, size, size), 0, 0);
						actualImage = canvas.toDataURL();
					}
					return { id: element.getAttribute('data-ash-icon-id'), difference: error, children: element.childElementCount, expectedImage, actualImage };
				}, profile);
				for (const [kind, data] of [['source', comparison.expectedImage], ['font', comparison.actualImage]] as const) {
					if (data) await testInfo.attach(`${comparison.id}-${profile}-${theme}-${kind}.png`, { body: Buffer.from(data.split(',')[1]!, 'base64'), contentType: 'image/png' });
				}
				expect(comparison.children).toBe(0);
				// TrueType's integer outlines and quadratic curves may shift edge coverage.
				expect(comparison.difference, `${comparison.id} in ${profile} ${theme}`).toBeLessThan(0.015);
			}
		}
	}
	await expect(page.locator('#color-glyphs svg')).toHaveCount(0);
	await expect(page.locator('#color-glyphs .ash-icon[aria-hidden="true"]')).toHaveCount(16);
});

test('Sessions loads its full WOFF2 profile without changing the IDE window', async ({ page, context }) => {
	await page.goto('/themes.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const ide = page.locator('#product-icon span.ash-icon');
	await expectIconFontLoaded(ide);
	const agents = await context.newPage();
	const fonts: string[] = [];
	agents.on('request', request => { if (/\/lxicon[^/]*\.woff2(?:\?|$)/.test(request.url())) fonts.push(request.url()); });
	try {
		await agents.goto('/sessions.html?automations');
		await expect(agents.locator('body')).toHaveAttribute('data-ready', 'true');
		const navigation = agents.locator('.ash-sessions-activity-content');
		const icon = navigation.getByRole('button', { name: 'New', exact: true }).locator('span.ash-icon');
		await expectIconFontLoaded(icon);
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
