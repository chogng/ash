import { expect, test, type Page } from '@playwright/test';

async function prompt(page: Page, locale = 'en'): Promise<void> {
	await page.goto(`/terminal.html?input&groups&clipboard&browser&suggest&locale=${locale}`);
	await page.waitForFunction(() => !!window.ashTerminalSuggestIntegration && !!window.ashTerminalInputIntegration);
	await page.evaluate(async () => {
		const feed = window.ashTerminalInputIntegration.feed;
		feed('', { type: 'processReady', isWindowsPty: false, shellType: 'bash' as import('../../../src/ash/platform/terminal/common/terminal.js').PosixShellType.Bash });
		feed('', { type: 'promptStart' }); feed('$ '); feed('', { type: 'commandStart' }); feed('ec');
		window.ashTerminalSuggestIntegration.history('echo accepted');
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.model())).toBe('ec|');
	await page.locator('.xterm-helper-textarea').focus();
	await page.evaluate(() => window.ashTerminalInputIntegration.clear());
}

async function confirmed(page: Page, key: string): Promise<void> {
	await page.locator('.xterm-helper-textarea').press(key);
	await page.evaluate(key => window.ashTerminalInputIntegration.feed(key), key);
}

for (const locale of ['en', 'zh-CN']) {
	test(`automatic terminal suggestions keep typing in the PTY and accept without Enter in ${locale}`, async ({ page }) => {
		await prompt(page, locale);
		await confirmed(page, 'h');
		const popup = page.locator('.ash-terminal-suggest');
		await expect(popup).toBeVisible();
		await expect(popup.getByRole('option')).toContainText('echo accepted');
		await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
		await expect(page.locator('.xterm-helper-textarea')).toHaveAttribute('aria-controls', /ash-list-/);
		await confirmed(page, 'o');
		await expect(popup).toBeVisible();
		await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
		await page.locator('.xterm-helper-textarea').press('Enter');
		await expect(popup).toBeHidden();
		await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['h', 'o', ' accepted']);
		await page.evaluate(() => window.ashTerminalInputIntegration.close());
	});
}

test('automatic terminal suggestions preserve native Tab and respect disabled and composition input', async ({ page }) => {
	await prompt(page);
	await page.evaluate(async () => { await window.ashTerminalSuggestIntegration.configure('terminal.integrated.suggest.enabled', false); });
	await confirmed(page, 'h');
	await expect(page.locator('.ash-terminal-suggest')).toBeHidden();
	await page.evaluate(async () => { await window.ashTerminalSuggestIntegration.configure('terminal.integrated.suggest.enabled', true); });
	const ime = await page.context().newCDPSession(page);
	await ime.send('Input.imeSetComposition', { text: 'o', selectionStart: 1, selectionEnd: 1 });
	await expect(page.locator('.ash-terminal-suggest')).toBeHidden();
	// Native composition commits to xterm before the execution host can echo it.
	await ime.send('Input.insertText', { text: 'o' });
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes.join(''))).toBe('ho');
	await page.evaluate(() => window.ashTerminalInputIntegration.feed('o'));
	await ime.detach();
	await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.model())).toBe('echo|');
	await confirmed(page, ' ');
	await expect(page.locator('.ash-terminal-suggest')).toBeVisible();
	await page.locator('.xterm-helper-textarea').press('Tab');
	await expect(page.locator('.ash-terminal-suggest')).toBeHidden();
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toContain('\t');
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

test('automatic terminal suggestions discard late provider results after input and provider withdrawal', async ({ page }) => {
	await prompt(page);
	await page.evaluate(() => window.ashTerminalSuggestIntegration.provider([{ label: 'echo extension', replacementRange: [0, 3] }], [], true));
	await confirmed(page, 'h');
	await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.providerRequests().length)).toBe(1);
	await page.locator('.xterm-helper-textarea').press('Escape');
	await expect(page.locator('.ash-terminal-suggest')).toBeHidden();
	await page.evaluate(() => { window.ashTerminalSuggestIntegration.disposeProvider(); window.ashTerminalSuggestIntegration.releaseProvider(); });
	await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.providerRequests()[0]?.cancelled)).toBe(true);
	await expect(page.locator('.ash-terminal-suggest')).toBeHidden();
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['h']);
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

test('automatic terminal popup fits a short narrow split and restores textarea accessibility attributes', async ({ page }) => {
	await prompt(page, 'zh-CN');
	await page.evaluate(() => {
		const terminal = document.querySelector<HTMLElement>('.ash-terminal-instance')!;
		terminal.style.maxHeight = '110px'; terminal.style.maxWidth = '270px';
		const input = terminal.querySelector('textarea')!;
		input.setAttribute('aria-controls', 'original-owner'); input.setAttribute('aria-autocomplete', 'none');
		for (let index = 0; index < 12; index++) window.ashTerminalSuggestIntegration.history(`echo long-history-${index}-with-a-full-readable-description`);
	});
	await confirmed(page, 'h');
	const popup = page.locator('.ash-terminal-suggest');
	await expect(popup).toBeVisible();
	await expect(page.locator('.xterm-helper-textarea')).toHaveAttribute('aria-autocomplete', 'list');
	const geometry = await popup.evaluate(element => {
		const bounds = element.getBoundingClientRect(), parent = element.closest('.ash-terminal-instance')!.getBoundingClientRect();
		return { left: bounds.left >= parent.left, right: bounds.right <= parent.right + 1, top: bounds.top >= parent.top, bottom: bounds.bottom <= parent.bottom + 1 };
	});
	expect(geometry).toEqual({ left: true, right: true, top: true, bottom: true });
	await expect(popup.locator('.ash-terminal-suggest-item').first()).toHaveAttribute('title', /echo long-history-/);
	await page.locator('.xterm-helper-textarea').press('Escape');
	await expect(page.locator('.xterm-helper-textarea')).toHaveAttribute('aria-controls', 'original-owner');
	await expect(page.locator('.xterm-helper-textarea')).toHaveAttribute('aria-autocomplete', 'none');
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

test('automatic terminal path suggestions insert literal quoted suffixes and retire on terminal switching', async ({ page }) => {
	await prompt(page);
	await page.evaluate(async () => {
		await window.ashTerminalSuggestIntegration.file('/workspace/space quote.txt');
		window.ashTerminalInputIntegration.feed('\r\x1b[2K$ cat ./s');
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.model())).toBe('cat ./s|');
	await confirmed(page, 'p');
	// Keep the original terminal's widget pinned after switchAway creates another.
	const popup = page.locator('.ash-terminal-instance').first().locator('.ash-terminal-suggest');
	await expect(popup.getByRole('option')).toContainText('./space quote.txt');
	await page.locator('.xterm-helper-textarea').press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['p', "'ace quote.txt'"]);
	await page.evaluate(() => window.ashTerminalInputIntegration.feed('\r\x1b[2K$ ec'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.model())).toBe('ec|');
	await confirmed(page, 'h');
	await expect(popup).toBeVisible();
	await page.evaluate(async () => { await window.ashTerminalClipboardIntegration.switchAway(); window.ashTerminalClipboardIntegration.switchBack(); });
	await expect(popup).toBeHidden();
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

for (const locale of ['en', 'zh-CN']) {
	test(`terminal automatic suggestion help opens with Alt+F1 and restores PTY focus in ${locale}`, async ({ page }) => {
		await page.goto(`/terminal.html?input&groups&clipboard&browser&suggest&accessibilityHelp&locale=${locale}`);
		await page.waitForFunction(() => !!window.ashTerminalSuggestIntegration && !!window.ashTerminalInputIntegration);
		const input = page.locator('.xterm-helper-textarea');
		await input.focus();
		const before = await page.evaluate(() => [...window.ashTerminalInputIntegration.writes]);
		await input.press('Alt+F1');
		const help = page.locator('.ash-accessible-view-content');
		await expect(help).toBeVisible();
		await expect(help).toHaveValue(locale === 'zh-CN' ? /建议列表保持终端输入焦点/ : /The suggestion list keeps terminal input focused/);
		await help.press('Escape');
		await expect(help).toBeHidden();
		await expect(input).toBeFocused();
		expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(before);
		await page.evaluate(() => window.ashTerminalInputIntegration.close());
	});
}
