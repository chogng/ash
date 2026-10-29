import { expect, type Page } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../../test/unit/browser/context.js';

suite('TerminalStickyScrollOverlay', () => {
	const browserTests = useBrowserTests();

	async function openTerminal(page: Page, locale = 'en'): Promise<void> {
		await page.goto(`/terminal.html?stream&commandModel&browser&locale=${locale}`);
		await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration?.model().input)).toBe('|');
		await page.evaluate(() => window.ashTerminalStreamIntegration.environmentFrame({ type: 'hasRichCommandDetection', value: true }));
	}

	test('the next multi-line prompt pushes the previous header away without covering it', async () => {
		const { page } = browserTests;
		await openTerminal(page);
		try {
			await page.evaluate(() => {
				const terminal = window.ashTerminalStreamIntegration;
				terminal.feedModel('echo first\r\nfirst-middle\r\nfirst-last\r\n');
				terminal.environmentFrame({
					type: 'commandExecuted',
					commandId: 'first',
					command: 'echo first\nfirst-middle\nfirst-last',
					isTrusted: true,
					cwd: '/workspace',
					timestampMillis: 1,
				});
				terminal.feedModel('first-output\r\n'.repeat(20));
				terminal.environmentFrame({ type: 'commandFinished', exitCode: 0, durationMillis: 1 });
				terminal.environmentFrame({ type: 'promptStart' });
				terminal.feedModel('next-directory\r\n$ ');
				terminal.environmentFrame({ type: 'commandStart' });
				terminal.feedModel('echo second\r\n');
				terminal.environmentFrame({
					type: 'commandExecuted',
					commandId: 'second',
					command: 'echo second',
					isTrusted: true,
					cwd: '/workspace',
					timestampMillis: 2,
				});
				terminal.feedModel('second-output\r\n'.repeat(50));
				terminal.environmentFrame({ type: 'commandFinished', exitCode: 0, durationMillis: 1 });
			});
			await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.model().commands?.length)).toBe(3);
			const second = await page.evaluate(() => window.ashTerminalStreamIntegration.serializeModel().commands.find(command => command.id === 'second')!);
			expect(second.startLine! - second.promptStartLine!).toBe(1);
			const header = page.locator('.ash-terminal-sticky-scroll');
			for (const distance of [3, 2, 1]) {
				await page.evaluate(line => window.ashTerminalStreamIntegration.stickyScroll.scroll(line), second.promptStartLine! - distance);
				await expect(header).toBeVisible();
				await expect
					.poll(() =>
						header.evaluate(element => {
							const bounds = element.getBoundingClientRect();
							const screen = element.closest('.ash-terminal-instance')!.querySelector('.xterm-screen')!.getBoundingClientRect();
							const rowHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
							return {
								bottom: Math.round((bounds.bottom - screen.top) / rowHeight),
								clippedRows: Math.round((screen.top - bounds.top) / rowHeight),
								clipPath: getComputedStyle(element).clipPath,
							};
						}),
					)
					.toMatchObject({ bottom: distance, clippedRows: 3 - distance });
			}
			await header.screenshot({ path: browserTests.info.outputPath('header-at-next-prompt.png') });
			await page.locator('.ash-terminal-instance:visible').screenshot({ path: browserTests.info.outputPath('next-prompt-visible.png') });
			await page.evaluate(line => window.ashTerminalStreamIntegration.stickyScroll.scroll(line), second.promptStartLine!);
			await expect(header).toBeHidden();
			await page.evaluate(line => window.ashTerminalStreamIntegration.stickyScroll.scroll(line), second.executedLine! + 3);
			await expect(header).toHaveAttribute('aria-label', 'Scroll to command: echo second');
			await expect(header).toHaveCSS('clip-path', 'inset(0px)');
		} finally {
			await page.evaluate(() => window.ashTerminalStreamIntegration.close());
		}
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`truncated commands expose an ellipsis and the full command in ${locale}`, async () => {
			const { page } = browserTests;
			await openTerminal(page, locale);
			try {
				await page.evaluate(async () => {
					const terminal = window.ashTerminalStreamIntegration;
					await terminal.stickyScroll.configure('maxLineCount', 2);
					terminal.feedModel('echo first 中文🙂\r\nmiddle\r\nlast\r\n');
					terminal.environmentFrame({
						type: 'commandExecuted',
						commandId: 'truncated',
						command: 'echo first 中文🙂\nmiddle\nlast',
						isTrusted: true,
						cwd: '/workspace',
						timestampMillis: 1,
					});
					terminal.feedModel('truncated-output\r\n'.repeat(60));
				});
				await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.observed())).toContain('truncated-output');
				await page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.scroll(8));
				const label = `${locale === 'zh-CN' ? '滚动到命令：' : 'Scroll to command: '}echo first 中文🙂\nmiddle\nlast`;
				const header = page.getByRole('button', { name: label, exact: true });
				await expect(header).toBeVisible();
				await expect(header).toHaveClass(/truncated/);
				expect(await header.evaluate(element => getComputedStyle(element, '::after').content)).toBe('"…"');
				expect(await header.locator(':scope > span').allTextContents()).toEqual(['middle', 'last']);
				await header.hover();
				await expect(page.getByRole('tooltip')).toContainText(label);
				await header.focus();
				await header.press('Escape');
				await expect(page.locator('.ash-terminal-instance:visible .xterm-helper-textarea')).toBeFocused();
				await page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.configure('maxLineCount', 1));
				await expect(header.locator(':scope > span')).toHaveCount(1);
				await page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.configure('maxLineCount', 5));
				await expect(header).not.toHaveClass(/truncated/);
				await expect(header.locator(':scope > span')).toHaveCount(3);
				await page.locator('.ash-terminal-instance:visible').screenshot({ path: browserTests.info.outputPath(`multiline-${locale}.png`) });
				await header.press('Enter');
				await expect(header).toBeHidden();
				await expect(page.locator('.ash-terminal-instance:visible .xterm-helper-textarea')).toBeFocused();
			} finally {
				await page.evaluate(() => window.ashTerminalStreamIntegration.close());
			}
		});

		test(`terminal accessibility help explains truncated commands in ${locale}`, async () => {
			const { page } = browserTests;
			await page.goto(`/terminal.html?input&clipboard&browser&locale=${locale}`);
			await page.waitForFunction(() => Boolean(window.ashTerminalClipboardIntegration));
			try {
				const help = await page.evaluate(() => window.ashTerminalClipboardIntegration.help());
				expect(help).toContain(locale === 'zh-CN' ? '省略号表示有命令行被隐藏' : 'An ellipsis indicates hidden command lines');
			} finally {
				await page.evaluate(() => window.ashTerminalInputIntegration.close());
			}
		});
	}

	test('cell colors, styles and Unicode widths follow all four terminal themes', async () => {
		const { page } = browserTests;
		await openTerminal(page);
		try {
			await page.evaluate(() => {
				const terminal = window.ashTerminalStreamIntegration;
				terminal.feedModel(
					'\x1b[31mred 中文🙂\x1b[0m \x1b[38;2;12;34;56mrgb\x1b[0m \x1b[38;5;196mcube\x1b[0m \x1b[38;5;244mgray\x1b[0m \x1b[7minverse\x1b[0m \x1b[48;2;65;43;21mbackground\x1b[0m \x1b[1;31mbold\x1b[0m \x1b[3;4mstyled\x1b[0m \x1b[1;31;44;7mflip\x1b[0m \x1b[38;2;12;34;56m\ue0b0█\x1b[0m\r\n',
				);
				terminal.environmentFrame({
					type: 'commandExecuted',
					commandId: 'styled',
					command: 'red 中文🙂 rgb cube gray inverse background bold styled flip \ue0b0█',
					isTrusted: true,
					cwd: '/workspace',
					timestampMillis: 1,
				});
				terminal.feedModel('colored-output\r\n'.repeat(60));
			});
			await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.observed())).toContain('colored-output');
			await page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.scroll(8));
			const header = page.locator('.ash-terminal-sticky-scroll');
			await expect(header).toBeVisible();
			for (const theme of ['dark', 'light', 'hcDark', 'hcLight'] as const) {
				await page.evaluate(mode => window.ashTerminalStreamIntegration.stickyScroll.theme(mode), theme);
				await header.click();
				await expect(header).toBeHidden();
				await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
				const original = page.locator('.ash-terminal-instance:visible .xterm-rows > div').filter({ hasText: 'red 中文🙂 rgb cube gray inverse background bold styled flip' });
				await expect(original).toBeVisible();
				// Compare against the original renderer, including its configured contrast adjustment.
				const colors = await original.evaluate(element => {
					const text = element.textContent!;
					const result: Record<string, { foreground: string; background: string }> = {};
					for (const word of ['red', 'rgb', 'cube', 'gray', 'inverse', 'background', 'bold', 'flip', '\ue0b0█']) {
						const index = text.indexOf(word);
						const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
						let offset = 0;
						for (let node = walker.nextNode(); node; node = walker.nextNode()) {
							const length = node.textContent!.length;
							if (index >= offset && index < offset + length) {
								const style = getComputedStyle(node.parentElement!);
								result[word] = { foreground: style.color, background: style.backgroundColor };
								break;
							}
							offset += length;
						}
					}
					return result;
				});
				const originalWidth = await original.evaluate(element => {
					const label = 'red 中文🙂';
					const start = element.textContent!.indexOf(label);
					const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
					let offset = 0;
					let left = Infinity;
					let right = 0;
					for (let node = walker.nextNode(); node; node = walker.nextNode()) {
						const length = node.textContent!.length;
						if (offset < start + label.length && offset + length > start) {
							const bounds = node.parentElement!.getBoundingClientRect();
							left = Math.min(left, bounds.left);
							right = Math.max(right, bounds.right);
						}
						offset += length;
					}
					return right - left;
				});
				await page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.scroll(8));
				await expect(header).toBeVisible();
				const red = header.getByText('red 中文🙂', { exact: true });
				for (const word of ['red', 'rgb', 'cube', 'gray', 'inverse', 'background', 'bold', 'flip', '\ue0b0█']) {
					const span = word === 'red' ? red : header.getByText(word, { exact: true });
					await expect(span).toHaveCSS('color', colors[word]!.foreground);
				}
				await expect(header.getByText('inverse', { exact: true })).toHaveCSS('background-color', colors.inverse!.background);
				await expect(header.getByText('background', { exact: true })).toHaveCSS('background-color', colors.background!.background);
				await expect(header.getByText('flip', { exact: true })).toHaveCSS('background-color', colors.flip!.background);
				await expect(header.getByText('styled', { exact: true })).toHaveCSS('font-style', 'italic');
				await expect(header.getByText('styled', { exact: true })).toHaveCSS('text-decoration-line', 'underline');
				expect((await red.boundingBox())!.width).toBeCloseTo(originalWidth, 1);
				await page.locator('.ash-terminal-instance:visible').screenshot({ path: browserTests.info.outputPath(`colors-${theme}.png`) });
			}
		} finally {
			await page.evaluate(() => window.ashTerminalStreamIntegration.close());
		}
	});

	test('blank command rows and the viewport percentage cap survive a resize', async () => {
		const { page } = browserTests;
		await openTerminal(page);
		try {
			await page.evaluate(() => {
				const terminal = window.ashTerminalStreamIntegration;
				terminal.feedModel('echo first\r\n\r\nthird\r\nfourth\r\nfifth\r\nsixth\r\n');
				terminal.environmentFrame({
					type: 'commandExecuted',
					commandId: 'blank',
					command: 'echo first\n\nthird\nfourth\nfifth\nsixth',
					isTrusted: true,
					cwd: '/workspace',
					timestampMillis: 1,
				});
				terminal.feedModel('blank-output\r\n'.repeat(60));
			});
			await expect.poll(() => page.evaluate(() => window.ashTerminalStreamIntegration.observed())).toContain('blank-output');
			await page.evaluate(async () => {
				await window.ashTerminalStreamIntegration.stickyScroll.configure('maxLineCount', 10);
				window.ashTerminalStreamIntegration.stickyScroll.scroll(10);
			});
			const header = page.locator('.ash-terminal-sticky-scroll');
			await expect(header.locator(':scope > span')).toHaveCount(6);
			const rowHeights = await header.locator(':scope > span').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
			expect(new Set(rowHeights).size).toBe(1);
			expect(rowHeights[1]).toBeGreaterThan(0);
			await page.evaluate(() => window.ashTerminalStreamIntegration.stickyScroll.resize(80, 10));
			await expect(header.locator(':scope > span')).toHaveCount(4);
			await expect(header).toHaveClass(/truncated/);
			expect(await header.evaluate(element => element.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(element).lineHeight))).toBeCloseTo(4, 1);
		} finally {
			await page.evaluate(() => window.ashTerminalStreamIntegration.close());
		}
	});
});
