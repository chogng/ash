import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import type { } from '../../../../../../../test/fixtures/browser/sessions.page.js';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('Session reference completions', () => {
	const browser = useBrowserTests();

	test('filters the host catalog and attaches the selected conversation with the keyboard', async () => {
		const { page } = browser;
		await page.goto('/sessions.html?multiHost&sideThreads&locale=zh-CN');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.locator('.ash-window-mode-control').getByRole('button', { name: '代码', exact: true }).click();
		const firstCall = await page.evaluate(async () => {
			const fixture = window.ashSessionsIntegration.multiHost!;
			await fixture.open('Host A');
			return fixture.calls.length;
		});
		const composer = page.locator('.ash-sessions-chat-slot.active .ash-chat-input-editor');
		const input = composer.getByRole('textbox');
		const options = composer.getByRole('listbox').getByRole('option');
		const content = composer.locator('.view-lines');
		await input.pressSequentially('Review #sess');
		await expect(options).toHaveCount(2);
		await expect(options.filter({ hasText: '当前对话' })).toHaveCount(1);
		await expect(options.filter({ hasText: 'Host B' })).toHaveCount(0);
		await input.pressSequentially('ion:Foll');
		await expect(options).toHaveCount(1);
		await expect(options.first()).toContainText('Follow-up chat');
		await input.press('Escape');
		await expect(options).toHaveCount(0);
		await expect(content).toHaveText('Review #session:Foll');

		await input.press('ControlOrMeta+a');
		await input.pressSequentially('Review #session:Foll');
		await expect(options).toHaveCount(1);
		await input.press('Tab');
		const attachment = composer.getByRole('button', { name: '打开 Follow-up chat', exact: true });
		await expect(attachment).toBeVisible();
		await expect(input).toBeFocused();
		expect(await page.evaluate(start => window.ashSessionsIntegration.multiHost!.calls.slice(start).filter(call => call.method === 'read' && call.threadId === 'side'), firstCall)).toEqual([
			{ host: 'Host A', method: 'read', sessionId: 'same', threadId: 'side' },
		]);
		await input.press('ControlOrMeta+z');
		await expect(attachment).toHaveCount(0);
		await expect(content).toHaveText('Review #session:Foll');
		await input.press('ControlOrMeta+Shift+z');
		await expect(attachment).toBeVisible();
		await input.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashSessionsIntegration.multiHost!.submissions)).toMatchObject([{
			host: 'Host A',
			contexts: [{ name: 'Follow-up chat', content: expect.stringContaining('Conversation: Follow-up chat\n') }],
		}]);
	});
});
