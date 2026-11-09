import { expect, type Locator } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../../../test/unit/browser/context.js';
import type { } from '../../../../../../../../../test/fixtures/browser/chatInput.page.js';

/** Measure the rendered surfaces, including margins inside an onboarding host or tip slot. */
async function expectGap(above: Locator, below: Locator): Promise<void> {
	const upper = await above.boundingBox();
	const lower = await below.boundingBox();
	expect(upper).not.toBeNull();
	expect(lower).not.toBeNull();
	expect(lower!.y - upper!.y - upper!.height).toBeCloseTo(8, 0);
}

suite('Chat input stack browser layout', () => {
	const browserTests = useBrowserTests();

	for (const compact of [false, true]) for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
		test(`notices and Changes share spacing through arbitration (${compact ? 'compact' : 'regular'}, ${theme}, zh-CN)`, async () => {
			const { page } = browserTests;
			await page.goto(`/chatInput.html?inlineCode&notices&locale=zh-CN&theme=${theme}${compact ? '&compact' : ''}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const stack = page.locator('.ash-chat-input-stack');
			const input = stack.locator('.ash-chat-input-container');
			const editor = input.locator('.stanza-editor-input');
			const tip = stack.locator('.ash-chat-input-tip');
			const changes = stack.locator('.ash-chat-input-changes');
			const notification = stack.locator('.ash-chat-input-notice-notification');
			const introduction = stack.locator('.ash-agents-voice-introduction');
			await expect(tip).toBeVisible();
			await expectGap(tip, input);
			await editor.pressSequentially('Retained draft');
			await page.evaluate(() => window.ashChatInputIntegration.setChanges({ files: 2, additions: 3, deletions: 1 }));
			await expectGap(tip, changes);
			await expectGap(changes, input);

			await page.evaluate(() => window.ashChatInputIntegration.showVoiceIntroduction());
			await expect(introduction).toBeVisible();
			await expect.poll(() => introduction.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
			await expect(tip).toBeHidden();
			await expectGap(introduction, changes);
			await page.evaluate(() => window.ashChatInputIntegration.setFooterPhase('error', '连接中断'));
			await expect(notification).toBeVisible();
			await expect(notification).toBeFocused();
			await expect(introduction).toBeHidden();
			await expectGap(notification, changes);
			await expectGap(changes, input);
			await expect(input).toHaveCSS('border-top-left-radius', '8px');
			await expect(notification).toBeFocused();
			await notification.press('Escape');
			await expect(editor).toBeFocused();
			await expect(stack).toHaveClass(/ash-chat-input-stack-input-focused/);
			await notification.focus();
			await expect(stack).not.toHaveClass(/ash-chat-input-stack-input-focused/);

			await page.evaluate(() => window.ashChatInputIntegration.setFooterPhase('ready'));
			await expectGap(introduction, changes);
			await page.evaluate(() => window.ashChatInputIntegration.toggleNoticeFocus());
			await introduction.press('Escape');
			await expect(introduction).toHaveCount(0);
			await expectGap(tip, changes);
			await changes.getByRole('button').focus();
			await page.evaluate(() => window.ashChatInputIntegration.setChanges(undefined));
			await expect(editor).toBeFocused();
			await expect(changes).toBeHidden();
			await expectGap(tip, input);
			expect(await page.evaluate(() => window.ashChatInputIntegration.dropState().text)).toBe('Retained draft');
			await stack.screenshot({ path: browserTests.info.outputPath(`input-stack-${compact ? 'compact' : 'regular'}-${theme}.png`) });
			await page.evaluate(() => window.ashChatInputIntegration.dispose());
			await expect(stack).toHaveCount(0);
		});
	}
});
