import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../../test/unit/browser/context.js';

suite('Ash Code terminal dictation', () => {
	const browserTests = useBrowserTests();

	for (const locale of ['en', 'zh-CN']) {
		test(`session capability controls the microphone and routes recording to the CLI in ${locale}`, async () => {
			const { page } = browserTests;
			await page.goto(`/terminal.html?input&groups&clipboard&browser&voice&locale=${locale}`);
			await page.waitForFunction(() => Boolean(window.ashTerminalGroupsIntegration));
			const start = page.locator(
				'.ash-terminal-title-toolbar > [data-action-id="workbench.action.terminal.startVoice"] button',
			);
			const stop = page.locator(
				'.ash-terminal-title-toolbar > [data-action-id="workbench.action.terminal.stopVoice"] button',
			);
			await expect(start).toHaveCount(0);
			await expect(stop).toHaveCount(0);
			await page.evaluate(() => window.ashTerminalGroupsIntegration.feed('ash code\r\n\x1b]0;Ash Code\x07'));
			await expect(start).toHaveCount(0);
			await page.evaluate(() => window.ashTerminalGroupsIntegration.feed('\x1b]7501;state=idle:app=ash\x1b\\'));
			await expect(start).toHaveCount(0);
			// Split writes exercise the actual xterm parser, including a split ST terminator.
			await page.evaluate(() => {
				window.ashTerminalGroupsIntegration.feed('\x1b]7501;state=idle:app=ash:dictation=idle:protocol=1\x1b');
				window.ashTerminalGroupsIntegration.feed('\\');
			});
			await expect(start).toBeVisible();
			await expect(start).toHaveAttribute(
				'aria-label',
				locale === 'zh-CN' ? '终端：开始听写' : 'Terminal: Start dictation',
			);
			await page.evaluate(() => window.ashTerminalGroupsIntegration.clearWrites());
			await start.focus();
			await start.press('Enter');
			await expect
				.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.writes().map(write => write.data)))
				.toEqual(['\x1b[23;8~']);
			await page.evaluate(() =>
				window.ashTerminalGroupsIntegration.feed(
					'\x1b]7501;state=idle:app=ash:dictation=active:protocol=1\x1b\\',
				),
			);
			await expect(start).toHaveCount(0);
			await expect(stop).toBeVisible();
			await stop.click();
			await expect
				.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.writes().map(write => write.data)))
				.toEqual(['\x1b[23;8~', '\x1b[24;8~']);
			await page.evaluate(() =>
				window.ashTerminalGroupsIntegration.feed(
					'\x1b]7501;state=idle:app=ash:dictation=busy:protocol=1\x1b\\',
				),
			);
			await expect(start).toBeDisabled();
			await page.evaluate(() =>
				window.ashTerminalGroupsIntegration.feed(
					'\x1b]7501;state=idle:app=ash:dictation=idle:protocol=1\x1b\\',
				),
			);
			await expect(start).toBeEnabled();
			await page.evaluate(() => window.ashTerminalGroupsIntegration.command('workbench.action.terminal.new'));
			await expect
				.poll(() =>
					page.evaluate(() => ({
						active: window.ashTerminalGroupsIntegration.active(),
						created: window.ashTerminalGroupsIntegration.metadata().created,
					})),
				)
				.toEqual({ active: 'terminal-instance-2', created: 2 });
			await expect(start).toHaveCount(0);
			await page.evaluate(() => window.ashTerminalClipboardIntegration.activateOriginal());
			await expect
				.poll(() =>
					page.evaluate(() => ({
						active: window.ashTerminalGroupsIntegration.active(),
						states: window.ashTerminalGroupsIntegration.dictation(),
					})),
				)
				.toEqual({
					active: 'terminal-instance-1',
					states: [
						{ id: 'terminal-instance-1', state: 'idle' },
						{ id: 'terminal-instance-2', state: 'unavailable' },
					],
				});
			await expect(start).toBeVisible();
			await page.evaluate(() => window.ashTerminalGroupsIntegration.feed('\x1b]7501;state=clear\x1b\\'));
			await expect(start).toHaveCount(0);
			await page.evaluate(() =>
				window.ashTerminalGroupsIntegration.feed(
					'\x1b]7501;state=idle:app=ash:dictation=idle:protocol=1\x1b\\',
				),
			);
			await expect(start).toBeVisible();
			await page.evaluate(() => window.ashTerminalClipboardIntegration.disconnect());
			await expect(start).toHaveCount(0);
		});
	}

	test('Ash Code menu launches the independent CLI in a new terminal and waits for its capability', async () => {
		const { page } = browserTests;
		await page.goto('/terminal.html?input&groups&clipboard&browser&voice');
		await page.waitForFunction(() => Boolean(window.ashTerminalGroupsIntegration));
		const trigger = page.locator('.ash-terminal-title-toolbar .ash-dropdown-with-primary-dropdown button');
		await trigger.focus();
		await trigger.press('ArrowDown');
		const entry = page.getByRole('menuitem', { name: 'Ash Code', exact: true });
		await expect(entry).toBeVisible();
		await page.evaluate(() => window.ashTerminalGroupsIntegration.clearWrites());
		await entry.focus();
		await entry.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashTerminalGroupsIntegration.metadata().created)).toBe(2);
		await expect
			.poll(() =>
				page.evaluate(() =>
					window.ashTerminalGroupsIntegration.writes().filter(write => write.data === 'ash code\r'),
				),
			)
			.toEqual([{ terminalId: 'input-shell-2', data: 'ash code\r' }]);
		await expect(
			page.locator('.ash-terminal-title-toolbar > [data-action-id="workbench.action.terminal.startVoice"]'),
		).toHaveCount(0);
	});
});
