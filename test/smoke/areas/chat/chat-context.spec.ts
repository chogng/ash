import type { ElectronApplication } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';

// The same renderer interaction is exercised in Browser, Electron UI and connected Electron.
test('Workbench context picker uploads, previews and removes attachments with the keyboard', async ({ workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	const add = chat.getByRole('button', { name: 'Add context', exact: true });
	await add.press('Enter');
	await expect(page.getByRole('dialog', { name: 'Search attachments', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(chat.locator('.stanza-editor-input')).toBeFocused();
	await add.press('Enter');
	const upload = page.waitForEvent('filechooser');
	await page.getByRole('dialog', { name: 'Search attachments', exact: true }).getByRole('combobox').fill('Attach files');
	await page.keyboard.press('Enter');
	await (await upload).setFiles([
		{ name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from('Workbench attachment brief') },
		{ name: 'preview.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Z1kAAAAASUVORK5CYII=', 'base64') },
	]);
	const attachments = chat.getByRole('list', { name: 'Attached context' });
	await expect(attachments.getByRole('listitem')).toHaveCount(2);
	await expect(page.locator('input[type="file"][aria-label="Attach files"]')).toHaveCount(0);
	await expect(attachments.getByRole('img', { name: 'preview.png' })).toHaveAttribute('src', /^data:image\/png;base64,/);
	const remove = chat.getByRole('button', { name: 'Remove brief.txt', exact: true });
	await remove.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/including unsaved text/);
	await page.keyboard.press('Escape');
	await expect(remove).toBeFocused();
	await remove.press('Enter');
	await expect(chat.getByRole('button', { name: 'Remove preview.png', exact: true })).toBeFocused();
	await page.keyboard.press('Alt+F2');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue('preview.png');
	await page.keyboard.press('Escape');
	await chat.getByRole('button', { name: 'Remove preview.png', exact: true }).press('Enter');
	await expect(attachments).toBeHidden();
	await expect(chat.locator('.stanza-editor-input')).toBeFocused();
});

test('cancelling attachment selection removes the picker and lets the composer attach again', async ({ workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	const add = chat.getByRole('button', { name: 'Add context', exact: true });
	await add.press('Enter');
	const cancelledUpload = page.waitForEvent('filechooser');
	await page.getByRole('dialog', { name: 'Search attachments', exact: true }).getByRole('combobox').fill('Attach files');
	await page.keyboard.press('Enter');
	await cancelledUpload;
	const input = page.locator('input[type="file"][aria-label="Attach files"]');
	await input.dispatchEvent('cancel');
	await expect(input).toHaveCount(0);
	await expect(chat.locator('.stanza-editor-input')).toBeFocused();
	await add.press('Enter');
	const upload = page.waitForEvent('filechooser');
	await page.getByRole('dialog', { name: 'Search attachments', exact: true }).getByRole('combobox').fill('Attach files');
	await page.keyboard.press('Enter');
	await (await upload).setFiles({ name: 'after-cancel.txt', mimeType: 'text/plain', buffer: Buffer.from('Attach after cancellation') });
	await expect(chat.getByRole('button', { name: 'Remove after-cancel.txt', exact: true })).toBeVisible();
	await expect(input).toHaveCount(0);
});


test('host clipboard image becomes a decoded context attachment in Workbench and Sessions', async ({ workbench, target, application }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	const png = await page.evaluate(() => {
		const canvas = document.createElement('canvas');
		canvas.width = 32; canvas.height = 24;
		canvas.getContext('2d')!.fillRect(0, 0, 32, 24);
		return canvas.toDataURL('image/png').split(',')[1];
	});
	const electron = application as ElectronApplication;
	if (target.kind === 'browser') await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
	// Snapshot every available format before writing so the smoke test restores the user's clipboard.
	const previous = target.kind === 'electron' ? await electron.evaluate(async ({ clipboard }) => Promise.all((await clipboard.read()).map(async item => {
		const formats: Record<string, { bytes: number[] } | { bookmark: { title: string; url: string } }> = {};
		for (const type of item.types) {
			const value = await item.getType(type);
			formats[type] = value instanceof Blob ? { bytes: Array.from(new Uint8Array(await value.arrayBuffer())) } : { bookmark: value };
		}
		return formats;
	}))) : await page.evaluate(async () => Promise.all((await navigator.clipboard.read()).map(async item => {
		const formats: Record<string, { bytes: number[] }> = {};
		for (const type of item.types) formats[type] = { bytes: Array.from(new Uint8Array(await (await item.getType(type)).arrayBuffer())) };
		return formats;
	})));
	try {
		if (target.kind === 'electron') {
			await electron.evaluate(async ({ clipboard, ClipboardItem }, data) => clipboard.write([new ClipboardItem({ 'image/png': new Blob([Buffer.from(data, 'base64')], { type: 'image/png' }) })]), png);
		} else {
			await page.evaluate(async data => navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([Uint8Array.from(atob(data), character => character.charCodeAt(0))], { type: 'image/png' }) })]), png);
		}
		for (const surface of ['workbench', 'sessions']) {
			const surfacePage = surface === 'workbench' ? page : await workbench.openAgentsWindow(target.kind);
			const composer = surface === 'workbench' ? chat : surfacePage.locator('.ash-sessions-chat-slot.active:visible');
			await composer.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
			await surfacePage.getByRole('dialog').getByRole('option', { name: 'Image from Clipboard', exact: true }).click();
			const image = composer.getByRole('img', { name: 'Pasted Image', exact: true });
			await expect(image).toBeVisible();
			await expect.poll(() => image.evaluate(element => [(element as HTMLImageElement).naturalWidth, (element as HTMLImageElement).naturalHeight])).toEqual([32, 24]);
			await expect(surfacePage.getByRole('dialog')).toHaveCount(0);
			await expect(composer.locator('.stanza-editor-input')).toBeFocused();
			await composer.getByRole('button', { name: 'Remove Pasted Image', exact: true }).press('Enter');
		}
	} finally {
		if (target.kind === 'electron') {
			await electron.evaluate(async ({ clipboard, ClipboardItem }, saved) => {
				saved = saved.filter(formats => Object.keys(formats).length > 0);
				if (!saved.length) { clipboard.clear(); return; }
				await clipboard.write(saved.map(formats => new ClipboardItem(Object.fromEntries(Object.entries(formats).map(([type, value]) => [type, 'bytes' in value ? new Blob([new Uint8Array(value.bytes)], { type }) : value.bookmark])))));
			}, previous);
		} else {
			await page.evaluate(async saved => {
				saved = saved.filter(formats => Object.keys(formats).length > 0);
				if (!saved.length) { await navigator.clipboard.writeText(''); return; }
				await navigator.clipboard.write(saved.map(formats => new ClipboardItem(Object.fromEntries(Object.entries(formats).map(([type, value]) => [type, new Blob([new Uint8Array('bytes' in value ? value.bytes : [])], { type })])))));
			}, previous);
		}
	}
});

test('host screenshot captures a PNG and releases the browser capture stream', async ({ workbench, target }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	if (target.kind === 'browser') {
		await page.evaluate(() => {
			const canvas = document.createElement('canvas');
			canvas.width = 48; canvas.height = 36;
			canvas.getContext('2d')!.fillRect(0, 0, 48, 36);
			const stream = canvas.captureStream(10);
			Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => stream });
			(window as Window & { ashContextCapture?: MediaStream }).ashContextCapture = stream;
		});
	}
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	await chat.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	await page.getByRole('dialog').getByRole('option', { name: target.kind === 'browser' ? 'Screenshot…' : 'Screenshot Window', exact: true }).click();
	const image = chat.getByRole('img', { name: 'Screenshot', exact: true });
	await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/);
	await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
	if (target.kind === 'browser') {
		await expect.poll(() => page.evaluate(() => (window as Window & { ashContextCapture?: MediaStream }).ashContextCapture!.getTracks().map(track => track.readyState))).toEqual(['ended']);
		await expect.poll(() => image.evaluate(element => [(element as HTMLImageElement).naturalWidth, (element as HTMLImageElement).naturalHeight])).toEqual([48, 36]);
	}
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(chat.locator('.stanza-editor-input')).toBeFocused();
	await chat.getByRole('button', { name: 'Remove Screenshot', exact: true }).press('Enter');
});


test('browser screen chooser cancellation returns to the attachment picker', async ({ workbench, target }) => {
	test.skip(target.kind !== 'browser', 'Only Browser uses the system screen chooser');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	await page.evaluate(() => {
		Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => { throw new DOMException('Cancelled', 'NotAllowedError'); } });
	});
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	await chat.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	await page.getByRole('dialog').getByRole('option', { name: 'Screenshot…', exact: true }).click();
	await expect(page.getByRole('dialog').getByRole('combobox')).toHaveAttribute('placeholder', 'Search attachments');
	await expect(page.getByRole('dialog').getByRole('combobox')).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(chat.getByRole('list', { name: 'Attached context' })).toBeHidden();
	await expect(chat.locator('.stanza-editor-input')).toBeFocused();
});
