import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { capture, changesBetween, compareImages, expectImagesStable } from '../../componentFixtures/cssOrderShared.mts';

// Findings are diagnostic, except the SelectBox/List conflict which is also a regression gate.
// Reapplying a complete, unlayered source file after the bundle models that file loading last
// without reversing its intentional internal rule order or replacing the component runtime.
const baseStyles = {
	button: 'src/ash/base/browser/ui/button/button.css',
	iconlabel: 'src/ash/base/browser/ui/iconlabel/iconlabel.css',
	list: 'src/ash/base/browser/ui/list/list.css',
	dropdown: 'src/ash/base/browser/ui/dropdown/dropdown.css',
	inputbox: 'src/ash/base/browser/ui/inputbox/inputbox.css',
} as const;

interface Scene {
	readonly name: string;
	readonly selectors: readonly string[];
	readonly styles: readonly (keyof typeof baseStyles)[];
	prepare(page: Page): Promise<void>;
}

const scenes: readonly Scene[] = [{
	name: 'buttons-menu',
	selectors: ['#default-style-buttons', '#default-style-probes .ash-menu'],
	styles: ['button', 'iconlabel'],
	prepare: async page => {
		await page.getByRole('menuitem', { name: 'Styled submenu', exact: true }).focus();
	},
}, {
	name: 'select-list',
	selectors: ['#default-style-probes .ash-select-box', '.ash-context-view:has(.ash-select-box-list)', '#default-style-probes .ash-list:not(.ash-tree)'],
	styles: ['list', 'dropdown', 'button', 'iconlabel'],
	prepare: async page => {
		await page.getByRole('combobox', { name: 'Styled select', exact: true }).click();
		await page.keyboard.press('ArrowDown');
		await expect(page.locator('.ash-select-box-list')).toBeVisible();
	},
}, {
	name: 'tree-input',
	selectors: ['#styled-tree', '#default-style-probes > .ash-input-box'],
	styles: ['list', 'inputbox', 'button'],
	prepare: async page => {
		await page.evaluate(() => window.openStyledTreeFind());
		const find = page.getByRole('searchbox', { name: 'Find in Tree', exact: true });
		await find.fill('Styled');
		await expect(find).toBeFocused();
	},
}];

async function assertSelectListPresentation(page: Page): Promise<void> {
	const popup = page.locator('.ash-select-box-list');
	for (const side of ['top', 'right', 'bottom', 'left']) {
		await expect(popup).toHaveCSS(`padding-${side}`, '4px');
	}
	const options = popup.getByRole('option');
	await expect(options).toHaveCount(3);
	for (const name of ['One', 'Two']) {
		await expect(popup.getByRole('option', { name, exact: true })).toHaveCSS('cursor', 'pointer');
	}
	const disabled = popup.getByRole('option', { name: 'Disabled option', exact: true });
	await expect(disabled).toHaveAttribute('aria-disabled', 'true');
	await expect(disabled).toHaveCSS('cursor', 'default');
	const geometry = await popup.evaluate(element => ({
		height: element.getBoundingClientRect().height,
		rows: [...element.querySelectorAll('[role="option"]')].map(row => row.getBoundingClientRect().height),
	}));
	expect(geometry.rows).toEqual([22, 22, 22]);
	expect(geometry.height).toBe(geometry.rows.reduce((sum, height) => sum + height, 8));
	const plainList = page.getByRole('listbox', { name: 'Styled list', exact: true });
	await expect(plainList).toHaveCSS('padding-top', '0px');
	await expect(plainList.locator('.ash-list-row').first()).toHaveCSS('cursor', 'default');

	// Restore the original focused option after verifying disabled rows are skipped both ways.
	await page.keyboard.press('Home');
	await expect(popup.getByRole('option', { name: 'One', exact: true })).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(popup.getByRole('option', { name: 'Two', exact: true })).toBeFocused();
	await page.keyboard.press('ArrowUp');
	await expect(popup.getByRole('option', { name: 'One', exact: true })).toBeFocused();
	await page.keyboard.press('End');
	const focused = popup.getByRole('option', { name: 'Two', exact: true });
	await expect(focused).toBeFocused();
	await expect(focused).toHaveCSS('outline-style', 'solid');
	await expect(focused).toHaveCSS('outline-width', '1px');
	await expect(page.getByRole('combobox', { name: 'Styled select', exact: true }))
		.toHaveAttribute('aria-activedescendant', (await focused.getAttribute('id'))!);
}

test.use({ viewport: { width: 1000, height: 1100 }, contextOptions: { reducedMotion: 'reduce' } });

for (const theme of ['ash-dark', 'ash-light', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
	for (const scene of scenes) {
		test(`CSS order experiment reports ${scene.name} in ${theme}`, async ({ page }, testInfo) => {
			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto('/themes.html?backend=offline');
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.evaluate(async ({ theme, withDisabledSelectOption }) => {
				window.mountDefaultStyleProbes(withDisabledSelectOption);
				await window.selectColorTheme(theme);
			}, { theme, withDisabledSelectOption: scene.name === 'select-list' });
			await expect(page.locator('#root')).toHaveAttribute('data-color-theme', theme);
			await page.mouse.move(0, 0);
			await scene.prepare(page);
			await page.mouse.move(0, 0);
			if (scene.name === 'select-list') await assertSelectListPresentation(page);
			for (const selector of scene.selectors) await expect(page.locator(selector)).not.toHaveCount(0);
			const baseline = await capture(page, scene.selectors);
			const repeated = await capture(page, scene.selectors);
			expect(changesBetween(baseline.samples, repeated.samples), 'The unchanged baseline must be stable').toEqual([]);
			const attachImages = async (name: string, images: readonly Buffer[]): Promise<void> => {
				for (const [index, image] of images.entries()) {
					await testInfo.attach(`${name}-${index}`, { body: image, contentType: 'image/png' });
				}
			};
			await attachImages('baseline', baseline.images);
			const baselineImageDifferences = await compareImages(page, baseline.images, repeated.images);
			if (baseline.imageHash !== repeated.imageHash) await attachImages('repeated', repeated.images);
			expectImagesStable(baselineImageDifferences, 'The unchanged baseline screenshot must be stable');

			const probes = [];
			for (const name of scene.styles) {
				const source = baseStyles[name];
				const css = await readFile(new URL(`../../../${source}`, import.meta.url), 'utf8');
				// Inline replay would change relative URL and layer semantics; reject unsupported sources.
				expect(css, source).not.toMatch(/@(?:import|layer)\b|url\s*\(/i);
				await page.evaluate(css => {
					const links = document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]');
					if (!links.length) throw new Error('CSS order experiment requires the runner\'s bundled stylesheets');
					const style = document.createElement('style');
					style.id = 'css-order-probe';
					style.textContent = css;
					links[0].before(style);
					if (!style.sheet?.cssRules.length) throw new Error('CSS probe did not produce any rules');
				}, css);
				try {
					// Both positions use the same source and injection path. An early replay must
					// reproduce the untouched product baseline before a late replay is meaningful.
					const control = await capture(page, scene.selectors);
					expect(changesBetween(baseline.samples, control.samples), `${source}: early replay must match the bundle`).toEqual([]);
					expectImagesStable(await compareImages(page, baseline.images, control.images), `${source}: early replay screenshot`);
					await page.evaluate(() => {
						const links = document.querySelectorAll('link[rel="stylesheet"]');
						// Keep runtime theme styles in place, after the static bundle and the probe.
						links[links.length - 1].after(document.querySelector('#css-order-probe')!);
					});
					const late = await capture(page, scene.selectors);
					const confirmed = await capture(page, scene.selectors);
					expect(changesBetween(late.samples, confirmed.samples), `${source}: late replay must be stable`).toEqual([]);
					expectImagesStable(await compareImages(page, late.images, confirmed.images), `${source}: late replay screenshot must be stable`);
					const changes = changesBetween(baseline.samples, late.samples);
					const imageDifferences = await compareImages(page, baseline.images, late.images);
					const imageChanged = imageDifferences.some(difference => difference.sizeChanged || difference.significantPixels > 0);
					probes.push({ source, sourceHash: createHash('sha256').update(css).digest('hex'), imageChanged, imageHash: late.imageHash, imageDifferences, changes });
					if (changes.length || imageChanged) {
						testInfo.annotations.push({ type: 'css-order-sensitive', description: `${source}: ${changes.length} property/geometry changes; screenshot changed: ${imageChanged}` });
						await attachImages(`late-${name}`, late.images);
					}
					if (scene.name === 'select-list' && name === 'list') {
						await assertSelectListPresentation(page);
						expect(changes, 'List loading last must preserve SelectBox styles, geometry and state').toEqual([]);
						expectImagesStable(imageDifferences, 'List loading last must preserve the SelectBox screenshot');
					}
				} finally {
					await page.locator('#css-order-probe').evaluate(element => element.remove());
				}
				const restored = await capture(page, scene.selectors);
				if (restored.imageHash !== baseline.imageHash) await attachImages(`restored-${name}`, restored.images);
				expect(changesBetween(baseline.samples, restored.samples), `${source}: removal must restore the baseline`).toEqual([]);
				expectImagesStable(await compareImages(page, baseline.images, restored.images), `${source}: restored screenshot`);
			}
			if (scene.name === 'select-list') {
				await page.keyboard.press('Escape');
				await expect(page.locator('.ash-select-box-list')).toBeHidden();
				await expect(page.getByRole('combobox', { name: 'Styled select', exact: true })).toBeFocused();
			}
			expect(errors, 'The real fixture must run without page errors').toEqual([]);
			const report = {
				scene: scene.name, theme, viewport: page.viewportSize(),
				method: 'Replay each intact source before and after the static bundle; retain runtime theme order.',
				limits: 'Selected sources and states only. SelectBox/List is a regression gate; other sensitivity is diagnostic. No layers, imports or relative URLs.',
				selectors: scene.selectors, sampledElements: baseline.samples.length, baselineImageHash: baseline.imageHash,
				imageTolerance: 'Per-channel delta <= 1/255; computed styles and geometry require exact equality in stability controls.',
				baselineImageDifferences,
				probes,
			};
			const reportPath = testInfo.outputPath('css-order-report.json');
			await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
			await testInfo.attach('css-order-report', { path: reportPath, contentType: 'application/json' });
		});
	}
}
