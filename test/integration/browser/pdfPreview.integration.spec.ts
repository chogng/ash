import { test, expect, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { globSync, readFileSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { createInterface } from 'node:readline';

let binary: string;
let worker: ChildProcessWithoutNullStreams;
let sequence = 0;
const pending = new Map<number, (reply: unknown) => void>();

function pdf(pageCount = 2, landscapePage?: number, stream = 'BT /F1 18 Tf 30 220 Td (aspdf native review) Tj ET', firstPageAnnotations: readonly string[] = [], withOutline = false): Buffer {
	const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'];
	for (let number = 3; number <= pageCount; number++) { objects.push(objects[2]); }
	if (landscapePage !== undefined) {
		const index = landscapePage === 1 ? 2 : landscapePage + 3;
		objects[index] = objects[index].replace('300 400', '600 300');
	}
	objects[1] = `<< /Type /Pages /Kids [3 0 R ${Array.from({ length: pageCount - 1 }, (_, index) => `${index + 6} 0 R`).join(' ')}] /Count ${pageCount} >>`;
	if (firstPageAnnotations.length) {
		const refs = firstPageAnnotations.map((_, index) => `${objects.length + index + 1} 0 R`).join(' ');
		objects[2] = objects[2].replace(/>>$/, `/Annots [${refs}] >>`);
		objects.push(...firstPageAnnotations);
	}
	if (withOutline) {
		const root = objects.length + 1;
		objects[0] = objects[0].replace(/>>$/, `/Outlines ${root} 0 R >>`);
		objects.push(
			`<< /Type /Outlines /First ${root + 1} 0 R /Last ${root + 5} 0 R /Count 5 >>`,
			`<< /Title (Introduction) /Parent ${root} 0 R /Next ${root + 2} 0 R /Dest [3 0 R /Fit] >>`,
			`<< /Title (Results) /Parent ${root} 0 R /Prev ${root + 1} 0 R /Next ${root + 5} 0 R /First ${root + 3} 0 R /Last ${root + 4} 0 R /Count 2 >>`,
			`<< /Title (Section start) /Parent ${root + 2} 0 R /Next ${root + 4} 0 R /Dest [6 0 R /Fit] >>`,
			`<< /Title (Lower section) /Parent ${root + 2} 0 R /Prev ${root + 3} 0 R /A << /S /GoTo /D [6 0 R /XYZ 0 220 null] >> >>`,
			`<< /Title (External reference) /Parent ${root} 0 R /Prev ${root + 2} 0 R /A << /S /URI /URI (https://example.com) >> >>`,
		);
	}
	let text = '%PDF-1.4\n'; const offsets: number[] = [];
	for (const [index, object] of objects.entries()) { offsets.push(text.length); text += `${index + 1} 0 obj\n${object}\nendobj\n`; }
	const start = text.length;
	text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
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
	await routePdfFixture(page);
});

async function routePdfFixture(page: Page): Promise<void> {
	await page.route('**/__aspdf_bytes', route => route.fulfill({ body: pdf(), contentType: 'application/pdf' }));
	await page.route('**/__aspdf_rpc', async route => {
		const request = route.request().postDataJSON(); const id = ++sequence;
		const reply = await new Promise<Record<string, unknown>>(resolve => {
			pending.set(id, value => resolve(value as Record<string, unknown>));
			worker.stdin.write(JSON.stringify({ ...request, id }) + '\n');
		});
		await route.fulfill({ json: { ...reply, id: request.id } });
	});
}

test.afterEach(async ({ page }) => {
	await page.evaluate(() => window.aspdfTest?.dispose()).catch(() => undefined);
	worker.stdin.end();
	await new Promise<void>(resolve => { if (worker.exitCode !== null) { resolve(); } else { worker.once('exit', () => resolve()); } });
	pending.clear();
});

test('A tool PDF restores unsaved annotations after its renderer crashes', async ({ page, context }) => {
	await page.goto('/pdfPreview.html?locale=zh-CN');
	await page.waitForFunction(() => !!window.aspdfTest);
	const resource = await page.evaluate(() => window.aspdfTest.openToolResponse());
	const viewer = page.getByRole('region', { name: 'PDF — tool-report.pdf' });
	const noteInput = viewer.getByRole('textbox', { name: '批注内容' });
	const addNote = viewer.getByRole('button', { name: '添加便签', exact: true });
	await noteInput.fill('放弃的批注');
	await addNote.click();
	await expect(viewer.locator('.ash-sessions-pdf-annotation textarea')).toHaveValue('放弃的批注');
	const hasBackup = (contents?: string) => page.evaluate(({ resource, contents }) => window.aspdfTest.hasBackup(resource, contents), { resource, contents });
	await expect.poll(() => hasBackup('放弃的批注')).toBe(true);
	await page.evaluate(() => { window.aspdfTest.retireToolResponse(); return window.aspdfTest.revert(); });
	await expect(viewer.locator('.ash-sessions-pdf-annotation')).toHaveCount(0);
	await expect.poll(() => hasBackup()).toBe(false);
	await noteInput.fill('崩溃前的批注');
	await addNote.click();
	await expect(viewer.getByRole('button', { name: '保存副本', exact: true })).toBeEnabled();
	await expect.poll(() => hasBackup('崩溃前的批注')).toBe(true);
	const debuggerSession = await context.newCDPSession(page);
	const crashed = page.waitForEvent('crash');
	void debuggerSession.send('Page.crash').catch(() => undefined);
	await crashed;

	const reopened = await context.newPage();
	try {
		await routePdfFixture(reopened);
		await reopened.goto('/pdfPreview.html?locale=zh-CN');
		await reopened.waitForFunction(() => !!window.aspdfTest);
		await reopened.evaluate(() => window.aspdfTest.restoreWorkspace());
		const restored = reopened.getByRole('region', { name: 'PDF — tool-report.pdf' });
		await expect(restored.locator('.ash-sessions-pdf-text')).toContainText('aspdf native review');
		await expect(restored.locator('.ash-sessions-pdf-annotation textarea')).toHaveValue('崩溃前的批注');
		expect(await reopened.evaluate(() => window.aspdfTest.errors())).toEqual([]);
		await restored.getByRole('button', { name: '保存副本', exact: true }).click();
		await expect.poll(() => reopened.evaluate(resource => window.aspdfTest.hasBackup(resource), resource)).toBe(false);
		await reopened.evaluate(() => window.aspdfTest.open(false, 'review-copy.pdf'));
		await expect(reopened.locator('.ash-sessions-pdf-annotation textarea')).toHaveValue('崩溃前的批注');
	} finally {
		await reopened.evaluate(() => window.aspdfTest?.dispose()).catch(() => undefined);
		await reopened.close();
	}
});

test('PDF keeps the original error when navigation creation fails', async ({ page }) => {
	await page.goto('/pdfPreview.html');
	await page.waitForFunction(() => !!window.aspdfTest);
	const failure = await page.evaluate(async () => {
		const append = Element.prototype.append;
		Element.prototype.append = function (this: Element, ...nodes: (Node | string)[]) {
			if (this.classList.contains('ash-sessions-pdf-navigation-pane')) { throw new Error('PDF navigation creation failed'); }
			append.apply(this, nodes);
		};
		try {
			await window.aspdfTest.createWithPaneHost();
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		} finally {
			Element.prototype.append = append;
		}
	});
	expect(failure).toBe('PDF navigation creation failed');
	await expect(page.locator('.ash-editor-pane-host')).toHaveCount(0);
	await page.evaluate(() => window.aspdfTest.open(true));
	await expect(page.getByRole('region', { name: 'PDF — review.pdf' }).getByRole('status')).toHaveText('Page 1 of 2');
});

test('PDF thumbnails open beside the document and follow page navigation', async ({ page }) => {
	await page.route('**/__aspdf_bytes', route => route.fulfill({ body: pdf(24, 2), contentType: 'application/pdf' }));
	const thumbnailRequests: number[] = [];
	await page.route('**/__aspdf_rpc', route => {
		const request = route.request().postDataJSON();
		if (['pdf/page', 'pdf/renderPage'].includes(request.method) && request.params.dimension === 256) {
			thumbnailRequests.push(request.params.page);
		}
		return route.fallback();
	});
	await page.goto('/pdfPreview.html?locale=zh-CN');
	await page.waitForFunction(() => !!window.aspdfTest);
	await page.evaluate(() => window.aspdfTest.open(true));
	const viewer = page.locator('.ash-sessions-pdf-preview');
	const toolbar = viewer.locator('.ash-sessions-pdf-controls');
	const toggle = toolbar.getByRole('button', { name: 'PDF 页面导航', exact: true });
	const rail = viewer.locator('.ash-sessions-pdf-navigation-pane');
	const list = rail.getByRole('listbox', { name: '页面缩略图', exact: true });
	const option = (number: number) => list.getByRole('option', { name: `第 ${number} 页`, exact: true });
	const input = viewer.locator('.ash-sessions-pdf-page-number');
	const reader = viewer.locator('.ash-sessions-pdf-continuous');
	await expect(reader).toBeVisible();
	await expect(toolbar.getByRole('button').first()).toHaveAccessibleName('PDF 页面导航');
	await expect(toggle.locator('.ash-icon-list-unordered')).toBeVisible();
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(rail).toBeHidden();
	expect(thumbnailRequests).toEqual([]);

	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	await expect(list).toBeVisible();
	await expect(option(1)).toHaveAttribute('aria-selected', 'true');
	await expect(option(1).locator('img')).toHaveJSProperty('naturalWidth', 192);
	await expect(option(2).locator('img')).toHaveJSProperty('naturalWidth', 256);
	for (const pageNumber of [1, 2]) {
		const row = option(pageNumber);
		const image = row.locator('> img');
		const [rowBounds, labelBounds, imageMetrics] = await Promise.all([
			row.boundingBox(), row.locator('> .ash-sessions-pdf-thumbnail-number').boundingBox(),
			image.evaluate((element: HTMLImageElement) => {
				const { top, bottom, width, height } = element.getBoundingClientRect();
				const style = getComputedStyle(element);
				const contentWidth = width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
				const contentHeight = height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
				return {
					top, bottom,
					contentRatio: contentWidth / contentHeight,
					intrinsicRatio: element.naturalWidth / element.naturalHeight,
				};
			}),
		]);
		expect(imageMetrics.top).toBeGreaterThan(rowBounds!.y);
		expect(imageMetrics.bottom).toBeLessThan(labelBounds!.y);
		expect(labelBounds!.y + labelBounds!.height).toBeLessThan(rowBounds!.y + rowBounds!.height);
		expect(imageMetrics.contentRatio).toBeCloseTo(imageMetrics.intrinsicRatio, 2);
	}
	const tabs = rail.getByRole('tablist', { name: 'PDF 页面导航' });
	const thumbnails = tabs.getByRole('tab', { name: '缩略图', exact: true });
	const outline = tabs.getByRole('tab', { name: '目录', exact: true });
	await expect(thumbnails).toHaveAttribute('aria-selected', 'true');
	await thumbnails.press('ArrowRight');
	await expect(outline).toBeFocused();
	await outline.press('Enter');
	const emptyOutline = rail.getByRole('tabpanel', { name: '目录', exact: true });
	await expect(emptyOutline).toBeVisible();
	await expect(emptyOutline).toBeEmpty();
	await outline.press('Tab');
	await expect(emptyOutline).toBeFocused();
	await thumbnails.click();
	await expect(list).toBeVisible();
	await expect(option(3).locator('.ash-sessions-pdf-thumbnail-number')).toHaveText('3');
	expect(await list.getByRole('option').count()).toBeLessThan(24);
	expect(thumbnailRequests.length).toBeLessThan(24);
	const railBounds = (await rail.boundingBox())!;
	const readerBounds = (await reader.boundingBox())!;
	expect(railBounds.x + railBounds.width).toBeCloseTo(readerBounds.x, 0);

	await option(3).click();
	await expect(input).toHaveValue('3');
	await expect(viewer.getByRole('status')).toHaveText('第 3 页，共 24 页');
	await expect(option(3)).toHaveAttribute('aria-selected', 'true');
	await reader.locator('> .ash-scrollbar-viewport').evaluate(element => { element.scrollTop = 0; });
	await expect(input).toHaveValue('1');
	await expect(option(1)).toHaveAttribute('aria-selected', 'true');
	await expect(option(3)).toHaveAttribute('aria-selected', 'false');

	await list.press('End');
	await expect(viewer.getByRole('status')).toHaveText('第 24 页，共 24 页');
	await expect(option(24)).toHaveAttribute('aria-selected', 'true');
	await list.press('Escape');
	await expect(rail).toBeHidden();
	await expect(rail.locator('img')).toHaveCount(0);
	await expect(toggle).toBeFocused();

	await page.evaluate(() => window.aspdfTest.setScrollMode('paged'));
	await expect(reader).toHaveCount(0);
	await expect(viewer).toHaveAttribute('aria-busy', 'false');
	await toggle.click();
	await expect(option(24)).toHaveAttribute('aria-selected', 'true');
	await list.press('Home');
	await expect(viewer.getByRole('status')).toHaveText('第 1 页，共 24 页');
	await expect(option(1)).toHaveAttribute('aria-selected', 'true');
});

for (const mode of ['continuous', 'paged']) {
	test(`PDF shows the latest thumbnail while the native raster is pending in ${mode} mode`, async ({ page }) => {
		await page.route('**/__aspdf_bytes', route => route.fulfill({ body: pdf(16, 9), contentType: 'application/pdf' }));
		await page.goto(`/pdfPreview.html?scrollMode=${mode}`);
		await page.waitForFunction(() => !!window.aspdfTest);
		await page.evaluate(() => window.aspdfTest.open(true));
		const viewer = page.locator('.ash-sessions-pdf-preview');
		const status = viewer.getByRole('status');
		const rail = viewer.locator('.ash-sessions-pdf-thumbnails');
		await viewer.getByRole('button', { name: 'PDF page navigation', exact: true }).click();
		await rail.locator('> .ash-scrollbar-viewport').evaluate(element => { element.scrollTop = 7 * 184; });
		const option = (number: number) => rail.getByRole('option', { name: `Page ${number}`, exact: true });
		await expect(option(8).locator('img')).toHaveJSProperty('naturalHeight', 256);
		await expect(option(9).locator('img')).toHaveJSProperty('naturalWidth', 256);
		const readingArea = viewer.locator('.ash-sessions-pdf-reading-area');
		const preview = readingArea.locator('.ash-sessions-pdf-page-thumbnail:visible');
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		let firstRasterPending = false;
		await page.route('**/__aspdf_rpc', async route => {
			const { method, params } = route.request().postDataJSON();
			if (['pdf/page', 'pdf/renderPage'].includes(method) && params.page >= 8 && params.dimension === 1600) {
				if (params.page === 8) { firstRasterPending = true; }
				await gate;
			}
			await route.fallback();
		});
		try {
			await option(8).click();
			await expect(preview).toHaveJSProperty('width', 192);
			await expect.poll(() => firstRasterPending).toBe(true);
			await option(9).click();
			await expect(preview).toHaveJSProperty('width', 256);
			await expect(preview).toBeInViewport();
			const bounds = (await preview.boundingBox())!;
			expect(bounds.width / bounds.height).toBeCloseTo(2, 2);
			await expect(status).toHaveText('Page 1 of 16');
			await expect(viewer).toHaveAttribute('aria-busy', 'true');
			// Removing the sidebar releases its object URLs while the main preview is still needed.
			await viewer.getByRole('button', { name: 'PDF page navigation', exact: true }).click();
			await expect(preview).toBeInViewport();
		} finally { release(); }
		await expect(status).toHaveText('Page 9 of 16');
		const full = readingArea.locator('[data-page-number="9"] > img');
		await expect(full).toHaveJSProperty('naturalWidth', 1600);
		await expect(full).toBeInViewport();
		await expect(preview).toHaveCount(0);
		await expect(viewer).toHaveAttribute('aria-busy', 'false');
		expect(await page.evaluate(() => window.aspdfTest.errors())).toEqual([]);
	});
}

test('PDF navigation reports outline and thumbnail failures without disabling page links', async ({ page }) => {
	await page.route('**/__aspdf_rpc', route => {
		const request = route.request().postDataJSON();
		if (request.method === 'pdf/outline' || request.params.dimension === 256) {
			return route.fulfill({ json: { id: request.id, error: { code: -32170, message: 'PdfNotFound', data: { kind: 'PdfNotFound' } } } });
		}
		return route.fallback();
	});
	await page.goto('/pdfPreview.html?locale=zh-CN&scrollMode=paged');
	await page.waitForFunction(() => !!window.aspdfTest);
	await page.evaluate(() => window.aspdfTest.open());
	const viewer = page.locator('.ash-sessions-pdf-preview');
	await viewer.getByRole('button', { name: 'PDF 页面导航', exact: true }).click();
	const errors = () => page.evaluate(() => window.aspdfTest.errors().sort());
	const expected = ['无法加载 PDF 目录：PdfNotFound', '无法加载 PDF 缩略图：PdfNotFound'].sort();
	await expect.poll(errors).toEqual(expected);
	await viewer.getByRole('option', { name: '第 2 页', exact: true }).click();
	await expect(viewer).toHaveAttribute('aria-busy', 'false');
	await expect(viewer.locator('.ash-sessions-pdf-page-number')).toHaveValue('2');
	expect(await errors()).toEqual(expected);
});

test('PDF thumbnail navigation retains the selected page when the view reaches the scroll limit', async ({ page }) => {
	await page.goto('/pdfPreview.html');
	await page.waitForFunction(() => !!window.aspdfTest);
	await page.evaluate(async () => {
		window.aspdfTest.resize(440, 1040);
		await window.aspdfTest.open(true);
	});
	const viewer = page.locator('.ash-sessions-pdf-preview');
	const reader = viewer.locator('.ash-sessions-pdf-continuous');
	const viewport = reader.locator('> .ash-scrollbar-viewport');
	await expect(reader).toBeVisible();
	await viewer.getByRole('button', { name: 'PDF page navigation', exact: true }).click();
	const secondPage = viewer.getByRole('option', { name: 'Page 2', exact: true });
	await secondPage.click();
	await expect(viewer.getByRole('status')).toHaveText('Page 2 of 2');
	await expect.poll(() => viewport.evaluate(element => {
		const row = element.querySelector('.ash-sessions-pdf-stage[data-page-number="2"]')!;
		return element.scrollTop > 0 &&
			element.scrollHeight - element.scrollTop - element.clientHeight < 2 &&
			row.getBoundingClientRect().top - element.getBoundingClientRect().top > element.clientHeight * 0.35;
	})).toBe(true);
	await expect(secondPage).toHaveAttribute('aria-selected', 'true');
	await viewport.evaluate(element => { element.scrollTop = 0; });
	await expect(viewer.getByRole('option', { name: 'Page 1', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('PDF outline switches with thumbnails and opens nested chapter destinations', async ({ page }) => {
	await page.route('**/__aspdf_bytes', route => route.fulfill({ body: pdf(3, undefined, undefined, [], true), contentType: 'application/pdf' }));
	await page.goto('/pdfPreview.html?locale=zh-CN');
	await page.waitForFunction(() => !!window.aspdfTest);
	await page.evaluate(() => window.aspdfTest.open(true));
	const viewer = page.locator('.ash-sessions-pdf-preview');
	const toggle = viewer.getByRole('button', { name: 'PDF 页面导航', exact: true });
	const tabs = viewer.getByRole('tablist', { name: 'PDF 页面导航' });
	const thumbnails = tabs.getByRole('tab', { name: '缩略图' });
	const outline = tabs.getByRole('tab', { name: '目录' });
	const tree = viewer.getByRole('tree', { name: '目录' });
	const reader = viewer.locator('.ash-sessions-pdf-continuous');
	const viewport = reader.locator('> .ash-scrollbar-viewport');
	const input = viewer.locator('.ash-sessions-pdf-page-number');

	await expect(tabs).toBeHidden();
	await toggle.click();
	await expect(thumbnails).toHaveAttribute('aria-selected', 'true');
	await expect(viewer.getByRole('tree', { includeHidden: true })).toHaveCount(0);
	await thumbnails.press('ArrowRight');
	await expect(outline).toBeFocused();
	await outline.press('Enter');
	await expect(outline).toHaveAttribute('aria-selected', 'true');
	await expect(viewer.getByRole('tabpanel', { name: '目录' })).toBeVisible();
	await expect(viewer.getByRole('listbox', { name: '页面缩略图' })).toBeHidden();

	const results = tree.getByRole('treeitem', { name: 'Results', exact: true });
	const lower = tree.getByRole('treeitem', { name: 'Lower section', exact: true });
	await expect(results).toHaveAttribute('aria-expanded', 'true');
	await expect(lower).toHaveAttribute('aria-level', '2');
	await expect(tree.getByRole('treeitem', { name: 'External reference' })).toHaveCount(0);
	await results.click();
	await expect(results).toHaveAttribute('aria-expanded', 'false');
	await expect(lower).toBeHidden();
	await results.click();
	await viewer.getByRole('button', { name: '适合宽度', exact: true }).click();
	await tree.getByRole('treeitem', { name: 'Section start' }).click();
	await expect(input).toHaveValue('2');

	const pageOffset = (scrollport = viewport) => scrollport.evaluate(element => {
		const stage = element.querySelector('.ash-sessions-pdf-stage[data-page-number="2"]')!;
		const bounds = stage.getBoundingClientRect();
		return (element.getBoundingClientRect().top - bounds.top) / bounds.height;
	});
	await expect.poll(() => pageOffset()).toBeLessThan(0.05);
	await lower.click();
	await expect.poll(() => pageOffset()).toBeCloseTo(0.45, 1);
	await expect(input).toHaveValue('2');

	await thumbnails.click();
	await expect(tree).toBeHidden();
	await expect(viewer.getByRole('option', { name: '第 2 页', exact: true })).toHaveAttribute('aria-selected', 'true');
	await outline.click();
	await tree.getByRole('treeitem', { name: 'Section start' }).click();
	await tree.press('Home');
	await expect(input).toHaveValue('2');
	await tree.press('Enter');
	await expect(input).toHaveValue('1');
	await tree.press('Escape');
	await expect(tabs).toBeHidden();
	await expect(toggle).toBeFocused();

	await page.evaluate(() => window.aspdfTest.resize(1280, 520));
	await page.evaluate(() => window.aspdfTest.setScrollMode('paged'));
	await expect(reader).toHaveCount(0);
	await expect(viewer).toHaveAttribute('aria-busy', 'false');
	await toggle.click();
	await expect(outline).toHaveAttribute('aria-selected', 'true');
	await tree.getByRole('treeitem', { name: 'Section start' }).click();
	const pagedViewport = viewer.locator('.ash-sessions-pdf-reading-area > .ash-scrollable-element > .ash-scrollbar-viewport');
	await expect(viewer.getByRole('status')).toHaveText('第 2 页，共 3 页');
	await expect.poll(() => pageOffset(pagedViewport)).toBeLessThan(0.05);
	await lower.click();
	await expect.poll(() => pageOffset(pagedViewport)).toBeCloseTo(0.45, 1);
});

test('PDF links stay in the document without appearing in the annotation panel', async ({ page }) => {
	const bytes = pdf(2, undefined, undefined, [
		'<< /Type /Annot /Subtype /Link /Rect [30 220 123 240] /Dest [6 0 R /Fit] >>',
		'<< /Type /Annot /Subtype /Link /Rect [125 220 190 240] /Contents (Citation link) /A << /S /URI /URI (https://example.com) >> >>',
	]);
	await page.route('**/__aspdf_bytes', route => route.fulfill({ body: bytes, contentType: 'application/pdf' }));
	await page.goto('/pdfPreview.html?scrollMode=paged');
	await page.waitForFunction(() => !!window.aspdfTest);
	await page.evaluate(() => window.aspdfTest.open(true));
	const viewer = page.locator('.ash-sessions-pdf-preview');
	const panel = viewer.locator('.ash-sessions-pdf-annotation-panel');
	const annotations = panel.locator('.ash-sessions-pdf-annotation');
	await expect(viewer.getByRole('status')).toHaveText('Page 1 of 2');
	await expect(panel).toBeVisible();
	await expect(annotations).toHaveCount(0);

	await page.evaluate(() => window.aspdfTest.open());
	await panel.getByRole('textbox', { name: 'Annotation text' }).fill('Review note');
	await viewer.getByRole('button', { name: 'Add note', exact: true }).click();
	const note = annotations.getByRole('textbox');
	await expect(note).toHaveValue('Review note');
	await note.fill('Updated review note');
	await annotations.getByRole('button', { name: 'Update', exact: true }).click();
	await viewer.getByRole('button', { name: 'Save changes', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.aspdfTest.dirty())).toBe(false);

	const rendered = page.waitForResponse(response => response.url().endsWith('/__aspdf_rpc') &&
		['pdf/page', 'pdf/renderPage'].includes(response.request().postDataJSON().method));
	await page.evaluate(() => window.aspdfTest.open(true));
	const { result } = await (await rendered).json();
	expect(result.annotations.map(({ kind, contents }: { kind: string; contents: string; }) => ({ kind, contents }))).toEqual([
		{ kind: 'Link', contents: '' },
		{ kind: 'Link', contents: 'Citation link' },
		{ kind: 'Text', contents: 'Updated review note' },
	]);
	await expect(panel).toBeVisible();
	await expect(annotations).toHaveCount(1);
	await expect(note).toHaveValue('Updated review note');
	await expect(note).toBeEditable();
});

for (const locale of ['en', 'zh-CN']) {
	test(`PDF defaults to continuous scrolling and remembers the mode for new files in ${locale}`, async ({ page }) => {
		await page.goto(`/pdfPreview.html?locale=${locale}`);
		await page.waitForFunction(() => !!window.aspdfTest);
		await page.evaluate(() => window.aspdfTest.open());
		const viewer = page.locator('.ash-sessions-pdf-preview');
		const continuous = viewer.locator('.ash-sessions-pdf-continuous');
		const mode = viewer.getByRole('button', { name: locale === 'en' ? 'Scroll mode' : '滚动模式', exact: true });
		await expect(continuous).toBeVisible();
		await expect(viewer).toHaveAttribute('aria-busy', 'false');
		await mode.click();
		await page.getByRole('menuitemradio', { name: locale === 'en' ? 'Page scrolling' : '按页滚动', exact: true }).click();
		await expect(continuous).toHaveCount(0);
		const preference = await page.evaluate(() => window.aspdfTest.scrollPreference());
		expect(preference.value).toBe('paged');
		expect(JSON.parse(preference.source)['sessions.pdf.scrollMode']).toBe('paged');
		await page.evaluate(() => window.aspdfTest.open(false, 'second.pdf'));
		await expect(viewer).toHaveAttribute('aria-busy', 'false');
		await expect(continuous).toHaveCount(0);
		// Stale per-file modes cannot override the profile preference.
		await page.evaluate(() => window.aspdfTest.restoreViewState({ page: 2, scrollMode: 'continuous' }));
		await expect(viewer.locator('.ash-sessions-pdf-page-number')).toHaveValue('2');
		await expect(continuous).toHaveCount(0);
		await expect(page.evaluate(() => window.aspdfTest.setScrollMode('invalid'))).rejects.toThrow();
		expect((await page.evaluate(() => window.aspdfTest.scrollPreference())).value).toBe('paged');
		await mode.click();
		await page.getByRole('menuitemradio', { name: locale === 'en' ? 'Continuous scrolling' : '连续滚动', exact: true }).click();
		await expect(continuous).toBeVisible();
		await page.evaluate(() => window.aspdfTest.open(false, 'third.pdf'));
		await expect(continuous).toBeVisible();
		await expect(viewer).toHaveAttribute('aria-busy', 'false');
		await page.evaluate(() => window.aspdfTest.restoreViewState({ page: 2, scrollMode: 'paged' }));
		await expect(viewer.locator('.ash-sessions-pdf-page-number')).toHaveValue('2');
		await expect(continuous).toBeVisible();
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`aspdf reads, annotates, saves and reopens through the native PDF service in ${locale}`, async ({ page }, testInfo) => {
		const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/pdfPreview.html?scrollMode=paged&locale=${locale}`);
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
		const failure = locale === 'zh-CN' ? '无法完成 PDF 操作：' : 'Could not complete the PDF operation: ';
		await expect.poll(() => page.evaluate(() => window.aspdfTest.errors())).toEqual([`${failure}File changed since it was read: file:///fixture/review.pdf`]);
		expect(await page.evaluate(() => window.aspdfTest.dirty())).toBe(true);
		expect(await page.evaluate(() => window.aspdfTest.hasExternalBytes())).toBe(true);
		await page.evaluate(() => window.aspdfTest.revert());
		await expect.poll(() => page.evaluate(() => window.aspdfTest.dirty())).toBe(false);
		await expect(viewer.locator('.ash-sessions-pdf-annotation')).toHaveCount(0);
		await page.evaluate(() => window.aspdfTest.highContrast());
		await testInfo.attach(`aspdf-${locale}`, { body: await page.screenshot(), contentType: 'image/png' });
		await page.evaluate(() => window.aspdfTest.open(true));
		await viewer.locator('.ash-sessions-pdf-annotations > textarea').fill('Copy review');
		await viewer.getByRole('button', { name: locale === 'zh-CN' ? '添加便签' : 'Add note', exact: true }).click();
		await expect(viewer.locator('.ash-sessions-pdf-annotation textarea')).toHaveValue('Copy review');
		await viewer.getByRole('button', { name: locale === 'zh-CN' ? '保存副本' : 'Save a copy', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.aspdfTest.dirty())).toBe(false);
		await page.evaluate(() => window.aspdfTest.open(false, 'review-copy.pdf'));
		await expect(viewer.locator('.ash-sessions-pdf-annotation textarea')).toHaveValue('Copy review');
		await page.evaluate(() => window.aspdfTest.open());
		await expect(viewer.locator('.ash-sessions-pdf-annotation')).toHaveCount(0);
		expect(await page.evaluate(() => window.aspdfTest.hasExternalBytes())).toBe(true);
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
		await page.goto(`/pdfPreview.html?scrollMode=paged&locale=${locale}`);
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
		await expect(viewer.getByRole('status')).toHaveText(label('Page 1 of 2', '第 1 页，共 2 页'));
		await expect(button('Previous page', '上一页')).toBeDisabled();
		const surface = viewer.locator('.ash-sessions-pdf-page');
		const stage = viewer.locator('.ash-sessions-pdf-stage');
		await expect.poll(async () => {
			const bounds = await stage.boundingBox(); const container = await surface.boundingBox();
			return bounds!.height <= container!.height && bounds!.width <= container!.width;
		}).toBe(true);
		const glyph = stage.locator('.ash-sessions-pdf-text span').first();
		const glyphPosition = async () => {
			await expect(glyph).toBeVisible();
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
		await expect.poll(() => page.evaluate(() => window.aspdfTest.dirty())).toBe(false);
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
		await page.goto(`/pdfPreview.html?scrollMode=paged&locale=${locale}`);
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
		const panel = viewer.locator('.ash-sessions-pdf-annotation-panel');
		await expect(panel).toBeVisible();
		await expect.poll(centered).toBe(true);
		const container = (await content.boundingBox())!;
		const frame = (await reader.boundingBox())!;
		expect(frame.width + (await panel.boundingBox())!.width).toBeCloseTo(container.width, 0);
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
		await expect(panel).toBeVisible();
		await testInfo.attach(`pdf-centered-narrow-${locale}`, { body: await page.screenshot(), contentType: 'image/png' });
		await page.evaluate(() => window.aspdfTest.resize(1400, 860));
		await expect.poll(centered).toBe(true);
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`PDF wheel and keyboard turn pages at scroll boundaries in ${locale}`, async ({ page }) => {
		await page.route('**/__aspdf_bytes', route => route.fulfill({ body: pdf(3), contentType: 'application/pdf' }));
		await page.setViewportSize({ width: 1440, height: 960 });
		await page.goto(`/pdfPreview.html?scrollMode=paged&locale=${locale}`);
		await page.waitForFunction(() => !!window.aspdfTest);
		await page.evaluate(readOnly => window.aspdfTest.open(readOnly), locale === 'en');
		await page.evaluate(() => window.aspdfTest.resize(1400, 860));
		const viewer = page.locator('.ash-sessions-pdf-preview');
		const reader = viewer.locator('.ash-sessions-pdf-page');
		const viewport = reader.locator('> .ash-scrollbar-viewport');
		const number = viewer.locator('.ash-sessions-pdf-page-number');
		const rendered = viewer.locator('[role="status"]');
		const status = (number: number) => locale === 'en' ? `Page ${number} of 3` : `第 ${number} 页，共 3 页`;
		await expect(rendered).toHaveText(status(1));
		await reader.hover();
		await page.mouse.wheel(0, -120);
		await expect(number).toHaveValue('1');
		await reader.dispatchEvent('wheel', { deltaY: 120, shiftKey: true });
		await expect(number).toHaveValue('1');
		// Keep one trackpad gesture alive across the async page render.
		await reader.evaluate(async element => {
			for (let index = 0; index < 40; index++) {
				element.dispatchEvent(new WheelEvent('wheel', { deltaY: 20, bubbles: true, cancelable: true }));
				await new Promise(resolve => setTimeout(resolve, 20));
			}
		});
		await expect(rendered).toHaveText(status(2));
		// An idle interval starts a new wheel gesture.
		await page.waitForTimeout(240);
		await page.mouse.wheel(0, 120);
		await expect(rendered).toHaveText(status(3));
		await page.mouse.wheel(0, -120);
		await expect(rendered).toHaveText(status(2));
		await reader.press('PageUp');
		await expect(rendered).toHaveText(status(1));
		await reader.press('PageDown');
		await expect(rendered).toHaveText(status(2));
		await viewer.getByRole('button', { name: locale === 'en' ? 'Fit width' : '适合宽度', exact: true }).click();
		await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(100);
		await reader.hover();
		await page.waitForTimeout(240);
		await page.mouse.wheel(0, 120);
		await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
		await expect(number).toHaveValue('2');
		await reader.press('End');
		await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
		await page.mouse.wheel(0, 120);
		await expect(rendered).toHaveText(status(3));
		await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0);
		await reader.press('PageUp');
		await expect(rendered).toHaveText(status(2));
		await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
		await reader.press('Home');
		await reader.hover();
		await page.mouse.wheel(0, -120);
		await expect(rendered).toHaveText(status(1));
		await reader.press('Home');
		await reader.press('PageUp');
		await expect(number).toHaveValue('1');
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`PDF continuous mode reuses the menu and virtual scrolling in ${locale}`, async ({ page }, testInfo) => {
		await page.route('**/__aspdf_bytes', route => route.fulfill({ body: pdf(20), contentType: 'application/pdf' }));
		await page.setViewportSize({ width: 1440, height: 960 });
		await page.goto(`/pdfPreview.html?scrollMode=paged&locale=${locale}`);
		await page.waitForFunction(() => !!window.aspdfTest);
		await page.evaluate(() => window.aspdfTest.open());
		await page.evaluate(() => window.aspdfTest.resize(1400, 860));
		const viewer = page.locator('.ash-sessions-pdf-preview');
		const mode = viewer.getByRole('button', { name: locale === 'en' ? 'Scroll mode' : '滚动模式', exact: true });
		const continuousLabel = locale === 'en' ? 'Continuous scrolling' : '连续滚动';
		const pagedLabel = locale === 'en' ? 'Page scrolling' : '按页滚动';
		const number = viewer.locator('.ash-sessions-pdf-page-number');
		await expect(mode).toHaveAttribute('aria-haspopup', 'menu');
		await mode.click();
		await expect(page.getByRole('menuitemradio', { name: pagedLabel, exact: true })).toHaveAttribute('aria-checked', 'true');
		await page.getByRole('menuitemradio', { name: continuousLabel, exact: true }).click();
		const continuous = viewer.locator('.ash-sessions-pdf-continuous');
		const viewport = continuous.locator('> .ash-scrollbar-viewport');
		await expect(continuous).toBeVisible();
		await expect(continuous.locator('img').first()).toHaveJSProperty('naturalWidth', 1200);
		await expect(number).toHaveValue('1');
		const frame = (await viewport.boundingBox())!;
		await continuous.hover();
		await page.mouse.wheel(0, frame.height * 0.8);
		await expect(number).toHaveValue('2');
		await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(frame.height * 0.5);
		await expect.poll(async () => {
			const pages = await continuous.locator('.ash-sessions-pdf-stage').evaluateAll(elements => elements.map(element => element.getBoundingClientRect()));
			return pages.filter(rect => rect.bottom > frame.y && rect.top < frame.y + frame.height).length;
		}).toBeGreaterThanOrEqual(2);
		await expect.poll(() => continuous.locator('img').count()).toBeGreaterThanOrEqual(2);
		expect(await continuous.locator('img').count()).toBeLessThan(6);
		await continuous.locator('[data-page-number="1"]').dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0 });
		await expect(number).toHaveValue('1');
		await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		await expect(number).toHaveValue('1');
		await page.mouse.wheel(0, 1);
		await expect(number).toHaveValue('2');
		await testInfo.attach(`pdf-continuous-${locale}`, { body: await page.screenshot(), contentType: 'image/png' });
		await mode.click();
		await expect(page.getByRole('menuitemradio', { name: continuousLabel, exact: true })).toHaveAttribute('aria-checked', 'true');
		await page.getByRole('menuitemradio', { name: pagedLabel, exact: true }).click();
		await expect(continuous).toHaveCount(0);
		await expect(number).toHaveValue('2');
		await expect(viewer.locator('img')).toHaveCount(1);
		await mode.focus(); await mode.press('ArrowDown');
		await page.getByRole('menuitemradio', { name: continuousLabel, exact: true }).click();
		await expect(continuous).toBeVisible();
		await number.fill('20'); await number.press('Enter');
		await expect(continuous.locator('[data-page-number="20"] img')).toHaveJSProperty('naturalWidth', 1200);
		await expect(number).toHaveValue('20');
		await continuous.press('PageUp');
		await expect(number).toHaveValue('19');
		const stage = continuous.locator('[data-page-number="19"]');
		const width = (await stage.boundingBox())!.width;
		await continuous.press('ControlOrMeta+=');
		await expect.poll(async () => (await stage.boundingBox())!.width).toBeGreaterThan(width);
		await viewer.getByRole('textbox', { name: locale === 'en' ? 'Annotation text' : '批注内容', exact: true }).fill('Continuous review');
		await viewer.getByRole('button', { name: locale === 'en' ? 'Add note' : '添加便签', exact: true }).click();
		await expect(viewer.locator('.ash-sessions-pdf-annotation textarea')).toHaveValue('Continuous review');
		await expect(number).toHaveValue('19');
		expect(await continuous.locator('img').count()).toBeLessThan(6);
	});
}

test('PDF selection joins mixed-height glyphs and spaces while preserving lines, columns and native endpoints', async ({ page }) => {
	const stream = 'BT /F1 18 Tf 30 310 Td (ABCidef) Tj -2 Ts (.) Tj 0 Ts [( ) -725 (9)] TJ 135 0 Td (WXYZ) Tj -135 -34 Td (Second lineQ) Tj ET';
	await page.route('**/__aspdf_bytes', route => route.fulfill({ body: pdf(2, undefined, stream), contentType: 'application/pdf' }));
	await page.goto('/pdfPreview.html?scrollMode=paged');
	await page.waitForFunction(() => !!window.aspdfTest);
	await page.evaluate(() => window.aspdfTest.open(true));
	const content = page.locator('.ash-sessions-pdf-text-content');
	await expect(content).toContainText('Second lineQ');
	const expected = await content.evaluate(element => {
		const glyph = (text: string) => Array.from(element.querySelectorAll('span')).find(span => span.textContent === text)!;
		const selection = element.ownerDocument.getSelection()!;
		selection.setBaseAndExtent(glyph('Q').firstChild!, 0, glyph('A').firstChild!, 1);
		return {
			start: parseFloat(glyph('B').style.left), column: parseFloat(glyph('W').style.left),
			end: parseFloat(glyph('Q').style.left), text: selection.toString().replace(/\s/g, ''),
		};
	});
	expect(expected.text).toBe('BCidef.9WXYZSecondline');
	const overlay = page.locator('.ash-sessions-pdf-selection');
	await expect(overlay).toHaveAttribute('aria-hidden', 'true');
	await expect(overlay).toHaveCSS('pointer-events', 'none');
	await expect(overlay).toHaveCSS('mix-blend-mode', 'multiply');
	const bands = overlay.locator('> div');
	await expect(bands).toHaveCount(3);
	const [first, column, last] = await bands.evaluateAll(elements => elements.map(element => {
		const { left, top, width } = (element as HTMLElement).style;
		return { left: parseFloat(left), top: parseFloat(top), right: parseFloat(left) + parseFloat(width) };
	}));
	expect(first.left).toBeCloseTo(expected.start, 3);
	expect(first.right).toBeLessThan(column.left);
	expect(column.left).toBeCloseTo(expected.column, 3);
	expect(last.top).toBeGreaterThan(first.top);
	expect(last.right).toBeLessThan(expected.end);
	await page.evaluate(() => window.aspdfTest.highContrast());
	await expect(overlay).toHaveCSS('mix-blend-mode', 'difference');
	await expect(bands).toHaveCount(3);
	await page.evaluate(() => document.getSelection()?.removeAllRanges());
	await expect(bands).toHaveCount(0);
});

test('PDF selection centers on visible ink when the hidden text layer is offset', async ({ page }) => {
	// The visible ink is four points above the hidden text used for selection.
	const ink = [31, 43, 55, 67, 79].map(x => `${x} 224 8 13 re`).join(' ');
	const stream = `0 g ${ink} f BT /F1 18 Tf 3 Tr 30 220 Td (ABCDE) Tj ET`;
	await page.route('**/__aspdf_bytes', route => route.fulfill({ body: pdf(2, undefined, stream), contentType: 'application/pdf' }));
	await page.goto('/pdfPreview.html?scrollMode=paged');
	await page.waitForFunction(() => !!window.aspdfTest);
	await page.evaluate(() => window.aspdfTest.open(true));
	const content = page.locator('.ash-sessions-pdf-text-content');
	await expect(content).toHaveText('ABCDE');
	const textCenter = await content.evaluate(element => {
		const glyph = element.querySelector('span')!;
		const selection = element.ownerDocument.getSelection()!;
		selection.selectAllChildren(element);
		return (parseFloat(glyph.style.top) + parseFloat(glyph.style.height) / 2) / 100;
	});
	const band = page.locator('.ash-sessions-pdf-selection > div');
	await expect(band).toHaveCount(1);
	const geometry = () => band.evaluate(element => {
		const { top, height, width } = (element as HTMLElement).style;
		return { center: (parseFloat(top) + parseFloat(height) / 2) / 100, width: parseFloat(width) };
	});
	const full = await geometry();
	expect(full.center).toBeCloseTo((400 - 230.5) / 400, 3);
	expect(textCenter - full.center).toBeGreaterThan(0.005);
	await content.evaluate(element => {
		const first = element.querySelector('span')!.firstChild!;
		element.ownerDocument.getSelection()!.setBaseAndExtent(first, 0, first, 1);
	});
	await expect.poll(async () => (await geometry()).width).toBeLessThan(full.width);
	expect((await geometry()).center).toBe(full.center);
});

test('PDF selection toolbar opens on release and routes localized selection actions', async ({ page, context }) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await page.goto('/pdfPreview.html?scrollMode=paged&locale=zh-CN');
	await page.waitForFunction(() => !!window.aspdfTest);
	await page.evaluate(() => window.aspdfTest.open());
	const surface = page.locator('.ash-sessions-pdf-page');
	const glyphs = surface.locator('.ash-sessions-pdf-text-content > span');
	await expect(glyphs.first()).toBeVisible();
	const first = (await glyphs.first().boundingBox())!;
	const last = (await glyphs.last().boundingBox())!;
	const toolbar = page.getByRole('toolbar', { name: 'PDF 选区操作' });
	await page.mouse.move(first.x + 1, first.y + first.height / 2);
	await page.mouse.down();
	await page.mouse.move(last.x + last.width - 1, last.y + last.height / 2, { steps: 8 });
	await expect(toolbar).toBeHidden();
	await page.mouse.up();
	await expect(toolbar).toBeVisible();
	const selected = await page.evaluate(() => {
		const selection = window.getSelection()!;
		return { text: selection.toString(), top: selection.getRangeAt(0).getBoundingClientRect().top };
	});
	expect(selected.text).toContain('native review');
	const popup = (await toolbar.boundingBox())!;
	expect(popup.y + popup.height).toBeLessThan(selected.top);
	const copy = toolbar.getByRole('button', { name: '复制', exact: true });
	await surface.press('Shift+F10');
	await expect(copy).toBeFocused();
	await page.keyboard.press('Enter');
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(selected.text);
	await page.keyboard.press('Escape');
	await expect(toolbar).toBeHidden();
	await expect(surface).toBeFocused();
	expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(selected.text);

	await surface.press('Shift+F10');
	await toolbar.getByRole('button', { name: '用 Ash 翻译', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.aspdfTest.chatDraft()))
		.toContain(`zh-CN。请将选段作为待翻译的原文，只返回译文。\n\n${selected.text}`);

	await surface.press('Shift+F10');
	await toolbar.getByRole('button', { name: '添加评论', exact: true }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByRole('textbox').fill('复核选段');
	await dialog.getByRole('button', { name: '添加评论', exact: true }).click();
	const annotations = page.locator('.ash-sessions-pdf-annotation textarea');
	await expect(annotations).toHaveCount(1);
	await expect(annotations.first()).toHaveValue('复核选段');

	const selectPageText = () => surface.locator('.ash-sessions-pdf-text-content').evaluate(element => {
		element.ownerDocument.getSelection()!.selectAllChildren(element);
	});
	await selectPageText();
	await toolbar.getByRole('button', { name: '高亮', exact: true }).click();
	await expect(annotations).toHaveCount(2);
	await expect(annotations.last()).toHaveValue('aspdf native review');
	await page.getByRole('button', { name: '保存修改', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.aspdfTest.dirty())).toBe(false);

	await page.evaluate(() => window.aspdfTest.open(true));
	await selectPageText();
	await expect(toolbar).toBeVisible();
	await expect(copy).toBeEnabled();
	await expect(toolbar.getByRole('button', { name: '用 Ash 翻译', exact: true })).toBeEnabled();
	await expect(toolbar.getByRole('button', { name: '添加评论', exact: true })).toBeEnabled();
	await expect(toolbar.getByRole('button', { name: '高亮', exact: true })).toBeEnabled();
	await page.getByRole('button', { name: '下一页', exact: true }).click();
	await expect(toolbar).toBeHidden();
});

test('PDF wheel zoom preserves neighboring rasters and text selection, including on a short return scroll', async ({ page }) => {
	await page.route('**/__aspdf_bytes', route => route.fulfill({ body: pdf(60), contentType: 'application/pdf' }));
	const renders: number[] = [];
	page.on('request', request => {
		if (!request.url().endsWith('/__aspdf_rpc')) { return; }
		const rpc = request.postDataJSON();
		if (['pdf/page', 'pdf/renderPage'].includes(rpc.method)) { renders.push(rpc.params.page); }
	});
	await page.goto('/pdfPreview.html');
	await page.waitForFunction(() => !!window.aspdfTest);
	await page.evaluate(() => window.aspdfTest.open(true));
	const reader = page.locator('.ash-sessions-pdf-continuous');
	const viewport = reader.locator('> .ash-scrollbar-viewport');
	const image = (number: number) => reader.locator(`[data-page-number="${number}"] img`);
	const number = page.locator('.ash-sessions-pdf-page-number');
	await number.fill('40'); await number.press('Enter');
	await expect(image(40)).toBeVisible();
	await expect(image(39)).toBeVisible();
	await expect(reader.locator('[data-page-number="40"] .ash-sessions-pdf-text span').first()).toBeAttached();
	const previous = await image(39).elementHandle();
	const previousRenders = renders.filter(number => number === 39).length;
	const zoom = await viewport.evaluate(async element => {
		const row = element.querySelector<HTMLElement>('[data-page-number="40"]')!;
		const text = row.querySelector('span')!.firstChild!;
		const selection = element.ownerDocument.getSelection()!;
		selection.setBaseAndExtent(text, 0, text, text.textContent!.length);
		const selected = selection.toString();
		const before = row.getBoundingClientRect();
		const bounds = element.getBoundingClientRect();
		const x = bounds.left + bounds.width / 2, y = bounds.top + bounds.height / 3;
		for (let frame = 0; frame < 5; frame++) {
			element.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -12, clientX: x, clientY: y, bubbles: true, cancelable: true }));
			await new Promise(resolve => requestAnimationFrame(resolve));
		}
		const after = row.getBoundingClientRect();
		return {
			grew: after.width > before.width, selected, remaining: selection.toString(),
			anchorError: Math.abs(after.y + (y - before.y) * after.height / before.height - y),
		};
	});
	expect(zoom.grew).toBe(true);
	expect(zoom.selected).not.toBe('');
	expect(zoom.remaining).toBe(zoom.selected);
	expect(zoom.anchorError).toBeLessThan(2);
	const selectedPage = reader.locator('[data-page-number="40"]');
	await expect(selectedPage.locator('.ash-sessions-pdf-selection > div')).toHaveCount(1);
	expect(await selectedPage.evaluate(element => {
		const glyph = element.querySelector('.ash-sessions-pdf-text-content > span')!.getBoundingClientRect();
		const band = element.querySelector('.ash-sessions-pdf-selection > div')!.getBoundingClientRect();
		return Math.max(Math.abs(glyph.left - band.left), Math.abs(glyph.width - band.width));
	})).toBeLessThan(1);
	// Page 39 leaves the mounted window, then comes back from the decoded-page cache.
	for (const destination of [42, 39]) {
		await viewport.evaluate((element, page) => { element.scrollTop = (page - 1) * element.scrollHeight / 60; }, destination);
		await expect(number).toHaveValue(String(destination));
		if (destination === 42) { await expect(image(39)).toHaveCount(0); }
	}
	expect(await image(39).evaluate((node, original) => node === original, previous)).toBe(true);
	expect(renders.filter(number => number === 39)).toHaveLength(previousRenders);
});

test('PDF reuses recently visited pages across distant scrolls and releases older rasters', async ({ page }) => {
	await page.route('**/__aspdf_bytes', route => route.fulfill({ body: pdf(60), contentType: 'application/pdf' }));
	const renders: number[] = [];
	page.on('request', request => {
		if (!request.url().endsWith('/__aspdf_rpc')) { return; }
		const { method, params } = request.postDataJSON();
		if (method === 'pdf/page' || method === 'pdf/renderPage') { renders.push(params.page); }
	});
	await page.goto('/pdfPreview.html');
	await page.waitForFunction(() => !!window.aspdfTest);
	await page.evaluate(() => window.aspdfTest.open(true));
	const reader = page.locator('.ash-sessions-pdf-continuous');
	const viewport = reader.locator('> .ash-scrollbar-viewport');
	const image = (number: number) => reader.locator(`[data-page-number="${number}"] img`);
	const scrollTo = async (number: number) => {
		await viewport.evaluate((element, page) => { element.scrollTop = (page - 1) * element.scrollHeight / 60; }, number);
		await expect(page.locator('.ash-sessions-pdf-page-number')).toHaveValue(String(number));
		await expect(image(number)).toHaveJSProperty('complete', true);
	};
	await scrollTo(10);
	const rasterUrl = await image(10).getAttribute('src');
	if (!rasterUrl) { throw new Error('Expected a decoded PDF page'); }
	const requests = () => renders.filter(number => number === 10).length;
	const initialRequests = requests();
	await scrollTo(45);
	await expect(image(10)).toHaveCount(0);
	await scrollTo(10);
	await expect(image(10)).toHaveAttribute('src', rasterUrl);
	expect(requests()).toBe(initialRequests);
	await expect(reader.locator('[data-page-number="10"] .ash-sessions-pdf-text')).toHaveText('aspdf native review');
	for (const number of [16, 22, 28, 34, 40, 46, 52, 58]) { await scrollTo(number); }
	// An evicted raster releases its blob even if another consumer kept the old URL.
	await expect.poll(() => page.evaluate(url => fetch(url).then(response => response.ok, () => false), rasterUrl)).toBe(false);
	await scrollTo(10);
	expect(requests()).toBe(initialRequests + 1);
});

test('PDF prioritizes the visible page after a large scroll and zooms while its raster is pending', async ({ page }) => {
	await page.route('**/__aspdf_bytes', route => route.fulfill({ body: pdf(60), contentType: 'application/pdf' }));
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const renders: number[] = [];
	await page.route('**/__aspdf_rpc', async route => {
		const { method, params } = route.request().postDataJSON();
		if (['pdf/page', 'pdf/renderPage'].includes(method) && params.page >= 40) {
			renders.push(params.page);
			await gate;
		}
		await route.fallback();
	});
	await page.goto('/pdfPreview.html');
	await page.waitForFunction(() => !!window.aspdfTest);
	await page.evaluate(() => window.aspdfTest.open(true));
	const reader = page.locator('.ash-sessions-pdf-continuous');
	const viewport = reader.locator('> .ash-scrollbar-viewport');
	await expect(reader.locator('[data-page-number="1"] img')).toBeVisible();
	await expect(page.locator('.ash-sessions-pdf-preview')).toHaveAttribute('aria-busy', 'false');
	const stage = reader.locator('[data-page-number="45"]');
	try {
		// A discarded image can still be decoding when the reader jumps a second time.
		await viewport.evaluate(element => {
			const decode = HTMLImageElement.prototype.decode;
			HTMLImageElement.prototype.decode = function () {
				HTMLImageElement.prototype.decode = decode;
				element.setAttribute('data-test-decoding', '');
				return new Promise(resolve => element.addEventListener('finish-test-decode', () => resolve(), { once: true }));
			};
			element.scrollTop = 8 * element.scrollHeight / 60;
		});
		await expect(viewport).toHaveAttribute('data-test-decoding', '');
		await viewport.evaluate(element => { element.scrollTop = 44 * element.scrollHeight / 60; });
		await expect.poll(() => renders[0]).toBe(45);
		await expect(stage.locator('img')).toHaveCount(0);
		const before = (await stage.boundingBox())!;
		await viewport.dispatchEvent('wheel', { ctrlKey: true, deltaY: -60, clientX: before.x + before.width / 2, clientY: before.y + before.height / 2 });
		await expect.poll(async () => (await stage.boundingBox())!.width).toBeGreaterThan(before.width);
	} finally {
		release();
		await viewport.dispatchEvent('finish-test-decode');
	}
	await expect(stage.locator('img')).toBeVisible();
	await expect(page.locator('.ash-sessions-pdf-page-number')).toHaveValue('45');
});

test('PDF restores continuous mode after a pending page turn finishes', async ({ page }) => {
	await page.goto('/pdfPreview.html?scrollMode=paged');
	await page.waitForFunction(() => !!window.aspdfTest);
	await page.evaluate(() => window.aspdfTest.open());
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>(resolve => { enter = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	let held = false;
	await page.route('**/__aspdf_rpc', async route => {
		const request = route.request().postDataJSON();
		if (!held && ['pdf/page', 'pdf/renderPage'].includes(request.method) && request.params.page === 2) {
			held = true; enter(); await gate;
		}
		await route.fallback();
	});
	try {
		const number = page.locator('.ash-sessions-pdf-page-number');
		await number.fill('2'); await number.press('Enter');
		await entered;
		await page.evaluate(() => window.aspdfTest.setScrollMode('continuous'));
		await page.evaluate(() => window.aspdfTest.restoreViewState({ page: 2 }));
		release();
		await expect(page.locator('.ash-sessions-pdf-continuous')).toBeVisible();
		await expect(number).toHaveValue('2');
		await expect(page.locator('.ash-sessions-pdf-continuous [data-page-number="2"] img')).toHaveJSProperty('naturalWidth', 1200);
	} finally { release(); }
});

test('PDF defers continuous restoration until the hidden viewport is laid out', async ({ page }) => {
	await page.goto('/pdfPreview.html?scrollMode=paged');
	await page.waitForFunction(() => !!window.aspdfTest);
	await page.evaluate(() => window.aspdfTest.open());
	await page.evaluate(() => window.aspdfTest.resize(0, 0));
	await page.evaluate(() => window.aspdfTest.setScrollMode('continuous'));
	await page.evaluate(() => window.aspdfTest.restoreViewState({ page: 2 }));
	await expect(page.locator('.ash-sessions-pdf-continuous')).toHaveCount(0);
	await page.evaluate(() => window.aspdfTest.resize(1400, 860));
	await expect(page.locator('.ash-sessions-pdf-continuous')).toBeVisible();
	await expect(page.locator('.ash-sessions-pdf-page-number')).toHaveValue('2');
	await expect(page.locator('.ash-sessions-pdf-continuous [data-page-number="2"] img')).toHaveJSProperty('naturalWidth', 1200);
	expect(await page.evaluate(() => window.aspdfTest.errors())).toEqual([]);
});

for (const mode of ['continuous', 'paged']) {
	test(`PDF page failures restore the previous view and allow retry in ${mode} mode`, async ({ page }) => {
		await page.route('**/__aspdf_bytes', route => route.fulfill({ body: pdf(16, 9), contentType: 'application/pdf' }));
		await page.goto(`/pdfPreview.html?locale=zh-CN&scrollMode=${mode}`);
		await page.waitForFunction(() => !!window.aspdfTest);
		await page.evaluate(() => window.aspdfTest.open());
		const viewer = page.locator('.ash-sessions-pdf-preview');
		await viewer.getByRole('button', { name: 'PDF 页面导航', exact: true }).click();
		const rail = viewer.locator('.ash-sessions-pdf-thumbnails');
		const target = rail.getByRole('option', { name: '第 9 页', exact: true });
		const revealThumbnail = async () => {
			await rail.locator('> .ash-scrollbar-viewport').evaluate(element => { element.scrollTop = 8 * 184; });
			await expect(target.locator('img')).toHaveJSProperty('naturalWidth', 256);
		};
		await revealThumbnail();
		let failNextTurn = true;
		await page.route('**/__aspdf_rpc', route => {
			const request = route.request().postDataJSON();
			if (failNextTurn && ['pdf/page', 'pdf/renderPage'].includes(request.method) && request.params.page === 9 && request.params.dimension === 1600) {
				failNextTurn = false;
				return route.fulfill({ json: { id: request.id, error: { code: -32170, message: 'PdfNotFound', data: { kind: 'PdfNotFound' } } } });
			}
			return route.fallback();
		});
		await target.click();
		await expect.poll(() => page.evaluate(() => window.aspdfTest.errors())).toEqual(['无法完成 PDF 操作：PdfNotFound']);
		await expect(viewer.locator('.ash-sessions-pdf-page-number')).toHaveValue('1');
		await expect(viewer.getByRole('alert')).toHaveCount(0);
		await expect(viewer.locator('.ash-sessions-pdf-reading-area [data-page-number="1"] > img:visible')).toBeInViewport();
		await expect(viewer.locator('.ash-sessions-pdf-page-thumbnail')).toHaveCount(0);
		await revealThumbnail();
		await target.click();
		await expect(viewer).toHaveAttribute('aria-busy', 'false');
		await expect(viewer.getByRole('status')).toHaveText('第 9 页，共 16 页');
	});
}

test('PDF continuous mode preserves mixed page sizes and restored reading mode', async ({ page }) => {
	await page.route('**/__aspdf_bytes', route => route.fulfill({ body: pdf(3, 2), contentType: 'application/pdf' }));
	await page.setViewportSize({ width: 1440, height: 960 });
	await page.goto('/pdfPreview.html?scrollMode=paged');
	await page.waitForFunction(() => !!window.aspdfTest);
	await page.evaluate(() => window.aspdfTest.open(true));
	await page.evaluate(() => window.aspdfTest.resize(1400, 860));
	const viewer = page.locator('.ash-sessions-pdf-preview');
	const mode = viewer.getByRole('button', { name: 'Scroll mode', exact: true });
	await mode.click();
	await page.getByRole('menuitemradio', { name: 'Continuous scrolling', exact: true }).click();
	const continuous = viewer.locator('.ash-sessions-pdf-continuous');
	const number = viewer.locator('.ash-sessions-pdf-page-number');
	await number.fill('2'); await number.press('Enter');
	const landscape = continuous.locator('[data-page-number="2"]');
	await expect(landscape.locator('img')).toHaveJSProperty('naturalWidth', 1600);
	await expect.poll(async () => {
		const bounds = (await landscape.boundingBox())!;
		return bounds.width / bounds.height;
	}).toBeCloseTo(2, 2);
	await expect(viewer.getByRole('button', { name: 'Add note', exact: true })).toBeEnabled();
	await continuous.press('Control+0');
	await expect.poll(async () => (await landscape.boundingBox())!.width).toBeCloseTo(800, 1);
	for (let index = 0; index < 3; index++) { await continuous.press('Control+='); }
	const viewport = continuous.locator('> .ash-scrollbar-viewport');
	await expect.poll(() => viewport.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0);
	const frame = (await continuous.boundingBox())!;
	const bounds = (await landscape.boundingBox())!;
	const anchor = { x: frame.x + frame.width * 0.6, y: frame.y + Math.min(bounds.height * 0.3, frame.height * 0.3) };
	const fraction = { x: (anchor.x - bounds.x) / bounds.width, y: (anchor.y - bounds.y) / bounds.height };
	await page.mouse.move(anchor.x, anchor.y);
	await page.keyboard.down('Control');
	try { await page.mouse.wheel(0, -120); } finally { await page.keyboard.up('Control'); }
	await expect.poll(async () => (await landscape.boundingBox())!.width).toBeGreaterThan(bounds.width);
	const enlarged = (await landscape.boundingBox())!;
	expect(Math.abs(enlarged.x + enlarged.width * fraction.x - anchor.x)).toBeLessThan(2);
	expect(Math.abs(enlarged.y + enlarged.height * fraction.y - anchor.y)).toBeLessThan(2);
	const state = await page.evaluate(() => window.aspdfTest.viewState());
	expect(state).toEqual({ page: 2 });
	await page.evaluate(() => window.aspdfTest.open(true));
	await page.evaluate(state => window.aspdfTest.restoreViewState(state), state);
	await expect(continuous).toBeVisible();
	await expect(number).toHaveValue('2');
	await expect(continuous.locator('[data-page-number="2"] img')).toHaveJSProperty('naturalWidth', 1600);
});

for (const modifier of ['Control', 'Meta'] as const) {
	test(`PDF ${modifier}+wheel zooms at the pointer without zooming the host`, async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 960 });
		await page.goto('/pdfPreview.html?scrollMode=paged');
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
		await expect(viewer.getByRole('button', { name: 'Save a copy', exact: true })).toBeDisabled();
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
		await page.goto('/pdfPreview.html?scrollMode=paged');
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
	await page.goto('/pdfPreview.html?scrollMode=paged');
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
