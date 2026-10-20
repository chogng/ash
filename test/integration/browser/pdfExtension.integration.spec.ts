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
	const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
	let text = '%PDF-1.4\n'; const offsets = [0];
	for (const [index, object] of objects.entries()) { offsets.push(text.length); text += `${index + 1} 0 obj\n${object}\nendobj\n`; }
	const start = text.length;
	text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
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
	await page.route('**/__pdf_bytes', route => route.fulfill({ body: Buffer.from(pdf()), contentType: 'application/pdf' }));
	await page.route('**/__pdf_catalog', route => route.fulfill({
		json: {
			generation, diagnostics: [], extensions: [{ id: 'ash.pdf-viewer', name: 'pdf-viewer', publisher: 'ash', version: '1.0.0', displayName: 'PDF Viewer', sourceKind: 'registry', manifestJson: JSON.stringify(manifest), manifestSha256: hash(JSON.stringify(manifest)), packageSha256: hash(JSON.stringify(compiled.resources)), rendererClient: runtimes.has(page) ? { ...compiled.client, runtimeId: 'ash.pdf-viewer' } : undefined }],
		}
	}));
	await page.route('**/__pdf_resource?*', route => {
		const query = new URL(route.request().url()).searchParams;
		const content = compiled.resources[query.get('path') ?? ''];
		if (!runtimes.has(page) || query.get('generation') !== String(generation) || content === undefined) return route.fulfill({ status: 410 });
		return route.fulfill({ body: content, contentType: query.get('path')?.endsWith('.css') ? 'text/css' : 'text/javascript' });
	});
	await page.route('**/__pdf_extension?*', async route => {
		const enabled = route.request().postDataJSON().enabled;
		if (!enabled) { await runtimes.get(page)?.dispose(); runtimes.delete(page); }
		else if (!runtimes.has(page)) runtimes.set(page, await startClientEditorExtension('ash-pdf-viewer', 'ash.pdf-viewer', new URL(route.request().url()).searchParams.get('locale') ?? 'en'));
		const runtime = runtimes.get(page);
		await route.fulfill({ json: { generation: ++generation, extensions: runtime ? [{ id: 'ash.pdf-viewer', version: '1.0.0', packageDigest: hash(JSON.stringify(compiled.resources)), runtimeApiVersion: 1, activationGeneration: generation, incarnation: generation, lifecycle: 'ready', failure: undefined, stderr: '', outputEvents: [], registrations: runtime.registrations }] : [] } });
	});
	await page.route('**/__pdf_invoke', async route => route.fulfill({ json: await runtimes.get(page)!.invoke('editor.resource.v1', 'receiveData', route.request().postDataJSON()) }));
});
test.afterEach(async ({ page }) => { await page.evaluate(() => window.pdfExtensionTest?.dispose()).catch(() => { }); await runtimes.get(page)?.dispose(); runtimes.delete(page); });

for (const locale of ['en', 'zh-CN']) test(`optional PDF package opens, saves, retires and reloads independently in ${locale}`, async ({ page }, testInfo) => {
	const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
	await page.goto(`/pdfExtension.html?locale=${locale}`);
	await page.waitForFunction(() => !!window.pdfExtensionTest);
	expect(await page.evaluate(() => window.pdfExtensionTest.available())).toBe(false);
	expect(await page.locator('style[data-ash-editor-client-style]').count()).toBe(0);
	await page.evaluate(() => window.pdfExtensionTest.enable(true));
	expect(await page.evaluate(() => window.pdfExtensionTest.available())).toBe(true);
	await page.evaluate(() => window.pdfExtensionTest.open());
	const reader = page.locator('.ash-pdf-editor');
	await expect(reader.locator('canvas')).toHaveCount(1);
	expect(await reader.locator('canvas').evaluate(element => { const canvas = element as HTMLCanvasElement; const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data; return data.some((value, index) => index % 4 !== 3 && value < 200); })).toBe(true);
	await expect(reader).toHaveAttribute('aria-label', locale === 'zh-CN' ? 'PDF 阅读器' : 'PDF reader');
	await expect(reader).toHaveAttribute('aria-description', locale === 'zh-CN' ? /打开无障碍帮助/ : /Open Accessibility Help/);
	await page.evaluate(() => window.pdfExtensionTest.verbosity(false));
	await expect(reader).not.toHaveAttribute('aria-description');
	await page.evaluate(() => window.pdfExtensionTest.verbosity(true));
	await reader.locator('[data-action-id="ash.pdf.annotations.note"] button').click();
	const layer = reader.locator('.ash-pdf-annotation-layer');
	await layer.focus();
	await layer.press('ArrowRight');
	expect(await page.evaluate(() => window.pdfExtensionTest.accessible())).toContain('Ash optional PDF Viewer');
	expect(await page.evaluate(() => window.pdfExtensionTest.accessible(true))).toContain(locale === 'zh-CN' ? '方向键' : 'arrow keys');
	await layer.press('Enter');
	await expect(reader.locator('.ash-pdf-annotation-note')).toHaveCount(1);
	await reader.locator('[data-action-id="ash.pdf.annotations.save"] button').click();
	await expect.poll(() => page.evaluate(async () => (await window.pdfExtensionTest.saved())?.annotations.length)).toBe(1);
	expect(await page.evaluate(() => window.pdfExtensionTest.unchanged())).toBe(true);
	await page.evaluate(() => window.pdfExtensionTest.open());
	await expect(reader.locator('.ash-pdf-annotation-note')).toHaveCount(1);
	await reader.locator('[data-action-id="ash.pdf.annotations.note"] button').click();
	await layer.focus(); await layer.press('Enter');
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
	await page.route('**/__pdf_resource?*', route => route.fulfill({ body: 'throw new Error("unverified client executed")', contentType: 'text/javascript' }));
	await page.goto('/pdfExtension.html'); await page.waitForFunction(() => !!window.pdfExtensionTest);
	await page.evaluate(() => window.pdfExtensionTest.enable(true));
	const result = await page.evaluate(() => window.pdfExtensionTest.open().then(() => '', error => String(error)));
	expect(result).toMatch(/versions do not match/);
	await expect(page.locator('canvas')).toHaveCount(0);
});

test('Chat uses the optional resource editor for immutable attachment previews and keeps actions without it', async ({ page }) => {
	await page.goto('/pdfExtension.html'); await page.waitForFunction(() => !!window.pdfExtensionTest);
	await page.evaluate(() => window.pdfExtensionTest.previewChat());
	const attachment = page.locator('.ash-chat-media');
	await expect(attachment.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
	await expect(attachment.getByRole('button', { name: 'Open resource', exact: true })).toBeVisible();
	await expect(attachment.locator('canvas')).toHaveCount(0);
	await page.evaluate(async () => { await window.pdfExtensionTest.enable(true); window.pdfExtensionTest.previewChat(); });
	await expect(attachment.locator('canvas')).toHaveCount(1);
	await expect(attachment.locator('[data-action-id="ash.pdf.annotations.note"] button')).toBeDisabled();
	expect(await page.evaluate(() => window.pdfExtensionTest.saved())).toBeUndefined();
	await page.evaluate(() => window.pdfExtensionTest.enable(false));
	await expect(attachment.locator('canvas')).toHaveCount(1);
	await page.evaluate(() => window.pdfExtensionTest.close());
	await expect(page.locator('style[data-ash-editor-client-style]')).toHaveCount(0);
});
