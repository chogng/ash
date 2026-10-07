import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
	await page.goto('/webview.html');
});

test('queues messages until content is ready and preserves the page for identical HTML', async ({ page }) => {
	const frame = page.frameLocator('iframe[title="First view"]').frameLocator('iframe');
	await expect(frame.locator('output')).toHaveText('before mount');
	expect(await page.evaluate(() => window.ashWebviewIntegration.initialSent())).toBe(true);
	await frame.getByRole('textbox', { name: 'First input' }).fill('keep this state');
	await page.evaluate(() => window.ashWebviewIntegration.sameHtml());
	await expect(frame.getByRole('textbox', { name: 'First input' })).toHaveValue('keep this state');
	await expect.poll(() => page.evaluate(() => window.ashWebviewIntegration.received)).toEqual([
		{ view: 'first', message: 'before mount' },
	]);
});

test('replacement cancels queued old messages and sends to the new document', async ({ page }) => {
	await expect(page.frameLocator('iframe[title="First view"]').frameLocator('iframe').locator('output')).toHaveText('before mount');
	expect(await page.evaluate(() => window.ashWebviewIntegration.replace())).toEqual([false, true]);
	await expect(page.frameLocator('iframe[title="First view"]').frameLocator('iframe').locator('output')).toHaveText('replacement');
	await expect.poll(() => page.evaluate(() => window.ashWebviewIntegration.received)).toEqual([
		{ view: 'first', message: 'before mount' },
		{ view: 'first', message: 'replacement' },
	]);
});

test('tracks real iframe focus, forwards keyboard input and removes disposed instances', async ({ page }) => {
	const firstInput = page.frameLocator('iframe[title="First view"]').frameLocator('iframe').getByRole('textbox', { name: 'First input' });
	await expect(firstInput).toBeVisible();
	await page.locator('iframe[title="First view"]').focus();
	await page.keyboard.press('F1');
	await expect.poll(() => page.evaluate(() => window.ashWebviewIntegration.keyboard)).toContain('F1');
	await firstInput.click();
	await expect.poll(() => page.evaluate(() => window.ashWebviewIntegration.active)).toBe('first');
	await firstInput.press('F1');
	await expect.poll(() => page.evaluate(() => window.ashWebviewIntegration.keyboard)).toContain('F1');
	await page.frameLocator('iframe[title="Second view"]').frameLocator('iframe').getByRole('textbox', { name: 'Second input' }).click();
	await expect.poll(() => page.evaluate(() => window.ashWebviewIntegration.active)).toBe('second');
	await page.getByRole('textbox', { name: 'Workbench input' }).click();
	await expect.poll(() => page.evaluate(() => window.ashWebviewIntegration.active)).toBeUndefined();
	await firstInput.click();
	await expect.poll(() => page.evaluate(() => window.ashWebviewIntegration.active)).toBe('first');
	expect(await page.evaluate(() => window.ashWebviewIntegration.disposeFirst())).toBe(false);
	await expect(page.locator('iframe')).toHaveCount(1);
	expect(await page.evaluate(() => ({
		active: window.ashWebviewIntegration.active,
		count: window.ashWebviewIntegration.count,
	}))).toEqual({ active: undefined, count: 1 });
	await page.evaluate(() => window.ashWebviewIntegration.focusSecond());
	await expect.poll(() => page.evaluate(() => window.ashWebviewIntegration.active)).toBe('second');
});

test('keeps keyboard focus requested before the document is ready', async ({ page }) => {
	await page.evaluate(() => window.ashWebviewIntegration.mountFocused());
	await expect(page.frameLocator('iframe[title="Loading view"]').frameLocator('iframe').locator('output')).toHaveText('Focused document');
	await expect.poll(() => page.frameLocator('iframe[title="Loading view"]').frameLocator('iframe').locator('body').evaluate(() => document.hasFocus())).toBe(true);
	await page.keyboard.press('F1');
	await expect.poll(() => page.evaluate(() => window.ashWebviewIntegration.keyboard)).toEqual(['F1', 'F1']);
});

test('loads workspace images, CSS siblings, fonts and module imports while enforcing roots and script permissions', async ({ page }) => {
	await page.evaluate(() => window.ashWebviewIntegration.mountResources());
	const content = page.frameLocator('iframe[title="Resource view"]').frameLocator('iframe');
	await expect(content.locator('body')).toHaveAttribute('data-answer', '42');
	await expect(content.locator('body')).toHaveAttribute('data-isolated', 'true');
	await expect(content.locator('body')).toHaveAttribute('data-inline', 'executed');
	await expect(content.locator('body')).toHaveCSS('color', 'rgb(1, 2, 3)');
	await expect.poll(() => content.getByRole('img', { name: 'Workspace image', exact: true }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(12);
	await expect.poll(() => content.locator('body').evaluate(async () => {
		await document.fonts.ready;
		return document.fonts.check('14px ResourceFont');
	})).toBe(true);
	expect(await content.getByRole('img', { name: 'Denied image', exact: true }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(0);
	const disabled = page.frameLocator('iframe[title="Scripts disabled"]').frameLocator('iframe');
	await expect.poll(() => disabled.getByRole('img', { name: 'Workspace image', exact: true }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(12);
	expect(await disabled.locator('body').evaluate(body => ({ inline: body.getAttribute('data-inline'), module: body.getAttribute('data-answer') }))).toEqual({ inline: null, module: null });
	const reads = await page.evaluate(() => window.ashWebviewIntegration.resourceReads);
	expect(reads).toEqual(expect.arrayContaining([
		'file:///workspace/assets/pixel.svg',
		'file:///workspace/assets/style.css',
		'file:///workspace/assets/font.ttf',
		'file:///workspace/assets/main.mjs',
		'file:///workspace/assets/value.mjs',
	]));
	expect(reads).not.toContain('file:///outside/secret.svg');
	const debuggerSession = await page.context().newCDPSession(page);
	try {
		await debuggerSession.send('ServiceWorker.enable');
		await debuggerSession.send('ServiceWorker.stopAllWorkers');
		const reloaded = await content.locator('body').evaluate(async () => {
			const source = document.querySelector<HTMLImageElement>('img[alt="Workspace image"]')!.src;
			const response = await fetch(`${source}?worker-restarted`);
			return { status: response.status, content: await response.text() };
		});
		expect(reloaded).toEqual({ status: 200, content: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"></svg>' });
	} finally {
		await debuggerSession.detach();
	}
});
