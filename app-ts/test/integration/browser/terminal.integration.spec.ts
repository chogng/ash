import { expect, test } from '@playwright/test';

test('host PTY created before the contribution preserves early output and remains read only', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?embedder');
	await page.waitForFunction(() => Boolean(window.ashEmbedderTerminalIntegration));
	await page.evaluate(() => window.ashEmbedderTerminalIntegration.ready());
	await expect(page.locator('.xterm-rows')).toHaveText(/synchronous host output/u);
	await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
	await page.keyboard.type('ignored input');
	await page.evaluate(() => {
		window.ashEmbedderTerminalIntegration.name('Renamed host');
		window.ashEmbedderTerminalIntegration.output('later output\r\n');
		window.ashEmbedderTerminalIntegration.exit(0);
	});
	await expect(page.locator('.xterm-rows')).toHaveText(/synchronous host output.*later output.*process exited with code 0/su);
	expect(await page.evaluate(() => window.ashEmbedderTerminalIntegration.status())).toEqual({ opens: 1, closes: 0, backendCalls: [], title: 'Renamed host', state: 'exited', readOnly: true, remaining: 1 });
	await page.evaluate(() => window.ashEmbedderTerminalIntegration.close());
	await expect(page.locator('.ash-terminal-instance')).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('disposing a window with a running host PTY closes it once', async ({ page }) => {
	await page.goto('/terminal.html?embedder');
	await page.waitForFunction(() => Boolean(window.ashEmbedderTerminalIntegration));
	await page.evaluate(() => window.ashEmbedderTerminalIntegration.ready());
	await expect(page.locator('.xterm')).toHaveCount(1);
	await page.evaluate(() => window.ashEmbedderTerminalIntegration.dispose());
	expect(await page.evaluate(() => window.ashEmbedderTerminalIntegration.status())).toEqual({ opens: 1, closes: 1, backendCalls: [], remaining: 0 });
	await expect(page.locator('.ash-terminal-instance')).toHaveCount(0);
});

test('Chinese terminal actions create terminals while preserving shell names', async ({ page }) => {
	await page.goto('/terminal.html?pane&locale=zh-CN');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.counts())).toEqual({ profiles: 1, creates: 1 });
	const actions = page.getByRole('toolbar', { name: '终端操作', exact: true });
	await expect(actions.getByRole('button', { name: '选择终端配置', exact: true })).toBeEnabled();
	await expect(actions.getByRole('button', { name: '当前终端：Shell', exact: true })).toBeVisible();
	await actions.getByRole('button', { name: '新建终端', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(2);
});

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
			window.ashTerminalPaneIntegration.focus();
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

for (const requestFocus of [false, true]) {
	test(`terminal activation ${requestFocus ? 'honors explicit focus' : 'preserves editor focus'}`, async ({ page }) => {
		await page.goto('/terminal.html?pane');
		await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
		await page.locator('#outside').focus();
		await page.evaluate(focus => {
			window.ashTerminalPaneIntegration.panel(true);
			if (focus) window.ashTerminalPaneIntegration.focus();
		}, requestFocus);
		await expect(page.locator('.xterm')).toHaveCount(1);
		await expect(page.locator(requestFocus ? '.xterm-helper-textarea' : '#outside')).toBeFocused();
		await page.evaluate(() => window.ashTerminalIntegration.dispose());
	});
}

test('collapsed terminal defers initialization until expanded', async ({ page }) => {
	await page.goto('/terminal.html?pane');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(async () => {
		window.ashTerminalPaneIntegration.expand(false);
		window.ashTerminalPaneIntegration.panel(true);
		window.ashTerminalPaneIntegration.workspace();
		await new Promise(requestAnimationFrame);
	});
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.counts())).toEqual({ profiles: 0, creates: 0 });
	await page.evaluate(() => window.ashTerminalPaneIntegration.expand(true));
	await expect(page.locator('.xterm')).toHaveCount(1);
	await page.evaluate(() => window.ashTerminalIntegration.dispose());
});

test('terminal relaunch preserves focus moved while the process restarts', async ({ page }) => {
	await page.goto('/terminal.html?pane&existing&exited');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
	await expect(page.locator('.xterm')).toHaveCount(1);
	await page.evaluate(() => window.ashTerminalPaneIntegration.hold());
	await page.getByRole('button', { name: 'Relaunch Terminal', exact: true }).focus();
	await page.keyboard.press('Enter');
	await page.locator('#outside').focus();
	await page.evaluate(async () => {
		window.ashTerminalPaneIntegration.release();
		await new Promise(requestAnimationFrame);
	});
	await expect(page.locator('#outside')).toBeFocused();
	await page.evaluate(() => window.ashTerminalIntegration.dispose());
});

test('terminal does not resize the process while its host has zero dimensions', async ({ page }) => {
	await page.goto('/terminal.html');
	await page.waitForFunction(() => Boolean(window.ashTerminalIntegration));
	await page.evaluate(() => window.ashTerminalIntegration.start());
	await page.evaluate(() => window.ashTerminalIntegration.ready());
	const sizes = await page.evaluate(async () => {
		const before = [...window.ashTerminalIntegration.resizes];
		document.querySelector<HTMLElement>('#terminal')!.hidden = true;
		window.ashTerminalIntegration.fit();
		await new Promise(requestAnimationFrame);
		return { before, after: [...window.ashTerminalIntegration.resizes] };
	});
	expect(sizes.after).toEqual(sizes.before);
	await page.evaluate(() => window.ashTerminalIntegration.dispose());
});


test('terminal dictation writes phrases without executing and cancels when the panel hides', async ({ page }) => {
	await page.goto('/terminal.html?pane&existing');
	await page.waitForFunction(() => window.ashTerminalPaneIntegration !== undefined);
	await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
	await page.getByRole('button', { name: 'Terminal: Start dictation', exact: true }).focus();
	await page.keyboard.press('Space');
	await expect(page.getByRole('button', { name: 'Stop dictation', exact: true })).toBeEnabled();
	await page.evaluate(() => window.ashTerminalPaneIntegration.transcript('echo hello\n\u001b', true));
	await expect.poll(() => page.evaluate(() => window.ashTerminalIntegration.writes)).toEqual(['echo hello ']);
	await page.evaluate(() => window.ashTerminalPaneIntegration.transcript('unfinished', false));
	await page.evaluate(() => window.ashTerminalPaneIntegration.panel(false));
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.stops())).toBe(1);
	await page.evaluate(() => window.ashTerminalPaneIntegration.transcript('late', true));
	expect(await page.evaluate(() => window.ashTerminalIntegration.writes)).toEqual(['echo hello ']);
});

test('Terminal contribution assembles independent window scopes and rejects a missing process registration', async ({ page }) => {
	await page.goto('/terminal.html?assembly');
	await page.waitForFunction(() => Boolean(window.ashTerminalAssemblyIntegration));
	const result = await page.evaluate(() => window.ashTerminalAssemblyIntegration());
	expect(result.isolated).toBe(true);
	expect(result.output).toEqual(['scope-output', 'scope-output']);
	expect(result.calls.filter(call => call.startsWith('write:'))).toEqual(['write:backend-1:input', 'write:backend-2:input']);
	expect(result.calls.filter(call => call.startsWith('resize:'))).toEqual(['resize:backend-1:30x90', 'resize:backend-2:30x90']);
	expect(result.calls.filter(call => call.startsWith('close:'))).toEqual(['close:backend-1', 'close:backend-2']);
	expect(result.remaining).toEqual([0, 0]);
	expect(result.missingDependency).toContain('terminalService <- terminalProcessService');
});


test('legacy mouse reports deliver their raw high bytes through xterm onBinary', async ({ page }) => {
	await page.setViewportSize({ width: 1500, height: 600 });
	await page.goto('/terminal.html');
	await page.waitForFunction(() => Boolean(window.ashTerminalIntegration));
	await page.evaluate(async () => {
		document.querySelector<HTMLElement>('#terminal')!.style.width = '1400px';
		window.ashTerminalIntegration.start();
		await window.ashTerminalIntegration.ready();
		window.ashTerminalIntegration.fit();
		window.ashTerminalIntegration.write('\x1b[?1000h');
	});
	const screen = page.locator('.xterm-screen');
	await expect(screen).toBeVisible();
	await expect.poll(async () => {
		await screen.click({ position: { x: 1100, y: 20 } });
		return page.evaluate(() => window.ashTerminalIntegration.binaryWrites.flat().some(byte => byte >= 0x80));
	}).toBe(true);
	expect(await page.evaluate(() => window.ashTerminalIntegration.writes)).toEqual([]);
	await page.evaluate(() => window.ashTerminalIntegration.dispose());
});

test('Shell output waits for xterm loading and preserves split UTF-8 before completion and exit', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	await page.route(/(?:xterm_xterm|xterm\/lib\/xterm|\/xterm-[^/]+\.js)/u, async route => { await gate; await route.continue(); });
	try {
		await page.goto('/terminal.html?stream');
		await page.waitForFunction(() => Boolean(window.ashTerminalStreamIntegration));
		await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.status())).toEqual({ reads: [0], events: [], closes: 0, state: 'running', remaining: 1 });
		await expect(page.locator('.xterm')).toHaveCount(0);
	} finally {
		release();
	}
	await page.evaluate(() => window.ashTerminalStreamIntegration.start());
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.status())).toEqual({ reads: [0, 1], events: ['succeeded', 'exit'], closes: 0, state: 'exited', remaining: 1 });
	await expect(page.locator('.xterm-rows')).toHaveText(/中文🙂.*process exited with code 0/su);
	await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
	await page.evaluate(() => window.ashTerminalStreamIntegration.close());
	await expect(page.locator('.ash-terminal-instance')).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('closing a Shell while xterm loads stops reading and releases the process', async ({ page }) => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	await page.route(/(?:xterm_xterm|xterm\/lib\/xterm|\/xterm-[^/]+\.js)/u, async route => { await gate; await route.continue(); });
	try {
		await page.goto('/terminal.html?stream');
		await page.waitForFunction(() => Boolean(window.ashTerminalStreamIntegration));
		await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.status().reads)).toEqual([0]);
		await page.evaluate(() => window.ashTerminalStreamIntegration.close());
	} finally {
		release();
	}
	expect(await page.evaluate(() => window.ashTerminalStreamIntegration.status())).toMatchObject({ reads: [0], events: [], closes: 1, remaining: 0 });
	await expect(page.locator('.ash-terminal-instance')).toHaveCount(0);
});

test('an existing hidden Shell parses and completes without revealing the panel or taking focus', async ({ page }) => {
	await page.goto('/terminal.html?stream&hidden');
	await page.waitForFunction(() => Boolean(window.ashTerminalStreamIntegration));
	await page.locator('#outside').focus();
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.status())).toEqual({ reads: [0, 1], events: ['succeeded', 'exit'], closes: 0, state: 'exited', remaining: 1 });
	await expect(page.locator('.ash-terminal-instance')).toBeHidden();
	await expect(page.locator('#outside')).toBeFocused();
	await page.evaluate(() => window.ashTerminalStreamIntegration.close());
});


test('runCommands shortcuts execute with Terminal focused and keep command keys out of the Shell', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?shortcuts');
	await expect.poll(async () => ({ ready: await page.evaluate(() => Boolean(window.ashTerminalBatchIntegration)), errors })).toEqual({ ready: true, errors: [] });
	await page.evaluate(async () => { window.ashTerminalIntegration.start(); await window.ashTerminalIntegration.ready(); });
	const terminal = page.locator('.xterm-helper-textarea');
	await expect(terminal).toBeFocused();
	await terminal.press('Control+Alt+Y');
	await expect.poll(() => page.evaluate(() => window.ashTerminalBatchIntegration.order)).toEqual([{ source: 'shortcut' }, 'first finished', 'second']);
	await terminal.press('Control+Alt+Z');
	await expect.poll(() => page.evaluate(() => window.ashTerminalBatchIntegration.errors())).toEqual(['Unknown command: test.terminal.missing']);
	expect(await page.evaluate(() => window.ashTerminalBatchIntegration.order)).toEqual([{ source: 'shortcut' }, 'first finished', 'second', undefined, 'first finished']);
	expect(await page.evaluate(() => window.ashTerminalIntegration.writes)).toEqual([]);
	await terminal.press('x');
	await expect.poll(() => page.evaluate(() => window.ashTerminalIntegration.writes)).toEqual(['x']);
	expect(errors).toEqual([]);
	await page.evaluate(() => window.ashTerminalIntegration.dispose());
});
