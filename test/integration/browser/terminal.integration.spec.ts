import { expect, test } from '@playwright/test';

test('terminal Find navigates real matches without sending its keys to the process', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?input&find');
	await page.waitForFunction(() => Boolean(window.ashTerminalFindIntegration));
	await page.evaluate(() => window.ashTerminalInputIntegration.feed('needle one\r\nNEEDLE two\r\nneedles three\r\nneedle four\r\n'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toContain('needle four');
	await page.evaluate(() => window.ashTerminalInputIntegration.clear());
	expect(await page.evaluate(() => window.ashTerminalFindIntegration.context())).toEqual({ terminal: true, find: false });
	await page.keyboard.press('ControlOrMeta+f');
	const find = page.getByRole('region', { name: 'Find in terminal' });
	const input = find.getByRole('textbox', { name: 'Find', exact: true });
	await expect(input).toBeFocused();
	expect(await page.evaluate(() => window.ashTerminalFindIntegration.context())).toEqual({ terminal: false, find: true });
	await input.fill('needle');
	await expect(find.getByRole('status')).toHaveText('1 of 4');
	await input.press('Enter');
	await expect(find.getByRole('status')).toHaveText('2 of 4');
	await input.press('Shift+Enter');
	await expect(find.getByRole('status')).toHaveText('1 of 4');
	await find.getByRole('button', { name: 'Match case', exact: true }).click();
	await expect(find.getByRole('status')).toHaveText(/of 3$/u);
	await find.getByRole('button', { name: 'Whole word', exact: true }).click();
	await expect(find.getByRole('status')).toHaveText(/of 2$/u);
	await input.focus();
	await input.press('Tab');
	await expect(find.getByRole('button', { name: 'Match case', exact: true })).toBeFocused();
	await page.locator('.xterm-helper-textarea').focus();
	await page.keyboard.press('F3');
	await expect(find.getByRole('status')).toHaveText('2 of 2');
	await input.focus();
	const help = await page.evaluate(() => window.ashTerminalFindIntegration.help());
	expect(help).toContain('Shift+Enter');
	await expect(input).toBeFocused();
	await input.press('Escape');
	await expect(find).toHaveCount(0);
	await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
	expect(await page.evaluate(() => window.ashTerminalFindIntegration.result().selection)).toBe('');
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
	await page.getByRole('textbox', { name: 'Outside terminal', exact: true }).focus();
	await page.keyboard.press('ControlOrMeta+f');
	await expect(find).toHaveCount(0);
	await page.locator('.xterm-helper-textarea').focus();
	await page.keyboard.press('ControlOrMeta+f');
	await expect(input).toHaveValue('needle');
	await expect(find.getByRole('button', { name: 'Whole word', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
	await expect(page.locator('.ash-terminal-find')).toHaveCount(0);
	expect(await page.evaluate(() => window.ashTerminalFindIntegration.errors())).toEqual([]);
	expect(errors).toEqual([]);
});

test('terminal Find rejects invalid regex and follows parsed output and wrapped matches', async ({ page }) => {
	await page.goto('/terminal.html?input&find');
	await page.waitForFunction(() => Boolean(window.ashTerminalFindIntegration));
	await page.evaluate(() => window.ashTerminalFindIntegration.command('workbench.action.terminal.focusFind'));
	const find = page.getByRole('region', { name: 'Find in terminal' });
	const input = find.getByRole('textbox', { name: 'Find', exact: true });
	await input.fill('later');
	await expect(find.getByRole('status')).toHaveText('No results');
	await page.evaluate(() => window.ashTerminalInputIntegration.feed('later 123\r\n'));
	await expect(find.getByRole('status')).toHaveText('1 of 1');
	await find.getByRole('button', { name: 'Regular expression', exact: true }).click();
	await input.fill('[');
	await expect(input).toHaveAttribute('aria-invalid', 'true');
	await expect(find.getByRole('status')).toHaveText('Invalid regular expression');
	await expect(find.getByRole('button', { name: 'Next match', exact: true })).toBeDisabled();
	await input.fill('later \\d+');
	await expect(find.getByRole('status')).toHaveText('1 of 1');
	expect(await page.evaluate(() => window.ashTerminalFindIntegration.result().selection)).toBe('later 123');
	await find.getByRole('button', { name: 'Regular expression', exact: true }).click();
	const text = 'wrapped-' + 'match'.repeat(30);
	await page.evaluate(text => window.ashTerminalInputIntegration.feed(text + '\r\n'), text);
	await input.fill(text);
	await expect(find.getByRole('status')).toHaveText('1 of 1');
	expect(await page.evaluate(() => window.ashTerminalFindIntegration.result().selection)).toBe(text);
	await page.evaluate(() => window.ashTerminalFindIntegration.command('workbench.action.terminal.hideFind'));
	await page.evaluate(() => window.ashTerminalInputIntegration.feed('later 456\r\n'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toContain('later 456');
	expect(await page.evaluate(() => window.ashTerminalFindIntegration.result().selection)).toBe('');
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
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

test('terminal Find reaches scrollback and closing during its first search releases the feature', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?input&find');
	await page.waitForFunction(() => Boolean(window.ashTerminalFindIntegration));
	await page.evaluate(() => window.ashTerminalInputIntegration.feed('old-match\r\n' + 'new output\r\n'.repeat(80)));
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toContain('old-match');
	await expect(page.locator('.xterm-rows')).not.toContainText('old-match');
	await page.keyboard.press('ControlOrMeta+f');
	const input = page.getByRole('textbox', { name: 'Find', exact: true });
	await input.fill('old-match');
	await expect(page.locator('.ash-terminal-find-result')).toHaveText('1 of 1');
	expect(await page.evaluate(() => window.ashTerminalFindIntegration.result().selection)).toBe('old-match');
	await input.press('Escape');
	await page.keyboard.press('F3');
	await expect(page.locator('.ash-terminal-find-result')).toHaveText('1 of 1');
	await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
	await expect(page.locator('.ash-terminal-find')).toHaveCount(0);

	// A fresh page has not fetched the SearchAddon; close in the same turn that requests it.
	await page.goto('/terminal.html?input&find');
	await page.waitForFunction(() => Boolean(window.ashTerminalFindIntegration));
	await page.evaluate(async () => {
		await window.ashTerminalFindIntegration.command('workbench.action.terminal.focusFind');
		const input = document.querySelector<HTMLInputElement>('.ash-terminal-find input')!;
		input.value = 'waiting for addon';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await window.ashTerminalInputIntegration.close();
	});
	await expect(page.locator('.ash-terminal-instance')).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => window.ashTerminalFindIntegration.errors())).toEqual([]);
	expect(errors).toEqual([]);
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

test('terminal context captures parsed queued output, wrapped lines and a bounded tail', async ({ page }) => {
	await page.goto('/terminal.html');
	await page.waitForFunction(() => Boolean(window.ashTerminalIntegration));
	const wrapped = 'x'.repeat(100);
	const snapshot = await page.evaluate(async text => {
		window.ashTerminalIntegration.write(`\x1b[32mgreen\x1b[0m\r\n${text}\r\nlast`);
		return window.ashTerminalIntegration.snapshot(1000);
	}, wrapped);
	expect(snapshot).toBe(`green\n${wrapped}\nlast`);
	expect(await page.evaluate(() => window.ashTerminalIntegration.snapshot(4))).toBe('[Earlier output omitted]\nlast');
	expect(await page.evaluate(async () => {
		const pending = window.ashTerminalIntegration.snapshot(1000);
		window.ashTerminalIntegration.dispose();
		return pending;
	})).toBeUndefined();
});

test('hidden terminal view exposes its retained output without changing focus or creating a shell', async ({ page }) => {
	await page.goto('/terminal.html?pane&existing');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(() => window.ashTerminalIntegration.write('hidden output\r\n'));
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.snapshot())).toBe('hidden output');
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.counts())).toEqual({ profiles: 0, creates: 0 });
	await expect(page.locator('.ash-terminal-instance:visible')).toHaveCount(0);
});

test('terminal context prefers the user selection over unrelated output', async ({ page }) => {
	await page.goto('/terminal.html');
	await page.waitForFunction(() => Boolean(window.ashTerminalIntegration));
	await page.evaluate(() => {
		window.ashTerminalIntegration.write('first selected last\r\nother output');
		window.ashTerminalIntegration.start();
	});
	await page.evaluate(() => window.ashTerminalIntegration.ready());
	await expect(page.locator('.xterm-rows')).toContainText('first selected last');
	const screen = await page.locator('.xterm-screen').boundingBox();
	const columns = await page.evaluate(() => window.ashTerminalIntegration.resizes.at(-1)!.cols);
	const row = await page.locator('.xterm-rows > div').first().boundingBox();
	await page.mouse.dblclick(screen!.x + screen!.width / columns * 9, row!.y + row!.height / 2);
	expect(await page.evaluate(() => window.ashTerminalIntegration.snapshot(100_000))).toBe('selected');
});


test('terminal commands stay in their window after another view is created and disposed', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?windows');
	await page.waitForFunction(() => Boolean(window.ashTerminalWindowsIntegration));
	await page.evaluate(() => window.ashTerminalWindowsIntegration.forEach(pane => pane.panel(true)));
	await expect.poll(() => page.evaluate(() => window.ashTerminalWindowsIntegration.map(pane => pane.counts().creates))).toEqual([1, 1]);
	const first = page.locator('#window-0');
	const second = page.locator('#window-1');
	await expect(first.getByRole('button', { name: 'New Terminal', exact: true })).toHaveCount(1);
	await expect(second.getByRole('button', { name: 'New Terminal', exact: true })).toHaveCount(1);
	await first.getByRole('button', { name: 'New Terminal', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashTerminalWindowsIntegration.map(pane => pane.counts().creates))).toEqual([2, 1]);
	await page.evaluate(() => window.ashTerminalWindowsIntegration[1]!.command('workbench.action.terminal.newWithProfile', 'shell'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalWindowsIntegration.map(pane => pane.counts().creates))).toEqual([2, 2]);
	await page.evaluate(() => window.ashTerminalWindowsIntegration[0]!.dispose());
	await expect(first.locator('.ash-terminal-title-toolbar')).toHaveCount(0);
	await second.getByRole('button', { name: 'New Terminal', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashTerminalWindowsIntegration.map(pane => pane.counts().creates))).toEqual([2, 3]);
	await page.evaluate(() => window.ashTerminalWindowsIntegration[1]!.dispose());
	expect(errors).toEqual([]);
});


test('terminal screen follows light, dark and high contrast themes after initialization', async ({ page }) => {
	await page.goto('/terminal.html');
	await page.waitForFunction(() => Boolean(window.ashTerminalIntegration));
	await page.evaluate(async () => { window.ashTerminalIntegration.start(); await window.ashTerminalIntegration.ready(); });
	for (const [mode, expected] of [
		['dark', { background: '#1e1e1e', foreground: '#d4d4d4', red: '#cf222e' }],
		['light', { background: '#ffffff', foreground: '#333333', red: '#cf222e' }],
		['hcDark', { background: '#000000', foreground: '#ffffff', red: '#ff8080' }],
		['hcLight', { background: '#ffffff', foreground: '#000000', red: '#a00000' }],
	] as const) {
		expect(await page.evaluate(mode => window.ashTerminalIntegration.theme(mode), mode)).toEqual(expected);
		await expect(page.locator('.xterm-scrollable-element')).toHaveCSS('background-color', mode === 'hcDark' ? 'rgb(0, 0, 0)' : mode === 'dark' ? 'rgb(30, 30, 30)' : 'rgb(255, 255, 255)');
	}
	await page.evaluate(() => window.ashTerminalIntegration.dispose());
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
