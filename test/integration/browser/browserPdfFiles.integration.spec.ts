import { expect, test } from '@playwright/test';

test('picked-folder saves reject unsupported cross-window locking before creating a file', async ({ page }) => {
	await page.goto('/browserPdfFiles.html');
	await page.evaluate(() => window.ashBrowserPdfFiles.prepareBrowserPdf());
	await page.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
	try {
		expect(await page.evaluate(() => window.ashBrowserPdfFiles.saveBrowserPdf('Unsupported'))).toBe('Unavailable');
		expect((await page.evaluate(() => window.ashBrowserPdfFiles.loadBrowserPdf())).document.annotations).toEqual([]);
	} finally { await page.evaluate(() => Reflect.deleteProperty(navigator, 'locks')); }
});

test('picked-folder PDF first saves reject a second window even when the first absence check is paused', async ({ page, context }) => {
	await page.goto('/browserPdfFiles.html');
	const root = await page.evaluate(() => window.ashBrowserPdfFiles.prepareBrowserPdf());
	const other = await context.newPage();
	try {
		await other.goto('/browserPdfFiles.html');
		await other.evaluate(root => window.ashBrowserPdfFiles.prepareBrowserPdf(root), root);
		expect(await Promise.all([page, other].map(p => p.evaluate(() => window.ashBrowserPdfFiles.loadBrowserPdf())))).toEqual([
			{ document: { version: 1, annotations: [] }, revision: undefined },
			{ document: { version: 1, annotations: [] }, revision: undefined },
		]);
		await page.evaluate(() => window.ashBrowserPdfFiles.pauseBrowserPdf('missing'));
		const first = page.evaluate(() => window.ashBrowserPdfFiles.saveBrowserPdf('First window'));
		await page.evaluate(() => window.ashBrowserPdfFiles.waitBrowserPdfPause());
		let otherSettled = false;
		const second = other.evaluate(() => window.ashBrowserPdfFiles.saveBrowserPdf('Second window')).finally(() => { otherSettled = true; });
		// Wait for either the fixed provider's queued lock or the old provider's completed save.
		await expect.poll(async () => otherSettled || await other.evaluate(async () => (await navigator.locks.query()).pending!.length > 0)).toBe(true);
		await page.evaluate(() => window.ashBrowserPdfFiles.releaseBrowserPdf());
		expect(await Promise.all([first, second])).toEqual(['saved', 'EntryExists']);
		const saved = await other.evaluate(() => window.ashBrowserPdfFiles.loadBrowserPdf());
		expect(saved.document.annotations[0]).toMatchObject({ text: 'First window' });
		expect(await other.evaluate(revision => window.ashBrowserPdfFiles.saveBrowserPdf('Refreshed', revision), saved.revision)).toBe('saved');
		expect(await page.evaluate(revision => window.ashBrowserPdfFiles.saveBrowserPdf('Stale', revision), saved.revision)).toBe('FileRevisionConflictError');
		expect((await page.evaluate(() => window.ashBrowserPdfFiles.loadBrowserPdf())).document.annotations[0]).toMatchObject({ text: 'Refreshed' });
	} finally {
		await page.evaluate(() => window.ashBrowserPdfFiles.releaseBrowserPdf());
		await other.close();
	}
});

test('picked-folder failed creation finishes rollback before another window writes the same file', async ({ page, context }) => {
	await page.goto('/browserPdfFiles.html');
	const root = await page.evaluate(() => window.ashBrowserPdfFiles.prepareBrowserPdf());
	const other = await context.newPage();
	try {
		await other.goto('/browserPdfFiles.html');
		await other.evaluate(root => window.ashBrowserPdfFiles.prepareBrowserPdf(root), root);
		await page.evaluate(() => window.ashBrowserPdfFiles.pauseBrowserPdf('failure'));
		const first = page.evaluate(() => window.ashBrowserPdfFiles.saveBrowserPdf('Failing window'));
		await page.evaluate(() => window.ashBrowserPdfFiles.waitBrowserPdfPause());
		let otherSettled = false;
		const second = other.evaluate(() => window.ashBrowserPdfFiles.overwriteBrowserSidecar()).finally(() => { otherSettled = true; });
		await expect.poll(async () => otherSettled || await other.evaluate(async () => (await navigator.locks.query()).pending!.length > 0)).toBe(true);
		await page.evaluate(() => window.ashBrowserPdfFiles.releaseBrowserPdf());
		expect(await first).toBe('Injected write failure');
		await second;
		expect(await other.evaluate(() => window.ashBrowserPdfFiles.readBrowserFile('paper.pdf.ash-annotations.json'))).toBe('other window');
	} finally {
		await page.evaluate(() => window.ashBrowserPdfFiles.releaseBrowserPdf());
		await other.close();
	}
});
