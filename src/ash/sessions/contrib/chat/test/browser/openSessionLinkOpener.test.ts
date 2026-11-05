import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import type { } from '../../../../../../../test/fixtures/browser/sessions.page.js';

suite('Sessions conversation link opener', () => {
	const browser = useBrowserTests();

	for (const sideBySide of [false, true]) test(`the Sessions opener resolves a conversation link on its addressed host${sideBySide ? ' beside the source' : ''}`, async () => {
		const { page } = browser;
		await page.goto('/sessions.html?multiHost');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		const result = await page.evaluate(async openToSide => {
			const host = window.ashSessionsIntegration.multiHost!;
			await host.open('Host A');
			const start = host.calls.length;
			const handled = await host.openLink('Host B', openToSide);
			return { handled, reads: host.calls.slice(start).filter(call => call.method === 'read') };
		}, sideBySide);
		expect(result.handled).toBe(true);
		expect(result.reads).toContainEqual({ host: 'Host B', method: 'read', sessionId: 'same', threadId: 'same' });
		expect(result.reads.every(call => call.host === 'Host B')).toBe(true);
		const input = page.locator('.ash-sessions-chat-slot.active .ash-chat-input-editor .stanza-editor').getByRole('textbox');
		await expect(input).toBeFocused();
		await expect(page.locator('.ash-sessions-chat-slot:visible')).toHaveCount(sideBySide ? 2 : 1);
	});

	test('a side link preserves the composer of another Thread in the same Session', async () => {
		const { page } = browser;
		await page.goto('/sessions.html?multiHost&sideThreads');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await page.evaluate(() => window.ashSessionsIntegration.multiHost!.open('Host A'));
		const slots = page.locator('.ash-sessions-chat-slot:visible');
		const sourceInput = slots.first().locator('.ash-chat-input-editor .stanza-editor').getByRole('textbox');
		await sourceInput.focus();
		await page.keyboard.insertText('Keep the source draft');
		expect(await page.evaluate(() => window.ashSessionsIntegration.multiHost!.openLink('Host A', true, 'side'))).toBe(true);
		await expect(slots).toHaveCount(2);
		await expect(slots.first().locator('.ash-chat-input-editor .view-lines')).toHaveText('Keep the source draft');
		await expect(slots.last().locator('.ash-chat-input-editor .stanza-editor').getByRole('textbox')).toBeFocused();
		const sidebar = page.locator('.ash-sessions-list[data-mode="code"]');
		const followUps = sidebar.locator('[data-item^="chat:"] > .ash-sessions-list-item').filter({ hasText: 'Follow-up chat' });
		const item = await followUps.and(page.locator('[aria-current="page"]')).locator('..').getAttribute('data-item');
		const followUp = sidebar.locator(`[data-item=${JSON.stringify(item)}] > .ash-sessions-list-item`);
		await expect(followUp).toBeVisible();
		await followUp.hover();
		await expect(page.locator('.ash-hover').getByText('Follow-up chat', { exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await sidebar.locator('[data-row-order-id] > .ash-sessions-list-item').filter({ hasText: 'Task from Host A' }).press('Enter');
		await expect(followUp).toHaveAttribute('aria-current', 'false');
		await followUp.press('Enter');
		await expect(followUp).toHaveAttribute('aria-current', 'page');
		await page.screenshot({ path: browser.info.outputPath('nested-session-chats.png') });
	});
});
