import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import { isArkdownImageSource, readArkdownImageLayout, writeArkdownImage } from '../../../../../workbench/contrib/markdown/browser/arkdown/arkdownImages.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Arkdown images', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const browser = useBrowserTests();
	const body = () => browser.page.getByRole('textbox', { name: 'Document body', exact: true });
	const image = () => body().locator('.ash-arkdown-image');
	const source = () => browser.page.evaluate(() => window.arkdownFixture.source);
	const mount = async (text = 'Before\n\nAfter') => { await browser.page.goto('/arkdown.html'); await expect(browser.page.locator('body')).toHaveAttribute('data-ready', 'true'); await browser.page.evaluate(value => window.arkdownFixture.mount(value), text); };
	const png = () => browser.page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 240; const context = canvas.getContext('2d')!; context.fillStyle = '#D9A84D'; context.fillRect(0, 0, 200, 240); context.fillStyle = '#597CBF'; context.fillRect(200, 0, 200, 240); return canvas.toDataURL(); });
	const item = (name: string) => browser.page.getByRole('menuitem', { name, exact: true }).or(browser.page.getByRole('menuitemcheckbox', { name, exact: true }));

	test('embedded image policy excludes active schemes and layout keeps ordinary titles', () => {
		assert.equal(isArkdownImageSource('data:image/png;base64,AQID'), true);
		for (const value of ['data:image/svg+xml;base64,AQID', 'data:text/html;base64,AQID', 'data:image/png;base64,AQ=I', 'javascript:alert(1)', 'file:///private.png']) assert.equal(isArkdownImageSource(value), false);
		const layout = { width: 336, alignment: 'center' as const, title: 'Original "title"' };
		assert.deepEqual(readArkdownImageLayout('ash-image:' + JSON.stringify(layout)), layout);
		assert.deepEqual(readArkdownImageLayout('ordinary title'), { alignment: 'left', title: 'ordinary title' });
		assert.match(writeArkdownImage({ source: 'https://example.test/a.png', description: 'A [diagram]', title: layout.title }, layout), /^!\[A \\\[diagram\\\]\]/u);
	});

	test('inserts embedded local bytes through source history and rejects corrupt images atomically', async () => {
		await mount(); const data = await png();
		await body().locator('p').first().click(); await browser.page.evaluate(value => window.arkdownFixture.insertImage(value), data);
		await expect(image().locator('img')).toHaveAttribute('alt', 'Studio'); await expect(image().locator('img')).toHaveJSProperty('naturalWidth', 400);
		const saved = await source(); assert.match(saved, /Before\n\n!\[Studio\]\(<data:image\/png;base64,/u);
		await body().press('ControlOrMeta+z'); assert.equal(await source(), 'Before\n\nAfter');
		await body().press('ControlOrMeta+Shift+z'); await expect(image()).toHaveCount(1);
		const failure = await browser.page.evaluate(async () => { try { await window.arkdownFixture.insertImage('data:image/png;base64,bm90LWFuLWltYWdl'); } catch (error) { return String(error); } });
		assert.match(failure!, /PNG, JPEG, GIF or WebP/u); assert.equal(await source(), saved);
	});

	test('paste and drop import raster files while plain text paste remains text', async () => {
		await mount(); const data = await png(); await body().locator('p').first().click();
		await body().evaluate(async (element, data) => { const blob = await (await fetch(data)).blob(); const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'Pasted.png', { type: 'image/png' })); element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })); }, data);
		await expect(image()).toHaveCount(1); await expect(image().locator('img')).toHaveAttribute('alt', 'Pasted');
		await body().press('ControlOrMeta+z');
		await body().evaluate(async (element, data) => { const blob = await (await fetch(data)).blob(); const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'Dropped.png', { type: 'image/png' })); const rect = element.getBoundingClientRect(); element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + 80, clientY: rect.top + 16 })); }, data);
		await expect(image()).toHaveCount(1); await expect(image().locator('img')).toHaveAttribute('alt', 'Dropped');
		await body().press('ControlOrMeta+z'); await body().locator('p').first().click();
		await body().evaluate(element => { const data = new DataTransfer(); data.setData('text/plain', '![literal](https://example.test/x.png)'); element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); });
		await expect(image()).toHaveCount(0); await expect(body()).toContainText('![literal]');
	});

	test('image selection, resize, size presets, description and deletion share source undo', async () => {
		await mount(); const data = await png(); await browser.page.evaluate(value => window.arkdownFixture.insertImage(value), data);
		await image().click(); await expect(image()).toHaveClass(/selected/u); assert.ok(await browser.page.evaluate(() => window.arkdownFixture.selectionBounds?.width > 0));
		const handle = image().locator('.right'); await handle.focus(); await handle.press('ArrowLeft');
		await expect(image()).toHaveCSS('width', '390px'); const resized = await source(); assert.match(resized, /ash-image:/u);
		await browser.page.evaluate(value => window.arkdownFixture.mount(value), resized); await expect(image()).toHaveCSS('width', '390px');
		await image().click({ button: 'right' }); await item('Set image size').focus(); await item('Set image size').press('ArrowRight'); await item('Medium').click(); await expect(image()).toHaveCSS('width', '336px');
		await image().click({ button: 'right' }); await item('Edit image description').click(); const dialog = browser.page.getByRole('dialog'); await expect(dialog).toBeVisible(); await dialog.getByRole('textbox').fill('Launch diagram'); await dialog.getByRole('button', { name: 'OK', exact: true }).click(); await expect(image().locator('img')).toHaveAttribute('alt', 'Launch diagram');
		await image().focus(); await image().press('Delete'); await expect(image()).toHaveCount(0); await body().press('ControlOrMeta+z'); await expect(image().locator('img')).toHaveAttribute('alt', 'Launch diagram');
		await body().press('ControlOrMeta+z'); await expect(image().locator('img')).toHaveAttribute('alt', 'Studio'); await body().press('ControlOrMeta+z'); await expect(image()).toHaveCSS('width', '390px');
	});

	test('pointer resize keeps proportions, commits once and Escape cancels', async () => {
		await mount(); await browser.page.evaluate(value => window.arkdownFixture.insertImage(value), await png()); await image().hover(); const before = await source();
		const handle = await image().locator('.right').boundingBox(); assert.ok(handle); await browser.page.mouse.move(handle.x + 6, handle.y + handle.height / 2); await browser.page.mouse.down(); await browser.page.mouse.move(handle.x - 74, handle.y + handle.height / 2, { steps: 4 }); await browser.page.mouse.up();
		await expect(image()).toHaveCSS('width', '320px'); const bounds = await image().locator('img').boundingBox(); assert.ok(bounds && Math.abs(bounds.height / bounds.width - 0.6) < 0.01);
		await body().press('ControlOrMeta+z'); assert.equal(await source(), before);
		await image().hover(); const cancel = await image().locator('.right').boundingBox(); assert.ok(cancel); await browser.page.mouse.move(cancel.x + 6, cancel.y + cancel.height / 2); await browser.page.mouse.down(); await browser.page.mouse.move(cancel.x - 50, cancel.y); await browser.page.keyboard.press('Escape'); await browser.page.mouse.up(); assert.equal(await source(), before);
	});

	test('read-only blocks image imports and edits and delayed insertion follows the owning model', async () => {
		await mount(); const data = await png();
		await browser.page.evaluate(value => window.arkdownFixture.insertImage(value), data); const saved = await source();
		await browser.page.evaluate(() => window.arkdownFixture.readOnly(true)); await image().focus(); await image().press('Delete'); await expect(image().locator('.right')).toBeHidden(); await browser.page.evaluate(value => window.arkdownFixture.insertImage(value), data); assert.equal(await source(), saved);
		await mount(); await body().locator('p').first().click();
		await browser.page.evaluate(value => { (window as unknown as { pendingImage: ReturnType<typeof window.arkdownFixture.beginImage>; }).pendingImage = window.arkdownFixture.beginImage(value); }, data);
		await body().press('Home'); await browser.page.keyboard.insertText('Edited ');
		await browser.page.evaluate(() => (window as unknown as { pendingImage: { finish(): Promise<void>; }; }).pendingImage.finish());
		assert.match(await source(), /Edited Before\n\n!\[Pending\]/u);
	});

	test('an image action captured before an external replacement cannot edit the new content', async () => {
		await mount(); await browser.page.evaluate(value => window.arkdownFixture.insertImage(value), await png()); await image().click();
		const replacement = 'Unrelated new text '.repeat(200);
		await browser.page.evaluate(value => window.arkdownFixture.imageActionAfterReplacement(value), replacement);
		assert.equal(await source(), replacement);
		assert.deepEqual(await browser.page.evaluate(() => window.arkdownFixture.errors), []);
	});

	test('repeated image projection replacement releases document listeners', async () => {
		await mount(); await browser.page.evaluate(value => window.arkdownFixture.insertImage(value), await png());
		const session = await browser.page.context().newCDPSession(browser.page);
		try {
			const document = await session.send('Runtime.evaluate', { expression: 'document', objectGroup: 'docs-image-listeners' });
			const count = async () => (await session.send('DOMDebugger.getEventListeners', { objectId: document.result.objectId! })).listeners.filter(listener => listener.type === 'pointerdown').length;
			const initial = await count();
			for (let index = 0; index < 6; index++) { await image().focus(); await image().locator('.right').focus(); await image().locator('.right').press('ArrowLeft'); }
			assert.equal(await count(), initial);
			await browser.page.evaluate(() => window.arkdownFixture.external('No image'));
			assert.equal(await count(), initial - 1);
		} finally { await session.send('Runtime.releaseObjectGroup', { objectGroup: 'docs-image-listeners' }); await session.detach(); }
	});

	test('the selection toolbar refreshes actions when a resized image projection replaces its widget', async () => {
		await mount(); await browser.page.evaluate(value => window.arkdownFixture.insertImage(value), await png()); await image().click();
		await browser.page.evaluate(() => window.arkdownFixture.showImageToolbar());
		await expect(browser.page.getByRole('button', { name: 'Center image', exact: true })).toBeVisible();
		await image().locator('.right').focus(); await image().locator('.right').press('ArrowLeft'); await expect(image()).toHaveCSS('width', '390px');
		await browser.page.getByRole('button', { name: 'Center image', exact: true }).click(); await expect(image()).toHaveAttribute('data-align', 'center');
	});
});
