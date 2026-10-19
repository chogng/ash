import { expect, test, type Page } from '@playwright/test';

for (const locale of ['en', 'zh-CN']) {
	test(`terminal path drops insert literal filenames and recent directories support keyboard acceptance and cancellation in ${locale}`, async ({ page }) => {
		await page.goto(`/terminal.html?input&groups&clipboard&browser&locale=${locale}`);
		await page.waitForFunction(() => Boolean(window.ashTerminalInputIntegration));
		await page.evaluate(() => window.ashTerminalInputIntegration.clear());
		await page.locator('.ash-terminal-instance:visible').first().dispatchEvent('drop', {
			dataTransfer: await page.evaluateHandle(() => { const transfer = new DataTransfer(); transfer.setData('text/uri-list', "file:///workspace/space%20%27%24%28literal%29.sh"); return transfer; }),
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

for (const locale of ['en', 'zh-CN']) {
	test(`terminal command marker menu copies bounded output and selects the command in ${locale}`, async ({ page }) => {
		await seedScreenCommand(page, true, locale);
		const marker = page.locator('.ash-terminal-command-status.succeeded');
		await expect(marker).toHaveAttribute('role', 'button');
		for (const [label, value] of [
			[locale === 'zh-CN' ? '复制命令' : 'Copy Command', 'echo marker'],
			[locale === 'zh-CN' ? '复制输出' : 'Copy Output', 'first line\nlast line'],
			[locale === 'zh-CN' ? '复制命令及输出' : 'Copy Command and Output', 'echo marker\nfirst line\nlast line'],
		] as const) {
			await marker.focus();
			await marker.press('Shift+F10');
			await page.getByRole('menuitem', { name: label, exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashTerminalClipboardIntegration.copied.at(-1))).toBe(value);
		}
		await marker.click();
		await page.getByRole('menuitem', { name: locale === 'zh-CN' ? '选择命令' : 'Select Command', exact: true }).click();
		expect((await page.evaluate(() => window.ashTerminalClipboardIntegration.selection())).trimEnd()).toBe('echo marker');
		expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
		await marker.focus();
		await marker.press('Enter');
		await page.keyboard.press('Escape');
		await expect(page.getByRole('menu')).toHaveCount(0);
	});
}

test('terminal command rerun targets its original process only after an explicit menu action', async ({ page }) => {
	await seedScreenCommand(page);
	await page.locator('.ash-terminal-command-status.succeeded').click();
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
	await page.getByRole('menuitem', { name: 'Rerun Command', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['echo marker\r']);
	expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.metadata().created)).toBe(1);
});

test('terminal untrusted command rerun requires confirmation and retires after switching away and back', async ({ page }) => {
	await seedScreenCommand(page, false);
	const marker = page.locator('.ash-terminal-command-status.succeeded');
	await marker.click();
	await page.getByRole('menuitem', { name: 'Rerun Command', exact: true }).click();
	await expect(page.getByRole('dialog')).toContainText('Run this command again?');
	await page.keyboard.press('Escape');
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
	await marker.click();
	await page.getByRole('menuitem', { name: 'Rerun Command', exact: true }).click();
	await expect(page.getByRole('dialog')).toBeVisible();
	await page.evaluate(async () => { await window.ashTerminalClipboardIntegration.switchAway(); window.ashTerminalClipboardIntegration.switchBack(); });
	await page.getByRole('button', { name: 'Run', exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
	await marker.click();
	await page.getByRole('menuitem', { name: 'Rerun Command', exact: true }).click();
	await page.getByRole('button', { name: 'Run', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['echo marker\r']);
});

test('terminal buffer trim dismisses the command menu and retires its copy callbacks', async ({ page }) => {
	await seedScreenCommand(page);
	await page.evaluate(() => window.ashTerminalInputIntegration.configure('terminal.integrated.scrollback', 0));
	await page.locator('.ash-terminal-command-status.succeeded').click();
	await expect(page.getByRole('menuitem', { name: 'Copy Output', exact: true })).toBeVisible();
	await page.evaluate(() => window.ashTerminalInputIntegration.feed('scroll\r\n'.repeat(100)));
	await expect(page.locator('.ash-terminal-command-status.succeeded')).toHaveCount(0);
	await expect(page.getByRole('menu')).toHaveCount(0);
	expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.copied)).toEqual([]);
});

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

test('terminal Find navigates real matches without sending its keys to the process', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?input&find');
	await expect.poll(async () => ({ initialized: await page.evaluate(() => Boolean(window.ashTerminalFindIntegration)), errors })).toEqual({ initialized: true, errors: [] });
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

test('a terminal arriving during profile discovery prevents an extra default process', async ({ page }) => {
	await page.goto('/terminal.html?pane&incoming');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(() => {
		window.ashTerminalPaneIntegration.hold();
		window.ashTerminalPaneIntegration.panel(true);
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.counts())).toEqual({ profiles: 1, creates: 0 });
	await page.evaluate(async () => {
		await window.ashTerminalPaneIntegration.receive();
		window.ashTerminalPaneIntegration.release();
	});
	await expect(page.locator('.xterm')).toHaveCount(1);
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(1);
	await page.evaluate(() => window.ashTerminalIntegration.dispose());
});

test('a transfer window waits for its incoming process before creating a default shell', async ({ page }) => {
	await page.goto('/terminal.html?pane&incoming&transfer');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(async () => {
		window.ashTerminalPaneIntegration.panel(true);
		await new Promise(requestAnimationFrame);
	});
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(0);
	await page.evaluate(() => window.ashTerminalPaneIntegration.receive());
	await expect(page.locator('.xterm')).toHaveCount(1);
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(1);
	await page.evaluate(() => window.ashTerminalPaneIntegration.command('workbench.action.terminal.kill'));
	await page.evaluate(() => {
		window.ashTerminalPaneIntegration.panel(false);
		window.ashTerminalPaneIntegration.panel(true);
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(2);
	await page.evaluate(() => window.ashTerminalIntegration.dispose());
});

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


test('terminal dictation writes phrases without executing and cancels when the panel hides', async ({ page }) => {
	await page.goto('/terminal.html?pane&existing');
	await page.waitForFunction(() => window.ashTerminalPaneIntegration !== undefined);
	await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
	await page.getByRole('button', { name: 'Terminal: Start dictation', exact: true }).focus();
	await page.keyboard.press('Space');
	await expect(page.getByRole('button', { name: 'Stop dictation', exact: true })).toBeEnabled();
	await page.evaluate(() => window.ashTerminalPaneIntegration.transcript('echo hello\n\u001b', true));
	await page.getByRole('button', { name: 'Stop dictation', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashTerminalIntegration.writes)).toEqual(['echo hello ']);
	await page.getByRole('button', { name: 'Terminal: Start dictation', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Stop dictation', exact: true })).toBeEnabled();
	await page.evaluate(() => window.ashTerminalPaneIntegration.transcript('unfinished', false));
	await page.evaluate(() => window.ashTerminalPaneIntegration.panel(false));
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.stops())).toBe(2);
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
	expect(result.missingDependency).toBe('Error: Unknown service: terminalProcessService');
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
		await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.snapshot())).toBe(`中文🙂\n\n${locale === 'zh-CN' ? '[进程已退出，代码为 0]' : '[process exited with code 0]'}`);
		await page.evaluate(() => window.ashTerminalStreamIntegration.close());
		await expect(page.locator('.ash-terminal-instance')).toHaveCount(0);
		expect(errors).toEqual([]);
	});
}

test('terminal bounds unseen display history while process observers still receive every chunk', async ({ page }) => {
	await page.goto('/terminal.html?stream&deferred&overflow');
	await page.waitForFunction(() => Boolean(window.ashTerminalStreamIntegration));
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.status().state)).toBe('exited');
	expect(await page.evaluate(() => window.ashTerminalStreamIntegration.observed())).toMatch(/^line-0\r\n.*line-4099\r\n$/su);
	await page.evaluate(() => window.ashTerminalStreamIntegration.start());
	const output = await page.evaluate(() => window.ashTerminalStreamIntegration.snapshot());
	expect(output).toMatch(/\[terminal output truncated\].*line-5\n.*line-4099/su);
	expect(output).not.toMatch(/^line-0$/mu);
	await page.evaluate(() => window.ashTerminalStreamIntegration.close());
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
	await expect.poll(async () => ({ ready: await page.evaluate(() => Boolean(window.ashTerminalWindowsIntegration)), errors })).toEqual({ ready: true, errors: [] });
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
		['dark', { background: '#252526', foreground: '#d4d4d4', red: '#cf222e' }],
		['light', { background: '#f8f8f8', foreground: '#333333', red: '#cf222e' }],
		['hcDark', { background: '#000000', foreground: '#ffffff', red: '#ff8080' }],
		['hcLight', { background: '#ffffff', foreground: '#000000', red: '#a00000' }],
	] as const) {
		expect(await page.evaluate(mode => window.ashTerminalIntegration.theme(mode), mode)).toEqual(expected);
		await expect(page.locator('.xterm-scrollable-element')).toHaveCSS('background-color', mode === 'hcDark' ? 'rgb(0, 0, 0)' : mode === 'dark' ? 'rgb(37, 37, 38)' : mode === 'light' ? 'rgb(248, 248, 248)' : 'rgb(255, 255, 255)');
	}
	await page.evaluate(() => window.ashTerminalIntegration.dispose());
});


test('terminal command markers follow the prompt, execution, result and themed gutter geometry', async ({ page }, testInfo) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?browser&locale=zh-CN');
	await page.evaluate(async () => { window.ashTerminalIntegration.start(); await window.ashTerminalIntegration.ready(); });
	await page.evaluate(async () => {
		await window.ashTerminalIntegration.sequence({ type: 'promptStart' });
		await window.ashTerminalIntegration.sequence({ type: 'commandStart' }, 'prompt> ');
	});
	const pending = page.getByRole('img', { name: '等待输入命令', exact: true });
	await expect(pending).toBeVisible();
	await expect(pending.locator('svg')).toHaveAttribute('data-ash-icon-id', 'terminal-decoration-incomplete');
	await expect(pending).toHaveCSS('width', '16px');
	expect(await pending.locator('svg').evaluate(element => (element as SVGGraphicsElement).getBBox().width)).toBe(8);
	await page.evaluate(() => window.ashTerminalIntegration.sequence({ type: 'commandExecuted', commandId: 'first', command: 'echo ok', isTrusted: true, cwd: '/workspace', timestampMillis: Date.now() }, 'echo ok'));
	await expect(page.getByRole('button', { name: '命令正在运行', exact: true })).toBeVisible();
	await page.evaluate(async () => {
		await window.ashTerminalIntegration.sequence({ type: 'commandFinished', exitCode: 0, durationMillis: 1 }, '\r\nok\r\n');
		await window.ashTerminalIntegration.sequence({ type: 'promptStart' });
		await window.ashTerminalIntegration.sequence({ type: 'commandStart' }, 'prompt> ');
	});
	const success = page.getByRole('button', { name: '命令已成功完成', exact: true });
	await expect(success).toBeVisible();
	await expect(pending).toBeVisible();
	await page.evaluate(async () => {
		await window.ashTerminalIntegration.sequence({ type: 'commandExecuted', commandId: 'second', command: 'false', isTrusted: true, cwd: '/workspace', timestampMillis: Date.now() }, 'false');
		await window.ashTerminalIntegration.sequence({ type: 'commandFinished', exitCode: 7, durationMillis: 1 }, '\r\n');
	});
	const failure = page.getByRole('button', { name: '命令失败，退出代码为 7', exact: true });
	await expect(failure).toBeVisible();
	await expect(failure.locator('svg')).toHaveAttribute('data-ash-icon-id', 'terminal-decoration-error');
	expect(await failure.locator('svg').evaluate(element => (element as SVGGraphicsElement).getBBox().width)).toBe(8);
	await expect(page.locator('.ash-terminal-command-status')).toHaveCount(2);
	for (const mode of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
		await page.evaluate(mode => window.ashTerminalIntegration.theme(mode), mode);
		const appearance = await success.evaluate(element => {
			const probe = document.createElement('span');
			probe.style.color = 'var(--ash-terminalCommandDecoration-successBackground)';
			element.append(probe);
			const expected = getComputedStyle(probe).color;
			probe.remove();
			return { actual: getComputedStyle(element).color, expected };
		});
		expect(appearance.actual).toBe(appearance.expected);
	}
	const defaultFontSize = await page.evaluate(() => window.ashTerminalIntegration.options().fontSize!);
	for (const [fontSize, lineHeight] of [[defaultFontSize, 1], [6, 1], [18, 1.5]]) {
		await page.evaluate(async ({ fontSize, lineHeight }) => {
			await window.ashTerminalIntegration.configure('terminal.integrated.fontSize', fontSize);
			await window.ashTerminalIntegration.configure('terminal.integrated.lineHeight', lineHeight);
		}, { fontSize, lineHeight });
		const scale = Math.min(1, fontSize / defaultFontSize);
		const icon = (await success.locator('svg').boundingBox())!;
		const decoration = (await success.boundingBox())!;
		const screen = (await page.locator('.xterm-screen').boundingBox())!;
		const terminal = (await page.locator('.ash-terminal-instance').boundingBox())!;
		await expect(page.locator('.ash-terminal-instance .xterm')).toHaveCSS('padding-left', '20px');
		expect(icon.width).toBeCloseTo(16 * scale, 1);
		expect(icon.height).toBeCloseTo(16 * scale, 1);
		expect(decoration.height).toBeCloseTo(16 * scale * lineHeight, 1);
		expect(decoration.x - screen.x).toBeCloseTo(-17 * scale, 1);
		expect(icon.x).toBeGreaterThanOrEqual(terminal.x);
		expect(icon.x + icon.width).toBeLessThanOrEqual(screen.x);
		expect(icon.y + icon.height / 2).toBeCloseTo(decoration.y + decoration.height / 2, 1);
	}
	expect(await success.locator('svg').evaluate(element => (element as SVGGraphicsElement).getBBox().width)).toBeCloseTo(8, 3);
	await page.screenshot({ path: testInfo.outputPath('terminal-command-markers.png') });
	await page.evaluate(() => window.ashTerminalIntegration.write('output\r\n'.repeat(80)));
	await expect(success).not.toBeVisible();
	await expect(failure).not.toBeVisible();
	await page.evaluate(() => window.ashTerminalIntegration.dispose());
	expect(errors).toEqual([]);
});

test('terminal panel uses themed surfaces and regular UI type for the instance list', async ({ page }) => {
	await page.goto('/terminal.html?pane&browser');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
	await expect(page.locator('.xterm')).toHaveCount(1);
	await page.evaluate(() => window.ashTerminalPaneIntegration.command('workbench.action.terminal.new'));
	const tabs = page.getByRole('tablist', { name: 'Terminal instances', exact: true });
	const active = tabs.getByRole('tab', { selected: true });
	await expect(active).toHaveCSS('font-weight', '400');
	for (const mode of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
		await page.evaluate(mode => window.ashTerminalPaneIntegration.theme(mode), mode);
		const appearance = await page.locator('.ash-terminal-content').evaluate(element => {
			const instance = element.querySelector('.ash-terminal-instance')!;
			const probe = document.createElement('span');
			probe.style.background = 'var(--ash-panel-background)';
			element.append(probe);
			const expected = getComputedStyle(probe).backgroundColor;
			probe.remove();
			return { content: getComputedStyle(element).backgroundColor, instance: getComputedStyle(instance).backgroundColor, canvas: getComputedStyle(instance.querySelector('.xterm-scrollable-element')!).backgroundColor, viewport: getComputedStyle(instance.querySelector('.xterm-viewport')!).backgroundColor, expected };
		});
		expect(appearance.content).toBe(appearance.expected);
		expect(appearance.instance).toBe(appearance.expected);
		expect(appearance.canvas).toBe(appearance.expected);
		expect(appearance.viewport).toBe(appearance.expected);
	}
	await active.focus();
	await expect(active.locator('..')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
	await page.evaluate(() => window.ashTerminalPaneIntegration.theme('light', { 'terminal.background': '#123456' }));
	for (const selector of ['.ash-terminal-content', '.ash-terminal-instance', '.xterm-viewport', '.xterm-scrollable-element']) {
		await expect(page.locator(selector).first()).toHaveCSS('background-color', 'rgb(18, 52, 86)');
	}
	await page.evaluate(() => window.ashTerminalPaneIntegration.theme('light'));
	await expect(page.locator('.xterm-scrollable-element').first()).toHaveCSS('background-color', 'rgb(248, 248, 248)');
	await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
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

test('terminal clipboard commands copy the parsed selection and preserve Shell Ctrl+C', async ({ page }) => {
	await page.goto('/terminal.html?input&clipboard');
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

test('terminal clipboard paste uses acknowledged input and the current child paste mode', async ({ page }) => {
	await page.goto('/terminal.html?input&clipboard');
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


test('terminal browser list menu keeps its captured instance after active selection changes', async ({ page }) => {
	await page.goto('/terminal.html?pane&browser');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(async () => { window.ashTerminalPaneIntegration.panel(true); });
	await expect(page.locator('.xterm')).toHaveCount(1);
	await page.evaluate(() => window.ashTerminalPaneIntegration.command('workbench.action.terminal.new'));
	const tabs = page.getByRole('tablist', { name: 'Terminal instances' });
	await expect(tabs.getByRole('tab')).toHaveCount(2);
	const ids = await page.evaluate(() => window.ashTerminalPaneIntegration.ids());
	expect((await page.evaluate(() => window.ashTerminalPaneIntegration.menuActions())).slice().sort()).toEqual(['Change Terminal Icon', 'Clear Terminal', 'Focus Terminal', 'Join or Reorder Terminals...', 'Kill Terminal', 'Move Terminal into Editor Area', 'Rename Terminal', 'Split Terminal', 'Terminal: Attach to Chat', 'Unsplit Terminal'].sort());
	await page.evaluate(id => window.ashTerminalPaneIntegration.activate(id), ids[0]!);
	await tabs.getByRole('tab').first().click({ button: 'right' });
	await expect(page.getByRole('menu')).toBeVisible();
	await expect(page.getByRole('menuitem', { name: 'Relaunch Terminal', exact: true })).toHaveCount(0);
	await page.evaluate(id => window.ashTerminalPaneIntegration.activate(id), ids[1]!);
	await page.getByRole('menuitem', { name: 'Clear Terminal', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.operations().cleared)).toEqual([ids[0]]);
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.activeId())).toBe(ids[1]);
	await tabs.getByRole('tab').first().click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Kill Terminal', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.operations().closed)).toEqual([ids[0]]);
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.ids())).toEqual([ids[1]]);
	await expect(page.locator('.ash-terminal-tabs')).toBeHidden();
	await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
});

test('terminal browser list menu supports keyboard dismissal and Chinese labels', async ({ page }) => {
	await page.goto('/terminal.html?pane&browser&locale=zh-CN');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
	await expect(page.locator('.xterm')).toHaveCount(1);
	await page.evaluate(() => window.ashTerminalPaneIntegration.command('workbench.action.terminal.new'));
	const tab = page.getByRole('tablist', { name: '终端实例' }).getByRole('tab').first();
	await tab.focus();
	expect((await page.evaluate(() => window.ashTerminalPaneIntegration.menuActions())).slice().sort()).toEqual(['取消终端拆分', '合并或调整终端顺序...', '拆分终端', '清除终端', '终止终端', '聚焦终端', '重命名终端', '更改终端图标', '将终端移入编辑区', '终端：附加到聊天'].sort());
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

test('terminal browser list menu relaunches its exited target and survives asynchronous execution', async ({ page }) => {
	await page.goto('/terminal.html?pane&browser&exited');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
	await expect(page.locator('.xterm')).toHaveCount(1);
	await page.evaluate(() => window.ashTerminalPaneIntegration.command('workbench.action.terminal.new'));
	const first = page.getByRole('tablist', { name: 'Terminal instances' }).getByRole('tab').first();
	const id = (await page.evaluate(() => window.ashTerminalPaneIntegration.ids()))[0]!;
	await page.evaluate(() => window.ashTerminalPaneIntegration.hold());
	await first.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Relaunch Terminal', exact: true }).click();
	await expect(page.getByRole('menu')).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.operations().relaunched)).toEqual([id]);
	await page.evaluate(() => { window.ashTerminalPaneIntegration.release(); window.ashTerminalPaneIntegration.dispose(); });
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

test('terminal profile commands select, cancel and apply the saved default to the next creation', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?pane&profiles&locale=zh-CN');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.createdProfiles())).toEqual(['shell']);
	await page.evaluate(() => { void window.ashTerminalPaneIntegration.command('workbench.action.terminal.newWithProfile'); });
	const picker = page.getByRole('combobox', { name: '选择终端配置', exact: true });
	await expect(picker).toBeFocused();
	await picker.press('Escape');
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.createdProfiles())).toEqual(['shell']);
	await page.evaluate(() => { void window.ashTerminalPaneIntegration.command('workbench.action.terminal.newWithProfile'); });
	await expect(picker).toBeFocused();
	await picker.fill('Bash'); await picker.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.createdProfiles())).toEqual(['shell', 'bash']);
	await page.evaluate(() => { void window.ashTerminalPaneIntegration.command('workbench.action.terminal.selectDefaultProfile'); });
	const defaults = page.getByRole('combobox', { name: '选择默认终端配置', exact: true });
	await expect(defaults).toBeFocused();
	await defaults.fill('Bash'); await defaults.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.defaultProfile())).toBe('bash');
	await page.evaluate(() => window.ashTerminalPaneIntegration.command('workbench.action.terminal.new'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.createdProfiles())).toEqual(['shell', 'bash', 'bash']);
	await page.evaluate(() => window.ashTerminalPaneIntegration.configure('terminal.integrated.defaultProfile.linux', 'Unavailable'));
	expect(await page.evaluate(() => window.ashTerminalPaneIntegration.defaultProfile())).toBe('shell');
	await page.evaluate(() => window.ashTerminalPaneIntegration.command('workbench.action.terminal.new'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.createdProfiles())).toEqual(['shell', 'bash', 'bash', 'shell']);
	expect(errors).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) {
	for (const kind of ['newWithProfile', 'selectDefaultProfile'] as const) {
		test(`terminal ${kind} picker retires on workspace change and the next command works in ${locale}`, async ({ page }) => {
			await page.goto(`/terminal.html?pane&profiles&browser&locale=${locale}`);
			await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
			await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
			await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(1);
			const command = `workbench.action.terminal.${kind}`;
			const label = kind === 'newWithProfile'
				? locale === 'zh-CN' ? '选择终端配置' : 'Select a terminal profile'
				: locale === 'zh-CN' ? '选择默认终端配置' : 'Select the default terminal profile';
			const picker = page.getByRole('combobox', { name: label, exact: true });
			await page.evaluate(id => { void window.ashTerminalPaneIntegration.command(id); }, command);
			await expect(picker).toBeFocused();
			await picker.fill('Bash');
			await page.evaluate(() => window.ashTerminalPaneIntegration.workspace());
			await expect(picker).toHaveCount(0);
			expect(await page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(1);
			expect(await page.evaluate(() => window.ashTerminalPaneIntegration.defaultProfile())).toBe('shell');
			await page.evaluate(id => { void window.ashTerminalPaneIntegration.command(id); }, command);
			await expect(picker).toBeFocused();
			await picker.fill('Bash');
			await picker.press('Enter');
			if (kind === 'newWithProfile') {
				await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.createdProfiles())).toEqual(['shell', 'bash']);
			} else {
				await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.defaultProfile())).toBe('bash');
			}
			await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
		});
	}
}

test('configured terminal profile reaches the real picker and resolver with argv, env, cwd and themed metadata', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?pane&profiles&browser&locale=zh-CN');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(async () => {
		await window.ashTerminalPaneIntegration.configure('terminal.integrated.profiles.linux', {
			'自定义 Shell': { path: ['/missing/shell', '${env:HOME}/shell'], args: ['${env:PROFILE_ARG}', 'with spaces'], env: { PROFILE: '${workspaceFolder}', REMOVED: null }, icon: 'terminal-git-bash', color: 'terminal.ansiGreen' },
		});
		await window.ashTerminalPaneIntegration.configure('terminal.integrated.cwd', '${workspaceFolder}/subdirectory');
		window.ashTerminalPaneIntegration.panel(true);
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(1);
	await page.evaluate(() => { void window.ashTerminalPaneIntegration.command('workbench.action.terminal.newWithProfile'); });
	const picker = page.getByRole('combobox', { name: '选择终端配置', exact: true });
	await expect(picker).toBeFocused();
	await picker.fill('自定义 Shell');
	await picker.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.launches().at(-1))).toEqual({
		profile: { type: 'custom', name: '自定义 Shell', path: ['/home/test/shell'], args: ['literal;$HOME', 'with spaces'] },
		env: { PROFILE: '/workspace', REMOVED: null }, cwd: '/workspace/subdirectory',
	});
	const tab = page.getByRole('tab', { name: '自定义 Shell', exact: true });
	await expect(tab).toBeVisible();
	await expect(tab.locator('svg')).toHaveAttribute('data-ash-icon-id', 'terminal-git-bash');
	expect(await tab.locator('.ash-icon-label-icon').evaluate(element => (element as HTMLElement).style.color)).toBe('var(--ash-terminal-ansiGreen)');
	await page.evaluate(() => { void window.ashTerminalPaneIntegration.command('workbench.action.terminal.selectDefaultProfile'); });
	const defaults = page.getByRole('combobox', { name: '选择默认终端配置', exact: true });
	await expect(defaults).toBeFocused(); await defaults.fill('自定义 Shell'); await defaults.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.defaultProfile())).toBe('custom:自定义 Shell');
	await page.evaluate(() => window.ashTerminalPaneIntegration.command('workbench.action.terminal.new'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(3);
	await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
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

test('terminal title toolbar follows display settings and exposes Chinese profile commands', async ({ page }) => {
	await page.goto('/terminal.html?pane&profiles&browser&locale=zh-CN');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
	await expect(page.locator('.xterm')).toHaveCount(1);
	const toolbar = page.getByRole('toolbar', { name: '终端操作', exact: true });
	await expect(toolbar.getByRole('button', { name: '拆分终端', exact: true })).toBeVisible();
	await page.evaluate(() => window.ashTerminalPaneIntegration.command('workbench.action.terminal.new'));
	await expect(page.locator('.xterm')).toHaveCount(2);
	await expect(toolbar.locator('.ash-terminal-active-action')).toHaveCount(0);
	await expect(toolbar.getByRole('button', { name: '终止终端', exact: true })).toHaveCount(0);
	const sash = page.getByRole('separator', { name: '调整终端实例列表大小', exact: true });
	const bounds = (await sash.boundingBox())!;
	await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
	await page.mouse.down();
	await page.mouse.move(bounds.x + 100, bounds.y + bounds.height / 2);
	await page.mouse.up();
	await expect(page.locator('.ash-terminal-tabs')).toHaveClass(/ash-terminal-tabs-narrow/);
	await expect(toolbar.locator('.ash-terminal-active-action')).toBeVisible();
	await expect(toolbar.getByRole('button', { name: '终止终端', exact: true })).toBeVisible();
	await page.evaluate(async () => {
		await window.ashTerminalPaneIntegration.configure('terminal.integrated.tabs.showActiveTerminal', 'always');
		await window.ashTerminalPaneIntegration.configure('terminal.integrated.tabs.showActions', 'always');
	});
	await expect(toolbar.locator('.ash-terminal-active-action')).toBeVisible();
	await expect(toolbar.getByRole('button', { name: '终止终端', exact: true })).toBeVisible();
	await toolbar.getByRole('button', { name: '选择终端配置', exact: true }).click();
	await expect(page.getByRole('menuitem', { name: '使用配置拆分终端', exact: true })).toBeVisible();
	await page.getByRole('menuitem', { name: '选择默认配置', exact: true }).click();
	const picker = page.getByRole('combobox', { name: '选择默认终端配置', exact: true });
	await expect(picker).toBeFocused();
	await picker.fill('Bash');
	await picker.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.defaultProfile())).toBe('bash');
	await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
});

test('renamed WSL profiles retain Ubuntu icons in the menu and created terminal', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?pane&profiles&browser&os=windows');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(async () => {
		await window.ashTerminalPaneIntegration.configure('terminal.integrated.profiles.windows', {
			'Work shell': { path: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu-24.04'] },
		});
		window.ashTerminalPaneIntegration.panel(true);
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(1);
	for (const name of ['Work shell', 'Renamed shell']) {
		if (name === 'Renamed shell') {
			await page.evaluate(() => window.ashTerminalPaneIntegration.configure('terminal.integrated.profiles.windows', {
				'Renamed shell': { path: 'C:\\Windows\\System32\\wsl.exe', args: '--distribution "Ubuntu-24.04"' },
			}));
		}
		await page.getByRole('button', { name: 'Select Terminal Profile', exact: true }).click();
		const item = page.getByRole('menuitem', { name, exact: true });
		await expect(item.locator('svg[data-ash-icon-id="terminal-ubuntu"]')).toBeVisible();
		await item.click();
		const tab = page.getByRole('tab', { name, exact: true });
		await expect(tab).toBeVisible();
		await expect(tab.locator('svg')).toHaveAttribute('data-ash-icon-id', 'terminal-ubuntu');
	}
	await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('Windows raw command line profile reaches the picker, resolver and next default without becoming argv', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?pane&profiles&browser&os=windows&locale=zh-CN');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(async () => {
		await window.ashTerminalPaneIntegration.configure('terminal.integrated.profiles.windows', {
			'原始命令行': { path: 'C:\\Windows\\cmd.exe', args: '/d /s /c "echo ${env:PROFILE_ARG} & echo two words"' },
		});
		window.ashTerminalPaneIntegration.panel(true);
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(1);
	await page.evaluate(() => { void window.ashTerminalPaneIntegration.command('workbench.action.terminal.newWithProfile'); });
	const picker = page.getByRole('combobox', { name: '选择终端配置', exact: true });
	await expect(picker).toBeFocused(); await picker.fill('原始命令行'); await picker.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.launches().at(-1))).toEqual({
		profile: { type: 'custom', name: '原始命令行', path: ['C:\\Windows\\cmd.exe'], args: '/d /s /c "echo literal;$HOME & echo two words"' }, env: {}, cwd: undefined,
	});
	await expect(page.getByRole('tab', { name: '原始命令行', exact: true })).toBeVisible();
	await page.evaluate(() => { void window.ashTerminalPaneIntegration.command('workbench.action.terminal.selectDefaultProfile'); });
	const defaults = page.getByRole('combobox', { name: '选择默认终端配置', exact: true });
	await expect(defaults).toBeFocused(); await defaults.fill('原始命令行'); await defaults.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.defaultProfile())).toBe('custom:原始命令行');
	await page.evaluate(() => window.ashTerminalPaneIntegration.command('workbench.action.terminal.new'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(3);
	expect((await page.evaluate(() => window.ashTerminalPaneIntegration.launches().at(-1)))?.profile).toEqual({ type: 'custom', name: '原始命令行', path: ['C:\\Windows\\cmd.exe'], args: '/d /s /c "echo literal;$HOME & echo two words"' });
	await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('extension terminal profile activates from the picker and persists as the next default', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?pane&profiles&browser&extensionProfiles&locale=zh-CN');
	await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
	await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(1);
	await page.evaluate(() => { void window.ashTerminalPaneIntegration.command('workbench.action.terminal.newWithProfile'); });
	const picker = page.getByRole('combobox', { name: '选择终端配置', exact: true });
	await expect(picker).toBeFocused(); await picker.fill('Extension Shell'); await picker.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.launches().at(-1))).toEqual({
		profile: { type: 'custom', name: 'Extension Shell', path: ['/home/test/extension-shell'], args: ['literal;$HOME'] }, env: { EXTENSION: 'value' }, cwd: '/workspace',
	});
	const tab = page.getByRole('tab', { name: 'Extension Shell', exact: true });
	await expect(tab).toBeVisible();
	await expect(tab.locator('svg')).toHaveAttribute('data-ash-icon-id', 'terminal-git-bash');
	await page.evaluate(() => { void window.ashTerminalPaneIntegration.command('workbench.action.terminal.selectDefaultProfile'); });
	const defaults = page.getByRole('combobox', { name: '选择默认终端配置', exact: true });
	await expect(defaults).toBeFocused(); await defaults.fill('Extension Shell'); await defaults.press('Enter');
	await expect(defaults).toHaveCount(0);
	await page.evaluate(() => window.ashTerminalPaneIntegration.command('workbench.action.terminal.new'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.createdProfiles())).toEqual(['shell', 'custom:Extension Shell', 'custom:Extension Shell']);
	await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('shell cwd waits for the original xterm commit and remains available with retained command output', async ({ page }) => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	await page.route(/(?:xterm_xterm|xterm\/lib\/xterm|\/xterm-[^/]+\.js)/u, async route => { await gate; await route.continue(); });
	try {
		await page.goto('/terminal.html?stream&cwd&history');
		await page.waitForFunction(() => Boolean(window.ashTerminalStreamIntegration));
		await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.status().reads)).toEqual([0]);
		expect(await page.evaluate(() => window.ashTerminalStreamIntegration.status().cwd)).toBeUndefined();
		expect(await page.evaluate(() => window.ashTerminalStreamIntegration.status().shellIntegration)).toBeUndefined();
		expect(await page.evaluate(() => window.ashTerminalStreamIntegration.status().events)).toEqual([]);
	} finally { release(); }
	await page.evaluate(() => window.ashTerminalStreamIntegration.start());
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.status().state)).toBe('exited');
	expect(await page.evaluate(() => window.ashTerminalStreamIntegration.status().cwd)).toBe('/workspace/changed; directory');
	expect(await page.evaluate(() => window.ashTerminalStreamIntegration.status().shellIntegration)).toEqual({ commandDetection: true, cwdDetection: true, hasRichCommandDetection: true, commandStorageDisabled: false, commands: [{ commandId: 'command', status: 'succeeded', exitCode: 0, cwd: '/workspace', command: 'echo 中文; printf \"quoted\"', isTrusted: true }] });
	expect(await page.evaluate(() => window.ashTerminalStreamIntegration.status().events)).toEqual(['succeeded', 'exit']);
	expect(await page.evaluate(() => window.ashTerminalStreamIntegration.snapshot())).toBe('中文🙂\n\n[process exited with code 0]');
	await page.evaluate(() => window.ashTerminalStreamIntegration.close());
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


test('Send Sequence user keybinding resolves variables and sends control characters through the real instance', async ({ page }) => {
	const pageErrors: string[] = [];
	page.on('pageerror', error => pageErrors.push(error.message));
	await page.goto('/terminal.html?input&sequence');
	await expect.poll(async () => ({ ready: await page.evaluate(() => Boolean(window.ashTerminalSequenceIntegration)), errors: pageErrors })).toEqual({ ready: true, errors: [] });
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([expect.stringMatching(/^\x1b\[\?[\d;]+c$/u)]);
	await page.evaluate(() => window.ashTerminalInputIntegration.clear());
	await page.locator('.xterm-helper-textarea').focus();
	await page.keyboard.press('Control+Alt+y');
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['\x1b[1;5D/workspace']);
	await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
	expect(await page.evaluate(() => window.ashTerminalSequenceIntegration.errors())).toEqual([]);
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

for (const locale of ['en', 'zh-CN'] as const) {
	test(`Send Sequence prompt supports control escapes, cancellation and accessible help in ${locale}`, async ({ page }) => {
		const pageErrors: string[] = [];
		page.on('pageerror', error => pageErrors.push(error.message));
		await page.goto(`/terminal.html?input&sequence&locale=${locale}`);
		await expect.poll(async () => ({ ready: await page.evaluate(() => Boolean(window.ashTerminalSequenceIntegration)), errors: pageErrors })).toEqual({ ready: true, errors: [] });
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([expect.stringMatching(/^\x1b\[\?[\d;]+c$/u)]);
		await page.evaluate(() => window.ashTerminalInputIntegration.clear());
		const title = locale === 'zh-CN' ? '终端：发送序列' : 'Terminal: Send Sequence';
		const placeholder = locale === 'zh-CN' ? '输入文本或控制字符（\\n、\\r、\\xNN）' : 'Enter text or control characters (\\n, \\r, \\xNN)';
		const sending = page.evaluate(() => window.ashTerminalSequenceIntegration.command());
		const input = page.getByPlaceholder(placeholder, { exact: true });
		await expect(page.getByRole('dialog', { name: title, exact: true })).toBeVisible();
		await expect(input).toBeFocused();
		await input.fill('\\x1b[A${workspaceFolder}\\r');
		await input.press('Enter');
		await sending;
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['\x1b[A/workspace\r']);
		await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
		const canceled = page.evaluate(() => window.ashTerminalSequenceIntegration.command());
		await expect(input).toBeVisible();
		await input.press('Escape');
		await canceled;
		expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['\x1b[A/workspace\r']);
		await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
		expect(await page.evaluate(() => window.ashTerminalSequenceIntegration.help())).toContain(locale === 'zh-CN' ? '发送序列' : 'Send Sequence');
		expect(await page.evaluate(() => window.ashTerminalSequenceIntegration.errors())).toEqual([]);
		await page.evaluate(() => window.ashTerminalInputIntegration.close());
	});
}


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

test('terminal row and pane drops join existing groups and reject an unrelated window resource', async ({ page }) => {
	await page.goto('/terminal.html?input&groups');
	await page.waitForFunction(() => Boolean(window.ashTerminalGroupsIntegration));
	await page.evaluate(async () => {
		await window.ashTerminalGroupsIntegration.command('workbench.action.terminal.split');
		await window.ashTerminalGroupsIntegration.command('workbench.action.terminal.unsplit');
		await window.ashTerminalGroupsIntegration.command('workbench.action.terminal.split');
		await window.ashTerminalGroupsIntegration.command('workbench.action.terminal.unsplit');
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.groups())).toEqual([['terminal-instance-1'], ['terminal-instance-2'], ['terminal-instance-3']]);
	const targetRow = page.locator('#terminal-instance-2-tab');
	const rowBounds = (await targetRow.boundingBox())!;
	await page.locator('#terminal-instance-1-tab').dragTo(targetRow, { targetPosition: { x: 10, y: rowBounds.height - 3 } });
	await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.groups())).toEqual([['terminal-instance-2', 'terminal-instance-1'], ['terminal-instance-3']]);
	const target = page.locator('.ash-terminal-group-pane[data-instance-id="terminal-instance-3"]');
	const bounds = (await target.boundingBox())!;
	await page.locator('#terminal-instance-2-tab').dragTo(target, { targetPosition: { x: bounds.width - 10, y: 20 } });
	await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.groups())).toEqual([['terminal-instance-1'], ['terminal-instance-3', 'terminal-instance-2']]);
	await target.evaluate(element => {
		const data = new DataTransfer();
		data.setData('Terminals', JSON.stringify(['vscode-terminal:/unrelated-window/1']));
		element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
	});
	expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.groups())).toEqual([['terminal-instance-1'], ['terminal-instance-3', 'terminal-instance-2']]);
	expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.metadata().created)).toBe(3);
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

test('changing the active terminal retires its open join picker', async ({ page }) => {
	await page.goto('/terminal.html?input&groups');
	await page.waitForFunction(() => Boolean(window.ashTerminalGroupsIntegration));
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.split'));
	const choosing = page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.join'));
	await expect(page.getByRole('combobox')).toBeVisible();
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.focusPreviousPane'));
	await choosing;
	await expect(page.getByRole('combobox')).toHaveCount(0);
	expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.groups())).toEqual([['terminal-instance-1', 'terminal-instance-2']]);
});


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

test('shared terminal editors confirm only the last closing host and cancellation retains the process', async ({ page }) => {
	await page.goto('/terminal.html?input&groups&editor');
	await page.waitForFunction(() => Boolean(window.ashTerminalEditorIntegration));
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.moveToEditor'));
	expect(await page.evaluate(() => window.ashTerminalEditorIntegration.activeContext())).toBe(true);
	await page.evaluate(() => window.ashTerminalEditorIntegration.copyToSide(false));
	await page.evaluate(() => window.ashTerminalEditorIntegration.confirmClose());
	await page.evaluate(() => window.ashTerminalEditorIntegration.close());
	await expect(page.getByRole('dialog')).toHaveCount(0);
	expect(await page.evaluate(() => window.ashTerminalEditorIntegration.state())).toMatchObject({ instances: 1, editorTabs: 1 });
	const cancelled = page.evaluate(() => window.ashTerminalEditorIntegration.close());
	await expect(page.getByRole('dialog')).toContainText('Terminate the running processes');
	await page.getByRole('button', { name: 'Cancel', exact: true }).click();
	await cancelled;
	expect(await page.evaluate(() => window.ashTerminalEditorIntegration.state())).toMatchObject({ instances: 1, editorTabs: 1 });
	const accepted = page.evaluate(() => window.ashTerminalEditorIntegration.close());
	await page.getByRole('button', { name: 'Terminate', exact: true }).click();
	await accepted;
	await expect.poll(() => page.evaluate(() => window.ashTerminalEditorIntegration.state())).toMatchObject({ instances: 0, editorTabs: 0 });
	expect(await page.evaluate(() => window.ashTerminalEditorIntegration.activeContext())).toBe(false);
});

test('close all skips a retained sticky terminal host and confirms once when it finally closes', async ({ page }) => {
	await page.goto('/terminal.html?input&groups&editor');
	await page.waitForFunction(() => Boolean(window.ashTerminalEditorIntegration));
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.moveToEditor'));
	await page.evaluate(() => window.ashTerminalEditorIntegration.copyToSide(true));
	await page.evaluate(() => window.ashTerminalEditorIntegration.confirmClose());
	expect(await page.evaluate(() => window.ashTerminalEditorIntegration.closeAll(true))).toBe(true);
	await expect(page.getByRole('dialog')).toHaveCount(0);
	expect(await page.evaluate(() => window.ashTerminalEditorIntegration.state())).toMatchObject({ instances: 1, editorTabs: 1 });
	const closing = page.evaluate(() => window.ashTerminalEditorIntegration.closeAll(false));
	await page.getByRole('button', { name: 'Terminate', exact: true }).click();
	expect(await closing).toBe(true);
	await expect.poll(() => page.evaluate(() => window.ashTerminalEditorIntegration.state())).toMatchObject({ instances: 0, editorTabs: 0 });
});

test('cancelling a later terminal confirmation aborts close all without terminating accepted terminals', async ({ page }) => {
	await page.goto('/terminal.html?input&groups&editor');
	await page.waitForFunction(() => Boolean(window.ashTerminalEditorIntegration));
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.moveToEditor'));
	await page.evaluate(() => window.ashTerminalEditorIntegration.createBackground());
	await page.evaluate(() => window.ashTerminalEditorIntegration.confirmClose());
	const closing = page.evaluate(() => window.ashTerminalEditorIntegration.closeAll(false));
	await page.getByRole('button', { name: 'Terminate', exact: true }).click();
	await expect(page.getByRole('dialog')).toContainText('Terminate the running processes');
	await page.getByRole('button', { name: 'Cancel', exact: true }).click();
	expect(await closing).toBe(false);
	expect(await page.evaluate(() => window.ashTerminalEditorIntegration.state())).toMatchObject({ instances: 2, editorTabs: 2 });
});
for (const locale of ['en', 'zh-CN']) {
	for (const action of ['tab', 'group', 'all', 'sticky'] as const) test(`shared terminal editor ${action} closes only its final host in ${locale}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/terminal.html?input&groups&editor&clipboard&browser&locale=${locale}`);
		await page.waitForFunction(() => Boolean(window.ashTerminalEditorIntegration));
		await page.evaluate(async () => {
			await window.ashTerminalGroupsIntegration.command('workbench.action.terminal.moveToEditor');
			await window.ashTerminalEditorIntegration.confirmOnKill();
		});
		const firstGroup = (await page.evaluate(() => window.ashTerminalEditorIntegration.groups()))[0]!.id;
		if (action === 'sticky') await page.evaluate(() => window.ashTerminalEditorIntegration.stick());
		await page.evaluate(() => window.ashTerminalEditorIntegration.split());
		await expect.poll(() => page.evaluate(() => window.ashTerminalEditorIntegration.state().editorTabs)).toBe(2);
		if (action === 'tab') {
			// Close the old group's tab through its keyboard-accessible action.
			const closeButton = page.locator('.ash-editor-group').first().getByRole('button', { name: locale === 'zh-CN' ? '关闭 Shell' : 'Close Shell', exact: true });
			await closeButton.focus();
			await closeButton.press('Enter');
		} else if (action === 'group') {
			expect(await page.evaluate(id => window.ashTerminalEditorIntegration.closeGroup(id), firstGroup)).toBe(true);
		} else if (action === 'sticky') {
			expect(await page.evaluate(() => window.ashTerminalEditorIntegration.closeAll(true))).toBe(true);
		}
		const remaining = action === 'all' ? 2 : 1;
		await expect.poll(() => page.evaluate(() => window.ashTerminalEditorIntegration.state().editorTabs)).toBe(remaining);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		expect(await page.evaluate(() => window.ashTerminalEditorIntegration.closedProcesses())).toEqual([]);
		await page.locator('.ash-terminal-editor .xterm-helper-textarea').last().focus();
		await page.keyboard.type('still-alive');
		await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.writes().filter(write => write.terminalId === 'input-shell-1').map(write => write.data).join(''))).toContain('still-alive');
		const cancel = page.evaluate(() => window.ashTerminalEditorIntegration.closeAll());
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();
		await page.keyboard.press('Escape');
		expect(await cancel).toBe(false);
		expect(await page.evaluate(() => window.ashTerminalEditorIntegration.state().editorTabs)).toBe(remaining);
		expect(await page.evaluate(() => window.ashTerminalEditorIntegration.closedProcesses())).toEqual([]);
		const close = page.evaluate(() => window.ashTerminalEditorIntegration.closeAll());
		await expect(dialog).toBeVisible();
		await dialog.getByRole('button', { name: locale === 'zh-CN' ? '终止' : 'Terminate', exact: true }).click();
		expect(await close).toBe(true);
		await expect.poll(() => page.evaluate(() => window.ashTerminalEditorIntegration.state().editorTabs)).toBe(0);
		expect(await page.evaluate(() => window.ashTerminalEditorIntegration.closedProcesses())).toEqual(['input-shell-1']);
		expect(errors).toEqual([]);
		await page.evaluate(() => window.ashTerminalGroupsIntegration.dispose());
	});
}

test('terminal editor restoration displays an unavailable resource without starting a shell', async ({ page }) => {
	await page.goto('/terminal.html?input&groups&editor&locale=zh-CN');
	await expect.poll(() => page.evaluate(() => Boolean(window.ashTerminalEditorIntegration))).toBe(true);
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.moveToEditor'));
	await page.evaluate(() => window.ashTerminalEditorIntegration.restore());
	await expect(page.locator('.ash-terminal-editor')).toContainText('此终端已不可用');
	await expect.poll(() => page.evaluate(() => window.ashTerminalEditorIntegration.state())).toMatchObject({ instances: 0, created: 1, editorTabs: 1 });
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

for (const locale of ['en', 'zh-CN']) {
	test(`terminal rename and icon selection update the original instance in ${locale}`, async ({ page }) => {
		await page.goto(`/terminal.html?input&groups&locale=${locale}`);
		await expect.poll(() => page.evaluate(() => Boolean(window.ashTerminalGroupsIntegration))).toBe(true);
		const before = await page.evaluate(() => window.ashTerminalGroupsIntegration.metadata());
		const renaming = page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.rename'));
		const name = locale === 'zh-CN' ? '重命名终端' : 'Rename Terminal';
		const dialog = page.getByRole('dialog', { name, exact: true });
		await expect(dialog).toBeVisible();
		await dialog.getByRole('textbox').fill('My shell');
		await dialog.getByRole('textbox').press('Enter');
		await renaming;
		await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.metadata())).toMatchObject({ title: 'My shell', created: before.created });
		await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
		const canceled = page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.rename'));
		await expect(dialog).toBeVisible();
		await dialog.getByRole('textbox').fill('Canceled');
		await dialog.getByRole('textbox').press('Escape');
		await canceled;
		expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.metadata().title)).toBe('My shell');
		const choosing = page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.changeIcon'));
		const icons = page.getByRole('combobox');
		await expect(icons).toBeVisible();
		await icons.fill('terminal-git-bash');
		await page.getByRole('option', { name: /terminal-git-bash/ }).click();
		await choosing;
		await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.metadata())).toMatchObject({ title: 'My shell', icon: 'terminal-git-bash', created: before.created });
		await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
	});
}

test('closing a terminal cancels its pending name interaction', async ({ page }) => {
	await page.goto('/terminal.html?input&groups');
	await expect.poll(() => page.evaluate(() => Boolean(window.ashTerminalGroupsIntegration))).toBe(true);
	const renaming = page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.rename'));
	await expect(page.getByRole('dialog', { name: 'Rename Terminal', exact: true })).toBeVisible();
	await page.evaluate(() => window.ashTerminalGroupsIntegration.close());
	await renaming;
	await expect(page.getByRole('dialog', { name: 'Rename Terminal', exact: true })).toHaveCount(0);
});


test('terminal Clear and Relaunch commands operate on the active editor instance', async ({ page }) => {
	await page.goto('/terminal.html?input&groups&editor');
	await expect.poll(() => page.evaluate(() => Boolean(window.ashTerminalEditorIntegration))).toBe(true);
	await page.evaluate(() => window.ashTerminalGroupsIntegration.feed('editor output\r\n'.repeat(50)));
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.moveToEditor'));
	await expect(page.locator('.ash-terminal-editor .xterm-rows')).toContainText('editor output');
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.clear'));
	await expect(page.locator('.ash-terminal-editor .xterm-rows')).not.toContainText('editor output');
	await page.evaluate(() => window.ashTerminalEditorIntegration.disconnect());
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.relaunch'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalEditorIntegration.state())).toEqual({ instances: 1, created: 2, editorTabs: 1, originalScreen: true, target: 2 });
	await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.kill'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalEditorIntegration.state())).toMatchObject({ instances: 0, editorTabs: 0 });
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
			window.ashTerminalInputIntegration.feed('\x1b[2J\x1b[Hhttps://example.com/terminal\r\n');
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
	test(`terminal environment information follows the collection owner in ${locale}`, async ({ page }) => {
		await page.goto(`/terminal.html?pane&profiles&locale=${locale}`);
		await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
		await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
		await page.evaluate(() => window.ashTerminalPaneIntegration.command('workbench.action.terminal.new'));
		const tabs = page.locator('.ash-terminal-tabs [role="tab"]');
		await expect(tabs).toHaveCount(2);
		await page.evaluate(() => window.ashTerminalPaneIntegration.environment(true));
		const label = locale === 'zh-CN' ? '以下扩展为新终端配置环境变量：acme.environment' : 'Extensions configure the environment for new terminals: acme.environment';
		await expect(tabs.first()).toHaveAttribute('title', new RegExp(label));
		await page.evaluate(() => window.ashTerminalPaneIntegration.environment(false));
		await expect(tabs.first()).not.toHaveAttribute('title', /acme\.environment/);
	});
}


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


test('execution-host shell type selects italic ghost text and resets with a legacy ready frame', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/terminal.html?stream&commandModel&powerShell');
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration?.model().input)).toBe('|');
	expect((await page.evaluate(() => window.ashTerminalStreamIntegration.serializeModel())).isWindowsPty).toBe(true);
	await page.evaluate(() => window.ashTerminalStreamIntegration.feedModel('user \x1b[3mproposal\x1b[0m\x1b[8D'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.model().input)).toBe('user |[proposal]');
	await page.evaluate(() => {
		window.ashTerminalStreamIntegration.environmentFrame({ type: 'processReady', isWindowsPty: false });
		window.ashTerminalStreamIntegration.feedModel('\r\x1b[2K$ ');
		window.ashTerminalStreamIntegration.environmentFrame({ type: 'promptStart' });
		window.ashTerminalStreamIntegration.environmentFrame({ type: 'commandStart' });
		window.ashTerminalStreamIntegration.feedModel('\x1b[3mother\x1b[0m\x1b[5D');
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.model().input)).toBe('|other');
	expect((await page.evaluate(() => window.ashTerminalStreamIntegration.serializeModel())).isWindowsPty).toBe(false);
	await page.evaluate(() => window.ashTerminalStreamIntegration.close());
	expect(errors).toEqual([]);
});

test('shell environment commits through the original xterm and rejects partial trust across reuse', async ({ page }) => {
	await page.goto('/terminal.html?stream&commandModel');
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration?.model().input)).toBe('|');
	await page.evaluate(() => window.ashTerminalStreamIntegration.environmentFrame({ type: 'environment', values: { CURRENT: 'startup' }, isTrusted: true }));
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.environment())).toEqual({ value: { CURRENT: 'startup' }, isTrusted: true });
	await page.evaluate(() => {
		window.ashTerminalStreamIntegration.environmentFrame({ type: 'environmentStart', clear: true, isTrusted: true });
		window.ashTerminalStreamIntegration.environmentFrame({ type: 'environmentEntry', key: 'CURRENT', value: 'pending 中文', isTrusted: true });
	});
	// A visible prompt model remains unchanged until the transaction's final boundary is parsed.
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.model().input)).toBe('|');
	expect(await page.evaluate(() => window.ashTerminalStreamIntegration.environment())).toEqual({ value: { CURRENT: 'startup' }, isTrusted: true });
	await page.evaluate(() => window.ashTerminalStreamIntegration.environmentFrame({ type: 'environmentEnd', isTrusted: true }));
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.environment())).toEqual({ value: { CURRENT: 'pending 中文' }, isTrusted: true });
	await page.evaluate(() => {
		window.ashTerminalStreamIntegration.environmentFrame({ type: 'environmentStart', clear: false, isTrusted: true });
		window.ashTerminalStreamIntegration.environmentFrame({ type: 'environmentEntry', key: 'CURRENT', value: 'forged', isTrusted: false });
		window.ashTerminalStreamIntegration.environmentFrame({ type: 'environmentEnd', isTrusted: true });
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.environment())).toEqual({ value: { CURRENT: 'forged' }, isTrusted: false });
	await page.evaluate(() => window.ashTerminalStreamIntegration.environmentFrame({ type: 'processReady', isWindowsPty: false }));
	await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.environment())).toEqual({ value: undefined, isTrusted: false });
	await page.evaluate(() => window.ashTerminalStreamIntegration.close());
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

test('terminal accessible buffer follows wrapping, clearing and the active buffer', async ({ page }) => {
	await page.goto('/terminal.html?input&find');
	await page.waitForFunction(() => Boolean(window.ashTerminalInputIntegration));
	await page.evaluate(() => {
		window.ashTerminalInputIntegration.feed('\x1b[2J\x1b[H' + 'a'.repeat(4000) + '\r\nnext');
	});
	await expect.poll(async () => (await page.evaluate(() => window.ashTerminalInputIntegration.accessible())).lines.at(-1)).toBe('next');
	const state = await page.evaluate(() => window.ashTerminalInputIntegration.accessible());
	expect(state.lines).toEqual(['a'.repeat(4000), 'next']);
	expect(state.lines[1]).toBe('next');
	await page.evaluate(() => window.ashTerminalInputIntegration.feed('\x1b[?1049h\x1b[HALTERNATE'));
	await expect.poll(async () => (await page.evaluate(() => window.ashTerminalInputIntegration.accessible())).content).toBe('ALTERNATE');
	await page.evaluate(() => window.ashTerminalInputIntegration.feed('\x1b[?1049l\x1b[2J\x1b[3J\x1b[HCLEARED'));
	await expect.poll(async () => (await page.evaluate(() => window.ashTerminalInputIntegration.accessible())).content).toBe('CLEARED');
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
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
