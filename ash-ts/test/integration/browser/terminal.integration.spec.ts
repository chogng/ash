import { expect, test } from '@playwright/test';

test('terminal loads xterm on demand and preserves early output, exit and first input', async ({ page }) => {
	const errors: string[] = [];
	const requests: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	page.on('request', request => requests.push(request.url()));
	await page.goto('/terminal.html');
	await page.waitForFunction(() => Boolean(window.ashTerminalIntegration));
	expect(requests.filter(url => /(?:xterm_xterm|xterm\/lib\/xterm|\/xterm-[^/]+\.js)/u.test(url))).toEqual([]);
	await expect(page.locator('.xterm')).toHaveCount(0);
	await page.evaluate(() => {
		window.ashTerminalIntegration.write('first\r\n');
		window.ashTerminalIntegration.write('second\r\n');
		window.ashTerminalIntegration.exit();
	});
	expect(await page.evaluate(() => window.ashTerminalIntegration.start())).toBe(true);
	await page.evaluate(() => window.ashTerminalIntegration.ready());
	await expect(page.locator('.xterm-rows')).toHaveText(/first.*second.*\[process exited with code 0\]/su);
	await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
	await page.keyboard.type('hello');
	expect(await page.evaluate(() => window.ashTerminalIntegration.writes.join(''))).toBe('hello');
	expect(requests.some(url => /(?:xterm_xterm|xterm\/lib\/xterm|\/xterm-[^/]+\.js)/u.test(url))).toBe(true);
	await page.evaluate(() => window.ashTerminalIntegration.dispose());
	await expect(page.locator('.ash-terminal-instance')).toHaveCount(0);
	expect(errors).toEqual([]);
});

for (const action of ['dispose', 'move focus'] as const) {
	test(`terminal loading respects ${action} before completion`, async ({ page }) => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		await page.route(/(?:xterm_xterm|xterm\/lib\/xterm|\/xterm-[^/]+\.js)/u, async route => {
			await gate;
			await route.continue();
		});
		await page.goto('/terminal.html');
		await page.waitForFunction(() => Boolean(window.ashTerminalIntegration));
		try {
			await page.evaluate(() => window.ashTerminalIntegration.start());
			if (action === 'dispose') {
				await page.evaluate(() => window.ashTerminalIntegration.dispose());
			} else {
				await page.locator('#outside').focus();
			}
		} finally {
			release();
		}
		await page.evaluate(() => window.ashTerminalIntegration.ready());
		if (action === 'dispose') {
			await expect(page.locator('.xterm')).toHaveCount(0);
		} else {
			await expect(page.locator('#outside')).toBeFocused();
			await expect(page.locator('.xterm')).toHaveCount(1);
			await page.evaluate(() => window.ashTerminalIntegration.dispose());
		}
	});
}

test('hidden terminal pane defers profiles, process and xterm until shown', async ({ page }) => {
	const requests: string[] = [];
	page.on('request', request => requests.push(request.url()));
	await page.goto('/terminal.html?pane');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(async () => {
		window.ashTerminalPaneIntegration.workspace();
		await new Promise(requestAnimationFrame);
	});
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.counts())).toEqual({ profiles: 0, creates: 0 });
	expect(requests.filter(url => /\/xterm-[^/]+\.js/u.test(url))).toEqual([]);
	await page.evaluate(() => {
		window.ashTerminalPaneIntegration.view(false);
		window.ashTerminalPaneIntegration.panel(true);
	});
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.counts())).toEqual({ profiles: 0, creates: 0 });
	await page.evaluate(() => window.ashTerminalPaneIntegration.view(true));
	await expect(page.locator('.xterm')).toHaveCount(1);
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.counts())).toEqual({ profiles: 1, creates: 1 });
	await page.evaluate(() => {
		window.ashTerminalPaneIntegration.panel(false);
		window.ashTerminalPaneIntegration.panel(true);
	});
	await expect(page.locator('.xterm')).toHaveCount(1);
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(1);
	await page.evaluate(() => window.ashTerminalIntegration.dispose());
});

for (const action of ['hide', 'dispose', 'move focus'] as const) {
	test(`terminal profile initialization respects ${action} and deduplicates repeated activation`, async ({ page }) => {
		await page.goto('/terminal.html?pane');
		await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
		await page.evaluate(() => {
			window.ashTerminalPaneIntegration.hold();
			window.ashTerminalPaneIntegration.panel(true);
			window.ashTerminalPaneIntegration.workspace();
			window.ashTerminalPaneIntegration.panel(false);
			window.ashTerminalPaneIntegration.panel(true);
		});
		expect(await page.evaluate(() => window.ashTerminalPaneIntegration.counts())).toEqual({ profiles: 1, creates: 0 });
		if (action === 'hide') await page.evaluate(() => window.ashTerminalPaneIntegration.panel(false));
		if (action === 'dispose') await page.evaluate(() => window.ashTerminalIntegration.dispose());
		await page.locator('#outside').focus();
		await page.evaluate(async () => {
			window.ashTerminalPaneIntegration.release();
			await new Promise(requestAnimationFrame);
		});
		if (action === 'move focus') {
			await expect(page.locator('.xterm')).toHaveCount(1);
		} else {
			expect(await page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(0);
			await expect(page.locator('.xterm')).toHaveCount(0);
		}
		await expect(page.locator('#outside')).toBeFocused();
		await page.evaluate(() => window.ashTerminalIntegration.dispose());
	});
}

test('existing hidden terminal retains output without loading xterm until revealed', async ({ page }) => {
	const requests: string[] = [];
	page.on('request', request => requests.push(request.url()));
	await page.goto('/terminal.html?pane&existing');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(() => window.ashTerminalIntegration.write('hidden output\r\n'));
	expect(requests.filter(url => /\/xterm-[^/]+\.js/u.test(url))).toEqual([]);
	await expect(page.locator('.xterm')).toHaveCount(0);
	await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
	await expect(page.locator('.xterm-rows')).toHaveText(/hidden output/u);
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(0);
	await page.evaluate(() => window.ashTerminalIntegration.dispose());
});
