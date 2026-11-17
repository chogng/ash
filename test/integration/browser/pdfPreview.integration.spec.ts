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
	const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'];
	let text = '%PDF-1.4\n'; const offsets: number[] = [];
	for (const [index, object] of objects.entries()) { offsets.push(text.length); text += `${index + 1} 0 obj\n${object}\nendobj\n`; }
	const start = text.length;
	text += `xref\n0 7\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
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
		await expect(viewer).toHaveAttribute('aria-label', /PDF/);
		await expect(viewer.locator('img')).toHaveJSProperty('naturalWidth', 1200);
		await expect(viewer.locator('.ash-sessions-pdf-text')).toContainText('aspdf native review');
		await viewer.getByRole('textbox', { name: locale === 'zh-CN' ? '批注内容' : 'Annotation text' }).fill('Check this evidence');
		await viewer.getByRole('button', { name: locale === 'zh-CN' ? '添加便签' : 'Add note', exact: true }).click();
		await expect(viewer.locator('.ash-sessions-pdf-annotation textarea')).toHaveValue('Check this evidence');
		expect(await page.evaluate(() => window.aspdfTest.dirty())).toBe(true);
		await expect(viewer.getByRole('button', { name: locale === 'zh-CN' ? '撤销' : 'Undo', exact: true })).toHaveCount(0);
		await viewer.locator('.ash-sessions-pdf-page').press('ControlOrMeta+z');
		await expect(viewer.locator('.ash-sessions-pdf-annotation')).toHaveCount(0);
		await viewer.locator('.ash-sessions-pdf-page').press('ControlOrMeta+Shift+z');
		await expect(viewer.locator('.ash-sessions-pdf-annotation textarea')).toHaveValue('Check this evidence');
		await viewer.getByRole('button', { name: locale === 'zh-CN' ? '保存修改' : 'Save changes', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.aspdfTest.dirty())).toBe(false);
		expect(await page.evaluate(() => window.aspdfTest.saved())).toEqual({ changed: true, pdf: true });
		await page.evaluate(() => window.aspdfTest.open());
		await expect(viewer.locator('.ash-sessions-pdf-annotation textarea')).toHaveValue('Check this evidence');
		await viewer.locator('.ash-sessions-pdf-annotations > textarea').fill('Unsaved review');
		await viewer.getByRole('button', { name: locale === 'zh-CN' ? '添加便签' : 'Add note', exact: true }).click();
		await expect(viewer.locator('.ash-sessions-pdf-annotation')).toHaveCount(2);
		await page.evaluate(() => window.aspdfTest.externalWrite());
		await viewer.getByRole('button', { name: locale === 'zh-CN' ? '保存修改' : 'Save changes', exact: true }).click();
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
		await second.getByRole('button', { name: locale === 'zh-CN' ? '保存修改' : 'Save changes', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.aspdfTest.dirty())).toBe(false);
		expect(errors).toEqual([]);
	});
}


for (const locale of ['en', 'zh-CN']) {
	test(`PDF toolbar jumps pages, fits, draws, erases and saves text in ${locale}`, async ({ page }, testInfo) => {
		await page.goto(`/pdfPreview.html?locale=${locale}`);
		await page.waitForFunction(() => !!window.aspdfTest);
		await page.evaluate(() => window.aspdfTest.open());
		const viewer = page.locator('.ash-sessions-pdf-preview');
		const label = (en: string, zh: string) => locale === 'zh-CN' ? zh : en;
		const button = (en: string, zh: string) => viewer.getByRole('button', { name: label(en, zh), exact: true });
		const number = viewer.getByRole('textbox', { name: label('Page number', '页码'), exact: true });
		await expect(number).toHaveValue('1');
		await expect(viewer.locator('.ash-sessions-pdf-pagination')).toHaveText('/2');
		await expect(viewer.locator('.ash-sessions-pdf-brand')).toHaveCount(0);
		await expect(button('Save changes', '保存修改')).toBeDisabled();
		await number.fill('2'); await number.press('Enter');
		await expect(viewer.locator('[role="status"]')).toHaveText(label('Page 2 of 2', '第 2 页，共 2 页'));
		await expect(button('Next page', '下一页')).toBeDisabled();
		for (const invalid of ['0', '3', '1.5', '1e0', '']) {
			await number.fill(invalid); await number.press('Enter'); await expect(number).toHaveValue('2');
		}
		await number.fill('1'); await number.press('Enter');
		await expect(button('Previous page', '上一页')).toBeDisabled();
		const surface = viewer.locator('.ash-sessions-pdf-page');
		const stage = viewer.locator('.ash-sessions-pdf-stage');
		await expect.poll(async () => {
			const bounds = await stage.boundingBox(); const container = await surface.boundingBox();
			return bounds!.height <= container!.height && bounds!.width <= container!.width;
		}).toBe(true);
		const glyph = viewer.locator('.ash-sessions-pdf-text span').first();
		const glyphPosition = async () => {
			const pageBounds = (await stage.boundingBox())!;
			const glyphBounds = (await glyph.boundingBox())!;
			return { x: (glyphBounds.x - pageBounds.x) / pageBounds.width, y: (glyphBounds.y - pageBounds.y) / pageBounds.height };
		};
		const fittedGlyph = await glyphPosition();
		await button('Fit width', '适合宽度').click();
		const width = (await stage.boundingBox())!.width;
		const enlargedGlyph = await glyphPosition();
		expect(enlargedGlyph.x).toBeCloseTo(fittedGlyph.x, 3);
		expect(enlargedGlyph.y).toBeCloseTo(fittedGlyph.y, 3);
		await button('Fit page', '适合页面').click();
		expect((await stage.boundingBox())!.width).toBeLessThan(width);
		await surface.locator('> .ash-scrollbar-viewport').evaluate(element => { element.scrollTop = 0; });
		await viewer.locator('.ash-sessions-pdf-text').evaluate(element => {
			const range = element.ownerDocument.createRange(); range.selectNodeContents(element);
			const selection = element.ownerDocument.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
		});
		await button('Highlight selection', '高亮选区').click();
		await expect(viewer.locator('.ash-sessions-pdf-annotation')).toHaveCount(1);
		await button('Draw', '绘制').click();
		await expect(button('Draw', '绘制')).toHaveAttribute('aria-pressed', 'true');
		const bounds = (await stage.boundingBox())!;
		await page.mouse.move(bounds.x + bounds.width * 0.2, bounds.y + bounds.height * 0.3);
		await page.mouse.down();
		await page.mouse.move(bounds.x + bounds.width * 0.4, bounds.y + bounds.height * 0.35, { steps: 8 });
		await page.mouse.up();
		await expect(viewer.locator('.ash-sessions-pdf-annotation')).toHaveCount(2);
		await button('Erase highlights and drawings', '擦除高亮和绘制笔迹').click();
		await button('Erase drawing', '擦除绘制笔迹').click();
		await expect(viewer.locator('.ash-sessions-pdf-annotation')).toHaveCount(1);
		await button('Draw', '绘制').click();
		await surface.press('Space'); await surface.press('ArrowRight'); await surface.press('ArrowDown'); await surface.press('Enter');
		await expect(viewer.locator('.ash-sessions-pdf-annotation')).toHaveCount(2);
		await button('Erase highlights and drawings', '擦除高亮和绘制笔迹').click();
		await button('Erase drawing', '擦除绘制笔迹').focus(); await page.keyboard.press('Enter');
		await expect(viewer.locator('.ash-sessions-pdf-annotation')).toHaveCount(1);
		await button('Add text box', '添加文本框').click();
		await surface.press('Enter');
		const text = viewer.getByRole('textbox', { name: label('Text box', '文本框'), exact: true });
		await expect(text).toBeFocused();
		await text.fill('Review 文本批注'); await text.press('ControlOrMeta+Enter');
		await expect(viewer.locator('.ash-sessions-pdf-text-editor')).toHaveCount(0);
		await expect(viewer.locator('.ash-sessions-pdf-annotation textarea').last()).toHaveValue('Review 文本批注');
		await button('Save changes', '保存修改').click();
		await expect(button('Save changes', '保存修改')).toBeDisabled();
		await page.evaluate(() => window.aspdfTest.open());
		await expect(viewer.locator('.ash-sessions-pdf-annotation')).toHaveCount(2);
		await expect(viewer.locator('.ash-sessions-pdf-annotation textarea').last()).toHaveValue('Review 文本批注');
		await expect(viewer.locator('.ash-sessions-pdf-text')).toContainText('aspdf native review');
		await button('Erase highlights and drawings', '擦除高亮和绘制笔迹').click();
		await expect(viewer.locator('.ash-sessions-pdf-erase-target')).toHaveCount(1);
		await button('Erase highlight', '擦除高亮').focus(); await page.keyboard.press('Enter');
		await expect(viewer.locator('.ash-sessions-pdf-annotation')).toHaveCount(1);
		await surface.press('Escape');
		await page.setViewportSize({ width: 560, height: 900 });
		const toolbar = viewer.locator('.ash-sessions-pdf-controls');
		const rect = (await toolbar.boundingBox())!;
		for (const action of await toolbar.getByRole('button').all()) {
			const bounds = (await action.boundingBox())!;
			expect(bounds.y + bounds.height).toBeLessThanOrEqual(rect.y + rect.height);
			await expect(action.locator('.ash-button-label')).toBeHidden();
		}
		await testInfo.attach(`pdf-toolbar-${locale}`, { body: await page.screenshot(), contentType: 'image/png' });
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`PDF reading viewport centers native pages and owns scrolling in ${locale}`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 1440, height: 960 });
		await page.goto(`/pdfPreview.html?locale=${locale}`);
		await page.waitForFunction(() => !!window.aspdfTest);
		await page.evaluate(() => window.aspdfTest.open(true));
		await page.evaluate(() => window.aspdfTest.resize(1400, 860));
		const viewer = page.locator('.ash-sessions-pdf-preview');
		const content = viewer.locator('.ash-sessions-pdf-content');
		const reader = viewer.locator('.ash-sessions-pdf-page');
		const viewport = reader.locator('> .ash-scrollbar-viewport');
		const stage = viewer.locator('.ash-sessions-pdf-stage');
		const controls = viewer.locator('.ash-sessions-pdf-controls');
		const fitWidth = () => controls.getByRole('button', { name: locale === 'zh-CN' ? '适合宽度' : 'Fit width', exact: true });
		const fitPage = () => controls.getByRole('button', { name: locale === 'zh-CN' ? '适合页面' : 'Fit page', exact: true });
		const centered = async (): Promise<boolean> => {
			const sheet = (await stage.boundingBox())!;
			const frame = (await viewport.boundingBox())!;
			return Math.abs(sheet.x + sheet.width / 2 - frame.x - frame.width / 2) < 1
				&& Math.abs(sheet.y + sheet.height / 2 - frame.y - frame.height / 2) < 1
				&& sheet.x >= frame.x + 11 && sheet.y >= frame.y + 11
				&& sheet.x + sheet.width <= frame.x + frame.width - 11
				&& sheet.y + sheet.height <= frame.y + frame.height - 11;
		};
		await expect(viewer.locator('.ash-sessions-pdf-annotation-panel')).toBeHidden();
		await expect.poll(centered).toBe(true);
		const container = (await content.boundingBox())!;
		const frame = (await reader.boundingBox())!;
		expect(frame.width).toBeCloseTo(container.width, 0);
		expect(await viewport.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
		await testInfo.attach(`pdf-centered-${locale}`, { body: await page.screenshot(), contentType: 'image/png' });
		if (locale === 'en') {
			for (const scheme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
				await page.evaluate(scheme => window.aspdfTest.colorTheme(scheme), scheme);
				await expect.poll(centered).toBe(true);
				await testInfo.attach(`pdf-paper-${scheme}`, { body: await page.screenshot(), contentType: 'image/png' });
			}
			await page.evaluate(() => window.aspdfTest.colorTheme('dark'));
		}


		await fitWidth().click();
		await expect.poll(() => viewport.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
		const track = reader.locator('> .ash-scrollbar-track-vertical');
		const trackBounds = (await track.boundingBox())!;
		expect(trackBounds.x + trackBounds.width).toBeCloseTo(frame.x + frame.width, 0);
		const toolbarTop = (await controls.boundingBox())!.y;
		await reader.hover(); await page.mouse.wheel(0, 480);
		await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
		expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
		expect((await controls.boundingBox())!.y).toBe(toolbarTop);
		await reader.press('End');
		await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
		await testInfo.attach(`pdf-bottom-${locale}`, { body: await page.screenshot(), contentType: 'image/png' });
		await controls.getByRole('button', { name: locale === 'zh-CN' ? '下一页' : 'Next page', exact: true }).click();
		await expect(viewer.locator('.ash-sessions-pdf-page-number')).toHaveValue('2');
		await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0);
		await reader.press('PageDown');
		await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
		await fitPage().click();
		await expect.poll(centered).toBe(true);
		await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0);

		await page.evaluate(() => window.aspdfTest.resize(560, 480));
		await expect.poll(centered).toBe(true);
		await expect(viewer.locator('.ash-sessions-pdf-annotation-panel')).toBeHidden();
		await testInfo.attach(`pdf-centered-narrow-${locale}`, { body: await page.screenshot(), contentType: 'image/png' });
		await page.evaluate(() => window.aspdfTest.resize(1400, 860));
		await expect.poll(centered).toBe(true);
	});
}

for (const modifier of ['Control', 'Meta'] as const) {
	test(`PDF ${modifier}+wheel zooms at the pointer without zooming the host`, async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 960 });
		await page.goto('/pdfPreview.html');
		await page.waitForFunction(() => !!window.aspdfTest);
		await page.evaluate(() => window.aspdfTest.open(true));
		await page.evaluate(() => window.aspdfTest.resize(1400, 860));
		const viewer = page.locator('.ash-sessions-pdf-preview');
		const reader = viewer.locator('.ash-sessions-pdf-page');
		const viewport = reader.locator('> .ash-scrollbar-viewport');
		const stage = viewer.locator('.ash-sessions-pdf-stage');
		const fitWidth = () => viewer.getByRole('button', { name: 'Fit width', exact: true });
		const fitPage = () => viewer.getByRole('button', { name: 'Fit page', exact: true });
		await fitWidth().click();
		const frame = (await viewport.boundingBox())!;
		const before = (await stage.boundingBox())!;
		const anchor = { x: frame.x + frame.width * 0.6, y: frame.y + frame.height * 0.3 };
		const point = { x: (anchor.x - before.x) / before.width, y: (anchor.y - before.y) / before.height };
		const hostScale = await page.evaluate(() => window.devicePixelRatio);
		const controlsHeight = (await viewer.locator('.ash-sessions-pdf-controls').boundingBox())!.height;
		await page.mouse.move(anchor.x, anchor.y);
		await page.keyboard.down(modifier);
		try { await page.mouse.wheel(0, -120); } finally { await page.keyboard.up(modifier); }
		await expect.poll(async () => (await stage.boundingBox())!.width).toBeGreaterThan(before.width);
		const enlarged = (await stage.boundingBox())!;
		expect(Math.abs(enlarged.x + enlarged.width * point.x - anchor.x)).toBeLessThan(1.5);
		expect(Math.abs(enlarged.y + enlarged.height * point.y - anchor.y)).toBeLessThan(1.5);
		expect(await viewport.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
		expect(await page.evaluate(() => window.devicePixelRatio)).toBe(hostScale);
		expect((await viewer.locator('.ash-sessions-pdf-controls').boundingBox())!.height).toBe(controlsHeight);
		const scrollBefore = await viewport.evaluate(element => element.scrollTop);
		await page.mouse.wheel(0, 120);
		await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(scrollBefore);
		expect((await stage.boundingBox())!.width).toBeCloseTo(enlarged.width, 1);
		await page.keyboard.down(modifier);
		try { await page.mouse.wheel(0, 120); } finally { await page.keyboard.up(modifier); }
		await expect.poll(async () => (await stage.boundingBox())!.width).toBeLessThan(enlarged.width);
		await fitPage().click();
		await expect.poll(() => viewport.evaluate(element => element.scrollLeft + element.scrollTop)).toBe(0);

		await reader.press('Control+0');
		await expect.poll(async () => (await stage.boundingBox())!.width).toBeCloseTo(400, 1);
		await reader.press('Control+=');
		await expect.poll(async () => (await stage.boundingBox())!.width).toBeGreaterThan(400);
		await reader.press('Control+-');
		await expect.poll(async () => (await stage.boundingBox())!.width).toBeCloseTo(400, 1);
		await reader.press('Control+0');
		const batched = await reader.evaluate(async element => {
			const stage = element.querySelector<HTMLElement>('.ash-sessions-pdf-stage')!;
			const before = stage.offsetWidth;
			for (const deltaY of [-10, -20]) element.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY, bubbles: true, cancelable: true, clientX: 400, clientY: 400 }));
			const immediate = stage.offsetWidth;
			await new Promise(resolve => requestAnimationFrame(resolve));
			return { before, immediate, after: stage.getBoundingClientRect().width };
		});
		expect(batched.immediate).toBe(batched.before);
		expect(batched.after).toBeCloseTo(400 * Math.exp(30 * 0.002), 1);
		await reader.evaluate(async element => {
			element.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -120, bubbles: true, cancelable: true }));
			element.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true, cancelable: true }));
			await new Promise(resolve => requestAnimationFrame(resolve));
		});
		await expect.poll(async () => (await stage.boundingBox())!.width).toBeCloseTo(400, 1);
		await page.evaluate(() => window.aspdfTest.resize(900, 600));
		expect((await stage.boundingBox())!.width).toBeCloseTo(400, 1);
		await reader.dispatchEvent('wheel', { ctrlKey: true, deltaY: -3, deltaMode: 1, clientX: anchor.x, clientY: anchor.y });
		await expect.poll(async () => (await stage.boundingBox())!.width).toBeGreaterThan(400);
		for (let index = 0; index < 12; index++) { await reader.dispatchEvent('wheel', { ctrlKey: true, deltaY: -10000 }); }
		await expect.poll(async () => (await stage.boundingBox())!.width).toBeCloseTo(3200, 1);
		await expect(stage.locator('img')).toHaveJSProperty('naturalHeight', 2048);
		for (let index = 0; index < 20; index++) { await reader.dispatchEvent('wheel', { ctrlKey: true, deltaY: 10000 }); }
		await expect.poll(async () => (await stage.boundingBox())!.width).toBeCloseTo(40, 1);
		await expect(viewer.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
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
	await viewer.getByRole('button', { name: 'Save changes', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.aspdfTest.dirty())).toBe(false);
	await page.evaluate(() => window.aspdfTest.open());
	await expect(viewer.locator('.ash-sessions-pdf-annotation textarea').last()).toHaveValue('Large scan review');
});
