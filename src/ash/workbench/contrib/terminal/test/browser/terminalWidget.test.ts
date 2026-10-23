import { expect, type Page } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('terminal browser component', () => {
	const browserTests = useBrowserTests();

	test('terminal follows new output after erasing retained scrollback while scrolled up', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
		await page.goto('/terminal.html?input&groups&clipboard&browser');
		await expect.poll(async () => ({ ready: await page.evaluate(() => Boolean(window.ashTerminalInputIntegration)), errors })).toEqual({ ready: true, errors: [] });
		await page.evaluate(() => window.ashTerminalInputIntegration.feed('retained-row\r\n'.repeat(120)));
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.viewport().bottom)).toBeGreaterThan(0);
		await page.evaluate(() => window.ashTerminalInputIntegration.command('workbench.action.terminal.scrollToTop'));
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.viewport().top)).toBe(0);
		await page.evaluate(() => window.ashTerminalInputIntegration.feed('\x1b[3J'));
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.viewport().bottom)).toBe(0);
		await page.evaluate(() => window.ashTerminalInputIntegration.feed('fresh-row\r\n'.repeat(120) + 'following-new-output'));
		await expect(page.locator('.ash-terminal-instance:visible .xterm-rows')).toContainText('following-new-output');
		await expect.poll(() => page.evaluate(() => {
			const { top, bottom } = window.ashTerminalInputIntegration.viewport();
			return bottom > 0 && top === bottom;
		})).toBe(true);
		await page.evaluate(() => window.ashTerminalInputIntegration.close());
	});

	test('terminal scroll shortcuts retire in the alternate buffer and resume with normal output', async function () {
		const { page } = browserTests;

		await page.goto('/terminal.html?input&groups&clipboard&browser');
		await page.waitForFunction(() => Boolean(window.ashTerminalInputIntegration));
		await page.evaluate(() => window.ashTerminalInputIntegration.feed('\x1b[?1049halternate-app'));
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.alternateContext())).toBe(true);
		await page.evaluate(() => window.ashTerminalInputIntegration.clear());
		const textarea = page.locator('.xterm-helper-textarea').first();
		await textarea.focus();
		await textarea.press(process.platform === 'linux' ? 'Control+Shift+ArrowUp' : process.platform === 'darwin' ? 'Meta+Alt+PageUp' : 'Control+Alt+PageUp');
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes.length)).toBeGreaterThan(0);
		await page.evaluate(() => window.ashTerminalInputIntegration.feed('\x1b[?1049l'));
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.alternateContext())).toBe(false);
		await page.evaluate(() => window.ashTerminalInputIntegration.close());
	});

	async function seedScreenCommand(page: Page, trusted = true, locale = 'en'): Promise<void> {
		await page.goto(`/terminal.html?input&groups&clipboard&browser&locale=${locale}`);
		await page.waitForFunction(() => Boolean(window.ashTerminalGroupsIntegration));
		await page.evaluate(isTrusted => {
			const feed = window.ashTerminalInputIntegration.feed;
			feed('', { type: 'processReady', isWindowsPty: false, shellType: 'bash' as import('../../../../../platform/terminal/common/terminal.js').PosixShellType.Bash });
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
		test(`terminal command marker menu copies bounded output and selects the command in ${locale}`, async function () {
			const { page } = browserTests;

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

	test('terminal command rerun targets its original process only after an explicit menu action', async function () {
		const { page } = browserTests;

		await seedScreenCommand(page);
		await page.locator('.ash-terminal-command-status.succeeded').click();
		expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
		await page.getByRole('menuitem', { name: 'Rerun Command', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['echo marker\r']);
		expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.metadata().created)).toBe(1);
	});

	test('terminal untrusted command rerun requires confirmation and retires after switching away and back', async function () {
		const { page } = browserTests;

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

	test('terminal buffer trim dismisses the command menu and retires its copy callbacks', async function () {
		const { page } = browserTests;

		await seedScreenCommand(page);
		await page.evaluate(() => window.ashTerminalInputIntegration.configure('terminal.integrated.scrollback', 0));
		await page.locator('.ash-terminal-command-status.succeeded').click();
		await expect(page.getByRole('menuitem', { name: 'Copy Output', exact: true })).toBeVisible();
		await page.evaluate(() => window.ashTerminalInputIntegration.feed('scroll\r\n'.repeat(100)));
		await expect(page.locator('.ash-terminal-command-status.succeeded')).toHaveCount(0);
		await expect(page.getByRole('menu')).toHaveCount(0);
		expect(await page.evaluate(() => window.ashTerminalClipboardIntegration.copied)).toEqual([]);
	});

	test('terminal Find navigates real matches without sending its keys to the process', async function () {
		const { page } = browserTests;

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

	test('terminal Find rejects invalid regex and follows parsed output and wrapped matches', async function () {
		const { page } = browserTests;

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

	test('terminal Find reaches scrollback and closing during its first search releases the feature', async function () {
		const { page } = browserTests;

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

	test('Chinese terminal actions create terminals while preserving shell names', async function () {
		const { page } = browserTests;

		await page.goto('/terminal.html?pane&locale=zh-CN');
		await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
		await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
		await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.counts())).toEqual({ profiles: 1, creates: 1 });
		const actions = page.getByRole('toolbar', { name: '终端操作', exact: true });
		await expect(actions.getByRole('button', { name: '选择终端配置', exact: true })).toBeEnabled();
		await expect(actions.getByRole('button', { name: '当前终端：sh（Shell）', exact: true })).toBeVisible();
		await actions.getByRole('button', { name: '新建终端', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(2);
	});

	for (const action of ['dispose', 'move focus'] as const) {
		test(`terminal loading respects ${action} before completion`, async function () {
			const { page } = browserTests;

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

	test('hidden terminal pane defers profiles, process and xterm until shown', async function () {
		const { page } = browserTests;

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
		test(`terminal profile initialization respects ${action} and deduplicates repeated activation`, async function () {
			const { page } = browserTests;

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

	test('a terminal arriving during profile discovery prevents an extra default process', async function () {
		const { page } = browserTests;

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

	test('a transfer window waits for its incoming process before creating a default shell', async function () {
		const { page } = browserTests;

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

	test('existing hidden terminal retains output without loading xterm until revealed', async function () {
		const { page } = browserTests;

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

	test('collapsed terminal defers initialization until expanded', async function () {
		const { page } = browserTests;

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


	test('terminal dictation writes phrases without executing and cancels when the panel hides', async function () {
		const { page } = browserTests;

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

	test('Terminal contribution assembles independent window scopes and rejects a missing process registration', async function () {
		const { page } = browserTests;

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

	test('terminal bounds unseen display history while process observers still receive every chunk', async function () {
		const { page } = browserTests;

		await page.goto('/terminal.html?stream&deferred&overflow');
		await page.waitForFunction(() => Boolean(window.ashTerminalStreamIntegration));
		await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.status().state)).toBe('exited');
		const observed = await page.evaluate(() => window.ashTerminalStreamIntegration.observed());
		expect(observed.length).toBeGreaterThan(1024 * 1024);
		expect(observed.match(/\r\n/gu)).toHaveLength(4100);
		expect(observed.replaceAll('\x1b[0m', '')).toMatch(/^line-0\r\n.*line-4099\r\n$/su);
		await page.evaluate(() => window.ashTerminalStreamIntegration.start());
		const output = await page.evaluate(() => window.ashTerminalStreamIntegration.snapshot());
		expect(output).toMatch(/\[terminal output truncated\].*line-4099/su);
		expect(output).not.toMatch(/^line-0$/mu);
		await page.evaluate(() => window.ashTerminalStreamIntegration.close());
	});

	test('closing a Shell while xterm loads stops reading and releases the process', async function () {
		const { page } = browserTests;

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

	test('terminal context captures parsed queued output, wrapped lines and a bounded tail', async function () {
		const { page } = browserTests;

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

	test('terminal context prefers the user selection over unrelated output', async function () {
		const { page } = browserTests;

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


	test('terminal commands stay in their window after another view is created and disposed', async function () {
		const { page } = browserTests;

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


	for (const mode of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
		test(`terminal scrollbar hides the native track and scrolls retained output in ${mode}`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await seedScreenCommand(page, true, 'zh-CN');
			await page.evaluate(mode => window.ashTerminalFindIntegration.theme(mode), mode);
			const terminal = page.locator('.ash-terminal-instance:visible');
			const track = terminal.locator('.xterm-scrollable-element > .xterm-scrollbar.xterm-vertical');
			const slider = track.locator('.xterm-slider');
			await expect(terminal.locator('.xterm-viewport')).toHaveCSS('overflow-y', 'hidden');
			await expect(track).toHaveCSS('opacity', '0');
			await page.evaluate(() => window.ashTerminalInputIntegration.feed('scrollbar-row\r\n'.repeat(120)));
			await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.viewport().bottom)).toBeGreaterThan(0);
			await terminal.locator('.xterm-screen').hover();
			await page.mouse.wheel(0, -300);
			await expect.poll(() => page.evaluate(() => {
				const { top, bottom } = window.ashTerminalInputIntegration.viewport();
				return top < bottom;
			})).toBe(true);
			await expect(track).toHaveCSS('opacity', '1');
			const expectedColor = async (token: string): Promise<string> => terminal.evaluate((element, token) => {
				const probe = document.createElement('span');
				probe.style.backgroundColor = `var(--ash-${token})`;
				element.append(probe);
				const color = getComputedStyle(probe).backgroundColor;
				probe.remove();
				return color;
			}, token);
			await expect(slider).toHaveCSS('background-color', await expectedColor('scrollbarSlider-background'));
			await slider.hover();
			await expect(slider).toHaveCSS('background-color', await expectedColor('scrollbarSlider-hoverBackground'));
			const thumb = (await slider.boundingBox())!;
			const bounds = (await track.boundingBox())!;
			await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
			await page.mouse.down();
			await expect(slider).toHaveCSS('background-color', await expectedColor('scrollbarSlider-activeBackground'));
			await page.mouse.move(thumb.x + thumb.width / 2, bounds.y, { steps: 5 });
			await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.viewport().top)).toBe(0);
			await page.mouse.move(thumb.x + thumb.width / 2, bounds.y + bounds.height, { steps: 5 });
			await page.mouse.up();
			await expect.poll(() => page.evaluate(() => {
				const { top, bottom } = window.ashTerminalInputIntegration.viewport();
				return top === bottom;
			})).toBe(true);
			await terminal.locator('.xterm-screen').hover();
			await page.screenshot({ path: testInfo.outputPath(`terminal-scrollbar-${mode}.png`) });
			await page.evaluate(() => window.ashTerminalInputIntegration.close());
		});
	}

	test('terminal command markers follow the prompt, execution, result and themed gutter geometry', async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

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
		await expect(pending.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'terminal-decoration-incomplete');
		await expect(pending).toHaveCSS('width', '16px');
		await expect(pending.locator('.ash-icon')).toHaveCSS('font-size', '16px');
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
		await expect(failure.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'terminal-decoration-error');
		await expect(failure.locator('.ash-icon')).toHaveCSS('font-size', '16px');
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
			const icon = (await success.locator('.ash-icon').boundingBox())!;
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
		await expect(success.locator('.ash-icon')).toHaveCSS('font-size', '16px');
		await page.screenshot({ path: testInfo.outputPath('terminal-command-markers.png') });
		await page.evaluate(() => window.ashTerminalIntegration.write('output\r\n'.repeat(80)));
		await expect(success).not.toBeVisible();
		await expect(failure).not.toBeVisible();
		await page.evaluate(() => window.ashTerminalIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('terminal panel uses themed surfaces and regular UI type for the instance list', async function () {
		const { page } = browserTests;

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

	for (const locale of ['en', 'zh-CN']) {
		for (const upstream of [false, true]) {
			test(`terminal quick fixes insert ${upstream ? 'push upstream' : 'Git typo'} suggestions without running them (${locale})`, async function () {
				const { page } = browserTests;

				await page.goto(`/terminal.html?stream&commandModel&locale=${locale}`);
				await page.waitForFunction(() => Boolean(window.ashTerminalStreamIntegration));
				await page.evaluate(() => window.ashTerminalStreamIntegration.start());
				await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.model().input)).toBe('|');
				await page.evaluate(upstream => {
					const fixture = window.ashTerminalStreamIntegration;
					const command = upstream ? 'git push' : 'git sttatus';
					fixture.feedModel(`${command}\r\n`);
					fixture.environmentFrame({ type: 'commandExecuted', commandId: 'quick-fix-failed', command, isTrusted: false, cwd: '/workspace', timestampMillis: 200 });
					fixture.feedModel(upstream
						? 'fatal: The current branch topic has no upstream branch.\r\nTo push the current branch and set the remote as upstream, use\r\n\r\n    git push --set-upstream origin topic\r\n'
						: "git: 'sttatus' is not a git command. See 'git --help'.\r\n\r\nThe most similar command is\r\n\tstatus\r\n");
					fixture.environmentFrame({ type: 'commandFinished', exitCode: 1, durationMillis: 1 });
					fixture.environmentFrame({ type: 'promptStart' });
					fixture.feedModel('$ ');
					fixture.environmentFrame({ type: 'commandStart' });
				}, upstream);
				await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.model().commands?.length)).toBe(2);
				await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.model().input)).toBe('|');
				const before = await page.evaluate(() => window.ashTerminalStreamIntegration.quickFix.writes());
				const command = page.evaluate(() => window.ashTerminalStreamIntegration.quickFix.command());
				const input = page.getByRole('combobox', { name: locale === 'zh-CN' ? '终端快速修复' : 'Terminal Quick Fixes', exact: true });
				await expect(input).toBeVisible();
				await expect(input).toHaveAttribute('placeholder', locale === 'zh-CN' ? '选择要插入的修复，不会立即运行' : 'Select a fix to insert without running it');
				const fixed = upstream ? 'git push --set-upstream origin topic' : 'git status';
				await expect(page.getByRole('option')).toContainText(fixed);
				expect(await page.evaluate(() => window.ashTerminalStreamIntegration.quickFix.writes())).toEqual(before);
				await input.press('Enter');
				await command;
				expect(await page.evaluate(() => window.ashTerminalStreamIntegration.quickFix.writes())).toEqual([...before, fixed]);
				await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.model().input)).toBe(`${fixed}|`);
				await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
				await page.evaluate(() => window.ashTerminalStreamIntegration.close());
			});
		}
	}

	test('terminal browser list menu keeps its captured instance after active selection changes', async function () {
		const { page } = browserTests;

		await page.goto('/terminal.html?pane&browser');
		await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
		await page.evaluate(async () => { window.ashTerminalPaneIntegration.panel(true); });
		await expect(page.locator('.xterm')).toHaveCount(1);
		await page.evaluate(() => window.ashTerminalPaneIntegration.command('workbench.action.terminal.new'));
		const tabs = page.getByRole('tablist', { name: 'Terminal instances' });
		await expect(tabs.getByRole('tab')).toHaveCount(2);
		const ids = await page.evaluate(() => window.ashTerminalPaneIntegration.ids());
		expect((await page.evaluate(() => window.ashTerminalPaneIntegration.menuActions())).slice().sort()).toEqual(['Change Terminal Icon', 'Clear Terminal', 'Copy', 'Paste', 'Focus Terminal', 'Join or Reorder Terminals...', 'Kill Terminal', 'Move Terminal into Editor Area', 'Relaunch Terminal', 'Rename Terminal', 'Split Terminal', 'Terminal: Attach to Chat', 'Unsplit Terminal'].sort());
		await page.evaluate(id => window.ashTerminalPaneIntegration.activate(id), ids[0]!);
		await tabs.getByRole('tab').first().click({ button: 'right' });
		await expect(page.getByRole('menu')).toBeVisible();
		await expect(page.getByRole('menuitem', { name: 'Relaunch Terminal', exact: true })).toBeVisible();
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

	test('terminal browser list menu relaunches its exited target and survives asynchronous execution', async function () {
		const { page } = browserTests;

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

	test('terminal profile commands select, cancel and apply the saved default to the next creation', async function () {
		const { page } = browserTests;

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
			test(`terminal ${kind} picker retires on workspace change and the next command works in ${locale}`, async function () {
				const { page } = browserTests;

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

	test('configured terminal profile reaches the real picker and resolver with argv, env, cwd and themed metadata', async function () {
		const { page } = browserTests;

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
		const tab = page.getByRole('tab', { name: 'shell', exact: true });
		await expect(tab).toBeVisible();
		await expect(tab.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'terminal-git-bash');
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

	test('terminal title toolbar follows display settings and exposes Chinese profile commands', async function () {
		const { page } = browserTests;

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

	for (const [kind, path, args, icon, title] of [
		['WSL', 'C:\\Windows\\System32\\wsl.exe', ['-d', 'Ubuntu-24.04'], 'terminal-ubuntu', 'wsl'],
		['Git Bash', 'C:\\Program Files\\Git\\bin\\bash.exe', ['--login', '-i'], 'terminal-git-bash', 'bash'],
		['Command Prompt', 'C:\\Windows\\System32\\cmd.exe', [], 'terminal-cmd', 'cmd'],
		['PowerShell', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', [], 'terminal-powershell', 'pwsh'],
	] as const) test(`renamed ${kind} profiles keep menu labels and use shell names and icons in terminal tabs`, async function () {
		const { page } = browserTests;
		const testInfo = browserTests.info;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/terminal.html?pane&profiles&browser&os=windows');
		await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
		await page.evaluate(async ({ path, args }) => {
			await window.ashTerminalPaneIntegration.configure('terminal.integrated.profiles.windows', {
				'Work shell': { path, args },
			});
			window.ashTerminalPaneIntegration.panel(true);
		}, { path, args });
		await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(1);
		for (const name of ['Work shell', 'Renamed shell']) {
			if (name === 'Renamed shell') {
				await page.evaluate(({ path, args }) => window.ashTerminalPaneIntegration.configure('terminal.integrated.profiles.windows', {
					'Renamed shell': { path, args },
				}), { path, args: kind === 'WSL' ? '--distribution "Ubuntu-24.04"' : args });
			}
			await page.getByRole('button', { name: 'Select Terminal Profile', exact: true }).click();
			const item = page.getByRole('menuitem', { name, exact: true });
			await expect(item.locator(`[data-ash-icon-id="${icon}"]`)).toBeVisible();
			await item.click();
			const tab = page.getByRole('tab', { name: title, exact: true, selected: true });
			await expect(tab).toBeVisible();
			await expect(tab.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', icon);
		}
		if (kind === 'Git Bash') await page.screenshot({ path: testInfo.outputPath('terminal-bash-name.png') });
		await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('Windows raw command line profile reaches the picker, resolver and next default without becoming argv', async function () {
		const { page } = browserTests;

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
		await expect(page.getByRole('tab', { name: 'cmd', exact: true })).toBeVisible();
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

	test('extension terminal profile activates from the picker and persists as the next default', async function () {
		const { page } = browserTests;

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
		await expect(tab.locator('.ash-icon')).toHaveAttribute('data-ash-icon-id', 'terminal-git-bash');
		await page.evaluate(() => { void window.ashTerminalPaneIntegration.command('workbench.action.terminal.selectDefaultProfile'); });
		const defaults = page.getByRole('combobox', { name: '选择默认终端配置', exact: true });
		await expect(defaults).toBeFocused(); await defaults.fill('Extension Shell'); await defaults.press('Enter');
		await expect(defaults).toHaveCount(0);
		await page.evaluate(() => window.ashTerminalPaneIntegration.command('workbench.action.terminal.new'));
		await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.createdProfiles())).toEqual(['shell', 'custom:Extension Shell', 'custom:Extension Shell']);
		await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('shell cwd waits for the original xterm commit and remains available with retained command output', async function () {
		const { page } = browserTests;

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


	test('Send Sequence user keybinding resolves variables and sends control characters through the real instance', async function () {
		const { page } = browserTests;

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
		test(`Send Sequence prompt supports control escapes, cancellation and accessible help in ${locale}`, async function () {
			const { page } = browserTests;

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

	test('terminal row and pane drops join existing groups and reject an unrelated window resource', async function () {
		const { page } = browserTests;

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

	test('changing the active terminal retires its open join picker', async function () {
		const { page } = browserTests;

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

	test('shared terminal editors confirm only the last closing host and cancellation retains the process', async function () {
		const { page } = browserTests;

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

	test('close all skips a retained sticky terminal host and confirms once when it finally closes', async function () {
		const { page } = browserTests;

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

	test('cancelling a later terminal confirmation aborts close all without terminating accepted terminals', async function () {
		const { page } = browserTests;

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
		for (const action of ['tab', 'group', 'all', 'sticky'] as const) test(`shared terminal editor ${action} closes only its final host in ${locale}`, async function () {
			const { page } = browserTests;

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

	test('terminal editor restoration displays an unavailable resource without starting a shell', async function () {
		const { page } = browserTests;

		await page.goto('/terminal.html?input&groups&editor&locale=zh-CN');
		await expect.poll(() => page.evaluate(() => Boolean(window.ashTerminalEditorIntegration))).toBe(true);
		await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.moveToEditor'));
		await page.evaluate(() => window.ashTerminalEditorIntegration.restore());
		await expect(page.locator('.ash-terminal-editor')).toContainText('此终端已不可用');
		await expect.poll(() => page.evaluate(() => window.ashTerminalEditorIntegration.state())).toMatchObject({ instances: 0, created: 1, editorTabs: 1 });
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`terminal rename and icon selection update the original instance in ${locale}`, async function () {
			const { page } = browserTests;

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

	test('closing a terminal cancels its pending name interaction', async function () {
		const { page } = browserTests;

		await page.goto('/terminal.html?input&groups');
		await expect.poll(() => page.evaluate(() => Boolean(window.ashTerminalGroupsIntegration))).toBe(true);
		const renaming = page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.rename'));
		await expect(page.getByRole('dialog', { name: 'Rename Terminal', exact: true })).toBeVisible();
		await page.evaluate(() => window.ashTerminalGroupsIntegration.close());
		await renaming;
		await expect(page.getByRole('dialog', { name: 'Rename Terminal', exact: true })).toHaveCount(0);
	});


	test('terminal Clear and Relaunch commands operate on the active editor instance', async function () {
		const { page } = browserTests;

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

	for (const locale of ['en', 'zh-CN']) {
		test(`terminal environment information follows the collection owner in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/terminal.html?pane&profiles&locale=${locale}`);
			await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
			await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
			await page.evaluate(() => window.ashTerminalPaneIntegration.command('workbench.action.terminal.new'));
			const tabs = page.locator('.ash-terminal-tabs [role="tab"]');
			await expect(tabs).toHaveCount(2);
			await page.evaluate(() => window.ashTerminalPaneIntegration.environment(true));
			await tabs.first().hover();
			const card = page.locator('.ash-terminal-instance-hover');
			await card.getByRole('button', { name: locale === 'zh-CN' ? '显示详细信息' : 'Show Details', exact: true }).click();
			const label = locale === 'zh-CN' ? '扩展更改了此终端的环境贡献' : 'Extensions changed this terminal’s environment contributions';
			await expect(card).toContainText(label);
			await page.keyboard.press('Escape');
			await page.evaluate(() => window.ashTerminalPaneIntegration.environment(false));
			await page.mouse.move(0, 0);
			await tabs.first().hover();
			await expect(card).toBeVisible();
			await expect(card).not.toContainText(label);
			await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`terminal instance hover shares process details across title and rows in ${locale}`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/terminal.html?pane&profiles&browser&workbench&shellIntegration=rich&locale=${locale}`);
			await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
			await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
			const title = page.locator('.ash-terminal-active-action button');
			await title.hover();
			const card = page.locator('.ash-terminal-instance-hover');
			await expect(card).toContainText(locale === 'zh-CN' ? '进程 ID（PID）：1235' : 'Process ID (PID): 1235');
			await expect(card).toContainText(locale === 'zh-CN' ? '命令行：/bin/sh' : 'Command line: /bin/sh');
			await expect(card).toContainText(locale === 'zh-CN' ? 'Shell 集成：丰富' : 'Shell integration: Rich');
			await expect(card).not.toContainText('/backend/workspace');
			const show = locale === 'zh-CN' ? '显示详细信息' : 'Show Details';
			const hide = locale === 'zh-CN' ? '隐藏详细信息' : 'Hide Details';
			await card.getByRole('button', { name: show, exact: true }).click();
			await expect(card).toContainText('/backend/workspace');
			await expect(card.getByRole('button', { name: hide, exact: true })).toHaveAttribute('aria-expanded', 'true');
			await page.screenshot({ path: testInfo.outputPath(`terminal-instance-hover-${locale}.png`) });
			await page.keyboard.press('Escape');
			await page.evaluate(() => window.ashTerminalPaneIntegration.command('workbench.action.terminal.new'));
			const row = page.locator('.ash-terminal-tabs [role="tab"]').first();
			await row.focus();
			await row.press('Alt+ArrowDown');
			await expect(card).toContainText(locale === 'zh-CN' ? '进程 ID（PID）：1235' : 'Process ID (PID): 1235');
			await expect(card.getByRole('button').first()).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(card.getByRole('button', { name: hide, exact: true })).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(card.getByRole('button', { name: show, exact: true })).toBeFocused();
			await expect(card).not.toContainText('/backend/workspace');
			await page.keyboard.press('Escape');
			await expect(row).toBeFocused();
			await expect(card).toHaveCount(0);
			await page.reload();
			await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
			await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
			await title.focus();
			await title.press('Alt+ArrowDown');
			await expect(card.getByRole('button', { name: show, exact: true })).toHaveAttribute('aria-expanded', 'false');
			await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
			await expect(card).toHaveCount(0);
			expect(errors).toEqual([]);
		});

		for (const host of ['posix', 'windows']) {
			test(`terminal instance hover shows actual ${host} launch arguments and expands a long path in ${locale}`, async function () {
				const { page } = browserTests;

				await page.goto(`/terminal.html?pane&profiles&browser&workbench&hoverLaunch=${host}&shellIntegration=none&locale=${locale}`);
				await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
				await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
				await page.locator('.ash-terminal-active-action button').hover();
				const card = page.locator('.ash-terminal-instance-hover');
				await expect(card).toContainText(host === 'windows' ? '…\\pwsh.exe -NoExit -Command ". fixture.ps1"' : '…/bash --rcfile "/private/fixture bashrc" ""');
				await expect(card).not.toContainText(host === 'windows' ? 'C:\\Program Files' : '/opt/fixture');
				await expect(card).toContainText(locale === 'zh-CN' ? '注入未能激活' : 'Injection failed to activate');
				await card.getByRole('button', { name: locale === 'zh-CN' ? '显示详细信息' : 'Show Details', exact: true }).click();
				await expect(card).toContainText(host === 'windows' ? 'C:\\Program Files\\Fixture Shell\\bin\\pwsh.exe' : '/opt/fixture/a/long/path/to/a/shell/bin/bash');
				await page.evaluate(() => window.ashTerminalPaneIntegration.metadata('rich', '/workspace'));
				await expect(card).toContainText(locale === 'zh-CN' ? 'Shell 集成：丰富' : 'Shell integration: Rich');
				await expect(card).not.toContainText(locale === 'zh-CN' ? '注入未能激活' : 'Injection failed to activate');
				await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
			});
		}
	}

	for (const locale of ['en', 'zh-CN']) {

		test(`terminal instance hover keeps process errors and secondary warnings visible without details in ${locale}`, async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.goto(`/terminal.html?pane&profiles&browser&workbench&rejectInput&locale=${locale}`);
			await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
			await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
			const failure = await page.evaluate(async () => {
				try {
					await window.ashTerminalPaneIntegration.command('workbench.action.terminal.sendSequence', { text: 'hover-input' });
					return '';
				} catch (error) {
					return (error as Error).message;
				}
			});
			expect(failure).toBe('Synthetic input failure');
			const title = page.locator('.ash-terminal-active-action button');
			await title.focus();
			await title.press('Alt+ArrowDown');
			const card = page.locator('.ash-terminal-instance-hover');
			const show = locale === 'zh-CN' ? '显示详细信息' : 'Show Details';
			await expect(card.getByRole('button', { name: show, exact: true })).toBeVisible();
			await expect(card.locator('[data-severity="error"]')).toContainText('Synthetic input failure');
			await page.evaluate(() => window.ashTerminalPaneIntegration.environment(true));
			await expect(card.locator('[data-severity="warning"]')).toBeVisible();
			await expect(card.locator('[data-severity="error"]')).toContainText('Synthetic input failure');
			await page.screenshot({ path: testInfo.outputPath(`terminal-hover-warning-${locale}.png`), animations: 'disabled' });
			for (const theme of ['dark', 'light', 'hcDark', 'hcLight'] as const) {
				await page.evaluate(theme => window.ashTerminalPaneIntegration.theme(theme), theme);
				const colors = await card.evaluate(element => ({
					background: getComputedStyle(element.closest('.ash-hover')!).backgroundColor,
					error: getComputedStyle(element.querySelector('[data-severity="error"]')!).color,
					warning: getComputedStyle(element.querySelector('[data-severity="warning"]')!).color,
				}));
				expect(colors.error).not.toBe(colors.background);
				expect(colors.warning).not.toBe(colors.background);
			}
			await card.getByRole('button', { name: show, exact: true }).click();
			await expect(card.locator('[data-severity="warning"]')).toContainText(locale === 'zh-CN' ? '显示环境贡献' : 'Show Environment Contributions');
			await page.evaluate(() => window.ashTerminalPaneIntegration.environment(false));
			await expect(card.locator('[data-severity="warning"]')).toHaveCount(0);
			await expect(card.locator('[data-severity="error"]')).toContainText('Synthetic input failure');
			await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
		});

		test(`terminal instance hover relaunches its warning target while another terminal is active in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/terminal.html?pane&profiles&browser&workbench&locale=${locale}`);
			await page.waitForFunction(() => Boolean(window.ashTerminalPaneIntegration));
			await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
			await page.evaluate(() => window.ashTerminalPaneIntegration.command('workbench.action.terminal.new'));
			const ids = await page.evaluate(() => window.ashTerminalPaneIntegration.ids());
			await page.evaluate(() => window.ashTerminalPaneIntegration.environment(true));
			const row = page.locator('.ash-terminal-tabs [role="tab"]').first();
			await row.focus();
			await row.press('Alt+ArrowDown');
			const card = page.locator('.ash-terminal-instance-hover');
			await expect(card).toContainText(locale === 'zh-CN' ? '进程 ID（PID）：1235' : 'Process ID (PID): 1235');
			await card.getByRole('button', { name: locale === 'zh-CN' ? '重新启动终端' : 'Relaunch Terminal', exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashTerminalPaneIntegration.counts().creates)).toBe(3);
			expect(await page.evaluate(() => window.ashTerminalPaneIntegration.operations().closed)).toEqual([1]);
			expect(await page.evaluate(() => window.ashTerminalPaneIntegration.activeId())).toBe(ids[1]);
			await row.focus();
			await row.press('Alt+ArrowDown');
			await expect(card).toContainText(locale === 'zh-CN' ? '进程 ID（PID）：1237' : 'Process ID (PID): 1237');
			await expect(card.getByRole('button', { name: locale === 'zh-CN' ? '重新启动终端' : 'Relaunch Terminal', exact: true })).toHaveCount(0);
			await page.evaluate(() => window.ashTerminalPaneIntegration.dispose());
		});
	}


	async function seedSuggestPrompt(page: Page, prefix: string, locale = 'en', shell: 'bash' | 'zsh' = 'bash'): Promise<void> {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/terminal.html?input&groups&clipboard&browser&suggest&locale=${locale}`);
		await expect.poll(async () => ({ ready: await page.evaluate(() => Boolean(window.ashTerminalSuggestIntegration && window.ashTerminalInputIntegration)), errors })).toEqual({ ready: true, errors: [] });
		await page.evaluate(({ prefix, shell }) => {
			const feed = window.ashTerminalInputIntegration.feed;
			feed('', { type: 'processReady', isWindowsPty: false, shellType: shell as import('../../../../../platform/terminal/common/terminal.js').PosixShellType });
			feed('', { type: 'promptStart' });
			feed('$ ');
			feed('', { type: 'commandStart' });
			feed(prefix);
		}, { prefix, shell });
		await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.model())).toBe(`${prefix}|`);
		await page.evaluate(() => window.ashTerminalInputIntegration.clear());
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`terminal suggest inserts only an explicitly accepted history suffix in ${locale}`, async function () {
			const { page } = browserTests;

			await seedSuggestPrompt(page, 'echo ', locale);
			await page.evaluate(() => {
				const history = window.ashTerminalSuggestIntegration.history;
				history('echo accepted');
				history('echo untrusted', false);
				history('echo disabled', true, true);
				history('echo unsafe\rcommand');
			});
			await page.locator('.xterm-helper-textarea').press('Control+Space');
			const picker = page.getByRole('combobox', { name: locale === 'zh-CN' ? '终端建议' : 'Terminal suggestions', exact: true });
			await expect(picker).toBeVisible();
			await expect(page.getByRole('option')).toHaveCount(1);
			await expect(page.getByRole('option')).toContainText('echo accepted');
			expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
			expect(await page.evaluate(() => window.ashTerminalSuggestIntegration.model())).toBe('echo |');
			await page.keyboard.press('Enter');
			await expect(picker).toBeHidden();
			await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['accepted']);
			await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
			const help = await page.evaluate(() => window.ashTerminalClipboardIntegration.help());
			expect(help).toContain('<keybinding:workbench.action.terminal.triggerSuggest>');
			await page.evaluate(() => window.ashTerminalInputIntegration.close());
		});
	}

	test('terminal suggest quotes path suffixes literally and keeps Tab owned by the shell', async function () {
		const { page } = browserTests;

		await seedSuggestPrompt(page, 'cat ./sp');
		await page.evaluate(async () => {
			await window.ashTerminalSuggestIntegration.file("/workspace/space 'quote\\file.txt");
			void window.ashTerminalInputIntegration.command('workbench.action.terminal.triggerSuggest');
		});
		const picker = page.getByRole('combobox', { name: 'Terminal suggestions', exact: true });
		await expect(page.getByRole('option')).toContainText("./space 'quote\\file.txt");
		expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
		await picker.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(["'ace '\"'\"'quote\\file.txt'"]);
		await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
		await page.evaluate(() => window.ashTerminalInputIntegration.clear());
		await page.locator('.xterm-helper-textarea').press('Tab');
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['\t']);
		await page.evaluate(() => window.ashTerminalInputIntegration.close());
	});

	for (const shell of ['bash', 'zsh'] as const) {
		for (const { name, suffix, directory = false } of [
			{ name: 'special file.txt', suffix: "'ecial file.txt'" },
			{ name: "special 'quoted\"\\file.txt", suffix: "'ecial '\"'\"'quoted\"\\file.txt'" },
			{ name: 'sp$(literal);`literal`&|<>.txt', suffix: "'$(literal);`literal`&|<>.txt'" },
			{ name: 'sp$HOME!#*?[ab]{a,b}(group).txt', suffix: "'$HOME!#*?[ab]{a,b}(group).txt'" },
			{ name: 'special 中文.txt', suffix: "'ecial 中文.txt'" },
			{ name: 'special.txt', suffix: 'ecial.txt' },
			{ name: 'special $(literal) dir', suffix: "'ecial $(literal) dir/'", directory: true },
		]) {
			test(`terminal suggest inserts a literal ${shell} resource suffix for ${JSON.stringify(name)}`, async function () {
				const { page } = browserTests;

				await seedSuggestPrompt(page, 'cat ./sp', 'en', shell);
				await page.evaluate(async ({ name, directory }) => {
					const resources = window.ashTerminalSuggestIntegration;
					if (directory) await resources.directory(`/workspace/${name}`);
					else await resources.file(`/workspace/${name}`);
					void window.ashTerminalInputIntegration.command('workbench.action.terminal.triggerSuggest');
				}, { name, directory });
				const picker = page.getByRole('combobox', { name: 'Terminal suggestions', exact: true });
				await expect(page.getByRole('option')).toContainText(`./${name}${directory ? '/' : ''}`);
				expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
				await picker.press('Enter');
				await expect(picker).toBeHidden();
				// The fixture records input instead of running a shell. Acceptance must
				// write the quoted suffix alone, without an execution newline.
				await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([suffix]);
				await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
				await page.evaluate(() => window.ashTerminalInputIntegration.close());
			});
		}
	}

	test('terminal suggest retires on prompt edits, terminal switching and delayed file completion', async function () {
		const { page } = browserTests;

		await seedSuggestPrompt(page, 'echo ');
		await page.evaluate(() => window.ashTerminalSuggestIntegration.history('echo history'));
		await page.evaluate(() => { void window.ashTerminalInputIntegration.command('workbench.action.terminal.triggerSuggest'); });
		const picker = page.getByRole('combobox', { name: 'Terminal suggestions', exact: true });
		await expect(picker).toBeVisible();
		await page.evaluate(() => window.ashTerminalInputIntegration.feed('changed'));
		await expect(picker).toBeHidden();
		await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.model())).toBe('echo changed|');
		await page.evaluate(() => window.ashTerminalInputIntegration.feed('\r\x1b[2K$ echo '));
		await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.model())).toBe('echo |');
		await page.evaluate(() => { void window.ashTerminalInputIntegration.command('workbench.action.terminal.triggerSuggest'); });
		await expect(picker).toBeVisible();
		await page.evaluate(async () => { await window.ashTerminalClipboardIntegration.switchAway(); window.ashTerminalClipboardIntegration.switchBack(); });
		await expect(picker).toBeHidden();
		await page.evaluate(async () => {
			await window.ashTerminalSuggestIntegration.file('/workspace/echo-file');
			window.ashTerminalSuggestIntegration.holdFiles();
			void window.ashTerminalInputIntegration.command('workbench.action.terminal.triggerSuggest');
		});
		await expect(picker).toBeVisible();
		await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.filesPending())).toBe(true);
		await picker.press('Escape');
		await page.evaluate(() => window.ashTerminalSuggestIntegration.releaseFiles());
		await expect(picker).toBeHidden();
		expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
		await page.evaluate(() => window.ashTerminalInputIntegration.close());
	});

	test('terminal suggest inserts directory suffixes and keeps directory reads inside the execution root', async function () {
		const { page } = browserTests;

		await seedSuggestPrompt(page, 'cd ./pr');
		await page.evaluate(async () => {
			await window.ashTerminalSuggestIntegration.directory('/workspace/project dir');
			await window.ashTerminalSuggestIntegration.directory('/outside');
			await window.ashTerminalSuggestIntegration.file('/outside/private.txt');
			void window.ashTerminalInputIntegration.command('workbench.action.terminal.triggerSuggest');
		});
		const picker = page.getByRole('combobox', { name: 'Terminal suggestions', exact: true });
		await expect(page.getByRole('option')).toContainText('./project dir/');
		await picker.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(["'oject dir/'"]);
		await page.evaluate(() => window.ashTerminalInputIntegration.feed('\r\x1b[2K$ cat /outside/pr'));
		await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.model())).toBe('cat /outside/pr|');
		await page.evaluate(() => { void window.ashTerminalInputIntegration.command('workbench.action.terminal.triggerSuggest'); });
		await expect(picker).toBeVisible();
		await expect(page.locator('.ash-quick-pick')).toHaveAttribute('aria-busy', 'false');
		await expect(page.getByRole('option')).toHaveCount(0);
		await picker.press('Escape');
		expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(["'oject dir/'"]);
		await page.evaluate(() => window.ashTerminalInputIntegration.close());
	});

	for (const prefix of ["cat './sp", 'cat ./sp\\', 'cat $(echo ./sp']) {
		test(`terminal suggest leaves shell token parsing to the shell for ${JSON.stringify(prefix)}`, async function () {
			const { page } = browserTests;

			await seedSuggestPrompt(page, prefix);
			await page.evaluate(async () => {
				await window.ashTerminalSuggestIntegration.file('/workspace/special.txt');
				void window.ashTerminalInputIntegration.command('workbench.action.terminal.triggerSuggest');
			});
			const picker = page.getByRole('combobox', { name: 'Terminal suggestions', exact: true });
			await expect(picker).toBeVisible();
			await expect(page.locator('.ash-quick-pick')).toHaveAttribute('aria-busy', 'false');
			await expect(page.getByRole('option')).toHaveCount(0);
			await picker.press('Escape');
			expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
			await page.evaluate(() => window.ashTerminalInputIntegration.close());
		});
	}

	test('terminal sticky scroll caps wrapped command rows and releases trimmed command markers', async function () {
		const { page } = browserTests;

		await page.goto('/terminal.html?stream&commandModel');
		await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration?.model().input)).toBe('|');
		await page.evaluate(async () => {
			const fixture = window.ashTerminalStreamIntegration;
			await fixture.stickyScroll.configure('maxLineCount', 2);
			fixture.environmentFrame({ type: 'hasRichCommandDetection', value: true });
			const command = `echo ${'wrapped-command '.repeat(20)}END`;
			fixture.feedModel(`${command}\r\n`);
			fixture.environmentFrame({ type: 'commandExecuted', commandId: 'wrapped-command', command, isTrusted: true, cwd: '/workspace', timestampMillis: 1 });
			fixture.feedModel(Array.from({ length: 80 }, (_, index) => `wrapped-output-${index}\r\n`).join(''));
		});
		await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.observed())).toContain('wrapped-output-79');
		await page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.scroll(12));
		const header = page.locator('.ash-terminal-sticky-scroll');
		await expect(header).toBeVisible();
		await expect(header.locator('span')).toHaveCount(2);
		await expect(header.locator('span').last()).toContainText('END');
		await page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.configure('maxLineCount', 10));
		await page.evaluate(() => {
			window.ashTerminalStreamIntegration.stickyScroll.resize(40, 12);
			window.ashTerminalStreamIntegration.stickyScroll.scroll(12);
		});
		const rows = await page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.position().rows);
		await expect(header.locator('span')).toHaveCount(Math.floor(rows * 0.4));
		await page.evaluate(() => window.ashTerminalStreamIntegration.feedModel('trim-output\r\n'.repeat(1200)));
		await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.observed())).toContain('trim-output');
		await expect(header).toBeHidden();
		await page.evaluate(() => window.ashTerminalStreamIntegration.close());
	});


	test('execution-host shell type selects italic ghost text and resets with a legacy ready frame', async function () {
		const { page } = browserTests;

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

	test('shell environment commits through the original xterm and rejects partial trust across reuse', async function () {
		const { page } = browserTests;

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

	test('terminal accessible buffer follows wrapping, clearing and the active buffer', async function () {
		const { page } = browserTests;

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

	for (const locale of ['en', 'zh-CN']) {
		test(`terminal Quick Access filters, cancels and reveals the existing panel and editor shells in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/terminal.html?input&groups&editor&locale=${locale}`);
			await page.waitForFunction(() => Boolean(window.ashTerminalGroupsIntegration));
			const command = (id: string): Promise<unknown> => page.evaluate(id => window.ashTerminalGroupsIntegration.command(id), id);
			const rename = async (title: string): Promise<void> => {
				const pending = command('workbench.action.terminal.rename');
				const dialog = page.getByRole('dialog', { name: locale === 'zh-CN' ? '重命名终端' : 'Rename Terminal', exact: true });
				await dialog.getByRole('textbox').fill(title);
				await dialog.getByRole('textbox').press('Enter');
				await pending;
			};
			await rename('Panel shell');
			const panelId = await page.evaluate(() => window.ashTerminalGroupsIntegration.active());
			await command('workbench.action.terminal.split');
			await rename('Editor shell');
			const editorId = await page.evaluate(() => window.ashTerminalGroupsIntegration.active());
			await command('workbench.action.terminal.moveToEditor');
			const created = await page.evaluate(() => window.ashTerminalGroupsIntegration.metadata().created);
			await page.evaluate(() => window.ashTerminalGroupsIntegration.clearWrites());
			await command('workbench.action.quickOpenTerm');
			const picker = page.getByRole('combobox', { name: locale === 'zh-CN' ? '输入要打开的终端名称' : 'Type the name of a terminal to open', exact: true });
			await picker.fill('term pnlsh');
			await expect(page.getByRole('option', { name: /Panel shell/ })).toBeVisible();
			await expect(page.getByRole('option', { name: /Editor shell/ })).toHaveCount(0);
			await picker.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.active())).toBe(panelId);
			const panelInput = page.locator('.ash-terminal-group-pane:visible .xterm-helper-textarea');
			await expect(panelInput).toBeFocused();
			await command('workbench.action.quickOpenTerm');
			await picker.fill('term Editor');
			await picker.press('Escape');
			await expect(panelInput).toBeFocused();
			expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.active())).toBe(panelId);
			await command('workbench.action.quickOpenTerm');
			await picker.fill('term Editor');
			await picker.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.active())).toBe(editorId);
			await expect(page.locator('.ash-terminal-editor .xterm-helper-textarea')).toBeFocused();
			expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.metadata().created)).toBe(created);
			expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.writes())).toEqual([]);
			await command('workbench.action.quickOpenTerm');
			await picker.fill('term Panel');
			const renameButton = page.getByRole('button', { name: locale === 'zh-CN' ? '重命名终端' : 'Rename Terminal', exact: true });
			await renameButton.focus();
			await renameButton.press('Enter');
			const dialog = page.getByRole('dialog', { name: locale === 'zh-CN' ? '重命名终端' : 'Rename Terminal', exact: true });
			await dialog.getByRole('textbox').fill('Renamed panel');
			await dialog.getByRole('textbox').press('Enter');
			await command('workbench.action.quickOpenTerm');
			await picker.fill('term Renamed');
			await expect(page.getByRole('option', { name: /Renamed panel/ })).toBeVisible();
			const closeButton = page.getByRole('button', { name: locale === 'zh-CN' ? '关闭终端' : 'Close Terminal', exact: true });
			await closeButton.focus();
			await closeButton.press('Enter');
			await expect(page.getByRole('option', { name: /Renamed panel/ })).toHaveCount(0);
			await expect.poll(() => page.evaluate(() => window.ashTerminalEditorIntegration.state().instances)).toBe(1);
			await picker.press('Escape');
			expect(await page.evaluate(() => window.ashTerminalGroupsIntegration.active())).toBe(editorId);
		});
	}

	test('terminal typeahead discards predictions on controls, alternate buffer and configuration changes', async function () {
		const { page } = browserTests;

		const input = page.locator('.ash-terminal-instance:visible .xterm-helper-textarea');
		const prediction = page.locator('.ash-terminal-typeahead');
		const enable = async (): Promise<void> => {
			await seedScreenCommand(page);
			await page.evaluate(() => window.ashTerminalInputIntegration.configure('terminal.integrated.localEchoEnabled', 'on'));
			await input.press('a');
			await expect(prediction).toBeEmpty();
			await page.evaluate(() => window.ashTerminalInputIntegration.feed('a'));
			await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toContain('next prompta');
		};
		await enable();
		await input.pressSequentially('pending');
		await expect(prediction).toHaveText('pending');
		await input.press('ArrowLeft');
		await expect(prediction).toBeEmpty();
		await input.press('x');
		await expect(prediction).toBeEmpty();
		// A control edit cannot be predicted again until a fresh detected prompt.
		await enable();
		await input.press('p');
		await expect(prediction).toHaveText('p');
		await page.evaluate(() => window.ashTerminalInputIntegration.feed('\x1b[?1049h'));
		await expect(prediction).toBeEmpty();
		await input.press('y');
		await expect(prediction).toBeEmpty();
		await page.evaluate(() => window.ashTerminalInputIntegration.feed('\x1b[?1049l'));
		await expect(prediction).toBeEmpty();
		await enable();
		await input.press('z');
		await expect(prediction).toHaveText('z');
		await page.evaluate(() => window.ashTerminalInputIntegration.configure('terminal.integrated.localEchoEnabled', 'off'));
		await expect(prediction).toBeEmpty();
		await input.press('q');
		await expect(prediction).toBeEmpty();
		await page.evaluate(() => window.ashTerminalInputIntegration.close());
		await expect(prediction).toHaveCount(0);
	});
});
