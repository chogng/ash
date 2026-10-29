import { expect, test, type Page } from '@playwright/test';

for (const locale of ['en', 'zh-CN']) {
	test(`terminal screen commands navigate retained output and clear selection from the keyboard in ${locale}`, async ({ page }) => {
		await page.goto(`/terminal.html?input&groups&clipboard&browser&locale=${locale}`);
		await page.waitForFunction(() => Boolean(window.ashTerminalInputIntegration));
		await page.evaluate(() => {
			window.ashTerminalInputIntegration.feed(Array.from({ length: 120 }, (_, index) => `screen-row-${index}\r\n`).join(''));
		});
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toContain('screen-row-119');
		await page.evaluate(() => window.ashTerminalInputIntegration.clear());
		const command = async (id: string): Promise<void> => { await page.evaluate(id => window.ashTerminalInputIntegration.command(id), `workbench.action.terminal.${id}`); };
		await command('scrollToTop');
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.viewport().top)).toBe(0);
		await command('scrollDown');
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.viewport().top)).toBe(1);
		await command('scrollUp');
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.viewport().top)).toBe(0);
		await command('scrollDownPage');
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.viewport().top)).toBeGreaterThan(1);
		await command('scrollUpPage');
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.viewport().top)).toBe(0);
		await command('scrollToBottom');
		await expect.poll(() => page.evaluate(() => {
			const viewport = window.ashTerminalInputIntegration.viewport();
			return viewport.top === viewport.bottom;
		})).toBe(true);
		const textarea = page.locator('.xterm-helper-textarea').first();
		await textarea.focus();
		await textarea.press(process.platform === 'darwin' ? 'PageUp' : 'Shift+PageUp');
		await expect.poll(() => page.evaluate(() => {
			const viewport = window.ashTerminalInputIntegration.viewport();
			return viewport.top < viewport.bottom;
		})).toBe(true);
		await command('selectAll');
		await expect.poll(() => page.evaluate(() => window.ashTerminalClipboardIntegration.selection())).toContain('screen-row-0');
		await textarea.press('Escape');
		await expect.poll(() => page.evaluate(() => window.ashTerminalClipboardIntegration.selection())).toBe('');
		await expect(textarea).toBeFocused();
		expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
		const help = await page.evaluate(() => window.ashTerminalClipboardIntegration.help());
		expect(help).toContain(locale === 'zh-CN' ? '只读终端' : 'read-only terminals');
		await page.evaluate(() => window.ashTerminalInputIntegration.close());
	});
}

test('terminal empty writes and pending screen reads finish across synchronous resize', async ({ page }) => {
	await page.goto('/terminal.html?browser');
	await page.evaluate(async () => { window.ashTerminalIntegration.start(); await window.ashTerminalIntegration.ready(); });
	const text = await page.evaluate(async () => {
		const terminal = window.ashTerminalIntegration;
		const pending = terminal.snapshot(10000);
		await Promise.resolve();
		terminal.write('');
		terminal.write('output-after-empty-write');
		const { cols, rows } = terminal.dimensions();
		terminal.resize(cols + 1, rows);
		return pending;
	});
	expect(text).toContain('output-after-empty-write');
	await expect(page.locator('.xterm-rows')).toContainText('output-after-empty-write');
	await page.evaluate(() => window.ashTerminalIntegration.dispose());
});

test('terminal ConPTY height expansion retains history before a full viewport repaint', async ({ page }) => {
	await page.goto('/terminal.html?stream&commandModel&os=windows');
	await page.waitForFunction(() => Boolean(window.ashTerminalStreamIntegration));
	await page.evaluate(() => window.ashTerminalStreamIntegration.start());
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.snapshot())).toContain('result 中文🙂');
	await page.evaluate(async () => {
		const terminal = window.ashTerminalStreamIntegration;
		terminal.stickyScroll.resize(80, 10);
		terminal.feedModel('\r\n' + Array.from({ length: 180 }, (_, index) => `pty-row-${index}\r\n`).join('') + 'prompt>');
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.snapshot())).toContain('pty-row-179');
	await page.evaluate(() => {
		const terminal = window.ashTerminalStreamIntegration;
		terminal.stickyScroll.resize(80, 12);
		terminal.feedModel('\x1b[H\x1b[2J' + Array.from({ length: 9 }, (_, index) => `pty-row-${171 + index}\r\n`).join('') + 'prompt>');
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.observed())).toContain('\x1b[H\x1b[2J');
	const text = await page.evaluate(() => window.ashTerminalStreamIntegration.snapshot());
	expect([...text!.matchAll(/^pty-row-(\d+)$/gmu)].map(match => Number(match[1]))).toEqual(Array.from({ length: 180 }, (_, index) => index));
	await page.evaluate(() => window.ashTerminalStreamIntegration.close());
});

test('terminal ConPTY narrowing retains output when a long prompt wraps during repaint', async ({ page }) => {
	await page.goto('/terminal.html?stream&commandModel&os=windows');
	await page.waitForFunction(() => Boolean(window.ashTerminalStreamIntegration));
	await page.evaluate(() => window.ashTerminalStreamIntegration.start());
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.snapshot())).toContain('result 中文🙂');
	await page.evaluate(() => {
		const terminal = window.ashTerminalStreamIntegration;
		terminal.stickyScroll.resize(80, 10);
		terminal.feedModel('\r\n' + Array.from({ length: 180 }, (_, index) => `pty-row-${index}\r\n`).join('') + 'PS ' + '/folder'.repeat(11) + '> ');
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.snapshot())).toContain('pty-row-179');
	await page.evaluate(() => {
		const terminal = window.ashTerminalStreamIntegration;
		terminal.stickyScroll.resize(37, 10);
		terminal.feedModel('\x1b[H\x1b[2J' + Array.from({ length: 7 }, (_, index) => `pty-row-${173 + index}\r\n`).join('') + 'PS ' + '/folder'.repeat(11) + '> ');
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.observed())).toContain('\x1b[H\x1b[2J');
	const text = await page.evaluate(() => window.ashTerminalStreamIntegration.snapshot());
	expect([...text!.matchAll(/^pty-row-(\d+)$/gmu)].map(match => Number(match[1]))).toEqual(Array.from({ length: 180 }, (_, index) => index));
	await page.evaluate(() => window.ashTerminalStreamIntegration.close());
});

for (const locale of ['en', 'zh-CN']) {
	test(`terminal path drops insert literal filenames and recent directories support keyboard acceptance and cancellation in ${locale}`, async ({ page }) => {
		await page.goto(`/terminal.html?input&groups&clipboard&browser&locale=${locale}`);
		await page.waitForFunction(() => Boolean(window.ashTerminalInputIntegration));
		await page.evaluate(() => window.ashTerminalInputIntegration.clear());
		await page.locator('.ash-terminal-instance:visible').first().dispatchEvent('drop', {
			dataTransfer: await page.evaluateHandle(() => { const transfer = new DataTransfer(); transfer.setData('text/uri-list', 'file:///workspace/space%20%27%24%28literal%29.sh'); return transfer; }),
		});
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(["'/workspace/space '\"'\"'$(literal).sh'"]);
		await page.evaluate(() => { void window.ashTerminalInputIntegration.command('workbench.action.terminal.goToRecentDirectory'); });
		await page.evaluate(() => window.ashTerminalInputIntegration.visit("/workspace/quoted ' directory"));
		// The backend fixture publishes cwd through the normal output-commit metadata path.
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.cwd())).toBe("/workspace/quoted ' directory");
		await expect(page.getByText("/workspace/quoted ' directory", { exact: true })).toBeVisible();
		await expect(page.getByRole('combobox', { name: locale === 'zh-CN' ? '此终端执行宿主上的最近目录' : 'Recent directories on this terminal execution host', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes.length)).toBe(1);
		await page.evaluate(() => { void window.ashTerminalInputIntegration.command('workbench.action.terminal.goToRecentDirectory'); });
		await expect(page.getByText("/workspace/quoted ' directory", { exact: true })).toBeVisible();
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(["'/workspace/space '\"'\"'$(literal).sh'", "cd -- '/workspace/quoted '\"'\"' directory'\r"]);
		await page.evaluate(() => window.ashTerminalInputIntegration.close());
	});
}

async function seedScreenCommand(page: Page, trusted = true, locale = 'en'): Promise<void> {
	await page.goto(`/terminal.html?input&groups&clipboard&browser&locale=${locale}`);
	await page.waitForFunction(() => Boolean(window.ashTerminalGroupsIntegration));
	await page.evaluate(isTrusted => {
		const feed = window.ashTerminalInputIntegration.feed;
		feed('', { type: 'processReady', isWindowsPty: false, shellType: 'bash' as import('../../../src/ash/platform/terminal/common/terminal.js').PosixShellType.Bash });
		feed('', { type: 'promptStart' });
		feed('$ ');
		feed('', { type: 'commandStart' });
		feed('echo marker\r\n');
		feed('', { type: 'commandExecuted', commandId: 'menu-command', command: 'echo marker', isTrusted, cwd: '/workspace', timestampMillis: 1 });
		feed('first line\r\nlast line\r\n');
		feed('', { type: 'commandFinished', exitCode: 0, durationMillis: 1 });
		feed('', { type: 'promptStart' });
		feed('$ next prompt');
		feed('', { type: 'commandStart' });
	}, trusted);
	await expect(page.locator('.ash-terminal-command-status.succeeded')).toBeVisible();
	await page.evaluate(() => window.ashTerminalInputIntegration.clear());
}

test('Enter input without shell integration records fallback positions and erase releases them', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html');
	await page.evaluate(() => window.ashTerminalIntegration.start());
	await page.evaluate(() => window.ashTerminalIntegration.ready());
	await page.evaluate(() => window.ashTerminalIntegration.write('prompt> echo text'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalIntegration.snapshot(100))).toContain('prompt> echo text');
	await page.locator('.xterm-helper-textarea').focus();
	await page.keyboard.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashTerminalIntegration.markers().length)).toBe(1);
	await page.evaluate(() => window.ashTerminalIntegration.write('\x1b[2J'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalIntegration.markers())).toEqual([]);
	await page.evaluate(() => window.ashTerminalIntegration.dispose());
	expect(errors).toEqual([]);
});

test('terminal Find uses Chinese labels and keeps a bounded overlay with visible focus in high contrast', async ({ page }) => {
	await page.goto('/terminal.html?input&find&locale=zh-CN');
	await page.waitForFunction(() => Boolean(window.ashTerminalFindIntegration));
	await page.evaluate(() => window.ashTerminalFindIntegration.command('workbench.action.terminal.focusFind'));
	const find = page.getByRole('region', { name: '在终端中查找' });
	const input = find.getByRole('textbox', { name: '查找', exact: true });
	await input.fill('不存在');
	await expect(find.getByRole('status')).toHaveText('无结果');
	await find.getByRole('button', { name: '正则表达式', exact: true }).click();
	await input.fill('[');
	await expect(find.getByRole('status')).toHaveText('正则表达式无效');
	await input.focus();
	expect(await page.evaluate(() => window.ashTerminalFindIntegration.help())).toContain('查找会搜索');
	for (const mode of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
		await page.evaluate(mode => window.ashTerminalFindIntegration.theme(mode), mode);
		const appearance = await find.evaluate(element => {
			const style = getComputedStyle(element);
			const input = element.querySelector('input')!;
			const inputStyle = getComputedStyle(input.parentElement!);
			const probe = document.createElement('span');
			probe.style.color = 'var(--ash-focusBorder)';
			element.append(probe);
			const expectedFocus = getComputedStyle(probe).color;
			probe.style.color = 'var(--ash-contrastBorder, var(--ash-widget-border))';
			const expectedBorder = getComputedStyle(probe).color;
			probe.remove();
			return { background: style.backgroundColor, border: style.borderTopWidth, borderColor: style.borderTopColor, focus: inputStyle.borderTopColor, focusWidth: inputStyle.borderTopWidth, expectedFocus, expectedBorder };
		});
		expect(appearance.background).not.toBe('rgba(0, 0, 0, 0)');
		expect(appearance.border).toBe('1px');
		expect(appearance.focus).not.toBe('rgba(0, 0, 0, 0)');
		expect(appearance.focus).toBe(appearance.expectedFocus);
		expect(appearance.focusWidth).toBe('1px');
		expect(appearance.borderColor).toBe(appearance.expectedBorder);
	}
	await page.setViewportSize({ width: 320, height: 600 });
	await page.evaluate(() => { document.querySelector<HTMLElement>('#terminal')!.style.width = '100%'; });
	const bounds = await find.boundingBox();
	expect(bounds!.x).toBeGreaterThanOrEqual(0);
	expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
	await input.press('Escape');
	await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

test('program text follows child paste mode while raw keyboard input stays unchanged', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?input');
	await page.waitForFunction(() => Boolean(window.ashTerminalInputIntegration));
	// A startup device query proves input was bound before the first output was parsed.
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([expect.stringMatching(/^\x1b\[\?[\d;]+c$/u)]);
	await page.evaluate(() => window.ashTerminalInputIntegration.clear());
	await page.keyboard.press('Control+j');
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['\n']);
	await page.evaluate(() => window.ashTerminalInputIntegration.send('one\r\ntwo\n', false, true));
	await page.evaluate(() => window.ashTerminalInputIntegration.feed('\x1b[?2004h'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.pasteMode())).toBe(true);
	await page.evaluate(() => window.ashTerminalInputIntegration.send('three\nfour', true, true));
	await page.evaluate(() => window.ashTerminalInputIntegration.feed('\x1b[?2004l'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.pasteMode())).toBe(false);
	await page.evaluate(() => window.ashTerminalInputIntegration.send('done\r', true, true));
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['\n', 'one\rtwo\r', '\x1b[200~three\rfour\x1b[201~\r', 'done\r']);
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
	expect(errors).toEqual([]);
});

test('instance reattachment preserves its screen and binds raw input only once', async ({ page }) => {
	await page.goto('/terminal.html?input');
	await page.waitForFunction(() => Boolean(window.ashTerminalInputIntegration));
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toContain('retained screen');
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes.length)).toBe(1);
	await page.evaluate(() => window.ashTerminalInputIntegration.clear());
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.reattach())).toBe(true);
	await expect(page.locator('.xterm-helper-textarea').last()).toBeFocused();
	await page.keyboard.type('after');
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes.filter(value => typeof value === 'string').join(''))).toBe('after');
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toContain('retained screen');
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
	await expect(page.locator('.ash-terminal-instance')).toHaveCount(0);
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.hasScreen())).toBe(false);
});

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

test('terminal loads xterm on demand and preserves early display writes and first input', async ({ page }) => {
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
	});
	expect(await page.evaluate(() => window.ashTerminalIntegration.start())).toBe(true);
	await page.evaluate(() => window.ashTerminalIntegration.ready());
	await expect(page.locator('.xterm-rows')).toHaveText(/first.*second/su);
	await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
	await page.keyboard.type('hello');
	expect(await page.evaluate(() => window.ashTerminalIntegration.writes.join(''))).toBe('hello');
	expect(requests.some(url => /(?:xterm_xterm|xterm\/lib\/xterm|\/xterm-[^/]+\.js)/u.test(url))).toBe(true);
	await page.evaluate(() => window.ashTerminalIntegration.dispose());
	await expect(page.locator('.ash-terminal-instance')).toHaveCount(0);
	expect(errors).toEqual([]);
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

test('terminal relaunch preserves focus moved while the process restarts', async ({ page }) => {
	await page.goto('/terminal.html?pane&existing&exited');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
	await expect(page.locator('.xterm')).toHaveCount(1);
	await page.evaluate(() => window.ashTerminalPaneIntegration.hold());
	await page.locator('.ash-terminal-title-toolbar [data-action-id="ash.toolbar.moreActions"] button').click();
	await page.getByRole('menuitem', { name: 'Relaunch Terminal', exact: true }).focus();
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

test('legacy mouse reports deliver their raw high bytes through xterm onBinary', async ({ page }) => {
	await page.setViewportSize({ width: 1500, height: 600 });
	await page.goto('/terminal.html?input');
	await page.waitForFunction(() => Boolean(window.ashTerminalInputIntegration));
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes.length)).toBe(1);
	await page.evaluate(() => {
		document.querySelector<HTMLElement>('#terminal')!.style.width = '1400px';
		window.ashTerminalInputIntegration.clear();
		window.ashTerminalInputIntegration.feed('\x1b[?1000h');
	});
	const screen = page.locator('.xterm-screen');
	await expect(screen).toBeVisible();
	await expect.poll(async () => (await screen.boundingBox())?.width ?? 0).toBeGreaterThan(1100);
	await expect.poll(async () => {
		await screen.click({ position: { x: 1100, y: 20 } });
		return page.evaluate(() => window.ashTerminalInputIntegration.writes.some(value => Array.isArray(value) && value.some(byte => byte >= 0x80)));
	}).toBe(true);
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes.filter(value => typeof value === 'string'))).toEqual([]);
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

for (const locale of ['en', 'zh-CN']) {
	test(`terminal retains process output consumed before screen creation and its exit (${locale})`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/terminal.html?stream&deferred&locale=${locale}`);
		await page.waitForFunction(() => Boolean(window.ashTerminalStreamIntegration));
		await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.status())).toEqual({ reads: [0, 1], events: ['succeeded', 'exit'], closes: 0, state: 'exited', remaining: 1 });
		expect(await page.evaluate(() => window.ashTerminalStreamIntegration.observed())).toBe('中文🙂\r\n');
		await expect(page.locator('.xterm')).toHaveCount(0);
		await page.locator('#outside').focus();
		await page.evaluate(() => window.ashTerminalStreamIntegration.start());
		await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.snapshot())).toBe('中文🙂');
		await page.evaluate(() => window.ashTerminalStreamIntegration.close());
		await expect(page.locator('.ash-terminal-instance')).toHaveCount(0);
		expect(errors).toEqual([]);
	});
}

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

test('hidden terminal view exposes its retained output without changing focus or creating a shell', async ({ page }) => {
	await page.goto('/terminal.html?pane&existing');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(() => window.ashTerminalIntegration.write('hidden output\r\n'));
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.snapshot())).toBe('hidden output');
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.counts())).toEqual({ profiles: 0, creates: 0 });
	await expect(page.locator('.ash-terminal-instance:visible')).toHaveCount(0);
});

test('terminal screen follows light, dark and high contrast themes after initialization', async ({ page }) => {
	await page.goto('/terminal.html?browser');
	await page.waitForFunction(() => Boolean(window.ashTerminalIntegration));
	await page.evaluate(async () => { window.ashTerminalIntegration.start(); await window.ashTerminalIntegration.ready(); });
	for (const [mode, expected] of [
		['dark', { background: '#252526', foreground: '#d4d4d4', red: '#cf222e' }],
		['light', { background: '#f8f8f8', foreground: '#333333', red: '#cf222e' }],
		['hcDark', { background: '#000000', foreground: '#ffffff', red: '#ff8080' }],
		['hcLight', { background: '#ffffff', foreground: '#000000', red: '#a00000' }],
	] as const) {
		expect(await page.evaluate(mode => window.ashTerminalIntegration.theme(mode), mode)).toEqual(expected);
		const background = mode === 'hcDark' ? 'rgb(0, 0, 0)' : mode === 'dark' ? 'rgb(37, 37, 38)' : mode === 'light' ? 'rgb(248, 248, 248)' : 'rgb(255, 255, 255)';
		await expect(page.locator('.xterm-scrollable-element')).toHaveCSS('background-color', background);
		await expect(page.locator('.xterm-viewport')).toHaveCSS('background-color', background);
	}
	await page.evaluate(() => window.ashTerminalIntegration.dispose());
});

test('Windows revival preserves history across fragmented initial ConPTY paint and allows later clear', async ({ page }) => {
	await page.goto('/terminal.html?stream&commandModel&reviveHistory');
	await page.waitForFunction(() => Boolean(window.ashTerminalStreamIntegration));
	await page.evaluate(() => window.ashTerminalStreamIntegration.start());
	await expect(page.locator('.xterm-rows')).toContainText('PS NEW>');
	expect(await page.evaluate(() => window.ashTerminalStreamIntegration.snapshot())).toContain('SAVED_HISTORY');
	await page.evaluate(() => window.ashTerminalStreamIntegration.feedModel('\x1b[2J\x1b[3J\x1b[HAFTER_CLEAR'));
	await expect(page.locator('.xterm-rows')).toContainText('AFTER_CLEAR');
	expect(await page.evaluate(() => window.ashTerminalStreamIntegration.snapshot())).not.toContain('SAVED_HISTORY');
	await page.evaluate(() => window.ashTerminalStreamIntegration.close());
});

test('child alternate scroll mode controls wheel input and restores its saved value', async ({ page }) => {
	await page.goto('/terminal.html');
	await page.waitForFunction(() => Boolean(window.ashTerminalIntegration));
	await page.evaluate(async () => { window.ashTerminalIntegration.start(); await window.ashTerminalIntegration.ready(); });
	const screen = page.locator('.xterm-screen');
	await page.evaluate(async () => {
		window.ashTerminalIntegration.write('\x1b[?1049h\x1b[?1007h\x1b[?1007s\x1b[?1007l');
		await window.ashTerminalIntegration.snapshot(1000);
	});
	await screen.hover();
	await page.mouse.wheel(0, 60);
	// The same subsequent key proves the wheel had time to traverse the renderer's input queue.
	await page.keyboard.type('x');
	await expect.poll(() => page.evaluate(() => window.ashTerminalIntegration.writes.join(''))).toBe('x');
	await page.evaluate(async () => {
		window.ashTerminalIntegration.write('\x1b[?1007r');
		await window.ashTerminalIntegration.snapshot(1000);
	});
	await page.mouse.wheel(0, 60);
	await expect.poll(() => page.evaluate(() => window.ashTerminalIntegration.writes.join(''))).toMatch(/^x(?:\x1b\[B)+$/u);
	await page.evaluate(() => window.ashTerminalIntegration.dispose());
});

test('terminal quick fixes preserve current input and cancel when command output is cleared', async ({ page }) => {
	await page.goto('/terminal.html?stream&commandModel');
	await page.waitForFunction(() => Boolean(window.ashTerminalStreamIntegration));
	await page.evaluate(() => window.ashTerminalStreamIntegration.start());
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.model().input)).toBe('|');
	await page.evaluate(() => window.ashTerminalStreamIntegration.feedModel('pending command'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.model().input)).toBe('pending command|');
	const before = await page.evaluate(() => window.ashTerminalStreamIntegration.quickFix.writes());
	const blocked = page.evaluate(() => window.ashTerminalStreamIntegration.quickFix.command());
	const picker = page.getByRole('combobox', { name: 'Terminal Quick Fixes', exact: true });
	await expect(picker).toHaveAttribute('placeholder', 'Quick fixes require an empty shell prompt; current input is preserved');
	await expect(page.getByRole('option')).toHaveCount(0);
	await picker.press('Escape');
	await blocked;
	expect(await page.evaluate(() => window.ashTerminalStreamIntegration.quickFix.writes())).toEqual(before);
	await page.evaluate(() => {
		const fixture = window.ashTerminalStreamIntegration;
		fixture.feedModel('\r\n');
		fixture.environmentFrame({ type: 'commandExecuted', commandId: 'other', command: 'git push', isTrusted: true, cwd: '/workspace', timestampMillis: 201 });
		fixture.feedModel('fatal: The current branch topic has no upstream branch.\r\n    git push --set-upstream origin topic\r\n');
		fixture.environmentFrame({ type: 'commandFinished', exitCode: 1, durationMillis: 1 });
		fixture.environmentFrame({ type: 'promptStart' });
		fixture.feedModel('$ ');
		fixture.environmentFrame({ type: 'commandStart' });
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.model().input)).toBe('|');
	const stale = page.evaluate(() => window.ashTerminalStreamIntegration.quickFix.command());
	await expect(page.getByRole('option')).toContainText('git push --set-upstream origin topic');
	await page.evaluate(() => window.ashTerminalStreamIntegration.clearModel());
	await stale;
	await expect(picker).toBeHidden();
	expect(await page.evaluate(() => window.ashTerminalStreamIntegration.quickFix.writes())).toEqual(before);
	await page.evaluate(() => window.ashTerminalStreamIntegration.close());
});

for (const clipboardFirst of [false, true]) test(`terminal clipboard commands copy the parsed selection and preserve Shell Ctrl+C (clipboard first: ${clipboardFirst})`, async ({ page }) => {
	await page.goto(`/terminal.html?input&clipboard${clipboardFirst ? '&clipboardFirst' : ''}`);
	await page.waitForFunction(() => Boolean(window.ashTerminalClipboardIntegration));
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toContain('retained screen');
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([expect.stringMatching(/^\x1b\[\?[\d;]+c$/u)]);
	await page.evaluate(() => { window.ashTerminalInputIntegration.clear(); window.ashTerminalClipboardIntegration.select(0, 8); });
	await expect.poll(() => page.evaluate(() => window.ashTerminalClipboardIntegration.selectedContext())).toBe(true);
	const copyKey = await page.evaluate(() => /Mac/u.test(navigator.platform) ? 'Meta+c' : 'Control+Shift+c');
	await page.keyboard.press(copyKey);
	await expect.poll(() => page.evaluate(() => window.ashTerminalClipboardIntegration.copied)).toEqual(['retained']);
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
	await page.getByRole('textbox', { name: 'Outside terminal' }).focus();
	expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.selectedContext())).toBe(false);
	await page.locator('.xterm-helper-textarea').focus();
	expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.selectedContext())).toBe(true);
	await page.evaluate(() => window.ashTerminalClipboardIntegration.command('workbench.action.terminal.copyAndClearSelection'));
	expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.copied)).toEqual(['retained', 'retained']);
	expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.selection())).toBe('');
	expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.selectedContext())).toBe(false);
	await page.keyboard.press('Control+c');
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['\x03']);
	await page.evaluate(() => window.ashTerminalClipboardIntegration.command('workbench.action.terminal.copySelection'));
	expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.copied)).toEqual(['retained', 'retained']);
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

test('terminal selection auto-copy and right-click copy/paste use the live terminal selection', async ({ page }) => {
	await page.goto('/terminal.html?input&clipboard');
	await page.waitForFunction(() => Boolean(window.ashTerminalClipboardIntegration));
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toContain('retained screen');
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toContain('\x1b[?1;2c');
	await page.evaluate(async () => {
		window.ashTerminalInputIntegration.clear();
		await window.ashTerminalIntegration.configure('terminal.integrated.copyOnSelection', true);
		await window.ashTerminalIntegration.configure('terminal.integrated.rightClickBehavior', 'copyPaste');
		window.ashTerminalClipboardIntegration.select(0, 8);
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalClipboardIntegration.copied)).toEqual(['retained']);
	await page.locator('.xterm-screen').click({ button: 'right' });
	await expect.poll(() => page.evaluate(() => window.ashTerminalClipboardIntegration.copied)).toEqual(['retained', 'retained']);
	expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.selection())).toBe('');
	await page.evaluate(() => window.ashTerminalClipboardIntegration.setText('from right click'));
	await page.locator('.xterm-screen').click({ button: 'right' });
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['from right click']);
	await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
	await page.evaluate(async () => {
		await window.ashTerminalIntegration.configure('terminal.integrated.copyOnSelection', false);
		window.ashTerminalClipboardIntegration.select(9, 6);
		await window.ashTerminalIntegration.configure('terminal.integrated.rightClickBehavior', 'paste');
	});
	await page.locator('.xterm-screen').click({ button: 'right' });
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['from right click', 'from right click']);
	expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.copied)).toEqual(['retained', 'retained']);
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

test('terminal right-click paste drops clipboard text after focus leaves and returns', async ({ page }) => {
	await page.goto('/terminal.html?input&clipboard');
	await page.waitForFunction(() => Boolean(window.ashTerminalClipboardIntegration));
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toContain('\x1b[?1;2c');
	await page.evaluate(async () => {
		window.ashTerminalInputIntegration.clear();
		await window.ashTerminalIntegration.configure('terminal.integrated.rightClickBehavior', 'paste');
		window.ashTerminalClipboardIntegration.hold();
	});
	await page.locator('.xterm-screen').click({ button: 'right' });
	await expect.poll(() => page.evaluate(() => window.ashTerminalClipboardIntegration.reads())).toBe(1);
	await page.getByRole('textbox', { name: 'Outside terminal' }).focus();
	await page.locator('.xterm-helper-textarea').focus();
	await page.evaluate(() => window.ashTerminalClipboardIntegration.release('stale right click'));
	// A fresh awaited command runs behind the old read's continuation and proves
	// it completed without injecting the stale clipboard text.
	await page.evaluate(async () => {
		window.ashTerminalClipboardIntegration.setText('fresh');
		await window.ashTerminalClipboardIntegration.command('workbench.action.terminal.paste');
	});
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['fresh']);
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

for (const clipboardFirst of [false, true]) test(`terminal clipboard paste uses acknowledged input and the current child paste mode (clipboard first: ${clipboardFirst})`, async ({ page }) => {
	await page.goto(`/terminal.html?input&clipboard${clipboardFirst ? '&clipboardFirst' : ''}`);
	await page.waitForFunction(() => Boolean(window.ashTerminalClipboardIntegration));
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toContain('retained screen');
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([expect.stringMatching(/^\x1b\[\?[\d;]+c$/u)]);
	await page.evaluate(() => { window.ashTerminalInputIntegration.clear(); window.ashTerminalClipboardIntegration.setText('中文\r\nsecond'); });
	const pasteKey = await page.evaluate(() => /Mac/u.test(navigator.platform) ? 'Meta+v' : /Linux/u.test(navigator.platform) ? 'Control+Shift+v' : 'Control+v');
	await page.keyboard.press(pasteKey);
	await expect(page.getByRole('dialog')).toBeVisible();
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
	await page.getByRole('button', { name: 'Paste', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['中文\rsecond']);
	expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.reads())).toBe(1);
	await page.evaluate(() => window.ashTerminalInputIntegration.feed('\x1b[?2004h'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.pasteMode())).toBe(true);
	await page.evaluate(async () => { window.ashTerminalInputIntegration.clear(); await window.ashTerminalClipboardIntegration.command('workbench.action.terminal.paste'); });
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['\x1b[200~中文\rsecond\x1b[201~']);
	await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
	await page.getByRole('textbox', { name: 'Outside terminal' }).focus();
	await page.keyboard.press(pasteKey);
	expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.reads())).toBe(2);
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

for (const locale of ['en', 'zh-CN']) {
	test(`terminal multi-line paste choices preserve whitespace and remember accepted preferences in ${locale}`, async ({ page }) => {
		await page.goto(`/terminal.html?input&clipboard&locale=${locale}`);
		await page.waitForFunction(() => Boolean(window.ashTerminalClipboardIntegration));
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toContain('\x1b[?1;2c');
		const text = ' echo first \r\n\techo second \rthird\n';
		await page.evaluate(text => {
			window.ashTerminalInputIntegration.clear();
			window.ashTerminalClipboardIntegration.setText(text);
			window.ashTerminalClipboardIntegration.beginPaste();
		}, text);
		const dialog = page.getByRole('dialog', { name: locale === 'zh-CN' ? '粘贴到终端' : 'Paste into Terminal', exact: true });
		const remember = dialog.getByRole('checkbox', { name: locale === 'zh-CN' ? '不再询问' : 'Do Not Ask Again', exact: true });
		const paste = dialog.getByRole('button', { name: locale === 'zh-CN' ? '粘贴' : 'Paste', exact: true });
		const singleLine = dialog.getByRole('button', { name: locale === 'zh-CN' ? '粘贴为一行' : 'Paste as One Line', exact: true });
		await expect(dialog).toBeVisible();
		await remember.focus();
		await page.keyboard.press('Space');
		await expect(remember).toBeChecked();
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.finish())).toBeUndefined();
		expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
		expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.warningPolicy())).toEqual({ value: 'auto', persisted: null });
		await expect(page.locator('.xterm-helper-textarea')).toBeFocused();

		await page.evaluate(() => window.ashTerminalClipboardIntegration.beginPaste());
		await expect(dialog).toBeVisible();
		await expect(remember).not.toBeChecked();
		await paste.focus();
		await page.keyboard.press('Tab');
		await expect(singleLine).toBeFocused();
		await page.keyboard.press('Enter');
		expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.finish())).toBeUndefined();
		expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([' echo first \techo second third']);
		await expect(page.locator('.xterm-helper-textarea')).toBeFocused();

		await page.evaluate(() => { window.ashTerminalInputIntegration.clear(); window.ashTerminalClipboardIntegration.beginPaste(); });
		await expect(dialog).toBeVisible();
		await remember.focus();
		await page.keyboard.press('Space');
		await expect(remember).toBeChecked();
		await paste.focus();
		await page.keyboard.press('Enter');
		expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.finish())).toBeUndefined();
		expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([' echo first \r\techo second \rthird\r']);
		expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.warningPolicy())).toEqual({ value: 'never', persisted: 'never' });
		await page.evaluate(async () => {
			window.ashTerminalInputIntegration.clear();
			await window.ashTerminalClipboardIntegration.command('workbench.action.terminal.paste');
		});
		await expect(dialog).toHaveCount(0);
		expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([' echo first \r\techo second \rthird\r']);
		await page.evaluate(() => window.ashTerminalInputIntegration.close());
	});
}

for (const browserPaste of [false, true]) {
	test(`terminal multi-line ${browserPaste ? 'browser' : 'command'} paste cancels with Escape and accepts once`, async ({ page }) => {
		await page.goto('/terminal.html?input&clipboard');
		await page.waitForFunction(() => Boolean(window.ashTerminalClipboardIntegration));
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toContain('retained screen');
		await page.evaluate(() => window.ashTerminalInputIntegration.clear());
		const paste = async () => {
			if (browserPaste) {
				await page.locator('.xterm-helper-textarea').evaluate(element => {
					const data = new DataTransfer();
					data.setData('text/plain', 'first\r\nsecond');
					element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
				});
			} else {
				await page.evaluate(() => { window.ashTerminalClipboardIntegration.setText('first\r\nsecond'); window.ashTerminalClipboardIntegration.beginPaste(); });
			}
		};
		await paste();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByRole('dialog')).toContainText('first\nsecond');
		expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
		expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
		await paste();
		await page.getByRole('button', { name: 'Paste', exact: true }).focus();
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['first\rsecond']);
		await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
		expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.reads())).toBe(browserPaste ? 0 : 2);
		await page.evaluate(() => window.ashTerminalInputIntegration.close());
	});
}

for (const transition of ['close', 'switch', 'disconnect'] as const) {
	test(`terminal multi-line confirmation drops its paste after ${transition}`, async ({ page }) => {
		await page.goto('/terminal.html?input&clipboard');
		await page.waitForFunction(() => Boolean(window.ashTerminalClipboardIntegration));
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toContain('retained screen');
		// The fixture asks for device attributes. Its asynchronous reply must finish
		// before clearing input observations for the paste cancellation assertion.
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toContain('\x1b[?1;2c');
		await page.evaluate(() => { window.ashTerminalInputIntegration.clear(); window.ashTerminalClipboardIntegration.setText('old\ncommand'); window.ashTerminalClipboardIntegration.beginPaste(); });
		await expect(page.getByRole('dialog')).toBeVisible();
		if (transition === 'close') await page.evaluate(() => window.ashTerminalInputIntegration.close());
		else if (transition === 'disconnect') await page.evaluate(() => window.ashTerminalClipboardIntegration.disconnect());
		else await page.evaluate(async () => { await window.ashTerminalClipboardIntegration.switchAway(); window.ashTerminalClipboardIntegration.switchBack(); });
		await page.getByRole('button', { name: 'Paste', exact: true }).click();
		expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.finish())).toBeUndefined();
		expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
		if (transition !== 'close') await page.evaluate(() => window.ashTerminalInputIntegration.close());
	});
}

test('terminal multi-line warning policy reloads and always confirms bracketed paste in Chinese', async ({ page }) => {
	await page.goto('/terminal.html?input&clipboard&locale=zh-CN');
	await page.waitForFunction(() => Boolean(window.ashTerminalClipboardIntegration));
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toContain('retained screen');
	await page.evaluate(async () => {
		await window.ashTerminalIntegration.configure('terminal.integrated.enableMultiLinePasteWarning', 'always');
		window.ashTerminalInputIntegration.feed('\x1b[?2004h');
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.pasteMode())).toBe(true);
	await page.evaluate(() => { window.ashTerminalInputIntegration.clear(); window.ashTerminalClipboardIntegration.setText('中文\n命令'); window.ashTerminalClipboardIntegration.beginPaste(); });
	await expect(page.getByRole('dialog', { name: '粘贴到终端' })).toBeVisible();
	await expect(page.getByRole('dialog')).toContainText('要将多行文本粘贴到终端吗？');
	await page.getByRole('button', { name: '粘贴', exact: true }).click();
	await page.evaluate(() => window.ashTerminalClipboardIntegration.finish());
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['\x1b[200~中文\r命令\x1b[201~']);
	await page.evaluate(async () => {
		await window.ashTerminalIntegration.configure('terminal.integrated.enableMultiLinePasteWarning', 'never');
		window.ashTerminalInputIntegration.clear();
		await window.ashTerminalClipboardIntegration.command('workbench.action.terminal.paste');
	});
	await expect(page.getByRole('dialog')).toHaveCount(0);
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['\x1b[200~中文\r命令\x1b[201~']);
	expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.help())).toContain('始终模式即使在括号粘贴模式下也确认换行');
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

for (const transition of ['close', 'switch', 'disconnect'] as const) {
	test(`terminal clipboard drops a delayed read after ${transition}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/terminal.html?input&clipboard');
		await page.waitForFunction(() => Boolean(window.ashTerminalClipboardIntegration));
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toContain('retained screen');
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([expect.stringMatching(/^\x1b\[\?[\d;]+c$/u)]);
		await page.evaluate(() => { window.ashTerminalInputIntegration.clear(); window.ashTerminalClipboardIntegration.hold(); window.ashTerminalClipboardIntegration.beginPaste(); });
		await expect.poll(() => page.evaluate(() => window.ashTerminalClipboardIntegration.reads())).toBe(1);
		if (transition === 'close') await page.evaluate(() => window.ashTerminalInputIntegration.close());
		else if (transition === 'disconnect') expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.disconnect())).toBe('disconnected');
		else await page.evaluate(async () => { await window.ashTerminalClipboardIntegration.switchAway(); window.ashTerminalClipboardIntegration.switchBack(); });
		await page.evaluate(() => window.ashTerminalClipboardIntegration.release('stale command'));
		expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.finish())).toBeUndefined();
		expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
		if (transition === 'switch') {
			await page.evaluate(async () => { window.ashTerminalClipboardIntegration.setText('fresh'); await window.ashTerminalClipboardIntegration.command('workbench.action.terminal.paste'); });
			expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['fresh']);
		}
		if (transition !== 'close') await page.evaluate(() => window.ashTerminalInputIntegration.close());
		expect(errors).toEqual([]);
	});
}

test('terminal clipboard read failures reject the command without entering stdin', async ({ page }) => {
	await page.goto('/terminal.html?input&clipboard');
	await page.waitForFunction(() => Boolean(window.ashTerminalClipboardIntegration));
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toContain('retained screen');
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([expect.stringMatching(/^\x1b\[\?[\d;]+c$/u)]);
	await page.evaluate(() => { window.ashTerminalInputIntegration.clear(); window.ashTerminalClipboardIntegration.hold(); window.ashTerminalClipboardIntegration.beginPaste(); });
	await expect.poll(() => page.evaluate(() => window.ashTerminalClipboardIntegration.reads())).toBe(1);
	await page.evaluate(() => window.ashTerminalClipboardIntegration.reject());
	expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.finish())).toBe('Clipboard access denied');
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

test('terminal clipboard commands and accessibility help are localized in Chinese', async ({ page }) => {
	await page.goto('/terminal.html?input&clipboard&locale=zh-CN');
	await page.waitForFunction(() => Boolean(window.ashTerminalClipboardIntegration));
	expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.title('workbench.action.terminal.copySelection'))).toBe('终端：复制选区');
	expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.title('workbench.action.terminal.paste'))).toBe('终端：粘贴到活动终端');
	const help = await page.evaluate(() => window.ashTerminalClipboardIntegration.help());
	expect(help).toContain('复制选中的终端文本');
	expect(help).toContain('将剪贴板文本粘贴到当前正在运行的终端');
	expect(help).toContain('“选中即复制”可以自动复制选中的终端文本');
	expect(help).toContain('终端实例菜单中的“复制”和“粘贴”操作该菜单对应的终端');
	await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

for (const failed of [false, true]) {
	test(`terminal clipboard paste ${failed ? 'rejects a failed' : 'waits for the'} process acknowledgement`, async ({ page }) => {
		await page.goto('/terminal.html?input&clipboard');
		await page.waitForFunction(() => Boolean(window.ashTerminalClipboardIntegration));
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([expect.stringMatching(/^\x1b\[\?[\d;]+c$/u)]);
		await page.evaluate(() => {
			window.ashTerminalInputIntegration.clear(); window.ashTerminalClipboardIntegration.setText('acknowledged');
			window.ashTerminalClipboardIntegration.holdInput(); window.ashTerminalClipboardIntegration.beginPaste();
		});
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['acknowledged']);
		expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.finished())).toBe(false);
		await page.evaluate(failed => window.ashTerminalClipboardIntegration.releaseInput(failed), failed);
		expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.finish())).toBe(failed ? 'Terminal write denied' : undefined);
		expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.finished())).toBe(true);
		await page.evaluate(() => window.ashTerminalInputIntegration.close());
	});
}

for (const locale of ['en', 'zh-CN']) test(`terminal clipboard menu retains its target after active selection changes in ${locale}`, async ({ page }) => {
	await page.goto(`/terminal.html?input&groups&clipboard&browser&locale=${locale}`);
	await page.waitForFunction(() => Boolean(window.ashTerminalClipboardIntegration));
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toContain('retained screen');
	await page.evaluate(async () => {
		window.ashTerminalClipboardIntegration.select(0, 8);
		await window.ashTerminalClipboardIntegration.switchAway();
		window.ashTerminalClipboardIntegration.switchBack();
	});
	const tabs = page.getByRole('tablist', { name: locale === 'en' ? 'Terminal instances' : '终端实例' });
	await expect(tabs.getByRole('tab')).toHaveCount(2);
	await tabs.getByRole('tab').first().click({ button: 'right' });
	await page.evaluate(() => window.ashTerminalClipboardIntegration.activateOther());
	await page.getByRole('menuitem', { name: locale === 'en' ? 'Copy' : '复制', exact: true }).click();
	expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.copied)).toEqual(['retained']);
	await page.evaluate(() => window.ashTerminalClipboardIntegration.activateOriginal());
	await tabs.getByRole('tab').first().click({ button: 'right' });
	await page.evaluate(() => {
		window.ashTerminalClipboardIntegration.activateOther();
		window.ashTerminalClipboardIntegration.setText('menu target text');
		window.ashTerminalGroupsIntegration.clearWrites();
	});
	await page.getByRole('menuitem', { name: locale === 'en' ? 'Paste' : '粘贴', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.writes())).toEqual([{ terminalId: 'input-shell-1', data: 'menu target text' }]);
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});
for (const [theme, locale] of [['light', 'en'], ['dark', 'zh-CN'], ['hcDark', 'en'], ['hcLight', 'zh-CN']] as const) {
	test(`terminal row actions reveal only on hover or list focus in ${theme}/${locale}`, async ({ page }, testInfo) => {
		await page.goto(`/terminal.html?pane&profiles&browser&locale=${locale}`);
		await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
		await page.evaluate(async theme => {
			window.ashTerminalPaneIntegration.theme(theme);
			window.ashTerminalPaneIntegration.panel(true);
			await window.ashTerminalPaneIntegration.command('workbench.action.terminal.new');
			await window.ashTerminalPaneIntegration.command('workbench.action.terminal.new');
		}, theme);
		const rows = page.locator('.ash-terminal-tabs .ash-tab');
		await expect(rows).toHaveCount(3);
		const ids = await page.evaluate(() => window.ashTerminalPaneIntegration.ids());
		const outside = page.getByRole('textbox', { name: 'Outside terminal', exact: true });
		await outside.focus();
		await outside.hover();
		const actions = (index: number) => rows.nth(index).locator('.ash-tab-actions');
		for (const index of [0, 1, 2]) await expect(actions(index)).toBeHidden();
		for (const hovered of [0, 1, 2]) {
			await rows.nth(hovered).hover();
			for (const index of [0, 1, 2]) {
				if (index === hovered) {
					await expect(actions(index)).toBeVisible();
					await expect(actions(index).getByRole('button')).toHaveCount(2);
				} else {
					await expect(actions(index)).toBeHidden();
				}
			}
		}
		await outside.hover();
		const firstTab = rows.first().getByRole('tab');
		await firstTab.focus();
		await expect(actions(0)).toBeVisible();
		await expect(actions(1)).toBeHidden();
		await expect(actions(2)).toBeVisible();
		await firstTab.press('Tab');
		const split = actions(0).getByRole('button', { name: locale === 'zh-CN' ? '拆分终端' : 'Split Terminal', exact: true });
		await expect(split).toBeFocused();
		await expect(split).toBeVisible();
		await split.press('ArrowRight');
		await expect(actions(0).locator('.ash-tab-close-action button')).toBeFocused();
		await outside.focus();
		for (const index of [0, 1, 2]) await expect(actions(index)).toBeHidden();
		await rows.first().hover();
		await page.screenshot({ path: testInfo.outputPath(`terminal-row-actions-${theme}.png`) });
		await actions(0).locator('.ash-tab-close-action button').click();
		await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.operations().closed)).toEqual([ids[0]]);
		await expect(rows).toHaveCount(2);
		await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
	});
}

test('terminal browser list menu supports keyboard dismissal and Chinese labels', async ({ page }) => {
	await page.goto('/terminal.html?pane&browser&locale=zh-CN');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
	await expect(page.locator('.xterm')).toHaveCount(1);
	await page.evaluate(() => window.ashTerminalPaneIntegration.command('workbench.action.terminal.new'));
	const tab = page.getByRole('tablist', { name: '终端实例' }).getByRole('tab').first();
	await tab.focus();
	expect((await page.evaluate(() => window.ashTerminalPaneIntegration.menuActions())).slice().sort()).toEqual(['复制', '粘贴', '取消终端拆分', '合并或调整终端顺序...', '拆分终端', '清除终端', '终止终端', '聚焦终端', '重命名终端', '更改终端图标', '将终端移入编辑区', '终端：附加到聊天', '重新启动终端'].sort());
	await tab.press('Shift+F10');
	await expect(page.getByRole('menu')).toBeVisible();
	await expect(page.getByRole('menuitem', { name: '聚焦终端', exact: true })).toBeVisible();
	await expect(page.getByRole('menuitem', { name: '清除终端', exact: true })).toBeVisible();
	await expect(page.getByRole('menuitem', { name: '终止终端', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('menu')).toHaveCount(0);
	await expect(tab).toBeFocused();
	await tab.press('ArrowDown');
	await expect(page.getByRole('tablist', { name: '终端实例' }).getByRole('tab').last()).toBeFocused();
	await page.keyboard.press('Enter');
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.activeId())).toBe((await page.evaluate(() => window.ashTerminalPaneIntegration.ids()))[1]);
	await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
});

test('terminal browser resize preserves scrollback while coalescing horizontal reflow', async ({ page }) => {
	await page.goto('/terminal.html?browser');
	await page.waitForFunction(() => Boolean(window.ashTerminalIntegration));
	await page.evaluate(async () => {
		window.ashTerminalIntegration.start(); await window.ashTerminalIntegration.ready();
		window.ashTerminalIntegration.write(Array.from({ length: 320 }, (_, index) => `line-${index}\r\n`).join(''));
		await window.ashTerminalIntegration.snapshot(100_000);
	});
	const result = await page.evaluate(() => {
		const before = window.ashTerminalIntegration.dimensions();
		const root = document.querySelector<HTMLElement>('#terminal')!;
		root.style.width = '900px'; root.style.height = '430px';
		window.ashTerminalIntegration.fit();
		return { before, immediate: window.ashTerminalIntegration.dimensions() };
	});
	expect(result.immediate.cols).toBe(result.before.cols);
	expect(result.immediate.rows).toBeGreaterThan(result.before.rows);
	await expect.poll(() => page.evaluate(() => window.ashTerminalIntegration.dimensions().cols)).toBeGreaterThan(result.before.cols);
	expect(await page.evaluate(() => window.ashTerminalIntegration.snapshot(100_000))).toContain('line-319');
	expect(await page.evaluate(() => window.ashTerminalIntegration.snapshot(100_000))).toContain('line-0');
	await page.evaluate(() => window.ashTerminalIntegration.dispose());
});

test('terminal browser resize flushes before focus and cancels pending work on disposal', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?browser');
	await page.waitForFunction(() => Boolean(window.ashTerminalIntegration));
	await page.evaluate(async () => {
		window.ashTerminalIntegration.start(); await window.ashTerminalIntegration.ready();
		window.ashTerminalIntegration.write('retained\r\n'.repeat(320)); await window.ashTerminalIntegration.snapshot(100_000);
	});
	await page.clock.install();
	const sizes = await page.evaluate(() => {
		const root = document.querySelector<HTMLElement>('#terminal')!;
		const before = window.ashTerminalIntegration.dimensions();
		root.style.width = '950px'; window.ashTerminalIntegration.fit();
		const queued = window.ashTerminalIntegration.dimensions();
		window.ashTerminalIntegration.start();
		return { before, queued, focused: window.ashTerminalIntegration.dimensions() };
	});
	expect(sizes.queued.cols).toBe(sizes.before.cols);
	expect(sizes.focused.cols).toBeGreaterThan(sizes.before.cols);
	const writes = await page.evaluate(() => {
		document.querySelector<HTMLElement>('#terminal')!.style.width = '800px'; window.ashTerminalIntegration.fit();
		window.ashTerminalIntegration.dispose(); return [...window.ashTerminalIntegration.resizes];
	});
	await page.clock.runFor(250);
	expect(await page.evaluate(() => window.ashTerminalIntegration.resizes)).toEqual(writes);
	expect(errors).toEqual([]);
});

test('terminal configuration applies live options and keeps the existing screen output', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?browser');
	await page.waitForFunction(() => Boolean(window.ashTerminalIntegration));
	await page.evaluate(async () => {
		await window.ashTerminalIntegration.configure('terminal.integrated.fontSize', 16);
		window.ashTerminalIntegration.start(); await window.ashTerminalIntegration.ready();
		window.ashTerminalIntegration.write('configuration retained\r\n');
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalIntegration.snapshot(10000))).toContain('configuration retained');
	expect(await page.evaluate(() => window.ashTerminalIntegration.options().fontSize)).toBe(16);
	await page.evaluate(async () => {
		for (const [key, value] of Object.entries({ fontSize: 20, fontFamily: 'monospace', cursorStyle: 'line', cursorBlinking: true, scrollback: 2000, lineHeight: 1.2, letterSpacing: 2, minimumContrastRatio: 7 })) {
			await window.ashTerminalIntegration.configure(`terminal.integrated.${key}`, value);
		}
	});
	expect(await page.evaluate(() => window.ashTerminalIntegration.options())).toEqual({ fontSize: 20, fontFamily: 'monospace', cursorStyle: 'bar', cursorBlink: true, scrollback: 2000, lineHeight: 1.2, letterSpacing: 2, minimumContrastRatio: 7 });
	expect(await page.evaluate(() => window.ashTerminalIntegration.snapshot(10000))).toContain('configuration retained');
	expect(await page.evaluate(async () => {
		try { await window.ashTerminalIntegration.configure('terminal.integrated.fontSize', -1); return false; } catch { return true; }
	})).toBe(true);
	expect(await page.evaluate(() => window.ashTerminalIntegration.options().fontSize)).toBe(20);
	expect(errors).toEqual([]);
});

test('terminal split action layers the hovered half over its shared background', async ({ page }, testInfo) => {
	await page.goto('/terminal.html?pane&profiles&browser&workbench');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
	const toolbar = page.locator('.ash-terminal-title-toolbar');
	const split = toolbar.locator('.ash-dropdown-with-primary-action-view-item');
	const primary = toolbar.getByRole('button', { name: 'New Terminal', exact: true });
	const dropdown = toolbar.getByRole('button', { name: 'Select Terminal Profile', exact: true });
	await expect(primary).toBeEnabled();
	await expect(dropdown).toBeEnabled();
	await expect(split).toHaveCSS('gap', '0px');
	await expect(split).toHaveCSS('border-radius', '4px');
	await expect(primary).toHaveCSS('border-radius', '4px 0px 0px 4px');
	await expect(dropdown).toHaveCSS('border-radius', '0px 4px 4px 0px');
	const [left, right] = await Promise.all([primary.boundingBox(), dropdown.boundingBox()]);
	expect(left).not.toBeNull();
	expect(right).not.toBeNull();
	expect(right!.x).toBeCloseTo(left!.x + left!.width, 1);
	expect(right!.height).toBe(left!.height);
	for (const theme of ['light', 'dark', 'hcLight', 'hcDark'] as const) {
		await page.evaluate(theme => window.ashTerminalPaneIntegration.theme(theme), theme);
		await page.getByRole('textbox', { name: 'Outside terminal', exact: true }).hover();
		await expect(split).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		for (const [name, hovered, other] of [['primary', primary, dropdown], ['dropdown', dropdown, primary]] as const) {
			await hovered.hover();
			const groupBackground = await split.evaluate(element => getComputedStyle(element).backgroundColor);
			expect(groupBackground).not.toBe('rgba(0, 0, 0, 0)');
			await expect(hovered).toHaveCSS('background-color', groupBackground);
			await expect(other).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await toolbar.screenshot({ path: testInfo.outputPath(`${theme}-${name}-hover.png`) });
		}
	}
	await primary.focus();
	await primary.press('ArrowRight');
	await expect(dropdown).toBeFocused();
	await dropdown.press('ArrowDown');
	await expect(page.getByRole('menuitem', { name: 'Select Default Profile', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(dropdown).toBeFocused();
	await dropdown.press('ArrowLeft');
	await expect(primary).toBeFocused();
	await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
});

test('terminal title toolbar opens captured instance actions, splits with a profile and closes the last terminal', async ({ page }, testInfo) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?pane&profiles&browser');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
	await expect(page.locator('.xterm')).toHaveCount(1);
	const toolbar = page.locator('.ash-terminal-title-toolbar');
	await expect(toolbar.locator('.ash-dropdown-with-primary-dropdown .ash-dropdown-menu-indicator')).toBeVisible();
	const title = toolbar.locator('.ash-terminal-active-action button');
	await title.click();
	await expect(page.getByRole('menuitem', { name: 'Rename Terminal', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(title).toBeFocused();
	await title.press('ArrowRight');
	await expect(toolbar.getByRole('button', { name: 'New Terminal', exact: true })).toBeFocused();
	await page.keyboard.press('ArrowRight');
	await expect(toolbar.getByRole('button', { name: 'Select Terminal Profile', exact: true })).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(page.getByRole('menuitem', { name: 'Select Default Profile', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(toolbar.getByRole('button', { name: 'Select Terminal Profile', exact: true })).toBeFocused();
	await toolbar.getByRole('button', { name: 'New Terminal', exact: true }).click({ modifiers: ['Alt'] });
	await expect(page.locator('.ash-terminal-group-pane')).toHaveCount(2);
	await expect(title).toBeVisible();
	await toolbar.getByRole('button', { name: 'Select Terminal Profile', exact: true }).click();
	const splitProfile = page.getByRole('menuitem', { name: 'Split Terminal with Profile', exact: true });
	await splitProfile.focus();
	await splitProfile.press('ArrowRight');
	await expect(splitProfile).toHaveAttribute('aria-expanded', 'true');
	await page.locator('[data-action-id="workbench.action.terminal.split.bash"] button').click();
	await expect(page.locator('.ash-terminal-group-pane:visible')).toHaveCount(3);
	expect((await page.evaluate(() => window.ashTerminalPaneIntegration.createdProfiles())).at(-1)).toBe('bash');
	const target = await page.evaluate(() => window.ashTerminalPaneIntegration.activeId());
	await title.click();
	await page.getByRole('menuitem', { name: 'Clear Terminal', exact: true }).click();
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.operations().cleared)).toEqual([target]);
	await page.screenshot({ path: testInfo.outputPath('terminal-title-toolbar.png') });
	for (const id of await page.evaluate(() => window.ashTerminalPaneIntegration.ids())) {
		await page.evaluate(id => window.ashTerminalPaneIntegration.activate(id), id);
		await toolbar.getByRole('button', { name: 'Kill Terminal', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.ids())).not.toContain(id);
	}
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.ids())).toEqual([]);
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(3);
	await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('terminal reuse keeps command decorations separate when the new PTY restarts command IDs with Chinese status labels', async ({ page }) => {
	await page.goto('/terminal.html?stream&reuseCommands&locale=zh-CN');
	await page.waitForFunction(() => Boolean(window.ashTerminalStreamIntegration));
	await page.evaluate(() => window.ashTerminalStreamIntegration.start());
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.status().state)).toBe('exited');
	await expect(page.locator('.ash-terminal-command-status.succeeded')).toHaveCount(1);
	await page.evaluate(() => window.ashTerminalStreamIntegration.reuse());
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.status().state)).toBe('exited');
	await expect(page.locator('.ash-terminal-command-status')).toHaveCount(2);
	await expect(page.getByRole('button', { name: '命令已成功完成', exact: true })).toHaveCount(1);
	await expect(page.getByRole('button', { name: '命令失败，退出代码为 11', exact: true })).toHaveCount(1);
	expect(await page.evaluate(() => window.ashTerminalStreamIntegration.status().remaining)).toBe(1);
	expect(await page.evaluate(() => window.ashTerminalStreamIntegration.status().closes)).toBe(1);
	await page.evaluate(() => window.ashTerminalStreamIntegration.close());
});

test('terminal font rendering updates the existing screen without replacing its content', async ({ page }) => {
	await page.goto('/terminal.html');
	await page.waitForFunction(() => Boolean(window.ashTerminalIntegration));
	await page.evaluate(async () => { window.ashTerminalIntegration.start(); await window.ashTerminalIntegration.ready(); window.ashTerminalIntegration.write('font policy retained'); });
	await expect(page.locator('.xterm-rows')).toContainText('font policy retained');
	const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
	await page.evaluate(() => window.ashTerminalIntegration.configure('terminal.integrated.fontRendering', 'grayscale'));
	await expect(page.locator('.xterm')).toHaveClass(mac ? /ash-terminal-font-grayscale/ : /^(?!.*ash-terminal-font-grayscale)/);
	if (mac) await expect(page.locator('.xterm')).toHaveCSS('-webkit-font-smoothing', 'antialiased');
	await page.evaluate(() => window.ashTerminalIntegration.configure('terminal.integrated.fontRendering', 'auto'));
	await expect(page.locator('.xterm')).not.toHaveClass(/ash-terminal-font-grayscale/);
	await expect(page.locator('.xterm-rows')).toContainText('font policy retained');
	await page.evaluate(() => window.ashTerminalIntegration.dispose());
});

test('terminal Split creates independent processes, preserves output and moves focus between panes', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?input&groups');
	await expect.poll(async () => ({ ready: await page.evaluate(() => Boolean(window.ashTerminalGroupsIntegration)), errors })).toEqual({ ready: true, errors: [] });
	await page.evaluate(() => window.ashTerminalGroupsIntegration.feed('original pane output'));
	await expect(page.locator('.xterm-rows')).toContainText('original pane output');
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.split'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.groups())).toEqual([['terminal-instance-1', 'terminal-instance-2']]);
	// No shell cwd metadata has arrived: the split must query the live execution owner.
	expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.launchDirectories()[1])).toBe('/workspace/current');
	const panes = page.locator('.ash-terminal-group-pane');
	await expect(panes).toHaveCount(2);
	await expect(panes.nth(0).locator('.xterm-rows')).toContainText('original pane output');
	await expect(panes.nth(1).locator('.xterm-helper-textarea')).toBeFocused();
	await page.evaluate(() => window.ashTerminalGroupsIntegration.clearWrites());
	await page.keyboard.type('right input');
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.focusPreviousPane'));
	await expect(panes.nth(0).locator('.xterm-helper-textarea')).toBeFocused();
	await page.keyboard.type('left input');
	await expect.poll(() => page.evaluate(() => ['input-shell-2', 'input-shell-1'].map(id => ({
		terminalId: id,
		data: window.ashTerminalGroupsIntegration.writes().filter(write => write.terminalId === id).map(write => write.data).join(''),
	})))).toEqual([
		{ terminalId: 'input-shell-2', data: 'right input' },
		{ terminalId: 'input-shell-1', data: 'left input' },
	]);
	const left = (await panes.nth(0).boundingBox())!;
	const right = (await panes.nth(1).boundingBox())!;
	expect(left.width).toBeGreaterThan(120); expect(right.width).toBeGreaterThan(120);
	expect(right.x).toBeGreaterThanOrEqual(left.x + left.width - 1);
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.kill'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.groups())).toEqual([['terminal-instance-2']]);
	await expect(panes).toHaveCount(1);
	await expect(panes.locator('.xterm-helper-textarea')).toBeFocused();
	expect(errors).toEqual([]);
	await page.evaluate(() => window.ashTerminalGroupsIntegration.dispose());
});

test('terminal split sash accepts keyboard resizing and Unsplit retains both processes', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?input&groups&locale=zh-CN');
	await expect.poll(async () => ({ ready: await page.evaluate(() => Boolean(window.ashTerminalGroupsIntegration)), errors })).toEqual({ ready: true, errors: [] });
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.split'));
	await expect(page.locator('.ash-terminal-group-pane')).toHaveCount(2);
	const left = page.locator('.ash-terminal-group-pane').nth(0);
	const initialWidth = (await left.boundingBox())!.width;
	const sash = page.getByRole('separator', { name: '调整终端窗格大小' });
	await sash.focus();
	await sash.press('ArrowRight');
	await expect.poll(async () => (await left.boundingBox())!.width).toBeGreaterThan(initialWidth);
	await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.sizes().some(size => size.terminalId === 'input-shell-1'))).toBe(true);
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.unsplit'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.groups())).toEqual([['terminal-instance-1'], ['terminal-instance-2']]);
	await expect(page.locator('.ash-terminal-group:not([hidden])')).toHaveCount(1);
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.focusAtIndex1'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.active())).toBe('terminal-instance-1');
	await expect(page.locator('.ash-terminal-group:not([hidden]) .xterm-helper-textarea')).toBeFocused();
	await page.evaluate(() => window.ashTerminalGroupsIntegration.close());
	await page.evaluate(() => window.ashTerminalGroupsIntegration.close());
	await page.evaluate(() => window.ashTerminalGroupsIntegration.dispose());
});

test('terminal row drag reorders adjacent panes while retaining their screen and proportions', async ({ page }) => {
	await page.goto('/terminal.html?input&groups');
	await page.waitForFunction(() => Boolean(window.ashTerminalGroupsIntegration));
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.split'));
	await page.evaluate(() => window.ashTerminalGroupsIntegration.feed('pending input'));
	const panes = page.locator('.ash-terminal-group-pane');
	await expect(panes).toHaveCount(2);
	const sash = page.getByRole('separator', { name: 'Resize terminal panes', exact: true });
	await sash.focus();
	await sash.press('ArrowRight');
	await sash.press('ArrowRight');
	const before = await panes.evaluateAll(elements => Object.fromEntries(elements.map(element => [(element as HTMLElement).dataset.instanceId!, element.getBoundingClientRect().width])));
	const content = await page.evaluate(() => window.ashTerminalInputIntegration.snapshot());
	expect(content).toContain('pending input');
	const targetRow = page.locator('#terminal-instance-2-tab');
	const rowBounds = (await targetRow.boundingBox())!;
	await page.locator('#terminal-instance-1-tab').dragTo(targetRow, { targetPosition: { x: 10, y: rowBounds.height - 3 } });
	await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.groups())).toEqual([['terminal-instance-2', 'terminal-instance-1']]);
	const after = await panes.evaluateAll(elements => Object.fromEntries(elements.map(element => [(element as HTMLElement).dataset.instanceId!, element.getBoundingClientRect().width])));
	for (const id of Object.keys(before)) expect(after[id]).toBeCloseTo(before[id]!, 0);
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toBe(content);
	expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.metadata().created)).toBe(2);
});

for (const locale of ['en', 'zh-CN']) {
	test(`terminal keyboard join picker cancels and moves the captured pane in ${locale}`, async ({ page }) => {
		await page.goto(`/terminal.html?input&groups&locale=${locale}`);
		await page.waitForFunction(() => Boolean(window.ashTerminalGroupsIntegration));
		await page.evaluate(async () => {
			await window.ashTerminalGroupsIntegration.command('workbench.action.terminal.split');
			await window.ashTerminalGroupsIntegration.command('workbench.action.terminal.unsplit');
		});
		const picker = page.getByRole('combobox', { name: locale === 'zh-CN' ? '选择目标终端及窗格位置' : 'Choose a terminal and pane position', exact: true });
		const canceled = page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.join'));
		await expect(picker).toBeVisible();
		await picker.press('Escape');
		await canceled;
		expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.groups())).toEqual([['terminal-instance-1'], ['terminal-instance-2']]);
		const moving = page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.join'));
		await expect(picker).toBeVisible();
		await picker.press('Enter');
		await moving;
		expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.groups())).toEqual([['terminal-instance-2', 'terminal-instance-1']]);
		await expect(page.locator('.ash-terminal-group-pane[data-instance-id="terminal-instance-2"] .xterm-helper-textarea')).toBeFocused();
		expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.metadata().created)).toBe(2);
	});
}

test('terminal error tooltip explains a refused input operation and relaunch removes the old reason', async ({ page }) => {
	await page.goto('/terminal.html?input&groups&clipboard&locale=zh-CN');
	await page.waitForFunction(() => Boolean(window.ashTerminalGroupsIntegration));
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.split'));
	await expect(page.getByRole('tab')).toHaveCount(2);
	await page.evaluate(() => window.ashTerminalClipboardIntegration.holdInput());
	const sending = page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.sendSequence', { text: 'failure input' }).catch(error => String(error.message)));
	await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.writes().some(write => write.data === 'failure input'))).toBe(true);
	await page.evaluate(() => window.ashTerminalClipboardIntegration.releaseInput(true));
	expect(await sending).toBe('Terminal write denied');
	const active = page.getByRole('tab', { selected: true });
	await expect(active).toHaveAttribute('title', /终端进程失败：Terminal write denied/);
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.relaunch'));
	await expect(active).not.toHaveAttribute('title', /Terminal write denied/);
	await expect(page.locator('.ash-terminal-group-pane')).toHaveCount(2);
	await page.evaluate(() => window.ashTerminalGroupsIntegration.dispose());
});

for (const locale of ['en', 'zh-CN']) {
	test(`terminal editor moves the original screen and process between hosts in ${locale}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/terminal.html?input&groups&editor&browser&locale=${locale}`);
		await expect.poll(async () => ({ ready: await page.evaluate(() => Boolean(window.ashTerminalEditorIntegration)), errors })).toEqual({ ready: true, errors: [] });
		await page.evaluate(() => window.ashTerminalFindIntegration.theme('light'));
		await expect(page.locator('.ash-terminal-widgets .xterm-scrollable-element')).toHaveCSS('background-color', 'rgb(248, 248, 248)');
		await page.evaluate(() => window.ashTerminalGroupsIntegration.feed('preserved editor output'));
		await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.moveToEditor'));
		await expect(page.locator('.ash-terminal-editor .xterm-rows')).toContainText('preserved editor output');
		await expect(page.locator('.ash-terminal-editor .xterm-scrollable-element')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
		await expect(page.locator('.ash-terminal-editor .ash-terminal-instance')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
		await expect.poll(() => page.evaluate(() => window.ashTerminalEditorIntegration.state())).toEqual({ instances: 1, created: 1, editorTabs: 1, originalScreen: true, target: 2 });
		await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.groups())).toEqual([]);
		await page.locator('.ash-terminal-editor .xterm-helper-textarea').press('x');
		await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.writes().some(write => write.data === 'x'))).toBe(true);
		await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.moveToTerminalPanel'));
		await expect.poll(() => page.evaluate(() => window.ashTerminalEditorIntegration.state())).toEqual({ instances: 1, created: 1, editorTabs: 0, originalScreen: true, target: 1 });
		await expect(page.locator('.ash-terminal-widgets .xterm-rows')).toContainText('preserved editor output');
		await expect(page.locator('.ash-terminal-widgets .xterm-scrollable-element')).toHaveCSS('background-color', 'rgb(248, 248, 248)');
		await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.moveToEditor'));
		await page.evaluate(() => window.ashTerminalEditorIntegration.close());
		await expect.poll(() => page.evaluate(() => window.ashTerminalEditorIntegration.state().instances)).toBe(0);
		await expect(page.locator('.ash-terminal-editor')).toHaveCount(0);
		expect(errors).toEqual([]);
	});
}

for (const contributed of [false, true]) test(`background ${contributed ? 'extension' : 'standard'} terminal editor creation and reveal preserve panel focus and input destination`, async ({ page }) => {
	await page.goto(`/terminal.html?input&groups&editor${contributed ? '&extensionProfiles' : ''}`);
	await page.waitForFunction(() => Boolean(window.ashTerminalEditorIntegration));
	const panelInput = page.locator('.ash-terminal-widgets .xterm-helper-textarea');
	await panelInput.focus();
	const original = await page.evaluate(() => window.ashTerminalGroupsIntegration.active());
	const background = await page.evaluate(contributed => window.ashTerminalEditorIntegration.createBackground(contributed), contributed);
	expect(background).not.toBe(original);
	await expect(page.locator('.ash-terminal-editor .xterm-helper-textarea')).toHaveCount(1);
	await expect(panelInput).toBeFocused();
	expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.active())).toBe(original);
	await panelInput.press('a');
	await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.writes().filter(write => write.data === 'a'))).toEqual([{ terminalId: 'input-shell-1', data: 'a' }]);
	await page.evaluate(id => window.ashTerminalEditorIntegration.revealBackground(id), background);
	await expect(panelInput).toBeFocused();
	expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.active())).toBe(original);
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.sendSequence', { text: 'panel-target' }));
	await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.writes().filter(write => write.data === 'panel-target'))).toEqual([{ terminalId: 'input-shell-1', data: 'panel-target' }]);
	await page.locator('.ash-terminal-editor .xterm-helper-textarea').focus();
	expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.active())).toBe(background);
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.sendSequence', { text: 'editor-target' }));
	await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.writes().filter(write => write.data === 'editor-target'))).toEqual([{ terminalId: 'input-shell-2', data: 'editor-target' }]);
	await page.evaluate(() => window.ashTerminalGroupsIntegration.dispose());
});

test('splitting an editor terminal opens an adjacent shell while retaining the original screen and launch cwd', async ({ page }) => {
	await page.goto('/terminal.html?input&groups&editor');
	await page.waitForFunction(() => Boolean(window.ashTerminalEditorIntegration));
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.moveToEditor'));
	await page.evaluate(() => window.ashTerminalGroupsIntegration.feed('editor pending'));
	const original = await page.evaluate(() => window.ashTerminalInputIntegration.snapshot());
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.split'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalEditorIntegration.groups().map(group => group.resources.length))).toEqual([1, 1]);
	await expect.poll(() => page.evaluate(() => window.ashTerminalEditorIntegration.state())).toEqual({ instances: 2, created: 2, editorTabs: 2, originalScreen: true, target: 2 });
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toBe(original);
	expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.groups())).toEqual([]);
	expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.launchDirectories()[1])).toBe('/workspace/current');
	await page.evaluate(() => window.ashTerminalGroupsIntegration.clearWrites());
	await page.keyboard.type('second-shell');
	await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.writes().filter(write => write.terminalId === 'input-shell-2').map(write => write.data).join(''))).toBe('second-shell');
	await page.evaluate(() => window.ashTerminalEditorIntegration.close());
	await expect.poll(() => page.evaluate(() => window.ashTerminalEditorIntegration.state().instances)).toBe(1);
});

test('terminal instance list restores its resized width after page reload', async ({ page }) => {
	await page.goto('/terminal.html?input&groups');
	await expect.poll(() => page.evaluate(() => Boolean(window.ashTerminalGroupsIntegration))).toBe(true);
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.split'));
	const sash = page.locator('.ash-terminal-tabs-layout > .ash-sash');
	await expect(sash).toBeVisible();
	await sash.press('ArrowLeft');
	await sash.press('ArrowLeft');
	const column = page.locator('.ash-terminal-tabs-layout > .ash-split-view-pane').nth(1);
	const resized = await column.evaluate(element => element.getBoundingClientRect().width);
	await page.reload();
	await expect.poll(() => page.evaluate(() => Boolean(window.ashTerminalGroupsIntegration))).toBe(true);
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.split'));
	await expect.poll(() => column.evaluate(element => element.getBoundingClientRect().width)).toBe(resized);
});

for (const [theme, locale] of [['dark', 'en'], ['hcDark', 'en'], ['hcLight', 'zh-CN']] as const) {
	test(`terminal URL hover uses screen geometry and shared Escape lifecycle in ${theme}/${locale}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/terminal.html?input&find&browser&locale=${locale}`);
		await page.waitForFunction(() => Boolean(window.ashTerminalInputIntegration));
		await page.evaluate(theme => {
			window.ashTerminalFindIntegration.theme(theme);
			window.ashTerminalInputIntegration.feed('\x1b[2J\x1b[H' + 'https://example.com/terminal\r\n');
		}, theme);
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toContain('https://example.com/terminal');
		const screen = await page.locator('.xterm-screen').boundingBox();
		const dimensions = await page.evaluate(() => window.ashTerminalInputIntegration.dimensions());
		await page.mouse.move(screen!.x + 6.5 * screen!.width / dimensions.cols, screen!.y + 0.5 * screen!.height / dimensions.rows);
		await expect(page.locator('.ash-hover')).toContainText('https://example.com/terminal');
		const anchor = await page.locator('.ash-terminal-link-hover-target').boundingBox();
		expect(anchor!.x).toBeCloseTo(screen!.x, 0);
		expect(anchor!.y).toBeCloseTo(screen!.y, 0);
		await page.keyboard.press('Escape');
		await expect(page.locator('.ash-hover')).toHaveCount(0);
		await page.mouse.move(0, 0);
		await page.evaluate(() => window.ashTerminalInputIntegration.configure('terminal.integrated.showLinkHover', false));
		await page.mouse.move(screen!.x + 5.5 * screen!.width / dimensions.cols, screen!.y + 0.5 * screen!.height / dimensions.rows);
		await expect(page.locator('.ash-hover')).toHaveCount(0);
		await page.evaluate(() => window.ashTerminalInputIntegration.close());
		await expect(page.locator('.ash-terminal-widget-overlay')).toHaveCount(0);
		expect(errors).toEqual([]);
	});
}

for (const locale of ['en', 'zh-CN']) {

	test(`terminal instance hover focus command reaches a hidden-title terminal and the focused row in ${locale}`, async ({ page }) => {
		await page.goto(`/terminal.html?pane&profiles&browser&workbench&locale=${locale}`);
		await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
		await page.evaluate(async () => {
			await window.ashTerminalPaneIntegration.panel(true);
			await window.ashTerminalPaneIntegration.configure('terminal.integrated.tabs.showActiveTerminal', 'never');
		});
		await expect(page.locator('.ash-terminal-active-action')).toHaveCount(0);
		const input = page.locator('.xterm-helper-textarea').first();
		await input.focus();
		await page.evaluate(() => window.ashTerminalPaneIntegration.command('workbench.action.terminal.focusHover'));
		const card = page.locator('.ash-terminal-instance-hover');
		await expect(card.getByRole('button').first()).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(card.getByRole('button').last()).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(card.getByRole('button').first()).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(card).toHaveCount(0);
		await expect(input).toBeFocused();
		await page.evaluate(() => window.ashTerminalPaneIntegration.command('workbench.action.terminal.new'));
		const first = page.locator('.ash-terminal-tabs [role="tab"]').first();
		await first.focus();
		const active = await page.evaluate(() => window.ashTerminalPaneIntegration.activeId());
		await page.evaluate(() => window.ashTerminalPaneIntegration.command('workbench.action.terminal.focusHover'));
		await expect(card).toContainText('1235');
		await expect(card.getByRole('button').first()).toBeFocused();
		expect(await page.evaluate(() => window.ashTerminalPaneIntegration.activeId())).toBe(active);
		await page.keyboard.press('Escape');
		await expect(first).toBeFocused();
		await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
	});

	test(`terminal instance hover updates received sequences and prompt input from the parsed screen in ${locale}`, async ({ page }) => {
		await page.goto(`/terminal.html?pane&profiles&browser&workbench&shellIntegration=rich&locale=${locale}`);
		await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
		await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
		const title = page.locator('.ash-terminal-active-action button');
		await title.focus();
		await title.press('Alt+ArrowDown');
		const card = page.locator('.ash-terminal-instance-hover');
		await card.getByRole('button', { name: locale === 'zh-CN' ? '显示详细信息' : 'Show Details', exact: true }).click();
		await page.evaluate(() => {
			window.ashTerminalPaneIntegration.sequence({ type: 'promptStart' }, '\r\nfixture> ');
			window.ashTerminalPaneIntegration.sequence({ type: 'commandStart' });
			window.ashTerminalPaneIntegration.sequence({ type: 'commandLine', value: 'echo fixture', isTrusted: true }, 'echo fixture');
		});
		await expect(card).toContainText(locale === 'zh-CN' ? '已接收的序列：promptStart, commandStart, commandLine' : 'Seen sequences: promptStart, commandStart, commandLine');
		await expect(card).toContainText(locale === 'zh-CN' ? '提示符输入：echo fixture|' : 'Prompt input: echo fixture|');
		await expect(card.getByRole('button', { name: locale === 'zh-CN' ? '隐藏详细信息' : 'Hide Details', exact: true })).toBeFocused();
		await page.evaluate(() => window.ashTerminalPaneIntegration.sequence({ type: 'processReady', isWindowsPty: false }));
		await expect(card).not.toContainText('commandLine');
		await expect(card).not.toContainText('echo fixture');
		await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
	});
}

for (const [level, label] of [['none', 'None'], ['basic', 'Basic'], ['rich', 'Rich']] as const) {
	test(`terminal instance hover reflects ${level} shell integration in themed cards`, async ({ page }) => {
		await page.goto(`/terminal.html?pane&profiles&browser&workbench&shellIntegration=${level}`);
		await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
		await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
		const title = page.locator('.ash-terminal-active-action button');
		await title.focus();
		await title.press('Alt+ArrowDown');
		const card = page.locator('.ash-terminal-instance-hover');
		await expect(card).toContainText(`Shell integration: ${label}`);
		for (const theme of ['dark', 'light', 'hcDark', 'hcLight'] as const) {
			await page.evaluate(theme => window.ashTerminalPaneIntegration.theme(theme), theme);
			const styles = await card.evaluate(element => {
				const hover = getComputedStyle(element.closest('.ash-hover')!);
				const button = getComputedStyle(element.querySelector('button')!);
				return { background: hover.backgroundColor, foreground: hover.color, outline: button.outlineColor, outlineStyle: button.outlineStyle };
			});
			expect(styles.foreground).not.toBe(styles.background);
			expect(styles.outline).not.toBe(styles.background);
			expect(styles.outlineStyle).toBe('solid');
		}
		await page.keyboard.press('Escape');
		await expect(title).toBeFocused();
		await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`terminal instance hover updates live integration details and preserves action focus in ${locale}`, async ({ page }) => {
		await page.goto(`/terminal.html?pane&profiles&browser&workbench&shellIntegration=basic&locale=${locale}`);
		await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
		await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
		const title = page.locator('.ash-terminal-active-action button');
		await title.focus();
		await title.press('Alt+ArrowDown');
		const card = page.locator('.ash-terminal-instance-hover');
		await expect(card).toContainText(locale === 'zh-CN' ? 'Shell 集成：基本' : 'Shell integration: Basic');
		const show = locale === 'zh-CN' ? '显示详细信息' : 'Show Details';
		const hide = locale === 'zh-CN' ? '隐藏详细信息' : 'Hide Details';
		await page.keyboard.press('Tab');
		await expect(card.getByRole('button', { name: show, exact: true })).toBeFocused();
		await page.evaluate(() => window.ashTerminalPaneIntegration.metadata('rich', '/workspace/hover-next', 'fixture-prompt'));
		await expect(card).toContainText(locale === 'zh-CN' ? 'Shell 集成：丰富' : 'Shell integration: Rich');
		await expect(card.getByRole('button', { name: show, exact: true })).toBeFocused();
		await page.evaluate(() => window.ashTerminalPaneIntegration.environment(true));
		await expect(card.locator('[data-severity="warning"]')).toContainText(locale === 'zh-CN' ? '扩展更改了此终端的环境贡献' : 'Extensions changed this terminal’s environment contributions');
		await expect(card.getByRole('button', { name: show, exact: true })).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(card).toContainText(locale === 'zh-CN' ? 'Shell 类型：bash' : 'Shell type: bash');
		await expect(card).toContainText('/workspace/hover-next');
		await expect(card).toContainText(locale === 'zh-CN' ? '提示符类型：fixture-prompt' : 'Prompt type: fixture-prompt');
		await page.evaluate(() => window.ashTerminalPaneIntegration.metadata('none', '/workspace/hover-final'));
		await expect(card).toContainText(locale === 'zh-CN' ? 'Shell 集成：无' : 'Shell integration: None');
		await expect(card).toContainText('/workspace/hover-final');
		await expect(card).not.toContainText('fixture-prompt');
		await expect(card).not.toContainText('/workspace/hover-next');
		await expect(card.getByRole('button', { name: hide, exact: true })).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(title).toBeFocused();
		await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
		await expect(card).toHaveCount(0);
	});
}

async function seedSuggestPrompt(page: Page, prefix: string, locale = 'en', shell: 'bash' | 'zsh' = 'bash'): Promise<void> {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto(`/terminal.html?input&groups&clipboard&browser&suggest&locale=${locale}`);
	await expect.poll(async () => ({ ready: await page.evaluate(() => Boolean(window.ashTerminalSuggestIntegration && window.ashTerminalInputIntegration)), errors })).toEqual({ ready: true, errors: [] });
	await page.evaluate(({ prefix, shell }) => {
		const feed = window.ashTerminalInputIntegration.feed;
		feed('', { type: 'processReady', isWindowsPty: false, shellType: shell as import('../../../src/ash/platform/terminal/common/terminal.js').PosixShellType });
		feed('', { type: 'promptStart' });
		feed('$ ');
		feed('', { type: 'commandStart' });
		feed(prefix);
	}, { prefix, shell });
	await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.model())).toBe(`${prefix}|`);
	await page.evaluate(() => window.ashTerminalInputIntegration.clear());
}

for (const theme of ['dark', 'light', 'hcDark', 'hcLight'] as const) {
	test(`terminal suggest follows registered theme colors and preserves keyboard dismissal in ${theme}`, async ({ page }) => {
		await seedSuggestPrompt(page, 'echo ');
		await page.evaluate(theme => {
			window.ashTerminalFindIntegration.theme(theme, {
				'editor.background': '#123456',
				'editor.foreground': '#abcdef',
				'description.foreground': '#789abc',
				'list.activeSelectionBackground': '#654321',
				'list.activeSelectionForeground': '#fedcba',
				focusBorder: '#112233',
			});
			window.ashTerminalSuggestIntegration.history('echo accepted');
		}, theme);
		// Automatic suggestions follow a typed key confirmed by the shell echo.
		// Control+Space deliberately opens the separate, accessible quick picker.
		await page.locator('.xterm-helper-textarea').press('a');
		await page.evaluate(() => window.ashTerminalInputIntegration.feed('a'));
		const picker = page.locator('.ash-terminal-suggest');
		await expect(picker).toBeVisible();
		await page.evaluate(() => window.ashTerminalInputIntegration.clear());
		await expect(picker).toHaveCSS('background-color', 'rgb(18, 52, 86)');
		await expect(picker).toHaveCSS('color', 'rgb(171, 205, 239)');
		const selected = picker.locator('.ash-list-row.focused');
		await expect(selected).toHaveCSS('background-color', 'rgb(101, 67, 33)');
		await expect(selected).toHaveCSS('color', 'rgb(254, 220, 186)');
		await expect(selected).toHaveCSS('outline-color', 'rgb(17, 34, 51)');
		await expect(picker.locator('.ash-terminal-suggest-detail')).toHaveCSS('color', 'rgb(120, 154, 188)');
		await expect(picker.locator('.ash-terminal-suggest-instructions')).toHaveCSS('color', 'rgb(120, 154, 188)');
		if (theme === 'hcDark' || theme === 'hcLight') {
			await expect(picker).toHaveCSS('box-shadow', 'none');
			await expect(picker).toHaveCSS('border-top-color', theme === 'hcDark' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)');
		}
		await page.keyboard.press('Escape');
		await expect(picker).toBeHidden();
		await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
		expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
		await page.evaluate(() => window.ashTerminalInputIntegration.close());
	});
}

test('terminal suggest preserves middle-of-input edits and shell ghost text', async ({ page }) => {
	await seedSuggestPrompt(page, 'echo pending');
	await page.evaluate(() => {
		window.ashTerminalSuggestIntegration.history('echo pending completion');
		window.ashTerminalInputIntegration.feed('\x1b[3D');
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.model())).toBe('echo pend|ing');
	await page.evaluate(() => window.ashTerminalInputIntegration.command('workbench.action.terminal.triggerSuggest'));
	await expect(page.getByRole('combobox', { name: 'Terminal suggestions', exact: true })).toHaveCount(0);
	await page.evaluate(() => window.ashTerminalInputIntegration.feed('\r\x1b[2K$ echo \x1b[2mghost\x1b[0m\x1b[5D'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.model())).toBe('echo |[ghost]');
	await page.evaluate(() => window.ashTerminalInputIntegration.command('workbench.action.terminal.triggerSuggest'));
	await expect(page.getByRole('combobox', { name: 'Terminal suggestions', exact: true })).toHaveCount(0);
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

for (const locale of ['en', 'zh-CN']) {
	test(`terminal sticky scroll follows retained command ranges and restores keyboard focus in ${locale}`, async ({ page }, testInfo) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/terminal.html?stream&commandModel&browser&locale=${locale}`);
		await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration?.model().input)).toBe('|');
		await page.evaluate(() => {
			const fixture = window.ashTerminalStreamIntegration;
			fixture.environmentFrame({ type: 'hasRichCommandDetection', value: true });
			fixture.feedModel('echo sticky 中文🙂\r\n');
			fixture.environmentFrame({ type: 'commandExecuted', commandId: 'sticky-command', command: 'echo sticky 中文🙂', isTrusted: true, cwd: '/workspace', timestampMillis: 1 });
			fixture.feedModel(Array.from({ length: 80 }, (_, index) => `sticky-output-${index}\r\n`).join(''));
			fixture.environmentFrame({ type: 'commandFinished', exitCode: 0, durationMillis: 1 });
			fixture.environmentFrame({ type: 'promptStart' });
			fixture.feedModel('$ ');
			fixture.environmentFrame({ type: 'commandStart' });
		});
		await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.model().commands?.length)).toBe(2);
		await page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.scroll(8));
		const header = page.getByRole('button', { name: locale === 'zh-CN' ? '滚动到命令：echo sticky 中文🙂' : 'Scroll to command: echo sticky 中文🙂', exact: true });
		await expect(header).toBeVisible();
		await expect(header).toHaveText('$ echo sticky 中文🙂');
		await page.evaluate(isChinese => window.ashTerminalStreamIntegration.stickyScroll.theme(isChinese ? 'hcLight' : 'hcDark'), locale === 'zh-CN');
		const colors = await header.evaluate(element => {
			const style = getComputedStyle(element);
			return { background: style.backgroundColor, foreground: style.color, border: style.borderBottomColor };
		});
		expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
		expect(colors.foreground).not.toBe(colors.background);
		expect(colors.border).not.toBe('rgba(0, 0, 0, 0)');
		const geometry = await header.evaluate(element => {
			const screen = element.closest('.ash-terminal-instance')!.querySelector('.xterm-screen')!.getBoundingClientRect();
			const bounds = element.getBoundingClientRect();
			return { left: Math.abs(screen.left - bounds.left), top: Math.abs(screen.top - bounds.top), width: Math.abs(screen.width - bounds.width) };
		});
		expect(geometry).toEqual({ left: 0, top: 0, width: 0 });
		await page.locator('.ash-terminal-instance:visible').screenshot({ path: testInfo.outputPath('sticky-scroll.png') });
		const screen = page.locator('.ash-terminal-instance:visible .xterm-screen');
		await screen.evaluate(element => {
			for (let packet = 0; packet < 16; packet++) element.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, deltaMode: WheelEvent.DOM_DELTA_LINE, bubbles: true, cancelable: true }));
		});
		await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.position().viewport)).not.toBe(8);
		const wheelPosition = await page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.position().viewport);
		await page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.scroll(8));
		await header.evaluate(element => {
			for (let packet = 0; packet < 16; packet++) element.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, deltaMode: WheelEvent.DOM_DELTA_LINE, bubbles: true, cancelable: true }));
		});
		await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.position().viewport)).toBe(wheelPosition);
		await page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.scroll(8));
		await header.focus();
		await header.press('Escape');
		await expect(page.locator('.ash-terminal-instance:visible .xterm-helper-textarea')).toBeFocused();
		await expect(header).toBeVisible();
		await page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.toggle());
		await expect(header).toBeHidden();
		await page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.toggle());
		await expect(header).toBeVisible();
		await page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.configure('ignoredCommands', ['echo']));
		await expect(header).toBeHidden();
		await page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.configure('ignoredCommands', []));
		await expect(header).toBeVisible();
		await page.evaluate(() => window.ashTerminalStreamIntegration.feedModel('\x1b[?1049h'));
		await expect(header).toBeHidden();
		await page.evaluate(() => window.ashTerminalStreamIntegration.feedModel('\x1b[?1049l'));
		await expect(header).toBeVisible();
		await header.focus();
		if (locale === 'en') await header.press('Enter');
		else await header.click();
		await expect(header).toBeHidden();
		await expect(page.locator('.ash-terminal-instance:visible .xterm-helper-textarea')).toBeFocused();
		expect(await page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.position().viewport)).toBe(2);
		await page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.scroll(8));
		await expect(header).toBeVisible();
		await page.evaluate(() => window.ashTerminalStreamIntegration.clearModel());
		await expect(header).toBeHidden();
		await page.evaluate(() => window.ashTerminalStreamIntegration.close());
		expect(errors).toEqual([]);
	});
}

test('terminal sticky header preserves fractional trackpad wheel input through the xterm viewport', async ({ page }) => {
	await page.goto('/terminal.html?stream&commandModel');
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration?.model().input)).toBe('|');
	await page.evaluate(() => {
		const fixture = window.ashTerminalStreamIntegration;
		fixture.environmentFrame({ type: 'hasRichCommandDetection', value: true });
		fixture.feedModel('echo fractional-wheel\r\n');
		fixture.environmentFrame({ type: 'commandExecuted', commandId: 'wheel-command', command: 'echo fractional-wheel', isTrusted: true, cwd: '/workspace', timestampMillis: 1 });
		fixture.feedModel('wheel-output\r\n'.repeat(120));
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.observed())).toContain('wheel-output');
	const header = page.locator('.ash-terminal-sticky-scroll');
	const viewport = () => page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.position().viewport);
	const positions: number[] = [];
	for (const selector of ['.xterm-screen', '.ash-terminal-sticky-scroll']) {
		await page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.scroll(30));
		await expect(header).toBeVisible();
		await expect.poll(viewport).toBe(30);
		await page.locator(`.ash-terminal-instance:visible ${selector}`).evaluate(element => {
			// Pixel packets intentionally omit legacy wheelDelta fields used for physical mouse wheels.
			for (let packet = 0; packet < 16; packet++) element.dispatchEvent(new WheelEvent('wheel', { deltaY: 0.5, deltaMode: WheelEvent.DOM_DELTA_PIXEL, bubbles: true, cancelable: true }));
		});
		await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		positions.push(await viewport());
	}
	expect(positions[0]).toBeLessThanOrEqual(32);
	expect(positions[1]).toBe(positions[0]);
	await page.evaluate(() => window.ashTerminalStreamIntegration.close());
});

test('decoded shell boundaries own prompt input and command output on the original xterm screen', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?stream&commandModel');
	await expect.poll(async () => ({ model: await page.evaluate(() => window.ashTerminalStreamIntegration?.model()), errors })).toEqual({
		model: {
			input: '|', state: 1, commands: [{ id: 'model-command', text: 'echo 中文🙂', output: 'result 中文🙂', timestamp: 123, duration: 25, trust: true, promptRows: 1, commandRows: 1 }],
		}, errors: []
	});
	await page.evaluate(() => window.ashTerminalStreamIntegration.feedModel('中文🙂'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.model().input)).toBe('中文🙂|');
	await page.evaluate(() => window.ashTerminalStreamIntegration.feedModel('\x1b[2D'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.model().input)).toBe('中文|🙂');
	await page.evaluate(() => window.ashTerminalStreamIntegration.feedModel('\x1b[2C\x1b[2mghost\x1b[0m\x1b[5D'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.model().input)).toBe('中文🙂|[ghost]');
	expect((await page.evaluate(() => window.ashTerminalStreamIntegration.model())).commands![0]!.output).toBe('result 中文🙂');
	await page.evaluate(() => {
		window.ashTerminalStreamIntegration.feedModel('\x1b[2K\r$ ');
		window.ashTerminalStreamIntegration.environmentFrame({ type: 'promptStart' });
		window.ashTerminalStreamIntegration.environmentFrame({ type: 'commandStart' });
		window.ashTerminalStreamIntegration.feedModel('input\x1b[60G');
		window.ashTerminalStreamIntegration.environmentFrame({ type: 'rightPromptStart' });
		window.ashTerminalStreamIntegration.feedModel('right prompt');
		window.ashTerminalStreamIntegration.environmentFrame({ type: 'rightPromptEnd' });
		window.ashTerminalStreamIntegration.feedModel('\x1b[8G');
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.model().input)).toBe('input|');
	await page.evaluate(() => {
		window.ashTerminalStreamIntegration.feedModel('\x1b[2K\r$ echo\r\n');
		window.ashTerminalStreamIntegration.environmentFrame({ type: 'continuationStart' });
		window.ashTerminalStreamIntegration.feedModel('续🙂> ');
		window.ashTerminalStreamIntegration.environmentFrame({ type: 'continuationEnd' });
		window.ashTerminalStreamIntegration.feedModel('中文');
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.model().input)).toBe('echo\n中文|');
	const serialized = await page.evaluate(() => window.ashTerminalStreamIntegration.serializeModel());
	expect(serialized.commands[0]!.command).toBe('echo 中文🙂');
	await page.evaluate(() => window.ashTerminalStreamIntegration.clearModel());
	expect((await page.evaluate(() => window.ashTerminalStreamIntegration.model())).commands).toEqual([]);
	await page.evaluate(value => window.ashTerminalStreamIntegration.restoreModel(value), serialized);
	expect((await page.evaluate(() => window.ashTerminalStreamIntegration.model())).commands![0]!.output).toBe('result 中文🙂');
	await page.evaluate(() => window.ashTerminalStreamIntegration.environmentFrame({ type: 'commandStorageDisabled' }));
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.model().commands![0]!.text)).toBe('');
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.commandStartContents())).toEqual([undefined]);
	expect((await page.evaluate(() => window.ashTerminalStreamIntegration.serializeModel())).promptInputModel).toBeUndefined();
	await page.evaluate(() => window.ashTerminalStreamIntegration.close());
	expect(errors).toEqual([]);
});

for (const chinese of [false, true]) {
	test(`terminal dropdown wires settings and task configuration with keyboard access (${chinese ? 'Chinese' : 'English'})`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/terminal.html?pane&profiles&browser&menuWiring${chinese ? '&locale=zh-CN' : ''}`);
		await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
		await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
		await expect(page.locator('.xterm')).toHaveCount(1);
		const dropdown = page.getByRole('button', { name: chinese ? '选择终端配置' : 'Select Terminal Profile', exact: true });
		await dropdown.focus();
		await dropdown.press('ArrowDown');
		await expect(page.getByRole('menuitem', { name: chinese ? '新建终端窗口' : 'New Terminal Window', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(dropdown).toBeFocused();
		await dropdown.press('ArrowDown');
		const settings = page.getByRole('menuitem', { name: chinese ? '配置终端设置' : 'Configure Terminal Settings', exact: true });
		await settings.focus();
		await settings.press('Enter');
		await expect.poll(() => page.evaluate(async () => (await window.ashTerminalPaneIntegration.menuEffects()).settings)).toEqual([{ jsonEditor: false, query: '@id:terminal.integrated.*' }]);
		await dropdown.click();
		await page.getByRole('menuitem', { name: chinese ? '运行任务...' : 'Run Task...', exact: true }).click();
		const picker = page.getByRole('combobox', { name: chinese ? '选择要运行的任务' : 'Select a task to run', exact: true });
		await expect(picker).toBeFocused();
		expect((await page.evaluate(() => window.ashTerminalPaneIntegration.menuEffects())).tasks).toEqual([]);
		await picker.press('Escape');
		await dropdown.click();
		await page.getByRole('menuitem', { name: chinese ? '运行任务...' : 'Run Task...', exact: true }).click();
		await expect(picker).toBeFocused();
		await picker.press('Enter');
		await expect.poll(() => page.evaluate(async () => (await window.ashTerminalPaneIntegration.menuEffects()).tasks)).toEqual(['build']);
		await dropdown.click();
		await page.getByRole('menuitem', { name: chinese ? '配置任务...' : 'Configure Tasks...', exact: true }).click();
		const configurationPicker = page.getByRole('combobox', { name: chinese ? '选择要配置的任务' : 'Select a task to configure', exact: true });
		const templatePicker = page.getByRole('combobox', { name: chinese ? '选择任务模板' : 'Select a task template', exact: true });
		await expect(configurationPicker).toBeFocused();
		await configurationPicker.press('Escape');
		expect((await page.evaluate(() => window.ashTerminalPaneIntegration.menuEffects())).editors).toEqual([]);
		await dropdown.click();
		await page.getByRole('menuitem', { name: chinese ? '配置任务...' : 'Configure Tasks...', exact: true }).click();
		await expect(configurationPicker).toBeFocused();
		await configurationPicker.fill('tasks.json');
		await configurationPicker.press('Enter');
		await expect(templatePicker).toBeFocused();
		await templatePicker.press('Escape');
		expect((await page.evaluate(() => window.ashTerminalPaneIntegration.menuEffects())).editors).toEqual([]);
		await dropdown.click();
		await page.getByRole('menuitem', { name: chinese ? '配置任务...' : 'Configure Tasks...', exact: true }).click();
		await expect(configurationPicker).toBeFocused();
		await configurationPicker.fill('tasks.json');
		await configurationPicker.press('Enter');
		await expect(templatePicker).toBeFocused();
		await templatePicker.fill(chinese ? '其他' : 'Others');
		await templatePicker.press('Enter');
		await expect.poll(() => page.evaluate(async () => (await window.ashTerminalPaneIntegration.menuEffects()).editors)).toEqual(['file:///workspace/.vscode/tasks.json']);
		const configuration = (await page.evaluate(() => window.ashTerminalPaneIntegration.menuEffects())).configuration!;
		expect(JSON.parse(configuration)).toEqual({ version: '2.0.0', tasks: [{ label: 'example', type: 'shell', command: 'echo', args: ['Hello'], problemMatcher: [] }] });
		await dropdown.click();
		await page.getByRole('menuitem', { name: chinese ? '配置任务...' : 'Configure Tasks...', exact: true }).click();
		await expect(configurationPicker).toBeFocused();
		await configurationPicker.fill('Build from terminal menu');
		await configurationPicker.press('Enter');
		await expect.poll(() => page.evaluate(async () => (await window.ashTerminalPaneIntegration.menuEffects()).editors.length)).toBe(2);
		expect((await page.evaluate(() => window.ashTerminalPaneIntegration.menuEffects())).configuration).toBe(configuration);
		await expect(templatePicker).toHaveCount(0);
		expect(await page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(1);
		await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
		expect(errors).toEqual([]);
	});
}

test('terminal split profile submenu activates extension providers and joins their created terminal', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?pane&profiles&browser&extensionProfiles');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
	await expect(page.locator('.xterm')).toHaveCount(1);
	await page.getByRole('button', { name: 'Select Terminal Profile', exact: true }).click();
	const submenu = page.getByRole('menuitem', { name: 'Split Terminal with Profile', exact: true });
	await submenu.focus();
	await submenu.press('ArrowRight');
	await expect(submenu).toHaveAttribute('aria-expanded', 'true');
	await page.locator('[data-action-id="workbench.action.terminal.split.extension:acme.extension/shell"] button').click();
	await expect(page.locator('.xterm')).toHaveCount(2);
	await expect(page.getByRole('separator', { name: 'Resize terminal panes', exact: true })).toHaveCount(1);
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.launches().at(-1))).toMatchObject({ profile: { type: 'custom', name: 'Extension Shell', path: ['/home/test/extension-shell'] }, cwd: '/backend/workspace' });
	await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('new terminal window opens a focused compact terminal editor and retains input in its own window', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?pane&profiles&browser&newWindow&workbench');
	await expect.poll(async () => ({ ready: await page.evaluate(() => Boolean(window.ashTerminalPaneIntegration)), errors })).toEqual({ ready: true, errors: [] });
	await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
	await expect(page.locator('.xterm')).toHaveCount(1);
	await page.getByRole('button', { name: 'Select Terminal Profile', exact: true }).click();
	const popupPromise = page.waitForEvent('popup');
	await page.getByRole('menuitem', { name: 'New Terminal Window', exact: true }).click();
	const popup = await popupPromise;
	popup.on('pageerror', error => errors.push(error.message));
	const input = popup.locator('.ash-terminal-editor .xterm-helper-textarea');
	await expect(input).toBeFocused();
	await expect(popup.locator('.ash-auxiliary-titlebar-compact')).toBeVisible();
	await input.pressSequentially('echo auxiliary');
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.newWindowState().input)).toBe('echo auxiliary');
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.newWindowState().parts)).toBe(2);
	await expect(page.locator('.ash-terminal-group-pane:visible .xterm')).toHaveCount(1);
	await page.evaluate(() => window.ashTerminalPaneIntegration.focus());
	await expect(page.locator('.ash-terminal-group-pane:visible .xterm-helper-textarea')).toBeFocused();
	await input.focus();
	await input.pressSequentially(' again');
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.newWindowState().input)).toBe('echo auxiliary again');
	await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
	await expect.poll(() => popup.isClosed()).toBe(true);
	expect(errors).toEqual([]);
});

test('splitting a configured shell retains its launch configuration after profile edits', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?pane&profiles&browser');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(async () => {
		await window.ashTerminalPaneIntegration.configure('terminal.integrated.profiles.linux', { Custom: { path: '/bin/custom', args: ['--login'], env: { CUSTOM: 'original' } } });
		window.ashTerminalPaneIntegration.panel(true);
	});
	await expect(page.locator('.xterm')).toHaveCount(1);
	await page.getByRole('button', { name: 'Select Terminal Profile', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Custom', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(2);
	const launch = await page.evaluate(() => window.ashTerminalPaneIntegration.launches().at(-1));
	await page.evaluate(() => window.ashTerminalPaneIntegration.configure('terminal.integrated.profiles.linux', {}));
	await page.evaluate(() => window.ashTerminalPaneIntegration.command('workbench.action.terminal.split'));
	await expect(page.getByRole('separator', { name: 'Resize terminal panes', exact: true })).toHaveCount(1);
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.launches().at(-1))).toEqual({ ...launch, cwd: '/backend/workspace' });
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(3);
	await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('screen reader textarea follows committed shell input and stops synchronizing when disabled', async ({ page }) => {
	await page.goto('/terminal.html?input&find');
	await page.waitForFunction(() => Boolean(window.ashTerminalInputIntegration));
	await page.evaluate(() => {
		window.ashTerminalInputIntegration.screenReader(true);
		window.ashTerminalInputIntegration.feed('\x1b[2J\x1b[H', { type: 'promptStart' });
		window.ashTerminalInputIntegration.feed('$ ', { type: 'commandStart' });
		window.ashTerminalInputIntegration.feed('echo 中文');
	});
	const input = page.locator('.xterm-helper-textarea');
	await expect(input).toHaveValue('echo 中文');
	await expect.poll(() => input.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([7, 7]);
	await page.evaluate(() => window.ashTerminalInputIntegration.screenReader(false));
	await page.evaluate(() => window.ashTerminalInputIntegration.feed('\b\bchanged'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toContain('changed');
	await expect(input).toHaveValue('echo 中文');
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

for (const locale of ['en', 'zh-CN'] as const) {
	test(`terminal split direction follows the real panel layout without replacing screens or sending input in ${locale}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/terminal.html?input&groups&panelLayout&locale=${locale}`);
		await expect.poll(async () => ({ ready: await page.evaluate(() => Boolean(window.ashTerminalGroupsIntegration)), errors })).toEqual({ ready: true, errors: [] });
		await page.evaluate(locale => window.ashTerminalFindIntegration.theme(locale === 'zh-CN' ? 'hcLight' : 'hcDark'), locale);
		const command = async (id: string): Promise<void> => { await page.evaluate(id => window.ashTerminalGroupsIntegration.command(id), id); };
		await command('workbench.action.terminal.split');
		const panes = page.locator('.ash-terminal-group-pane:visible');
		await expect(panes).toHaveCount(2);
		const ids = await panes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-instance-id')));
		const created = await page.evaluate(() => window.ashTerminalGroupsIntegration.metadata().created);
		await page.evaluate(() => window.ashTerminalGroupsIntegration.feed('retained-panel-output\r\n'));
		await expect(panes.nth(0).locator('.xterm-rows')).toContainText('retained-panel-output');
		const sash = page.getByRole('separator', { name: locale === 'zh-CN' ? '调整终端窗格大小' : 'Resize terminal panes', exact: true });
		const share = async (horizontal: boolean): Promise<number> => panes.evaluateAll((nodes, horizontal) => {
			const sizes = nodes.map(node => horizontal ? node.getBoundingClientRect().width : node.getBoundingClientRect().height);
			return sizes[0]! / sizes.reduce((sum, size) => sum + size, 0);
		}, horizontal);
		const before = await share(true);
		await sash.focus();
		await sash.press('ArrowRight');
		await expect.poll(() => share(true)).toBeGreaterThan(before);
		let expectedShare = await share(true);
		const input = panes.nth(1).locator('.xterm-helper-textarea');
		await input.focus();
		await input.pressSequentially('unsent-panel-input');
		await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.writes().map(write => write.data).join(''))).toContain('unsent-panel-input');
		await page.evaluate(() => window.ashTerminalGroupsIntegration.clearWrites());
		for (const [position, suffix, horizontal] of [['left', 'Left', false], ['top', 'Top', true], ['right', 'Right', false], ['bottom', 'Bottom', true]] as const) {
			await command(`workbench.action.positionPanel${suffix}`);
			await expect(page.locator('.ash-workbench-layout')).toHaveAttribute('data-panel-position', position);
			await expect(sash).toHaveAttribute('aria-orientation', horizontal ? 'vertical' : 'horizontal');
			const panel = (await page.locator('[data-part="panel"]').boundingBox())!;
			const editor = (await page.locator('[data-part="editor"]').boundingBox())!;
			if (position === 'left') expect(panel.x + panel.width).toBeLessThanOrEqual(editor.x + 1);
			if (position === 'right') expect(editor.x + editor.width).toBeLessThanOrEqual(panel.x + 1);
			if (position === 'top') expect(panel.y + panel.height).toBeLessThanOrEqual(editor.y + 1);
			if (position === 'bottom') expect(editor.y + editor.height).toBeLessThanOrEqual(panel.y + 1);
			await expect(input).toBeFocused();
			const separator = await panes.nth(1).locator('..').evaluate(element => {
				const style = getComputedStyle(element, '::before');
				return { color: style.backgroundColor, width: parseFloat(style.width), height: parseFloat(style.height) };
			});
			expect(separator.color).not.toBe('rgba(0, 0, 0, 0)');
			expect(horizontal ? separator.width : separator.height).toBeGreaterThan(0);
			await expect.poll(() => panes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-instance-id')))).toEqual(ids);
			await expect.poll(async () => Math.abs(await share(horizontal) - expectedShare)).toBeLessThan(0.025);
			if (position === 'left') {
				await sash.focus();
				await sash.press('ArrowDown');
				await expect.poll(() => share(false)).toBeGreaterThan(expectedShare);
				expectedShare = await share(false);
				await input.focus();
			}
			const first = (await panes.nth(0).boundingBox())!;
			const second = (await panes.nth(1).boundingBox())!;
			if (horizontal) {
				expect(second.x).toBeGreaterThanOrEqual(first.x + first.width - 1);
				expect(Math.abs(first.y - second.y)).toBeLessThan(1);
			} else {
				expect(second.y).toBeGreaterThanOrEqual(first.y + first.height - 1);
				expect(Math.abs(first.x - second.x)).toBeLessThan(1);
			}
			await expect(panes.nth(0).locator('.xterm-rows')).toContainText('retained-panel-output');
			expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.writes())).toEqual([]);
			expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.metadata().created)).toBe(created);
		}
		await command('workbench.action.positionPanelRight');
		const target = page.locator(`.ash-terminal-group-pane[data-instance-id="${ids[1]}"]`);
		const bounds = (await target.boundingBox())!;
		await page.locator(`#${ids[0]}-tab`).dragTo(target, { targetPosition: { x: 10, y: bounds.height - 10 } });
		await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.groups())).toEqual([[ids[1], ids[0]]]);
		expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.writes())).toEqual([]);
		expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.metadata().created)).toBe(created);
		expect(errors).toEqual([]);
	});
}

for (const moveFocus of [false, true]) {
	test(`restored terminal keeps deferred focus ownership before its first visible layout (move focus: ${moveFocus})`, async ({ page }) => {
		await page.goto('/terminal.html?deferredFocus&browser');
		await page.waitForFunction(() => Boolean(window.ashTerminalDeferredFocusIntegration));
		const root = page.locator('#terminal-deferred-focus');
		await expect(root.locator('.xterm-helper-textarea')).toHaveCount(0);
		await page.getByRole('button', { name: 'Focus source', exact: true }).focus();
		await page.evaluate(() => window.ashTerminalDeferredFocusIntegration.focus());
		const other = page.getByRole('button', { name: 'Other focus target', exact: true });
		if (moveFocus) await other.focus();
		await page.evaluate(() => window.ashTerminalDeferredFocusIntegration.reveal());
		const input = root.locator('.xterm-helper-textarea');
		await expect(input).toHaveCount(1);
		await expect(root.locator('.xterm-rows')).toContainText('retained deferred output');
		if (moveFocus) {
			await expect(other).toBeFocused();
			await expect(input).not.toBeFocused();
		} else await expect(input).toBeFocused();
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`terminal font zoom commands and wheel resize the retained screen without sending input in ${locale}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/terminal.html?input&groups&locale=${locale}`);
		await page.waitForFunction(() => Boolean(window.ashTerminalGroupsIntegration));
		const command = (id: string): Promise<unknown> => page.evaluate(id => window.ashTerminalGroupsIntegration.command(id), id);
		const rows = page.locator('.ash-terminal-group-pane:visible .xterm-rows');
		const input = page.locator('.ash-terminal-group-pane:visible .xterm-helper-textarea');
		const fontSize = () => rows.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
		const initialSize = await fontSize();
		await page.evaluate(() => window.ashTerminalInputIntegration.configure('terminal.integrated.fontSize', 18));
		await expect.poll(fontSize).toBe(18);
		await page.evaluate(() => window.ashTerminalGroupsIntegration.feed('retained zoom output\r\n'));
		await expect(rows).toContainText('retained zoom output');
		await input.focus();
		await input.pressSequentially('pending-zoom-input');
		await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.writes().map(write => write.data).join(''))).toContain('pending-zoom-input');
		await input.evaluate(element => { element.dataset.zoomScreen = 'retained'; });
		await page.evaluate(() => window.ashTerminalGroupsIntegration.clearWrites());
		const before = await page.evaluate(() => ({
			dimensions: window.ashTerminalInputIntegration.dimensions(),
			sizes: window.ashTerminalGroupsIntegration.sizes().length,
			created: window.ashTerminalGroupsIntegration.metadata().created,
		}));
		await command('workbench.action.terminal.fontZoomIn');
		await expect.poll(fontSize).toBe(19);
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.dimensions().cols)).toBeLessThan(before.dimensions.cols);
		const resized = await page.evaluate(() => window.ashTerminalInputIntegration.dimensions());
		await expect.poll(() => page.evaluate(({ after, dimensions }) => window.ashTerminalGroupsIntegration.sizes().slice(after).some(size => size.cols === dimensions.cols && size.rows === dimensions.rows), { after: before.sizes, dimensions: resized })).toBe(true);
		await command('workbench.action.terminal.fontZoomOut');
		await expect.poll(fontSize).toBe(18);
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.dimensions())).toEqual(before.dimensions);
		await command('workbench.action.terminal.fontZoomReset');
		await expect.poll(fontSize).toBe(initialSize);
		await page.evaluate(() => window.ashTerminalInputIntegration.configure('terminal.integrated.fontSize', 18));

		let wheelTime = 1000;
		const wheel = (options: Pick<WheelEventInit, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'deltaY' | 'deltaMode'> = {}) => page.locator('.ash-terminal-group-pane:visible .xterm-viewport').evaluate((element, { time, options }) => {
			let reachedViewport = false;
			const reached = () => { reachedViewport = true; };
			element.addEventListener('wheel', reached, { capture: true });
			try {
				const event = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true, ...options });
				Object.defineProperty(event, 'timeStamp', { value: performance.now() + time });
				element.dispatchEvent(event);
				return { reachedViewport, defaultPrevented: event.defaultPrevented };
			} finally {
				element.removeEventListener('wheel', reached, { capture: true });
			}
		}, { time: wheelTime += 100, options });
		// The default setting leaves wheel events available to the terminal viewport.
		expect((await wheel()).reachedViewport).toBe(true);
		await command('workbench.action.terminal.fontZoomIn');
		await expect.poll(fontSize).toBe(19);
		await page.evaluate(() => window.ashTerminalInputIntegration.configure('terminal.integrated.mouseWheelZoom', true));
		expect(await wheel()).toEqual({ reachedViewport: false, defaultPrevented: true });
		await command('workbench.action.terminal.fontZoomIn');
		await expect.poll(fontSize).toBe(21);
		expect((await wheel({ ctrlKey: false })).reachedViewport).toBe(true);
		await command('workbench.action.terminal.fontZoomOut');
		await expect.poll(fontSize).toBe(20);
		const mac = await page.evaluate(() => navigator.platform.toLowerCase().includes('mac'));
		const commandWheel = await wheel({ ctrlKey: false, metaKey: true });
		expect(commandWheel.reachedViewport).toBe(!mac);
		await command('workbench.action.terminal.fontZoomOut');
		await expect.poll(fontSize).toBe(mac ? 20 : 19);
		// Ctrl-modified pixels also cover the browser's macOS pinch representation.
		expect(await wheel({ deltaY: 5, ctrlKey: true })).toEqual({ reachedViewport: false, defaultPrevented: true });
		await command('workbench.action.terminal.fontZoomIn');
		await expect.poll(fontSize).toBe(mac ? 20 : 19);
		await page.evaluate(() => window.ashTerminalInputIntegration.configure('terminal.integrated.mouseWheelZoom', false));
		expect((await wheel()).reachedViewport).toBe(true);
		await command('workbench.action.terminal.fontZoomIn');
		await expect.poll(fontSize).toBe(mac ? 21 : 20);
		await expect(input).toBeFocused();
		await expect(input).toHaveAttribute('data-zoom-screen', 'retained');
		await expect(rows).toContainText('retained zoom output');
		expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.writes())).toEqual([]);
		expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.metadata().created)).toBe(before.created);
		expect(errors).toEqual([]);
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`terminal resize dimensions overlay follows the committed grid and setting without taking focus in ${locale}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/terminal.html?input&groups&browser&locale=${locale}`);
		await page.waitForFunction(() => Boolean(window.ashTerminalGroupsIntegration));
		await page.evaluate(locale => window.ashTerminalFindIntegration.theme(locale === 'zh-CN' ? 'hcLight' : 'dark'), locale);
		const command = (id: string): Promise<unknown> => page.evaluate(id => window.ashTerminalGroupsIntegration.command(id), id);
		const firstPane = page.locator('.ash-terminal-group-pane:visible').first();
		const overlay = firstPane.locator('.ash-terminal-resize-dimensions-overlay');
		// Attachment is observable readiness for the contribution's startup grace period.
		await expect(overlay).toHaveCount(1);
		await expect(overlay).toBeHidden();
		await page.evaluate(() => window.ashTerminalGroupsIntegration.feed('retained dimensions output\r\n'));
		await expect(firstPane.locator('.xterm-rows')).toContainText('retained dimensions output');
		await command('workbench.action.terminal.split');
		await expect(page.locator('.ash-terminal-group-pane:visible')).toHaveCount(2);
		await expect(page.locator('.ash-terminal-group-pane:visible .ash-terminal-resize-dimensions-overlay')).toHaveCount(2);
		await expect(overlay).toBeHidden();
		const original = await page.evaluate(() => ({
			dimensions: window.ashTerminalInputIntegration.dimensions(),
			created: window.ashTerminalGroupsIntegration.metadata().created,
		}));
		await page.evaluate(() => window.ashTerminalGroupsIntegration.clearWrites());
		const sash = page.getByRole('separator', { name: locale === 'zh-CN' ? '调整终端窗格大小' : 'Resize terminal panes', exact: true });
		await sash.focus();
		await sash.press('ArrowRight');
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.dimensions().cols)).toBeGreaterThan(original.dimensions.cols);
		const dimensions = await page.evaluate(() => window.ashTerminalInputIntegration.dimensions());
		await expect(overlay).toBeVisible();
		await expect(overlay).toHaveText(locale === 'zh-CN' ? `${dimensions.cols} 列 × ${dimensions.rows} 行` : `${dimensions.cols} columns × ${dimensions.rows} rows`);
		await expect(overlay).toHaveAttribute('aria-hidden', 'true');
		await expect(sash).toBeFocused();
		const style = await overlay.evaluate(element => {
			const style = getComputedStyle(element);
			return { pointerEvents: style.pointerEvents, background: style.backgroundColor, borderWidth: parseFloat(style.borderWidth), borderColor: style.borderColor, radius: parseFloat(style.borderRadius) };
		});
		expect(style.pointerEvents).toBe('none');
		expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
		expect(style.borderColor).not.toBe('rgba(0, 0, 0, 0)');
		expect(style.borderWidth).toBeGreaterThan(0);
		expect(style.radius).toBe(8);
		const badge = (await overlay.boundingBox())!;
		const terminal = (await firstPane.locator('.ash-terminal-instance').boundingBox())!;
		expect(Math.abs(badge.x + badge.width / 2 - terminal.x - terminal.width / 2)).toBeLessThan(1);
		expect(Math.abs(badge.y + badge.height / 2 - terminal.y - terminal.height / 2)).toBeLessThan(1);
		await expect(overlay).toBeHidden();

		await page.evaluate(() => window.ashTerminalInputIntegration.configure('terminal.integrated.resizeDimensionsOverlay.enabled', false));
		await expect(page.locator('.ash-terminal-resize-dimensions-overlay')).toHaveCount(0);
		const input = firstPane.locator('.xterm-helper-textarea');
		await input.focus();
		await command('workbench.action.terminal.fontZoomIn');
		await expect(page.locator('.ash-terminal-resize-dimensions-overlay')).toHaveCount(0);
		await page.evaluate(() => window.ashTerminalInputIntegration.configure('terminal.integrated.resizeDimensionsOverlay.enabled', true));
		await expect(overlay).toBeHidden();
		await command('workbench.action.terminal.fontZoomOut');
		await expect(overlay).toBeVisible();
		await expect(input).toBeFocused();
		await expect(firstPane.locator('.xterm-rows')).toContainText('retained dimensions output');
		expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.writes())).toEqual([]);
		expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.metadata().created)).toBe(original.created);
		await page.evaluate(() => window.ashTerminalGroupsIntegration.dispose());
		await expect(page.locator('.ash-terminal-resize-dimensions-overlay')).toHaveCount(0);
		expect(errors).toEqual([]);
	});
}

async function hoverCommandGuideOutput(page: Page): Promise<void> {
	const output = page.locator('.ash-terminal-instance:visible .xterm-rows > div').filter({ hasText: 'first line' });
	await expect(output).toBeVisible();
	const bounds = (await output.boundingBox())!;
	// xterm's screen receives pointer events; rendered rows only supply cell geometry.
	await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
}

for (const theme of ['dark', 'light', 'hcDark', 'hcLight'] as const) {
	test(`terminal command guide projects command rows and follows the ${theme} theme without sending input`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await seedScreenCommand(page);
		await page.evaluate(theme => window.ashTerminalFindIntegration.theme(theme), theme);
		const command = page.locator('.ash-terminal-instance:visible .xterm-rows > div').filter({ hasText: '$ echo marker' });
		const output = page.locator('.ash-terminal-instance:visible .xterm-rows > div').filter({ hasText: 'first line' });
		await expect(output).toBeVisible();
		await hoverCommandGuideOutput(page);
		const guide = page.locator('.ash-terminal-command-guide');
		await expect(guide).toBeVisible();
		await expect(guide).toHaveAttribute('aria-hidden', 'true');
		const commandBounds = await command.boundingBox();
		const geometry = await guide.evaluate(element => {
			const bounds = element.getBoundingClientRect();
			const screen = element.closest('.ash-terminal-instance')!.querySelector('.xterm-screen')!.getBoundingClientRect();
			const terminal = element.closest('.ash-terminal-instance')!.getBoundingClientRect();
			return { top: bounds.top, height: bounds.height, inGutter: bounds.left >= terminal.left && bounds.right < screen.left, pointerEvents: getComputedStyle(element).pointerEvents };
		});
		expect(geometry.top).toBeCloseTo(commandBounds!.y, 0);
		expect(geometry.height).toBeCloseTo(commandBounds!.height * 3, 0);
		expect(geometry.inGutter).toBe(true);
		expect(geometry.pointerEvents).toBe('none');
		const color = await guide.evaluate(element => getComputedStyle(element).borderLeftColor);
		expect(color).not.toBe('rgba(0, 0, 0, 0)');
		if (theme === 'hcDark') expect(color).toBe('rgb(255, 255, 255)');
		if (theme === 'hcLight') expect(color).toBe('rgb(0, 0, 0)');
		await page.evaluate(theme => window.ashTerminalFindIntegration.theme(theme, { 'terminalCommandGuide.foreground': '#123456' }), theme);
		await expect(guide).toHaveCSS('border-left-color', 'rgb(18, 52, 86)');
		await page.mouse.move(0, 0);
		await expect(guide).toBeHidden();
		expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
		await page.evaluate(() => window.ashTerminalInputIntegration.close());
		await expect(guide).toHaveCount(0);
		expect(errors).toEqual([]);
	});
}

test('terminal command guide clears on typing, alternate buffer, disabled configuration and trimmed markers', async ({ page }) => {
	await seedScreenCommand(page);
	const output = page.locator('.ash-terminal-instance:visible .xterm-rows > div').filter({ hasText: 'first line' });
	const guide = page.locator('.ash-terminal-command-guide');
	await hoverCommandGuideOutput(page);
	await expect(guide).toBeVisible();
	await page.locator('.ash-terminal-instance:visible .xterm-helper-textarea').press('x');
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes.join(''))).toBe('x');
	await expect(guide).toBeHidden();
	await page.mouse.move(0, 0);
	await hoverCommandGuideOutput(page);
	await expect(guide).toBeVisible();
	await page.evaluate(() => window.ashTerminalInputIntegration.feed('\x1b[?1049h'));
	await expect(guide).toBeHidden();
	await page.evaluate(() => window.ashTerminalInputIntegration.feed('\x1b[?1049l'));
	await expect(output).toBeVisible();
	await page.mouse.move(0, 0);
	await hoverCommandGuideOutput(page);
	await expect(guide).toBeVisible();
	await page.evaluate(() => window.ashTerminalInputIntegration.configure('terminal.integrated.shellIntegration.showCommandGuide', false));
	await expect(guide).toBeHidden();
	await page.mouse.move(0, 0);
	await hoverCommandGuideOutput(page);
	await expect(guide).toBeHidden();
	await page.evaluate(() => window.ashTerminalInputIntegration.configure('terminal.integrated.shellIntegration.showCommandGuide', true));
	await page.mouse.move(0, 0);
	await hoverCommandGuideOutput(page);
	await expect(guide).toBeVisible();
	await page.evaluate(async () => {
		window.ashTerminalInputIntegration.clear();
		await window.ashTerminalInputIntegration.configure('terminal.integrated.scrollback', 0);
		window.ashTerminalInputIntegration.feed('trim command markers\r\n'.repeat(100));
	});
	await expect(page.locator('.ash-terminal-command-status.succeeded')).toHaveCount(0);
	await expect(guide).toBeHidden();
	await page.locator('.ash-terminal-instance:visible .xterm-screen').hover();
	await expect(guide).toBeHidden();
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
	await expect(guide).toHaveCount(0);
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
});

for (const locale of ['en', 'zh-CN']) {
	test(`terminal typeahead confirms raw echo without changing parsed output or duplicating input in ${locale}`, async ({ page }) => {
		await seedScreenCommand(page, true, locale);
		await page.evaluate(() => window.ashTerminalInputIntegration.configure('terminal.integrated.localEchoEnabled', 'on'));
		const screen = page.locator('.ash-terminal-instance:visible');
		const prediction = screen.locator('.ash-terminal-typeahead');
		const input = screen.locator('.xterm-helper-textarea');
		const rows = screen.locator('.xterm-rows');
		await input.press('a');
		await expect(prediction).toBeEmpty();
		await page.evaluate(() => window.ashTerminalInputIntegration.feed('a'));
		await expect(rows).toContainText('next prompta');
		await input.pressSequentially('bc');
		await expect(prediction).toHaveText('bc');
		await expect(prediction).toHaveAttribute('aria-hidden', 'true');
		await expect(rows).not.toContainText('abc');
		await page.evaluate(() => window.ashTerminalInputIntegration.feed('b'));
		await expect(prediction).toHaveText('c');
		await page.evaluate(() => window.ashTerminalInputIntegration.feed('c'));
		await expect(prediction).toBeEmpty();
		await expect(rows).toContainText('abc');
		expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes.join(''))).toBe('abc');
		await input.pressSequentially('xyz');
		await expect(prediction).toHaveText('xyz');
		await page.evaluate(() => window.ashTerminalInputIntegration.feed('different output'));
		await expect(prediction).toBeEmpty();
		await expect(rows).toContainText('different output');
		await input.press('Enter');
		await input.pressSequentially('password');
		await expect(prediction).toBeEmpty();
		await page.evaluate(() => window.ashTerminalInputIntegration.close());
		await expect(prediction).toHaveCount(0);
	});
}
