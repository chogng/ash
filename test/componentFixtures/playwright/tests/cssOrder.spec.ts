import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type TestInfo } from '@playwright/test';
import { scanFixture } from '../../cssOrderShared.mts';
import type { FixtureScanOptions } from '../../cssOrderShared.mts';
import { runCssOrderCommand } from './utils.js';

async function imageRecorder(testInfo: TestInfo, id: string) {
	const directory = testInfo.outputPath('images');
	await mkdir(directory, { recursive: true });
	const prefix = `${id.replaceAll(/[^a-z0-9-]/gi, '-').slice(0, 32)}-${createHash('sha256').update(id).digest('hex').slice(0, 8)}`;
	const images: { name: string; path: string; }[] = [];
	return {
		images,
		save: async (name: string, buffers: readonly Buffer[]): Promise<void> => {
			for (const [index, buffer] of buffers.entries()) {
				const filename = `${prefix}-${name}-${index}.png`;
				const path = testInfo.outputPath('images', filename);
				await writeFile(path, buffer);
				images.push({ name: `${name}-${index}`, path });
				await testInfo.attach(filename, { path, contentType: 'image/png' });
			}
		},
	};
}

test('component explorer discovers themed fixtures and exposes real CSS source order', async ({ page }) => {
	await page.goto('/componentExplorer.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const catalog = await page.evaluate(() => window.componentExplorer.catalog);
	expect(catalog.length).toBeGreaterThanOrEqual(12);
	expect(new Set(catalog.map(entry => entry.id)).size).toBe(catalog.length);
	await page.getByRole('searchbox', { name: 'Filter fixtures' }).fill('SelectAndList/ash-high-contrast-light');
	const id = 'shared/SelectAndList/ash-high-contrast-light';
	await page.getByRole('link', { name: id, exact: true }).click();
	await expect(page.getByRole('status')).toHaveText(id);
	const frame = page.frameLocator('#preview');
	await expect(frame.getByRole('combobox', { name: 'Fixture choice' })).toBeVisible();
	await expect(frame.locator('html')).toHaveAttribute('data-color-theme', 'ash-high-contrast-light');
	const original = await frame.locator('body').evaluate(() => window.componentFixture.order());
	await page.getByRole('button', { name: 'Reverse CSS', exact: true }).click();
	expect(await frame.locator('body').evaluate(() => window.componentFixture.order())).toEqual([...original].reverse());
	await page.getByRole('button', { name: 'Reset CSS', exact: true }).click();
	expect(await frame.locator('body').evaluate(() => window.componentFixture.order())).toEqual(original);
	await expect(page.locator('#stylesheets')).toContainText('selectbox.css');
	await page.getByText('Stylesheet source order', { exact: true }).click();
	await frame.getByRole('combobox', { name: 'Fixture choice' }).click();
	await expect(frame.getByRole('option', { name: 'Unavailable choice' })).toBeVisible();
	const screenshot = test.info().outputPath('component-explorer.png');
	await page.screenshot({ path: screenshot });
	await test.info().attach('component-explorer', { path: screenshot, contentType: 'image/png' });
	// Retain the former integration regression gate using the existing source-order runtime.
	for (const theme of ['ash-dark', 'ash-light', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
		const fixtureId = `shared/SelectAndList/${theme}`;
		await page.getByRole('searchbox', { name: 'Filter fixtures' }).fill(fixtureId);
		await page.getByRole('link', { name: fixtureId, exact: true }).click();
		await expect(page.getByRole('status')).toHaveText(fixtureId);
		await expect(frame.locator('body')).toHaveAttribute('data-ready', 'true');
		const popup = frame.locator('.ash-select-box-list');
		await frame.getByRole('combobox', { name: 'Fixture choice' }).click();
		await frame.getByRole('combobox', { name: 'Fixture choice' }).press('ArrowDown');
		const assertPresentation = async (): Promise<void> => {
			for (const side of ['top', 'right', 'bottom', 'left']) await expect(popup).toHaveCSS(`padding-${side}`, '4px');
			await expect(popup.getByRole('option')).toHaveCount(3);
			for (const name of ['First choice', 'Last choice']) await expect(popup.getByRole('option', { name, exact: true })).toHaveCSS('cursor', 'pointer');
			const disabled = popup.getByRole('option', { name: 'Unavailable choice', exact: true });
			await expect(disabled).toHaveAttribute('aria-disabled', 'true');
			await expect(disabled).toHaveCSS('cursor', 'default');
			expect(await popup.evaluate(element => ({
				height: element.getBoundingClientRect().height,
				rows: [...element.querySelectorAll('[role="option"]')].map(row => row.getBoundingClientRect().height),
			}))).toEqual({ height: 74, rows: [22, 22, 22] });
			const plainList = frame.getByRole('listbox', { name: 'Fixture list', exact: true });
			await expect(plainList).toHaveCSS('padding-top', '0px');
			await expect(plainList.locator('.ash-list-row').first()).toHaveCSS('cursor', 'default');
			await popup.getByRole('option', { name: 'First choice', exact: true }).focus();
			await page.keyboard.press('Home');
			await expect(popup.getByRole('option', { name: 'First choice', exact: true })).toBeFocused();
			await page.keyboard.press('ArrowDown');
			await expect(popup.getByRole('option', { name: 'Last choice', exact: true })).toBeFocused();
			await page.keyboard.press('ArrowUp');
			await expect(popup.getByRole('option', { name: 'First choice', exact: true })).toBeFocused();
			await page.keyboard.press('End');
			const focused = popup.getByRole('option', { name: 'Last choice', exact: true });
			await expect(focused).toBeFocused();
			await expect(focused).toHaveCSS('outline-style', 'solid');
			await expect(focused).toHaveCSS('outline-width', '1px');
			await expect(frame.getByRole('combobox', { name: 'Fixture choice' })).toHaveAttribute('aria-activedescendant', (await focused.getAttribute('id'))!);
		};
		await assertPresentation();
		await frame.locator('body').evaluate(() => {
			const order = window.componentFixture.order();
			const list = window.componentFixture.documents().find(document => document.source.endsWith('/list/list.css'))!;
			window.componentFixture.setOrder([...order.filter(index => index !== list.index), list.index]);
		});
		await assertPresentation();
		await page.keyboard.press('Escape');
		await expect(popup).toBeHidden();
		await expect(frame.getByRole('combobox', { name: 'Fixture choice' })).toBeFocused();
	}
	await page.goto('/componentFixture.html?fixture=unknown');
	await expect(page.getByRole('alert')).toContainText('Unknown component fixture');
});

test('CSS scan localizes an injected conflict to its two actual source files', async ({ page }, testInfo) => {
	const id = 'shared/ButtonsAndMenu/ash-dark';
	const recorder = await imageRecorder(testInfo, id);
	const result = await scanFixture(page, id, Date.now() + 60_000, /fixtures\/cssOrder\/(earlier|later)\.css$/, recorder.save, async page => {
		await page.evaluate(async () => {
			document.querySelector('.ash-component-fixture')!.classList.add('ash-fixture-order-probe');
			await import('/test/componentFixtures/fixtures/cssOrder/earlier.css');
			await import('/test/componentFixtures/fixtures/cssOrder/later.css');
			window.componentFixture.refreshStyles();
		});
	});
	const report = testInfo.outputPath('injected-conflict.json');
	await writeFile(report, `${JSON.stringify({ fault: 'Injected border-width conflict', result, images: recorder.images }, null, 2)}\n`);
	await testInfo.attach('injected-conflict', { path: report, contentType: 'application/json' });
	expect(result.status, JSON.stringify(result)).toBe('localized');
	expect(result.conflict?.map(document => document.source)).toEqual([
		'test/componentFixtures/fixtures/cssOrder/earlier.css',
		'test/componentFixtures/fixtures/cssOrder/later.css',
	]);
	expect(result.probes).toBeLessThan(15);
	expect(result.difference?.styles.some(change => change.property === '/border-top-width')).toBe(true);
});

test('a dynamic stylesheet between source documents prevents a false pair attribution', async ({ page }, testInfo) => {
	const recorder = await imageRecorder(testInfo, 'dynamic-stylesheet-boundary');
	const result = await scanFixture(page, 'shared/ButtonsAndMenu/ash-dark', Date.now() + 60_000, /fixtures\/cssOrder\/(earlier|later)\.css$/, recorder.save, async page => {
		await page.evaluate(async () => {
			document.querySelector('.ash-component-fixture')!.classList.add('ash-fixture-order-probe');
			await import('/test/componentFixtures/fixtures/cssOrder/earlier.css');
			const dynamic = document.createElement('style');
			dynamic.textContent = '.ash-fixture-order-probe .ash-button { border-width: 4px; }';
			document.head.append(dynamic);
			await import('/test/componentFixtures/fixtures/cssOrder/later.css');
			window.componentFixture.refreshStyles();
		});
	});
	expect(result.detected).toBe(true);
	expect(result.status).toBe('unlocalized');
	expect(result.reason).toContain('dynamic stylesheet');
	expect(result.conflict).toBeUndefined();
});

test('scanner rediscovers the original SelectBox and List conflict through real source documents', async ({ page }, testInfo) => {
	const recorder = await imageRecorder(testInfo, 'original-selectbox-conflict');
	const result = await scanFixture(page, 'shared/SelectAndList/ash-dark', Date.now() + 60_000, /.*/, recorder.save, async page => {
		await page.evaluate(() => {
			// Restore the fragile selectors only in this page's actual source node.
			// The checked-out CSS stays fixed, and the source mapping still names its owner.
			const source = [...document.querySelectorAll<HTMLStyleElement>('style[data-vite-dev-id]')].find(style => style.dataset.viteDevId?.endsWith('/selectbox/selectbox.css'))!;
			source.textContent = source.textContent!
				.replace('.ash-select-box-list.ash-list', '.ash-select-box-list')
				.replace('.ash-select-box-option:not(.ash-select-box-option-disabled)', '.ash-select-box-option');
			window.componentFixture.refreshStyles();
		});
	});
	const report = testInfo.outputPath('selectbox-conflict.json');
	await writeFile(report, `${JSON.stringify({ fault: 'Original fragile selectors restored only in this browser document', result, images: recorder.images }, null, 2)}\n`);
	await testInfo.attach('selectbox-conflict', { path: report, contentType: 'application/json' });
	expect(result.status, JSON.stringify(result)).toBe('localized');
	expect(new Set(result.conflict?.map(document => document.source))).toEqual(new Set([
		'src/ash/base/browser/ui/selectbox/selectbox.css',
		'src/ash/base/browser/ui/list/list.css',
	]));
});

test('scan command covers registered fixtures within the shared time budget', async ({ baseURL }, testInfo) => {
	const options = testInfo.config.metadata.fixtureOptions as FixtureScanOptions;
	const report = await runCssOrderCommand(testInfo, baseURL!, 'Scan', [
		'--fixture-id-regex', options.pattern, '--stylesheet-source-regex', options.sourcePattern,
		'--time-budget-minutes', String(options.budgetMs / 60_000),
		'--concurrency', String(options.concurrency), '--batch-size', String(options.batchSize),
	]);
	expect(report.results.length).toBeGreaterThan(0);
	expect(report.results.filter(result => result.status === 'error')).toEqual([]);
	const incomplete = report.results.filter(result => ['unlocalized', 'not-scanned'].includes(result.status));
	if (incomplete.length) testInfo.annotations.push({ type: 'css-order-incomplete', description: `${incomplete.length} fixtures; see the command report` });
	const conflicts = report.results.filter(result => result.detected);
	if (conflicts.length) testInfo.annotations.push({ type: 'css-order-sensitive', description: `${conflicts.length} fixtures; see the command report` });
});

test('bisection command selects exactly one fixture and saves its actual CSS manifest', async ({ baseURL }, testInfo) => {
	const id = 'shared/SelectAndList/ash-high-contrast-light';
	const report = await runCssOrderCommand(testInfo, baseURL!, 'Bisect', ['--fixture-id-regex', `^${id}$`]);
	expect(report.results.map(result => result.id)).toEqual([id]);
	expect(report.results[0].status).toBe('clean');
	expect(report.results[0].documents.map(document => document.source)).toContain('src/ash/base/browser/ui/selectbox/selectbox.css');
});

test('scan command records every skipped batch when its budget expires', async ({ baseURL }, testInfo) => {
	const report = await runCssOrderCommand(testInfo, baseURL!, 'Scan', ['--time-budget-minutes', '0.00001', '--batch-size', '2']);
	expect(report.results.length).toBeGreaterThanOrEqual(12);
	expect(report.results.every(result => result.status === 'not-scanned')).toBe(true);
	expect(report.results.every(result => result.reason === 'Scan time budget exceeded')).toBe(true);
});
