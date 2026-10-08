import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { createMediaPreviewFixture, mediaPreviewEvidence } from './mediaPreviewFixture.js';

declare global {
	interface Window {
		readonly imagePreviewRevokedURLs: Set<string>;
	}
}

test('Image preview opens workspace images, zooms, exposes metadata and releases resources', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind === 'electron' && target.appServerMode !== 'required', 'Desktop workspace files require App Server.');
	const page = workbench.page;
	const images = await page.evaluate(() => {
		const canvas = document.createElement('canvas');
		canvas.width = 800; canvas.height = 600;
		const context = canvas.getContext('2d')!;
		context.fillStyle = '#007acc'; context.fillRect(0, 0, 400, 600);
		return ['image/png', 'image/jpeg', 'image/webp'].map((mediaType, index) => ({
			name: ['product.png', 'product.jpg', 'product.webp'][index]!,
			encoded: canvas.toDataURL(mediaType).split(',')[1]!,
		}));
	});
	if (target.kind === 'browser' && target.appServerMode === 'disabled') {
		await page.evaluate(async images => {
			const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(`image-preview-${crypto.randomUUID()}`, { create: true });
			for (const image of images) {
				const writer = await (await folder.getFileHandle(image.name, { create: true })).createWritable();
				await writer.write(Uint8Array.from(atob(image.encoded), character => character.charCodeAt(0)));
				await writer.close();
			}
			const invalid = await (await folder.getFileHandle('broken.png', { create: true })).createWritable();
			await invalid.write(new Uint8Array([137, 80, 78, 71])); await invalid.close();
			Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
		}, images);
		await workbench.editors.groupAt(0).welcome.getByRole('button', { name: 'Open folder', exact: true }).click();
	} else {
		for (const image of images) { await writeFile(join(testWorkspace.directory, image.name), Buffer.from(image.encoded, 'base64')); }
		await writeFile(join(testWorkspace.directory, 'broken.png'), new Uint8Array([137, 80, 78, 71]));
	}
	await page.evaluate(() => {
		const revoke = URL.revokeObjectURL.bind(URL);
		const revoked = new Set<string>();
		URL.revokeObjectURL = url => { revoked.add(url); revoke(url); };
		Object.defineProperty(window, 'imagePreviewRevokedURLs', { value: revoked, configurable: true });
	});
	await expect(page.locator('.ash-explorer').getByRole('treeitem', { name: 'product.png', exact: true })).toBeVisible();
	const explorer = page.locator('.ash-explorer');
	await explorer.getByRole('treeitem', { name: 'product.png', exact: true }).dblclick();
	const preview = page.locator('.ash-image-preview');
	const image = preview.locator('img');
	await expect(preview).toBeVisible();
	await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(800);
	await expect(preview.locator('.ash-image-preview-summary')).toContainText('800 × 600 pixels');
	const originalURL = await image.getAttribute('src');
	const viewport = preview.getByLabel('Image viewport', { exact: true });
	await viewport.focus();
	await viewport.press('1');
	await expect(image).toHaveCSS('width', '800px');
	await viewport.press('+');
	await expect(image).toHaveCSS('width', '1000px');
	await viewport.press('0');
	const geometry = await viewport.evaluate(element => ({
		width: element.clientWidth, height: element.clientHeight,
		imageWidth: element.querySelector('img')!.getBoundingClientRect().width,
		imageHeight: element.querySelector('img')!.getBoundingClientRect().height,
	}));
	expect(geometry.imageWidth).toBeLessThanOrEqual(geometry.width);
	expect(geometry.imageHeight).toBeLessThanOrEqual(geometry.height);
	await viewport.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Press Plus or Minus[\s\S]*original file stays intact/);
	await page.keyboard.press('Escape');
	await expect(viewport).toBeFocused();
	await viewport.press('Alt+F2');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Image: product.png[\s\S]*800 × 600 pixels[\s\S]*image\/png/);
	await page.keyboard.press('Escape');
	if (target.kind === 'electron') {
		const updated = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 90; return canvas.toDataURL().split(',')[1]!; });
		await writeFile(join(testWorkspace.directory, 'product.png'), Buffer.from(updated, 'base64'));
		await expect(preview.locator('.ash-image-preview-summary')).toContainText('120 × 90 pixels');
		await expect.poll(() => page.evaluate(url => window.imagePreviewRevokedURLs.has(url!), originalURL)).toBe(true);
	}
	for (const name of ['product.jpg', 'product.webp']) {
		await explorer.getByRole('treeitem', { name, exact: true }).dblclick();
		const activeImage = workbench.editors.groupAt(0).content.locator('.ash-image-preview:visible img');
		await expect(activeImage).toHaveAttribute('alt', name);
		await expect.poll(() => activeImage.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(800);
	}
	const lastURL = await workbench.editors.groupAt(0).content.locator('.ash-image-preview:visible img').getAttribute('src');
	await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
	await expect.poll(() => page.evaluate(url => window.imagePreviewRevokedURLs.has(url!), lastURL)).toBe(true);
	await explorer.getByRole('treeitem', { name: 'broken.png', exact: true }).dblclick();
	await expect(workbench.editors.groupAt(0).content.getByRole('alert')).toContainText('Choose a PNG, JPEG or WebP image.');
});

test('Image preview retries a first read failure, recovers corrupted content and ignores a late read', async ({ target, testWorkspace, workbench }, testInfo) => {
	test.skip(target.kind === 'electron' && target.appServerMode !== 'required', 'Desktop workspace files require App Server.');
	test.setTimeout(90_000);
	const page = workbench.page;
	const fixture = await createMediaPreviewFixture(page, target, testWorkspace.directory, workbench);
	try {
		const explorer = page.locator('.ash-explorer');
		const preview = workbench.editors.groupAt(0).content.locator('.ash-image-preview:visible');
		const image = preview.locator('img');
		await page.evaluate(() => window.mediaRetryProbe.fail.add('retry.png'));
		await explorer.getByRole('treeitem', { name: 'retry.png', exact: true }).dblclick();
		await expect(preview.getByRole('alert')).toContainText('Could not load image:');
		const firstFailure = await mediaPreviewEvidence(page);
		expect(firstFailure.failedReads).toHaveLength(1);
		expect(firstFailure.failedReads[0]!.name).toBe('retry.png');
		if (target.appServerMode === 'disabled') { await expect(preview.getByRole('alert')).toContainText(firstFailure.failedReads[0]!.message); }
		expect(firstFailure.created).toEqual([]);
		await expect(image).not.toHaveAttribute('src');
		await testInfo.attach('image-read-failure', { body: await preview.screenshot(), contentType: 'image/png' });
		const retry = preview.getByRole('button', { name: 'Retry', exact: true });
		await expect(retry).toBeEnabled();
		await retry.focus(); await retry.press('Enter');
		await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(800);
		await expect(preview.getByRole('status')).toContainText('800 × 600 pixels');
		await expect(preview.getByRole('alert')).toHaveCount(0);
		await expect(retry).toHaveCount(0);
		const url = (await image.getAttribute('src'))!;
		const viewport = preview.getByLabel('Image viewport', { exact: true });
		await viewport.focus(); await viewport.press('1'); await viewport.press('+');
		await expect(image).toHaveCSS('width', '1000px');
		await testInfo.attach('image-retry-zoom', { body: await preview.screenshot(), contentType: 'image/png' });
		await viewport.press('0');
		await expect.poll(() => viewport.evaluate(element => {
			const bounds = element.querySelector('img')!.getBoundingClientRect();
			return bounds.width <= element.clientWidth && bounds.height <= element.clientHeight;
		})).toBe(true);
		await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
		await expect.poll(async () => (await mediaPreviewEvidence(page)).revoked).toContain(url);

		await explorer.getByRole('treeitem', { name: 'broken.png', exact: true }).dblclick();
		await expect(preview.getByRole('alert')).toContainText('The image data could not be decoded.');
		expect((await mediaPreviewEvidence(page)).created).toEqual([url]);
		await expect(preview.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
		await testInfo.attach('image-decode-failure', { body: await preview.screenshot(), contentType: 'image/png' });
		await fixture.repair('broken.png');
		// A filesystem observer may recover before the explicit action is reached.
		if (await preview.getByRole('button', { name: 'Retry', exact: true }).isVisible()) {
			await preview.getByRole('button', { name: 'Retry', exact: true }).click();
		}
		await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(800);
		await expect(preview.getByRole('status')).toContainText('800 × 600 pixels');
		await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');

		await page.evaluate(() => window.mediaRetryProbe.hold.add('pending.png'));
		await explorer.getByRole('treeitem', { name: 'pending.png', exact: true }).dblclick();
		await expect.poll(async () => (await mediaPreviewEvidence(page)).pending).toContain('pending.png');
		await explorer.getByRole('treeitem', { name: 'product.png', exact: true }).dblclick();
		await expect(image).toHaveAttribute('alt', 'product.png');
		await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(800);
		const currentURL = (await image.getAttribute('src'))!;
		const beforeLateRead = await mediaPreviewEvidence(page);
		await page.evaluate(() => window.mediaRetryProbe.pending.get('pending.png')!());
		await expect.poll(async () => (await mediaPreviewEvidence(page)).pending).toEqual([]);
		if (target.appServerMode === 'required') {
			await expect.poll(async () => (await mediaPreviewEvidence(page)).releasedResources.length).toBeGreaterThan(beforeLateRead.releasedResources.length);
		} else {
			await expect.poll(async () => (await mediaPreviewEvidence(page)).completedReads).toContain('pending.png');
		}
		await expect(image).toHaveAttribute('src', currentURL);
		await expect(preview.getByRole('alert')).toHaveCount(0);
		expect((await mediaPreviewEvidence(page)).created).toEqual(beforeLateRead.created);
		await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
		await expect.poll(async () => {
			const evidence = await mediaPreviewEvidence(page);
			return evidence.created.every(url => evidence.revoked.includes(url)) && evidence.liveResources.length === 0;
		}).toBe(true);
		await testInfo.attach('image-lifecycle', { body: JSON.stringify(await mediaPreviewEvidence(page), null, 2), contentType: 'application/json' });
	} finally { await fixture.dispose(); }
});
