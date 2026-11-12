import { suite, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../../test/unit/browser/context.js';
import type { } from '../../../../../../../../test/fixtures/browser/chatTranscript.page.js';

suite('Chat widget external links', () => {
	const browserTests = useBrowserTests();

	test('a rendered conversation link preserves its source window through the shared opener', async () => {
		const { page } = browserTests;
		await page.goto('/chatTranscript.html?recordChatLinks');
		await page.evaluate(() => {
			const chat = window.ashChatTranscriptIntegration;
			chat.showChatApp();
			chat.appendChatItem({ id: 'preview-link', type: 'agentMessage', text: '[Preview](https://example.test/preview)', transient: false });
		});
		await page.locator('#app-chat [data-item-id="preview-link"]').getByRole('link', { name: 'Preview', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashChatTranscriptIntegration.openedAppLinks())).toEqual([{
			uri: 'https://example.test/preview',
			options: { openExternal: true, fromUserGesture: true, allowContributedOpeners: true, sourceWindowId: 1 },
		}]);
	});
});
