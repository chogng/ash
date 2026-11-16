import { test, expect } from '@playwright/test';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { globSync, readFileSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { createInterface } from 'node:readline';

let binary: string;
let worker: ChildProcessWithoutNullStreams;
let sequence = 0;
const pending = new Map<number, (reply: unknown) => void>();

function pdf(): Buffer {
	const stream = 'BT /F1 18 Tf 30 220 Td (aspdf native review) Tj ET';
	const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
	let text = '%PDF-1.4\n'; const offsets: number[] = [];
	for (const [index, object] of objects.entries()) { offsets.push(text.length); text += `${index + 1} 0 obj\n${object}\nendobj\n`; }
	const start = text.length;
	text += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
	return Buffer.from(text);
}

test.beforeAll(() => {
	test.setTimeout(120000);
	execFileSync('just', ['test', 'ash-pdf', '--test', 'pdf_process', '--no-run', '--locked'], { timeout: 120000, stdio: 'pipe' });
	binary = globSync('.build/cargo/ci-test/deps/pdf_process-*').filter(path => extname(path) === (process.platform === 'win32' ? '.exe' : '')).sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0]!;
	if (!binary) { throw new Error('Native PDF process fixture was not built'); }
});

test.beforeEach(async ({ page }) => {
	worker = spawn(resolve(binary), ['--fixture'], { stdio: 'pipe' });
	const lines = createInterface({ input: worker.stdout });
	lines.on('line', line => { const reply = JSON.parse(line) as { id: number; }; pending.get(reply.id)?.(reply); pending.delete(reply.id); });
	await page.route('**/__aspdf_bytes', route => route.fulfill({ body: pdf(), contentType: 'application/pdf' }));
	await page.route('**/__aspdf_rpc', async route => {
		const request = route.request().postDataJSON(); const id = ++sequence;
		const reply = await new Promise<Record<string, unknown>>(resolve => {
			pending.set(id, value => resolve(value as Record<string, unknown>));
			worker.stdin.write(JSON.stringify({ ...request, id }) + '\n');
		});
		await route.fulfill({ json: { ...reply, id: request.id } });
	});
});

test.afterEach(async ({ page }) => {
	await page.evaluate(() => window.aspdfTest?.dispose()).catch(() => undefined);
	worker.stdin.end();
	await new Promise<void>(resolve => { if (worker.exitCode !== null) { resolve(); } else { worker.once('exit', () => resolve()); } });
	pending.clear();
});

for (const locale of ['en', 'zh-CN']) {
	test(`aspdf reads, annotates, saves and reopens through the native PDF service in ${locale}`, async ({ page }, testInfo) => {
		const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/pdfPreview.html?locale=${locale}`);
		await page.waitForFunction(() => !!window.aspdfTest);
		await page.evaluate(() => window.aspdfTest.open());
		const viewer = page.locator('.ash-sessions-pdf-preview');
		await expect(viewer).toHaveAttribute('aria-label', /aspdf/);
		await expect(viewer.locator('img')).toHaveJSProperty('naturalWidth', 1200);
		await expect(viewer.locator('.ash-sessions-pdf-text')).toContainText('aspdf native review');
		await viewer.getByRole('textbox', { name: locale === 'zh-CN' ? '批注内容' : 'Annotation text' }).fill('Check this evidence');
		await viewer.getByRole('button', { name: locale === 'zh-CN' ? '添加便签' : 'Add note', exact: true }).click();
		await expect(viewer.locator('.ash-sessions-pdf-annotation textarea')).toHaveValue('Check this evidence');
		expect(await page.evaluate(() => window.aspdfTest.dirty())).toBe(true);
		await viewer.getByRole('button', { name: locale === 'zh-CN' ? '撤销' : 'Undo', exact: true }).click();
		await expect(viewer.locator('.ash-sessions-pdf-annotation')).toHaveCount(0);
		await viewer.getByRole('button', { name: locale === 'zh-CN' ? '重做' : 'Redo', exact: true }).click();
		await expect(viewer.locator('.ash-sessions-pdf-annotation textarea')).toHaveValue('Check this evidence');
		await viewer.getByRole('button', { name: locale === 'zh-CN' ? '保存 PDF' : 'Save PDF', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.aspdfTest.dirty())).toBe(false);
		expect(await page.evaluate(() => window.aspdfTest.saved())).toEqual({ changed: true, pdf: true });
		await page.evaluate(() => window.aspdfTest.open());
		await expect(viewer.locator('.ash-sessions-pdf-annotation textarea')).toHaveValue('Check this evidence');
		await viewer.locator('.ash-sessions-pdf-annotations > textarea').fill('Unsaved review');
		await viewer.getByRole('button', { name: locale === 'zh-CN' ? '添加便签' : 'Add note', exact: true }).click();
		await expect(viewer.locator('.ash-sessions-pdf-annotation')).toHaveCount(2);
		await page.evaluate(() => window.aspdfTest.externalWrite());
		await viewer.getByRole('button', { name: locale === 'zh-CN' ? '保存 PDF' : 'Save PDF', exact: true }).click();
		await expect(viewer.locator('[role="alert"]')).not.toBeEmpty();
		expect(await page.evaluate(() => window.aspdfTest.dirty())).toBe(true);
		expect(await page.evaluate(() => window.aspdfTest.hasExternalBytes())).toBe(true);
		await page.evaluate(() => window.aspdfTest.revert());
		await expect.poll(() => page.evaluate(() => window.aspdfTest.dirty())).toBe(false);
		await expect(viewer.locator('.ash-sessions-pdf-annotation')).toHaveCount(0);
		await page.evaluate(() => window.aspdfTest.highContrast());
		await testInfo.attach(`aspdf-${locale}`, { body: await page.screenshot(), contentType: 'image/png' });
		await page.evaluate(() => window.aspdfTest.open(true));
		await expect(viewer.getByRole('button', { name: locale === 'zh-CN' ? '添加便签' : 'Add note', exact: true })).toBeDisabled();
		await page.evaluate(() => window.aspdfTest.open());
		await page.evaluate(() => window.aspdfTest.split());
		const first = page.locator('#viewer .ash-sessions-pdf-preview');
		const second = page.locator('#split .ash-sessions-pdf-preview');
		await first.locator('.ash-sessions-pdf-annotations > textarea').fill('Shared review');
		await first.getByRole('button', { name: locale === 'zh-CN' ? '添加便签' : 'Add note', exact: true }).click();
		await expect(second.locator('.ash-sessions-pdf-annotation textarea')).toHaveValue('Shared review');
		await page.evaluate(() => window.aspdfTest.closeFirst());
		await expect(second.locator('.ash-sessions-pdf-text')).toContainText('aspdf native review');
		await second.getByRole('button', { name: locale === 'zh-CN' ? '保存 PDF' : 'Save PDF', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.aspdfTest.dirty())).toBe(false);
		expect(errors).toEqual([]);
	});
}

// Opt-in sustained workload; generate with scripts/pdf-stress.py --generate-only.
test('aspdf sustains a thousand page turns with bounded renderer state', async ({ page }, testInfo) => {
	test.skip(process.env.ASPDF_STRESS !== '1', 'Opt-in performance workload');
	test.setTimeout(600000);
	await page.route('**/__aspdf_bytes', route => route.fulfill({ body: readFileSync('.build/aspdf-perf/corpus/thousand-pages.pdf'), contentType: 'application/pdf' }));
	const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
	const session = await page.context().newCDPSession(page);
	const samples: unknown[] = [];
	const timings: number[] = [];
	try {
		await session.send('Performance.enable');
		await page.goto('/pdfPreview.html');
		await page.waitForFunction(() => !!window.aspdfTest);
		await page.evaluate(() => window.aspdfTest.open());
		const viewer = page.locator('.ash-sessions-pdf-preview');
		for (let number = 1; number <= 1000; number++) {
			const started = performance.now();
			if (number > 1) { await viewer.getByRole('button', { name: 'Next page', exact: true }).click(); }
			await expect(viewer.locator('[role="status"]')).toHaveText(`Page ${number} of 1000`);
			await expect(viewer.locator('.ash-sessions-pdf-text')).toContainText(`page ${String(number).padStart(4, '0')}`);
			await expect(viewer.locator('img')).toHaveJSProperty('naturalWidth', 1200);
			timings.push(performance.now() - started);
			if (number === 100 || number % 250 === 0) {
				await session.send('HeapProfiler.collectGarbage');
				samples.push({ page: number, counters: await session.send('Memory.getDOMCounters'), metrics: await session.send('Performance.getMetrics') });
				await expect(viewer.locator('img')).toHaveCount(1);
				expect(await viewer.locator('.ash-sessions-pdf-text span').count()).toBeLessThan(20000);
			}
		}
		const counters = samples.map(value => (value as { counters: { nodes: number; jsEventListeners: number; }; }).counters);
		expect(counters.at(-1)!.nodes).toBeLessThan(counters[0]!.nodes + 500);
		expect(counters.at(-1)!.jsEventListeners).toBeLessThan(counters[0]!.jsEventListeners + 100);
		await page.evaluate(() => window.aspdfTest.dispose());
		await session.send('HeapProfiler.collectGarbage');
		samples.push({ closed: true, counters: await session.send('Memory.getDOMCounters'), metrics: await session.send('Performance.getMetrics') });
		expect(errors).toEqual([]);
	} finally {
		await testInfo.attach('aspdf-renderer-stress.json', { body: JSON.stringify({ pages: 1000, dimension: 1600, samples, timings, errors }, null, 2), contentType: 'application/json' });
		await session.detach();
	}
});

test('aspdf opens a 42 MiB scanned PDF and saves an annotation', async ({ page }) => {
	test.skip(process.env.ASPDF_STRESS !== '1', 'Opt-in performance workload');
	test.setTimeout(120000);
	await page.route('**/__aspdf_bytes', route => route.fulfill({ body: readFileSync('.build/aspdf-perf/corpus/large-scan.pdf'), contentType: 'application/pdf' }));
	await page.goto('/pdfPreview.html');
	await page.waitForFunction(() => !!window.aspdfTest);
	await page.evaluate(() => window.aspdfTest.open());
	const viewer = page.locator('.ash-sessions-pdf-preview');
	await expect(viewer.locator('img')).toHaveJSProperty('naturalWidth', 1200);
	await viewer.locator('.ash-sessions-pdf-annotations > textarea').fill('Large scan review');
	await viewer.getByRole('button', { name: 'Add note', exact: true }).click();
	await expect(viewer.locator('.ash-sessions-pdf-annotation')).toHaveCount(2);
	await viewer.getByRole('button', { name: 'Save PDF', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.aspdfTest.dirty())).toBe(false);
	await page.evaluate(() => window.aspdfTest.open());
	await expect(viewer.locator('.ash-sessions-pdf-annotation textarea').last()).toHaveValue('Large scan review');
});
