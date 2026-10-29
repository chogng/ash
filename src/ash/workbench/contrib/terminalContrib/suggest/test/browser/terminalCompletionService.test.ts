import { expect, type Page } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../../test/unit/browser/context.js';
import assert from 'node:assert/strict';
import { test, suite } from 'mocha';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../../base/common/errors.js';
import type { ITerminalInstance } from '../../../../terminal/browser/terminal.js';
import { TerminalCompletionService, type ITerminalCompletion } from '../../browser/terminalCompletionService.js';

test('Terminal completions isolate synchronous and asynchronous provider failures', async () => {
	using service = new TerminalCompletionService();
	using broken = service.registerTerminalCompletionProvider('extension', 'broken', {
		provideCompletions: () => {
			throw new Error('Synchronous failure');
		},
	});
	using rejected = service.registerTerminalCompletionProvider('extension', 'rejected', {
		provideCompletions: async () => {
			throw new Error('Asynchronous failure');
		},
	});
	using healthy = service.registerTerminalCompletionProvider('extension', 'healthy', {
		provideCompletions: async () => [{ label: 'status', replacementRange: [4, 6] }],
	});
	const results = await service.provideCompletions(
		{} as ITerminalInstance,
		'git st',
		6,
		new AbortController().signal,
	);
	assert.deepEqual(
		results.map(({ isValid, ...item }) => item),
		[{ label: 'status', replacementRange: [4, 6] }],
	);
	assert.equal(results[0]!.isValid?.(), true);
});

test('Terminal completions do not dispatch an already cancelled request', async () => {
	using service = new TerminalCompletionService();
	let calls = 0;
	using registration = service.registerTerminalCompletionProvider('extension', 'provider', {
		provideCompletions: async () => {
			calls++;
			return [];
		},
	});
	const request = new AbortController();
	request.abort();
	assert.deepEqual(await service.provideCompletions({} as ITerminalInstance, '', 0, request.signal), []);
	assert.equal(calls, 0);
});

test('Terminal completions discard results from a registration that was replaced while pending', async () => {
	using service = new TerminalCompletionService();
	const pending = new DeferredPromise<readonly ITerminalCompletion[]>();
	const provider = { provideCompletions: () => pending.p };
	using original = service.registerTerminalCompletionProvider('extension', 'provider', provider, '.');
	const operation = service.provideCompletions({} as ITerminalInstance, '.', 1, new AbortController().signal, '.');
	original.dispose();
	using replacement = service.registerTerminalCompletionProvider('extension', 'provider', provider, '.');
	await pending.complete([{ label: 'stale', replacementRange: [0, 1] }]);
	assert.deepEqual(await operation, []);
	const results = await service.provideCompletions(
		{} as ITerminalInstance,
		'.',
		1,
		new AbortController().signal,
		'.',
	);
	assert.equal(results[0]!.isValid?.(), true);
	replacement.dispose();
	assert.equal(results[0]!.isValid?.(), false);
});

for (const transition of ['cancel', 'unregister', 'dispose'] as const) {
	test(`Terminal completions settle after ${transition} even when a provider ignores cancellation`, async () => {
		using service = new TerminalCompletionService();
		const pending = new DeferredPromise<readonly ITerminalCompletion[]>();
		let providerSignal: AbortSignal | undefined;
		using registration = service.registerTerminalCompletionProvider('extension', 'pending', {
			provideCompletions: (_instance, _value, _cursor, signal) => {
				providerSignal = signal;
				return pending.p;
			},
		});
		using healthy = service.registerTerminalCompletionProvider('extension', 'healthy', {
			provideCompletions: async () => [{ label: 'healthy', replacementRange: [0, 0] }],
		});
		const request = new AbortController();
		const operation = service.provideCompletions({} as ITerminalInstance, '', 0, request.signal);
		if (transition === 'cancel') request.abort();
		else if (transition === 'unregister') registration.dispose();
		else service.dispose();
		const result = await operation;
		assert.equal(providerSignal?.aborted, true);
		assert.deepEqual(
			result.map(item => item.label),
			transition === 'unregister' ? ['healthy'] : [],
		);
		// The original work remains observed after cancellation, including late failures.
		await pending.error(new Error('Late provider failure'));
	});
}

test('Terminal completions reject registration after the window service is disposed', () => {
	using service = new TerminalCompletionService();
	service.dispose();
	assert.throws(
		() => service.registerTerminalCompletionProvider('extension', 'late', { provideCompletions: async () => [] }),
		isCancellationError,
	);
	assert.deepEqual([...service.providers], []);
});

suite('terminalSuggest browser component', () => {
	const browserTests = useBrowserTests();
	async function prompt(page: Page, locale = 'en'): Promise<void> {
		await page.goto(`/terminal.html?input&groups&clipboard&browser&suggest&locale=${locale}`);
		await page.waitForFunction(
			() => !!window.ashTerminalSuggestIntegration && !!window.ashTerminalInputIntegration,
		);
		await page.evaluate(async () => {
			const feed = window.ashTerminalInputIntegration.feed;
			feed('', {
				type: 'processReady',
				isWindowsPty: false,
				shellType:
					'bash' as import('../../../../../../platform/terminal/common/terminal.js').PosixShellType.Bash,
			});
			feed('', { type: 'promptStart' });
			feed('$ ');
			feed('', { type: 'commandStart' });
			feed('ec');
			window.ashTerminalSuggestIntegration.history('echo accepted');
		});
		await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.model())).toBe('ec|');
		await page.locator('.xterm-helper-textarea').focus();
		await page.evaluate(() => window.ashTerminalInputIntegration.clear());
	}

	async function confirmed(page: Page, key: string): Promise<void> {
		const before = await page.evaluate(() => window.ashTerminalInputIntegration.writes.join(''));
		await page.locator('.xterm-helper-textarea').press(key);
		// Native composition can defer xterm input. A real execution host cannot echo
		// a key before receiving it, so the fixture must observe that same boundary.
		await expect
			.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes.join('')))
			.toBe(before + key);
		await page.evaluate(key => window.ashTerminalInputIntegration.feed(key), key);
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`automatic terminal suggestions keep typing in the PTY and accept without Enter in ${locale}`, async function () {
			const { page } = browserTests;

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
			await expect
				.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes))
				.toEqual(['h', 'o', ' accepted']);
			await page.evaluate(() => window.ashTerminalInputIntegration.close());
		});
	}

	test('automatic terminal suggestions preserve native Tab and respect disabled and composition input', async function () {
		const { page } = browserTests;

		await prompt(page);
		await page.evaluate(async () => {
			await window.ashTerminalSuggestIntegration.configure('terminal.integrated.suggest.enabled', false);
		});
		await confirmed(page, 'h');
		await expect(page.locator('.ash-terminal-suggest')).toBeHidden();
		await page.evaluate(async () => {
			await window.ashTerminalSuggestIntegration.configure('terminal.integrated.suggest.enabled', true);
		});
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

	test('automatic terminal suggestions discard late provider results after input and provider withdrawal', async function () {
		const { page } = browserTests;

		await prompt(page);
		await page.evaluate(() =>
			window.ashTerminalSuggestIntegration.provider(
				[{ label: 'echo extension', replacementRange: [0, 3] }],
				[],
				true,
			),
		);
		await confirmed(page, 'h');
		await expect
			.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.providerRequests().length))
			.toBe(1);
		await page.locator('.xterm-helper-textarea').press('Escape');
		await expect(page.locator('.ash-terminal-suggest')).toBeHidden();
		await page.evaluate(() => {
			window.ashTerminalSuggestIntegration.disposeProvider();
			window.ashTerminalSuggestIntegration.releaseProvider();
		});
		await expect
			.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.providerRequests()[0]?.cancelled))
			.toBe(true);
		await expect(page.locator('.ash-terminal-suggest')).toBeHidden();
		expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(['h']);
		await page.evaluate(() => window.ashTerminalInputIntegration.close());
	});

	test('automatic terminal popup fits a short narrow split and restores textarea accessibility attributes', async function () {
		const { page } = browserTests;

		await prompt(page, 'zh-CN');
		const dimensions = await page.evaluate(() => window.ashTerminalInputIntegration.dimensions());
		await page.evaluate(() => {
			const terminal = document.querySelector<HTMLElement>('.ash-terminal-instance')!;
			terminal.style.maxHeight = '110px';
			terminal.style.maxWidth = '270px';
			const input = terminal.querySelector('textarea')!;
			input.setAttribute('aria-controls', 'original-owner');
			input.setAttribute('aria-autocomplete', 'none');
			for (let index = 0; index < 12; index++)
				window.ashTerminalSuggestIntegration.history(
					`echo long-history-${index}-with-a-full-readable-description`,
				);
		});
		// Fitting the split dismisses suggestions; finish that resize before typing opens them.
		await expect
			.poll(async () => {
				const fitted = await page.evaluate(() => window.ashTerminalInputIntegration.dimensions());
				return fitted.cols < dimensions.cols && fitted.rows < dimensions.rows;
			})
			.toBe(true);
		await confirmed(page, 'h');
		const popup = page.locator('.ash-terminal-suggest');
		await expect(popup).toBeVisible();
		await expect(page.locator('.xterm-helper-textarea')).toHaveAttribute('aria-autocomplete', 'list');
		const geometry = await popup.evaluate(element => {
			const bounds = element.getBoundingClientRect(),
				parent = element.closest('.ash-terminal-instance')!.getBoundingClientRect();
			return {
				left: bounds.left >= parent.left,
				right: bounds.right <= parent.right + 1,
				top: bounds.top >= parent.top,
				bottom: bounds.bottom <= parent.bottom + 1,
			};
		});
		expect(geometry).toEqual({ left: true, right: true, top: true, bottom: true });
		await expect(popup.locator('.ash-terminal-suggest-item').first()).toHaveAttribute(
			'title',
			/echo long-history-/,
		);
		await page.locator('.xterm-helper-textarea').press('Escape');
		await expect(page.locator('.xterm-helper-textarea')).toHaveAttribute('aria-controls', 'original-owner');
		await expect(page.locator('.xterm-helper-textarea')).toHaveAttribute('aria-autocomplete', 'none');
		await page.evaluate(() => window.ashTerminalInputIntegration.close());
	});

	test('automatic terminal path suggestions insert literal quoted suffixes and retire on terminal switching', async function () {
		const { page } = browserTests;

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
		await expect
			.poll(() => page.evaluate(() => window.ashTerminalInputIntegration.writes))
			.toEqual(['p', "'ace quote.txt'"]);
		await page.evaluate(() => window.ashTerminalInputIntegration.feed('\r\x1b[2K$ ec'));
		await expect.poll(() => page.evaluate(() => window.ashTerminalSuggestIntegration.model())).toBe('ec|');
		await confirmed(page, 'h');
		await expect(popup).toBeVisible();
		await page.evaluate(async () => {
			await window.ashTerminalClipboardIntegration.switchAway();
			window.ashTerminalClipboardIntegration.switchBack();
		});
		await expect(popup).toBeHidden();
		await page.evaluate(() => window.ashTerminalInputIntegration.close());
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`terminal automatic suggestion help opens with Alt+F1 and restores PTY focus in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/terminal.html?input&groups&clipboard&browser&suggest&accessibilityHelp&locale=${locale}`);
			await page.waitForFunction(
				() => !!window.ashTerminalSuggestIntegration && !!window.ashTerminalInputIntegration,
			);
			const input = page.locator('.xterm-helper-textarea');
			await input.focus();
			const before = await page.evaluate(() => [...window.ashTerminalInputIntegration.writes]);
			await input.press('Alt+F1');
			const help = page.locator('.ash-accessible-view-content');
			await expect(help).toBeVisible();
			await expect(help).toHaveValue(
				locale === 'zh-CN' ? /建议列表保持终端输入焦点/ : /The suggestion list keeps terminal input focused/,
			);
			await help.press('Escape');
			await expect(help).toBeHidden();
			await expect(input).toBeFocused();
			expect(await page.evaluate(() => window.ashTerminalInputIntegration.writes)).toEqual(before);
			await page.evaluate(() => window.ashTerminalInputIntegration.close());
		});
	}
});
