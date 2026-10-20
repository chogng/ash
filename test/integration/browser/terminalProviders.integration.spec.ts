import { expect, test, type Page } from '@playwright/test';

async function prompt(page: Page, value: string): Promise<void> {
	await page.goto('/terminal.html?input&groups&clipboard&browser&suggest');
	await page.waitForFunction(() => !!window.ashTerminalSuggestIntegration && !!window.ashTerminalInputIntegration);
	await page.evaluate(value => {
		const feed = window.ashTerminalInputIntegration.feed;
		feed('', { type: 'processReady', isWindowsPty: false, shellType: 'bash' as import('../../../src/ash/platform/terminal/common/terminal.js').PosixShellType.Bash });
		feed('', { type: 'promptStart' }); feed('$ '); feed('', { type: 'commandStart' }); feed(value);
	}, value);
	await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.model())).toBe(`${value}|`);
	await page.evaluate(() => window.ashTerminalInputIntegration.clear());
}

test('terminal extension completion replaces its selected range in the original prompt without executing', async ({ page }) => {
	await prompt(page, 'git --he');
	await page.evaluate(() => {
		window.ashTerminalSuggestIntegration.provider([{ label: '--help', replacementRange: [4, 8], detail: 'Extension flag', documentation: 'Show help' }]);
		void window.ashTerminalInputIntegration.command('workbench.action.terminal.triggerSuggest');
	});
	const picker = page.getByRole('combobox', { name: 'Terminal suggestions', exact: true });
	await expect(picker).toBeVisible();
	await expect(page.getByRole('option')).toContainText('--help');
	expect(await page.evaluate(() => window.ashTerminalSuggestIntegration.providerRequests())).toEqual([{ value: 'git --he', cursorIndex: 8, cancelled: false }]);
	await picker.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['\x7f\x7f\x7f\x7f--help']);
	await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

test('terminal resource completion displays the filename and inserts only its quoted text', async ({ page }) => {
	await prompt(page, 'cat sp');
	const label = "sp ace'$(literal);&`literal`\\[x].txt";
	const insertText = "'sp ace'\"'\"'$(literal);&`literal`\\[x].txt'";
	await page.evaluate(({ label, insertText }) => {
		window.ashTerminalSuggestIntegration.provider([{ label, insertText, replacementRange: [4, 6] }]);
		void window.ashTerminalInputIntegration.command('workbench.action.terminal.triggerSuggest');
	}, { label, insertText });
	const picker = page.getByRole('combobox', { name: 'Terminal suggestions', exact: true });
	await expect(page.getByRole('option')).toContainText(label);
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
	await picker.press('Enter');
	await expect(picker).toBeHidden();
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['\x7f\x7f' + insertText]);
	await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

test('terminal extension completion applies a range at the middle of the prompt', async ({ page }) => {
	await prompt(page, 'git --he tail');
	await page.evaluate(() => {
		window.ashTerminalSuggestIntegration.provider([{ label: '--help', replacementRange: [4, 8] }]);
		window.ashTerminalInputIntegration.feed('\x1b[5D');
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.model())).toBe('git --he| tail');
	await page.evaluate(() => { void window.ashTerminalInputIntegration.command('workbench.action.terminal.triggerSuggest'); });
	const picker = page.getByRole('combobox', { name: 'Terminal suggestions', exact: true });
	await expect(page.getByRole('option')).toContainText('--help');
	await picker.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['\x7f\x7f\x7f\x7f--help']);
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

test('terminal completion cancels mid-prompt activation before a terminal switch can revive it', async ({ page }) => {
	await prompt(page, 'git --he tail');
	await page.evaluate(() => {
		window.ashTerminalSuggestIntegration.provider([{ label: '--help', replacementRange: [4, 8] }]);
		window.ashTerminalInputIntegration.feed('\x1b[5D');
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.model())).toBe('git --he| tail');
	await page.evaluate(() => {
		window.ashTerminalSuggestIntegration.holdActivation();
		void window.ashTerminalInputIntegration.command('workbench.action.terminal.triggerSuggest');
	});
	const picker = page.getByRole('combobox', { name: 'Terminal suggestions', exact: true });
	await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.activationCancelled())).toBe(false);
	await page.evaluate(async () => {
		await window.ashTerminalClipboardIntegration.switchAway();
		window.ashTerminalClipboardIntegration.switchBack();
	});
	await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.activationCancelled())).toBe(true);
	await page.evaluate(() => window.ashTerminalSuggestIntegration.releaseActivation());
	await expect(picker).toBeHidden();
	expect(await page.evaluate(() => window.ashTerminalSuggestIntegration.providerRequests())).toEqual([]);
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

test('terminal extension trigger characters wait for confirmed shell input before opening suggestions', async ({ page }) => {
	await prompt(page, 'git ');
	await page.evaluate(async () => { await window.ashTerminalSuggestIntegration.configure('terminal.integrated.suggest.suggestOnTriggerCharacters', true); window.ashTerminalSuggestIntegration.provider([{ label: '--help', replacementRange: [4, 5] }], ['-']); });
	await page.locator('.xterm-helper-textarea').press('-');
	expect(await page.evaluate(() => window.ashTerminalSuggestIntegration.providerRequests())).toEqual([]);
	await page.evaluate(() => window.ashTerminalInputIntegration.feed('-'));
	const picker = page.locator('.ash-terminal-suggest');
	await expect(picker).toBeVisible();
	await expect(page.getByRole('option')).toContainText('--help');
	expect(await page.evaluate(() => window.ashTerminalSuggestIntegration.providerRequests())).toEqual([{ value: 'git -', cursorIndex: 5, cancelled: false }]);
	await page.locator('.xterm-helper-textarea').press('Escape');
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['-']);
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

test('terminal extension completion ignores a late reply after prompt edits and unregisters its provider', async ({ page }) => {
	await prompt(page, 'git -');
	await page.evaluate(() => {
		window.ashTerminalSuggestIntegration.provider([{ label: '--help', replacementRange: [4, 5] }], [], true);
		void window.ashTerminalInputIntegration.command('workbench.action.terminal.triggerSuggest');
	});
	const picker = page.getByRole('combobox', { name: 'Terminal suggestions', exact: true });
	await expect(picker).toBeVisible();
	await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.providerRequests().length)).toBe(1);
	await page.evaluate(() => window.ashTerminalInputIntegration.feed('x'));
	await expect(picker).toBeHidden();
	await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.providerRequests()[0]?.cancelled)).toBe(true);
	await page.evaluate(() => { window.ashTerminalSuggestIntegration.disposeProvider(); window.ashTerminalSuggestIntegration.releaseProvider(); });
	await expect(page.getByRole('option')).toHaveCount(0);
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

test('terminal extension completion cannot apply a visible item after its provider is revoked', async ({ page }) => {
	await prompt(page, 'git -');
	await page.evaluate(() => {
		window.ashTerminalSuggestIntegration.provider([{ label: '--help', replacementRange: [4, 5] }]);
		void window.ashTerminalInputIntegration.command('workbench.action.terminal.triggerSuggest');
	});
	const picker = page.getByRole('combobox', { name: 'Terminal suggestions', exact: true });
	await expect(page.getByRole('option')).toContainText('--help');
	await page.evaluate(() => window.ashTerminalSuggestIntegration.disposeProvider());
	await picker.press('Enter');
	await expect(picker).toBeHidden();
	expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual([]);
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});

test('terminal extension trigger survives fragmented shell echo from an earlier key', async ({ page }) => {
	await prompt(page, 'git ');
	await page.evaluate(async () => {
		await window.ashTerminalSuggestIntegration.configure('terminal.integrated.suggest.quickSuggestions', false);
		await window.ashTerminalSuggestIntegration.configure('terminal.integrated.suggest.suggestOnTriggerCharacters', true);
		window.ashTerminalSuggestIntegration.provider([{ label: '--help', replacementRange: [5, 6] }], ['-']);
	});
	// The real input owner has accepted both keys, but the shell's first output
	// frame confirms only the earlier key. Its next frame confirms the trigger.
	await page.locator('.xterm-helper-textarea').pressSequentially('a-');
	await page.evaluate(() => window.ashTerminalInputIntegration.feed('a'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.model())).toBe('git a|');
	expect(await page.evaluate(() => window.ashTerminalSuggestIntegration.providerRequests())).toEqual([]);
	await page.evaluate(() => window.ashTerminalInputIntegration.feed('-'));
	await expect(page.locator('.ash-terminal-suggest')).toBeVisible();
	await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.providerRequests())).toEqual([{ value: 'git a-', cursorIndex: 6, cancelled: false }]);
	await page.locator('.xterm-helper-textarea').press('Escape');
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});


test('terminal extension trigger waits for the whole typed run when an earlier fragment ends with the same trigger', async ({ page }) => {
	await prompt(page, 'git ');
	await page.evaluate(async () => {
		await window.ashTerminalSuggestIntegration.configure('terminal.integrated.suggest.quickSuggestions', false);
		await window.ashTerminalSuggestIntegration.configure('terminal.integrated.suggest.suggestOnTriggerCharacters', true);
		window.ashTerminalSuggestIntegration.provider([{ label: '--help', replacementRange: [7, 8] }], ['-']);
	});
	await page.locator('.xterm-helper-textarea').pressSequentially('a-a-');
	await page.evaluate(() => window.ashTerminalInputIntegration.feed('a-'));
	await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.model())).toBe('git a-|');
	// Wait beyond the real query debounce to prove no early request was queued.
	await page.waitForTimeout(180);
	expect(await page.evaluate(() => window.ashTerminalSuggestIntegration.providerRequests())).toEqual([]);
	await expect(page.locator('.ash-terminal-suggest')).toBeHidden();
	await page.evaluate(() => window.ashTerminalInputIntegration.feed('a-'));
	await expect(page.locator('.ash-terminal-suggest')).toBeVisible();
	await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.providerRequests())).toEqual([{ value: 'git a-a-', cursorIndex: 8, cancelled: false }]);
	await page.locator('.xterm-helper-textarea').press('Escape');
	await page.evaluate(() => window.ashTerminalInputIntegration.close());
});
