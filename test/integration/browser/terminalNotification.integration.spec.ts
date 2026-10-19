import { expect, test } from '@playwright/test';

for (const locale of ['en', 'zh-CN']) {
	test(`terminal OSC 99 flows from process output through the real parser and replies to the originating process in ${locale}`, async ({ page }) => {
		await page.goto(`/terminal.html?input&groups&clipboard&browser&osc99&locale=${locale}`);
		await page.waitForFunction(() => !!window.ashTerminalOscIntegration);
		await page.evaluate(() => {
			window.ashTerminalInputIntegration.clear();
			window.ashTerminalInputIntegration.feed('\x1b]99;i=build:d=0;Build\x1b\\');
			window.ashTerminalInputIntegration.feed('\x1b]99;i=build:d=0:p=buttons;View\u2028Dismiss\x1b\\');
			window.ashTerminalInputIntegration.feed('\x1b]99;i=build:p=body:a=report:c=1;finished\x1b\\');
		});
		await expect.poll(() => page.evaluate(() => window.ashTerminalOscIntegration.notifications().map(item => item.message))).toEqual(['Build: finished']);
		await page.evaluate(() => window.ashTerminalInputIntegration.feed('\x1b]99;i=query:p=alive;\x1b\\'));
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes.join(''))).toContain('\x1b]99;i=query:p=alive;build\x1b\\');
		const view = page.locator('.ash-notification').filter({ hasText: 'Build: finished' }).getByRole('button', { name: 'View', exact: true });
		await expect(view).toBeVisible();
		await view.focus();
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes.join(''))).toContain('\x1b]99;i=build;1\x1b\\');
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes.join(''))).toContain('\x1b]99;i=build:p=close;\x1b\\');
		await page.evaluate(() => window.ashTerminalInputIntegration.configure('terminal.integrated.enableNotifications', false));
		await page.evaluate(() => window.ashTerminalInputIntegration.feed('\x1b]99;;Disabled\x1b\\discard-check'));
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toContain('discard-check');
		expect(await page.evaluate(() => window.ashTerminalOscIntegration.notifications())).toEqual([]);
	});
}

test('terminal developer writes display escapes through its command and records real output until stopped', async ({ page }) => {
	await page.goto('/terminal.html?input&groups&clipboard&browser&osc99');
	await page.waitForFunction(() => !!window.ashTerminalOscIntegration);
	await page.evaluate(() => {
		window.ashTerminalInputIntegration.clear();
		void window.ashTerminalInputIntegration.command('workbench.action.terminal.writeDataToTerminal');
	});
	await page.getByRole('textbox').last().fill('debug\\r\\nline');
	await page.keyboard.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.snapshot())).toContain('debug\nline');
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
	await page.evaluate(() => { void window.ashTerminalInputIntegration.command('workbench.action.terminal.recordSession'); });
	await expect.poll(() => page.evaluate(() => window.ashTerminalOscIntegration.recording())).toBe(true);
	await page.evaluate(() => window.ashTerminalOscIntegration.feedActive('recorded real process output\r\n'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalOscIntegration.snapshotActive())).toContain('recorded real process output');
	await page.evaluate(() => window.ashTerminalOscIntegration.stopRecording());
	await expect.poll(() => page.evaluate(() => window.ashTerminalClipboardIntegration.copied.length)).toBe(1);
	const recording = await page.evaluate(() => JSON.parse(window.ashTerminalClipboardIntegration.copied[0]));
	expect(recording.replay.events.map((entry: { data: string; }) => entry.data).join('')).toContain('recorded real process output');
	expect(recording.truncated).toBe(false);
});

test('terminal dictation converts spoken symbols before acknowledged input and keeps non-English text without executing Enter', async ({ page }) => {
	await page.goto('/terminal.html?pane&existing');
	await page.waitForFunction(() => !!window.ashTerminalPaneIntegration);
	await page.evaluate(() => window.ashTerminalPaneIntegration.panel(true));
	await page.getByRole('button', { name: 'Terminal: Start dictation', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Stop dictation', exact: true })).toBeEnabled();
	await page.evaluate(() => window.ashTerminalPaneIntegration.transcript('Echo dollar sign HOME ampersand echo 中文\r\n\x1b\x9b', true));
	await page.getByRole('button', { name: 'Stop dictation', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashTerminalIntegration.writes)).toEqual(['echo $ HOME & echo 中文 ']);
});
