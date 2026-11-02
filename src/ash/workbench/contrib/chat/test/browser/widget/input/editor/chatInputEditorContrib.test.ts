import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../../../../test/unit/browser/context.js';

suite('Chat input command removal', () => {
	const browser = useBrowserTests();
	async function acceptCommand(locale = 'en', prefix = '/'): Promise<void> {
		const { page } = browser;
		await page.goto(`/chatInput.html?inlineCode&locale=${locale}`);
		await page.evaluate(() => window.ashChatInputIntegration.setSlashCommands([
			{ name: 'review', description: 'Review code', argumentMode: 'optional', argumentHint: '<path>' },
		]));
		const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
		await input.pressSequentially(prefix);
		const review = page.getByRole('option').filter({ hasText: '/review' });
		await expect(review).toBeVisible();
		await review.click();
		assert.equal(await page.evaluate(() => window.ashChatInputIntegration.dropState().text), '/review ');
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`Backspace removes an accepted command in one undoable edit in ${locale}`, async () => {
			await acceptCommand(locale);
			const { page } = browser;
			const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
			await input.press('Backspace');
			assert.equal(await page.evaluate(() => window.ashChatInputIntegration.dropState().text), '');
			await expect(page.getByLabel('Submission', { exact: true })).toBeEmpty();
			await expect(input).toBeFocused();
			await input.press('ControlOrMeta+z');
			assert.equal(await page.evaluate(() => window.ashChatInputIntegration.dropState().text), '/review ');
			await input.press('ControlOrMeta+Shift+z');
			assert.equal(await page.evaluate(() => window.ashChatInputIntegration.dropState().text), '');
			const help = await page.evaluate(() => window.ashChatInputIntegration.inputAccessibility());
			assert.ok(help?.includes(locale === 'zh-CN' ? '仅输入 / 后接受命令补全' : 'accepting a command completion from a bare /'));
		});

		test(`accepting over a typed prefix keeps ordinary Backspace in ${locale}`, async () => {
			await acceptCommand(locale, '/rev');
			const { page } = browser;
			const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
			await input.press('Backspace');
			assert.equal(await page.evaluate(() => window.ashChatInputIntegration.dropState().text), '/review');
			await input.press('Backspace');
			assert.equal(await page.evaluate(() => window.ashChatInputIntegration.dropState().text), '/revie');
		});
	}

	test('typing after acceptance retires whole-command removal', async () => {
		await acceptCommand();
		const { page } = browser;
		const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
		await input.pressSequentially('x');
		await input.press('Backspace');
		assert.equal(await page.evaluate(() => window.ashChatInputIntegration.dropState().text), '/review ');
		await input.press('Backspace');
		assert.equal(await page.evaluate(() => window.ashChatInputIntegration.dropState().text), '/review');
	});

	test('moving inside an accepted command preserves normal character deletion', async () => {
		await acceptCommand();
		const { page } = browser;
		const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
		await input.press('ArrowLeft');
		await input.press('Backspace');
		assert.equal(await page.evaluate(() => window.ashChatInputIntegration.dropState().text), '/revie ');
	});

	test('a manually typed command retains normal Backspace behavior', async () => {
		const { page } = browser;
		await page.goto('/chatInput.html?inlineCode');
		const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
		await input.pressSequentially('/review ');
		await input.press('Backspace');
		assert.equal(await page.evaluate(() => window.ashChatInputIntegration.dropState().text), '/review');
	});

	test('read-only input cannot remove an accepted command', async () => {
		await acceptCommand();
		const { page } = browser;
		await page.evaluate(() => window.ashChatInputIntegration.setInputReadOnly(true));
		const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
		await expect(input).toHaveAttribute('aria-readonly', 'true');
		await input.press('Backspace');
		assert.equal(await page.evaluate(() => window.ashChatInputIntegration.dropState().text), '/review ');
	});
});
