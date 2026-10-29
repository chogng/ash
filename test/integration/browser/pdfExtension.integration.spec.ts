import { test, expect } from '@playwright/test';
import { compileEditorClient } from '../../../build/builtin/editorClients.ts';
import { prepareClientEditorExtension, startClientEditorExtension } from '../../fixtures/clientEditorExtension.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

let compiled: Awaited<ReturnType<typeof compileEditorClient>>;
let manifest: Record<string, unknown>;
const runtimes = new WeakMap<object, Awaited<ReturnType<typeof startClientEditorExtension>>>();
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function pdf(): Uint8Array {
	const stream = 'BT /F1 18 Tf 30 220 Td (Ash optional PDF Viewer) Tj ET';
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
	];
	let text = '%PDF-1.4\n';
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(text.length);
		text += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const start = text.length;
	text += `xref\n0 6\n0000000000 65535 f \n${offsets
		.slice(1)
		.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`)
		.join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
	return new TextEncoder().encode(text);
}

test.beforeAll(async () => {
	test.setTimeout(120000);
	prepareClientEditorExtension('ash-pdf-viewer');
	compiled = await compileEditorClient(resolve('extensions/pdf-viewer'));
	manifest = JSON.parse(await readFile('extensions/pdf-viewer/package.json', 'utf8'));
});
test.beforeEach(async ({ page }) => {
	let generation = 0;
	await page.route('**/__pdf_bytes', route =>
		route.fulfill({ body: Buffer.from(pdf()), contentType: 'application/pdf' }),
	);
	await page.route('**/__pdf_catalog', route =>
		route.fulfill({
			json: {
				generation,
				diagnostics: [],
				extensions: [
					{
						id: 'ash.pdf-viewer',
						name: 'pdf-viewer',
						publisher: 'ash',
						version: '1.0.0',
						displayName: 'PDF Viewer',
						sourceKind: 'registry',
						manifestJson: JSON.stringify(manifest),
						manifestSha256: hash(JSON.stringify(manifest)),
						packageSha256: hash(JSON.stringify(compiled.resources)),
						rendererClient: runtimes.has(page)
							? { ...compiled.client, runtimeId: 'ash.pdf-viewer' }
							: undefined,
					},
				],
			},
		}),
	);
	await page.route('**/__pdf_resource?*', route => {
		const query = new URL(route.request().url()).searchParams;
		const content = compiled.resources[query.get('path') ?? ''];
		if (!runtimes.has(page) || query.get('generation') !== String(generation) || content === undefined)
			return route.fulfill({ status: 410 });
		return route.fulfill({
			body: content,
			contentType: query.get('path')?.endsWith('.css') ? 'text/css' : 'text/javascript',
		});
	});
	await page.route('**/__pdf_extension?*', async route => {
		const enabled = route.request().postDataJSON().enabled;
		if (!enabled) {
			await runtimes.get(page)?.dispose();
			runtimes.delete(page);
		} else if (!runtimes.has(page))
			runtimes.set(
				page,
				await startClientEditorExtension(
					'ash-pdf-viewer',
					'ash.pdf-viewer',
					new URL(route.request().url()).searchParams.get('locale') ?? 'en',
				),
			);
		const runtime = runtimes.get(page);
		await route.fulfill({
			json: {
				generation: ++generation,
				extensions: runtime
					? [
							{
								id: 'ash.pdf-viewer',
								version: '1.0.0',
								packageDigest: hash(JSON.stringify(compiled.resources)),
								runtimeApiVersion: 1,
								activationGeneration: generation,
								incarnation: generation,
								lifecycle: 'ready',
								failure: undefined,
								stderr: '',
								outputEvents: [],
								registrations: runtime.registrations,
							},
						]
					: [],
			},
		});
	});
	await page.route('**/__pdf_invoke', async route =>
		route.fulfill({
			json: await runtimes.get(page)!.invoke('editor.resource.v1', 'receiveData', route.request().postDataJSON()),
		}),
	);
});
test.afterEach(async ({ page }) => {
	await page.evaluate(() => window.pdfExtensionTest?.dispose()).catch(() => {});
	await runtimes.get(page)?.dispose();
	runtimes.delete(page);
});

for (const locale of ['en', 'zh-CN'])
	test(`optional PDF package opens, saves, retires and reloads independently in ${locale}`, async ({
		page,
	}, testInfo) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/pdfExtension.html?locale=${locale}`);
		await page.waitForFunction(() => !!window.pdfExtensionTest);
		expect(await page.evaluate(() => window.pdfExtensionTest.available())).toBe(false);
		expect(await page.locator('style[data-ash-editor-client-style]').count()).toBe(0);
		await page.evaluate(() => window.pdfExtensionTest.enable(true));
		expect(await page.evaluate(() => window.pdfExtensionTest.available())).toBe(true);
		await page.evaluate(() => window.pdfExtensionTest.open());
		const reader = page.locator('.ash-pdf-editor');
		await expect(reader.locator('canvas')).toHaveCount(1);
		expect(
			await reader.locator('canvas').evaluate(element => {
				const canvas = element as HTMLCanvasElement;
				const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
				return data.some((value, index) => index % 4 !== 3 && value < 200);
			}),
		).toBe(true);
		await expect(reader).toHaveAttribute('aria-label', locale === 'zh-CN' ? 'PDF 阅读器' : 'PDF reader');
		await expect(reader).toHaveAttribute(
			'aria-description',
			locale === 'zh-CN' ? /打开无障碍帮助/ : /Open Accessibility Help/,
		);
		await page.evaluate(() => window.pdfExtensionTest.verbosity(false));
		await expect(reader).not.toHaveAttribute('aria-description');
		await page.evaluate(() => window.pdfExtensionTest.verbosity(true));
		await reader.locator('[data-action-id="ash.pdf.annotations.note"] button').click();
		const layer = reader.locator('.ash-pdf-annotation-layer');
		await layer.focus();
		await layer.press('ArrowRight');
		expect(await page.evaluate(() => window.pdfExtensionTest.accessible())).toContain('Ash optional PDF Viewer');
		expect(await page.evaluate(() => window.pdfExtensionTest.accessible(true))).toContain(
			locale === 'zh-CN' ? '方向键' : 'arrow keys',
		);
		await layer.press('Enter');
		await expect(reader.locator('.ash-pdf-annotation-note')).toHaveCount(1);
		await reader.locator('[data-action-id="ash.pdf.annotations.save"] button').click();
		await expect
			.poll(() => page.evaluate(async () => (await window.pdfExtensionTest.saved())?.annotations.length))
			.toBe(1);
		expect(await page.evaluate(() => window.pdfExtensionTest.unchanged())).toBe(true);
		await page.evaluate(() => window.pdfExtensionTest.open());
		await expect(reader.locator('.ash-pdf-annotation-note')).toHaveCount(1);
		await reader.locator('[data-action-id="ash.pdf.annotations.note"] button').click();
		await layer.focus();
		await layer.press('Enter');
		await expect(reader.locator('.ash-pdf-annotation-note')).toHaveCount(2);
		await page.evaluate(() => window.pdfExtensionTest.enable(false));
		expect(await page.evaluate(() => window.pdfExtensionTest.available())).toBe(false);
		await expect(reader.locator('[data-action-id="ash.pdf.annotations.note"] button')).toBeDisabled();
		await expect(reader.locator('canvas')).toHaveCount(1);
		await expect(reader.locator('.ash-pdf-annotation-note')).toHaveCount(2);
		await expect(page.locator('style[data-ash-editor-client-style]')).toHaveCount(1);
		await page.screenshot({ path: testInfo.outputPath(`pdf-extension-${locale}.png`) });
		await page.evaluate(() => window.pdfExtensionTest.enable(true));
		await expect(reader.locator('[data-action-id="ash.pdf.annotations.note"] button')).toBeDisabled();
		await page.evaluate(() => window.pdfExtensionTest.open(true));
		await expect(reader.locator('[data-action-id="ash.pdf.annotations.note"] button')).toBeDisabled();
		await page.evaluate(() => window.pdfExtensionTest.close());
		await expect(page.locator('style[data-ash-editor-client-style]')).toHaveCount(0);
		expect(errors).toEqual([]);
	});

test('optional PDF rejects modified client bytes before executing the package', async ({ page }) => {
	await page.route('**/__pdf_resource?*', route =>
		route.fulfill({ body: 'throw new Error("unverified client executed")', contentType: 'text/javascript' }),
	);
	await page.goto('/pdfExtension.html');
	await page.waitForFunction(() => !!window.pdfExtensionTest);
	await page.evaluate(() => window.pdfExtensionTest.enable(true));
	const result = await page.evaluate(() =>
		window.pdfExtensionTest.open().then(
			() => '',
			error => String(error),
		),
	);
	expect(result).toMatch(/versions do not match/);
	await expect(page.locator('canvas')).toHaveCount(0);
});

test('Chat uses the optional resource editor for immutable attachment previews and keeps actions without it', async ({
	page,
}) => {
	await page.goto('/pdfExtension.html');
	await page.waitForFunction(() => !!window.pdfExtensionTest);
	await page.evaluate(() => window.pdfExtensionTest.previewChat());
	const attachment = page.locator('.ash-chat-media');
	await expect(attachment.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
	await expect(attachment.getByRole('button', { name: 'Open resource', exact: true })).toBeVisible();
	await expect(attachment.locator('canvas')).toHaveCount(0);
	await page.evaluate(async () => {
		await window.pdfExtensionTest.enable(true);
		window.pdfExtensionTest.previewChat();
	});
	await expect(attachment.locator('canvas')).toHaveCount(1);
	await expect(attachment.locator('[data-action-id="ash.pdf.annotations.note"] button')).toBeDisabled();
	expect(await page.evaluate(() => window.pdfExtensionTest.saved())).toBeUndefined();
	await page.evaluate(() => window.pdfExtensionTest.enable(false));
	await expect(attachment.locator('canvas')).toHaveCount(1);
	await page.evaluate(() => window.pdfExtensionTest.close());
	await expect(page.locator('style[data-ash-editor-client-style]')).toHaveCount(0);
});

/** Text spans, line breaks and page rotation exercise PDF.js layout rather than HTML-only fixtures. */
function readingPdf(options: { scanned?: boolean; rotated?: boolean } = {}): Uint8Array {
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>',
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
	];
	for (let page = 1; page <= 3; page++) {
		const stream = options.scanned
			? '0 0 0 rg 30 200 100 20 re f'
			: `BT /F1 18 Tf 30 440 Td (Ash optional PDF Viewer) Tj 0 -40 Td (Find across) Tj 0 -24 Td (lines on page ${page}) Tj 0 -40 Td (Literal [PDF] text) Tj ET`;
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 520] ${options.rotated ? '/Rotate 90' : ''} /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + (page - 1) * 2} 0 R >>`,
			`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		);
	}
	let text = '%PDF-1.4\n';
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(text.length);
		text += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const start = text.length;
	text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
		.slice(1)
		.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`)
		.join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
	return new TextEncoder().encode(text);
}

for (const locale of ['en', 'zh-CN'])
	test(`PDF reading preserves selection, matches and annotations through zoom in ${locale}`, async ({
		page,
		context,
	}, testInfo) => {
		await page.route('**/__pdf_bytes', route =>
			route.fulfill({ body: Buffer.from(readingPdf()), contentType: 'application/pdf' }),
		);
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/pdfExtension.html?locale=${locale}`);
		await page.waitForFunction(() => !!window.pdfExtensionTest);
		await page.evaluate(async () => {
			await window.pdfExtensionTest.enable(true);
			await window.pdfExtensionTest.open();
		});
		const reader = page.locator('.ash-pdf-editor');
		const zoom = reader.locator('.ash-pdf-zoom');
		await expect(zoom).toHaveAccessibleName(locale === 'en' ? 'PDF zoom' : 'PDF 缩放');
		const firstPage = reader.locator('.ash-pdf-page').first();
		await expect(reader.locator('.ash-pdf-text-layer')).toHaveCount(3);
		const text = firstPage.locator('.ash-pdf-text-layer > span').filter({ hasText: 'Ash optional PDF Viewer' });
		const bounds = (await text.boundingBox())!;
		expect(bounds.width).toBeGreaterThan(150);
		expect(bounds.height).toBeGreaterThan(15);
		await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
		await page.mouse.down();
		await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 12 });
		await page.mouse.up();
		expect(await page.evaluate(() => document.getSelection()?.toString())).toContain('optional PDF');
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c');
		expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('optional PDF');

		await reader.locator('[data-action-id="ash.pdf.annotations.note"] button').click();
		await firstPage.locator('.ash-pdf-annotation-layer').focus();
		await page.keyboard.press('Enter');
		await expect(reader.locator('.ash-pdf-annotation-note')).toHaveCount(1);
		await zoom.selectOption('2');
		await expect(reader).not.toHaveAttribute('aria-busy');
		expect((await firstPage.boundingBox())!.width).toBeCloseTo(840, 0);
		await expect(reader.locator('.ash-pdf-annotation-note')).toHaveCount(1);
		await reader.locator('[data-action-id="ash.pdf.annotations.undo"] button').click();
		await expect(reader.locator('.ash-pdf-annotation-note')).toHaveCount(0);
		await reader.locator('[data-action-id="ash.pdf.annotations.redo"] button').click();
		await expect(reader.locator('.ash-pdf-annotation-note')).toHaveCount(1);
		await reader.locator('[data-action-id="ash.pdf.annotations.save"] button').click();
		await expect
			.poll(() => page.evaluate(async () => (await window.pdfExtensionTest.saved())?.annotations.length))
			.toBe(1);

		await reader.locator('.ash-pdf-pages').focus();
		await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
		const search = reader.getByRole('searchbox');
		await expect(search).toBeFocused();
		await search.fill('pdf viewer');
		const status = reader.locator('.ash-pdf-find-status');
		await expect(status).toHaveText(locale === 'en' ? '1 of 3 · page 1' : '第 1 / 3 项 · 第 1 页');
		await expect(reader.locator('.ash-pdf-search-match')).toHaveCount(3);
		await search.press('Enter');
		await expect(status).toContainText(locale === 'en' ? 'page 2' : '第 2 页');
		await search.press('Shift+Enter');
		await search.press('Shift+Enter');
		await expect(status).toContainText(locale === 'en' ? 'page 3' : '第 3 页');
		const match = reader.locator('.ash-pdf-search-match.current');
		await expect(match).toBeInViewport();
		const originalRatio = await match.evaluate(
			element =>
				element.getBoundingClientRect().width /
				element.parentElement!.parentElement!.getBoundingClientRect().width,
		);
		for (const scale of ['1', '2', '0.5', '1.5']) await zoom.selectOption(scale);
		await expect(reader).not.toHaveAttribute('aria-busy');
		expect((await firstPage.boundingBox())!.width).toBeCloseTo(630, 0);
		expect(
			await match.evaluate(
				element =>
					element.getBoundingClientRect().width /
					element.parentElement!.parentElement!.getBoundingClientRect().width,
			),
		).toBeCloseTo(originalRatio, 2);
		await expect(status).toContainText(locale === 'en' ? 'page 3' : '第 3 页');
		await search.fill('across lines');
		await expect(status).toHaveText(locale === 'en' ? '1 of 3 · page 1' : '第 1 / 3 项 · 第 1 页');
		await search.fill('[PDF]');
		await expect(status).toHaveText(locale === 'en' ? '1 of 3 · page 1' : '第 1 / 3 项 · 第 1 页');
		for (const theme of ['hcDark', 'hcLight'] as const) {
			await page.evaluate(theme => window.pdfExtensionTest.setTheme(theme), theme);
			await expect(match).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(match).toHaveCSS('border-top-width', '2px');
			const colors = await match.evaluate(element => {
				const style = getComputedStyle(element);
				return [style.borderTopColor, style.outlineColor];
			});
			expect(colors[0]).not.toBe(colors[1]);
		}
		await page.evaluate(() => window.pdfExtensionTest.setTheme('dark'));
		await expect(reader).not.toHaveClass(/high-contrast/);
		await search.fill('missing result');
		await expect(status).toHaveText(locale === 'en' ? 'No matches' : '无匹配结果');
		await expect(reader.locator('.ash-pdf-search-match')).toHaveCount(0);
		await search.press('Escape');
		await expect(reader.locator('.ash-pdf-pages')).toBeFocused();
		await expect(reader.locator('.ash-pdf-find')).toBeHidden();
		await page.keyboard.press(process.platform === 'darwin' ? 'Meta+0' : 'Control+0');
		await expect(zoom).toHaveValue('1');
		await expect(reader).not.toHaveAttribute('aria-busy');
		await reader.getByRole('button', { name: locale === 'en' ? 'Fit width' : '适合宽度', exact: true }).click();
		await expect(reader).not.toHaveAttribute('aria-busy');
		expect(
			await reader.locator('.ash-pdf-pages').evaluate(element => element.scrollWidth - element.clientWidth),
		).toBeLessThanOrEqual(1);
		expect(await page.evaluate(() => window.pdfExtensionTest.unchanged())).toBe(true);
		await page.screenshot({ path: testInfo.outputPath(`pdf-reading-${locale}.png`) });
		await page.evaluate(() => window.pdfExtensionTest.open(true));
		await zoom.selectOption('2');
		await expect(reader).not.toHaveAttribute('aria-busy');
		await reader
			.getByRole('button', { name: locale === 'en' ? 'Find in PDF' : '在 PDF 中查找', exact: true })
			.click();
		await search.fill('PDF Viewer');
		await expect(reader.locator('.ash-pdf-search-match')).toHaveCount(3);
		await page.evaluate(() => window.pdfExtensionTest.enable(false));
		await expect(zoom).toBeDisabled();
		await expect(search).toBeDisabled();
		expect(errors).toEqual([]);
	});

test('PDF search reports image-only pages and keeps rotated text aligned', async ({ page }) => {
	await page.route('**/__pdf_bytes', route =>
		route.fulfill({ body: Buffer.from(readingPdf({ scanned: true })), contentType: 'application/pdf' }),
	);
	await page.goto('/pdfExtension.html');
	await page.waitForFunction(() => !!window.pdfExtensionTest);
	await page.evaluate(async () => {
		await window.pdfExtensionTest.enable(true);
		await window.pdfExtensionTest.open();
	});
	await page.getByRole('button', { name: 'Find in PDF', exact: true }).click();
	await page.getByRole('searchbox').fill('anything');
	await expect(page.locator('.ash-pdf-find-status')).toHaveText('No searchable text in this PDF');
	await page.route('**/__pdf_bytes', route =>
		route.fulfill({ body: Buffer.from(readingPdf({ rotated: true })), contentType: 'application/pdf' }),
	);
	await page.reload();
	await page.waitForFunction(() => !!window.pdfExtensionTest);
	await page.evaluate(async () => {
		await window.pdfExtensionTest.enable(true);
		await window.pdfExtensionTest.open();
	});
	await page.getByRole('button', { name: 'Find in PDF', exact: true }).click();
	await page.getByRole('searchbox').fill('PDF Viewer');
	await expect(page.locator('.ash-pdf-search-match')).toHaveCount(3);
	const rect = (await page.locator('.ash-pdf-search-match.current').boundingBox())!;
	expect(rect.height).toBeGreaterThan(rect.width * 2);
	await expect(page.locator('.ash-pdf-search-match.current')).toBeInViewport();
});
