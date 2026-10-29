import { expect, test } from '@playwright/test';

for (const surface of ['chat', 'cowork']) {
	test(`Split picker handles touch and pen taps and rejects drags and cancelled touches in ${surface}`, async ({ browser, baseURL }) => {
		const context = await browser.newContext({ baseURL, hasTouch: true });
		try {
			const page = await context.newPage();
			await page.goto(`/chatInput.html?surface=${surface}&gestureAncestor=1`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const control = page.locator('.ash-chat-model-picker-control');
			const model = control.locator('.ash-chat-input-model-action');
			const options = control.locator('.ash-chat-input-configuration-action');
			const picker = page.getByRole('dialog', { name: 'Choose a chat model' });
			const menu = page.getByRole('menu', { name: 'Model options', exact: true });
			const triggers = [
				{ trigger: model, popup: picker },
				{ trigger: options, popup: menu },
			];
			if (surface === 'chat') {
				triggers.push({
					trigger: page.locator('.ash-chat-input-mode-action'),
					popup: page.locator('.ash-chat-input-mode-menu'),
				});
			}
			for (const { trigger, popup } of triggers) {
				await trigger.tap();
				await expect(popup).toBeVisible();
				await page.keyboard.press('Escape');
				await expect(trigger).toBeFocused();
			}
			await expect(page.locator('output[aria-label="Decision"]')).toBeEmpty();
			const bounds = (await model.boundingBox())!;
			const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
			const input = await context.newCDPSession(page);
			await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
			await expect(picker).toBeHidden();
			await input.send('Input.dispatchTouchEvent', {
				type: 'touchMove',
				touchPoints: [{ ...point, x: point.x + 30 }],
			});
			await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
			await expect(picker).toBeHidden();
			await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
			await input.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
			await expect(picker).toBeHidden();
			await model.tap();
			await expect(picker).toBeVisible();
			await page.keyboard.press('Escape');
			await input.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, pointerType: 'pen' });
			await input.send('Input.dispatchMouseEvent', {
				type: 'mousePressed',
				...point,
				pointerType: 'pen',
				button: 'left',
				clickCount: 1,
			});
			await expect(picker).toBeHidden();
			await input.send('Input.dispatchMouseEvent', {
				type: 'mouseReleased',
				...point,
				pointerType: 'pen',
				button: 'left',
				clickCount: 1,
			});
			await expect(picker).toBeVisible();
			await input.detach();
		} finally {
			await context.close();
		}
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`File paste waits for preparation and preserves a newer draft in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}&history=1`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const input = page.locator('.ash-chat-textarea-input');
		await input.fill('Original pasted request');
		const prevented = await input.evaluate(element => {
			const transfer = new DataTransfer();
			transfer.items.add(new File(['Pasted file contents'], 'pasted.txt', { type: 'text/plain' }));
			const prevented = !element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
			element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
			(element as HTMLTextAreaElement).value = 'Next draft';
			element.dispatchEvent(new Event('input', { bubbles: true }));
			return prevented;
		});
		expect(prevented).toBe(true);
		await expect(input).toHaveValue('Next draft pasted.txt ');
		await expect(page.getByLabel('Submission', { exact: true })).toHaveText('');
		await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
		expect(await page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({
			submissions: [],
		});
		await input.press('Enter');
		await expect(page.getByLabel('Submission', { exact: true })).toHaveText(JSON.stringify([{ name: 'pasted.txt', content: 'Pasted file contents' }]));
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ submissions: [{ text: 'Next draft pasted.txt ' }] });
	});

	test(`Pending file-only mouse Send waits for the real reader in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}&history=1`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const input = page.locator('.ash-chat-textarea-input');
		const send = page.locator('[data-action-id="ash.chat.input.send"] button');
		await expect(input).toHaveValue('');
		const prevented = await input.evaluate(element => {
			const Reader = globalThis.FileReader;
			const reads: (() => void)[] = [];
			globalThis.FileReader = class extends Reader {
				override readAsArrayBuffer(blob: Blob): void {
					reads.push(() => super.readAsArrayBuffer(blob));
				}
			};
			(window as Window & { ashInputReadTest?: { release(): void; restore(): void; count(): number } }).ashInputReadTest = {
				release: () => {
					for (const read of reads.splice(0)) read();
				},
				count: () => reads.length,
				restore: () => {
					globalThis.FileReader = Reader;
				},
			};
			const transfer = new DataTransfer();
			transfer.items.add(new File(['Actual held reader contents'], 'held-mouse.txt', { type: 'text/plain' }));
			const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
			element.dispatchEvent(event);
			return event.defaultPrevented;
		});
		try {
			expect(prevented).toBe(true);
			await expect.poll(() => page.evaluate(() => (window as Window & { ashInputReadTest?: { count(): number } }).ashInputReadTest!.count())).toBe(1);
			await expect(send).toBeVisible();
			await expect(send).toBeEnabled();
			await expect(page.locator('.ash-chat-input-attachment-item')).toHaveCount(0);
			await page.locator('main').screenshot({ path: test.info().outputPath(`pending-mouse-send-${locale}.png`) });
			await send.click();
			await expect(send).toBeDisabled();
			expect(await page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({
				submissions: [],
			});
			await page.evaluate(() => (window as Window & { ashInputReadTest?: { release(): void } }).ashInputReadTest!.release());
			await expect(page.getByLabel('Submission', { exact: true })).toHaveText(JSON.stringify([{ name: 'held-mouse.txt', content: 'Actual held reader contents' }]));
			await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({ submissions: [{ text: 'held-mouse.txt ' }] });
			await expect(input).toHaveValue('');
		} finally {
			await page.evaluate(() => {
				const owner = window as Window & { ashInputReadTest?: { restore(): void } };
				owner.ashInputReadTest?.restore();
				delete owner.ashInputReadTest;
			});
		}
	});

	test(`Invalid pasted context blocks sending and keeps the draft in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}&history=1`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const input = page.locator('.ash-chat-textarea-input');
		await input.fill('Keep this draft');
		await input.evaluate(element => {
			const transfer = new DataTransfer();
			transfer.items.add(new File([new Uint8Array([0xff])], 'invalid.bin'));
			element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
			element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		});
		await expect(page.getByLabel('Context error', { exact: true })).toContainText('invalid.bin');
		await expect(input).toHaveValue('Keep this draft');
		await expect(page.getByLabel('Submission', { exact: true })).toHaveText('');
		await expect(page.locator('.ash-chat-input-attachments')).toHaveCount(0);
		expect(await page.evaluate(() => window.ashChatInputIntegration.historyState())).toMatchObject({
			submissions: [],
		});
	});
}

for (const theme of ['light', 'dark', 'hcLight', 'hcDark']) {
	test(`File drop feedback stays inside the shared composer in ${theme}`, async ({ page }) => {
		await page.goto(`/chatInput.html?theme=${theme}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const composer = page.locator('.ash-chat-input-container');
		const before = await composer.boundingBox();
		await composer.evaluate(element => {
			const transfer = new DataTransfer();
			transfer.items.add(new File(['Dropped contents'], 'dropped.txt', { type: 'text/plain' }));
			element.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true }));
		});
		const overlay = composer.locator('.ash-chat-drop-overlay');
		await expect(overlay).toBeVisible();
		await expect(overlay).toHaveCSS('pointer-events', 'none');
		await expect(overlay).toHaveCSS('position', 'absolute');
		expect(await composer.boundingBox()).toEqual(before);
		const bounds = await overlay.boundingBox();
		expect(bounds!.x).toBeGreaterThanOrEqual(before!.x);
		expect(bounds!.y).toBeGreaterThanOrEqual(before!.y);
		expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(before!.x + before!.width);
		expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(before!.y + before!.height);
		await composer.evaluate(element => {
			const transfer = new DataTransfer();
			transfer.items.add(new File(['Dropped contents'], 'dropped.txt', { type: 'text/plain' }));
			element.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
		});
		await expect(overlay).toBeHidden();
		await expect(page.locator('.ash-chat-textarea-input')).toHaveValue('dropped.txt ');
		await expect(composer.getByRole('listitem')).toHaveCount(0);
		await page.locator('.ash-chat-textarea-input').press('Enter');
		await expect(page.getByLabel('Submission', { exact: true })).toHaveText(JSON.stringify([{ name: 'dropped.txt', content: 'Dropped contents' }]));
	});
}
