import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../../test/unit/browser/context.js';
import type { } from '../../../../../../../../test/fixtures/browser/chatInput.page.js';

suite('Chat Agent hover', () => {
	const browser = useBrowserTests();
	const agent = { name: 'Reviewer', description: 'Review the current change.\nKeep the draft intact.', sourceId: 'internal-directory-id' };

	for (const locale of ['en', 'zh-CN']) for (const theme of ['light', 'dark', 'hcLight', 'hcDark']) {
		test(`the selected Agent is readable by pointer, keyboard and accessible view in ${locale} ${theme}`, async () => {
			const { page } = browser;
			await page.goto(`/chatInput.html?inlineCode&locale=${locale}&theme=${theme}`);
			await page.evaluate(agent => {
				window.ashChatInputIntegration.setAgent(agent);
				window.ashChatInputIntegration.appendToDraft('Unsent draft');
			}, agent);
			const picker = page.locator('[data-action-id="ash.chat.input.mode"] button');
			await expect(picker).toContainText(agent.name);
			await picker.hover();
			const card = page.locator('.ash-hover .ash-chat-agent-hover');
			await expect(card).toBeVisible();
			await expect(card.getByRole('heading')).toHaveText(agent.name);
			await expect(card).toContainText(agent.description);
			await expect(card).not.toContainText(agent.sourceId);
			await picker.focus();
			await page.evaluate(() => window.ashChatInputIntegration.showAgentHover());
			await expect(page.locator('.ash-hover')).toBeFocused();
			const accessible = await page.evaluate(() => window.ashChatInputIntegration.agentHoverAccessibility());
			assert.ok(accessible.content?.includes(agent.description), JSON.stringify(accessible));
			assert.ok(!accessible.content?.includes(agent.sourceId));
			assert.ok(accessible.help?.includes('Escape'));
			const style = await card.evaluate(element => ({
				color: getComputedStyle(element).color,
				width: element.getBoundingClientRect().width,
				overflow: element.scrollWidth > element.clientWidth + 1,
			}));
			assert.notEqual(style.color, 'rgba(0, 0, 0, 0)');
			assert.ok(style.width > 0);
			assert.equal(style.overflow, false);
			if (locale === 'en' && theme === 'light') {
				await page.screenshot({ path: browser.info.outputPath('agent-hover.png') });
			}
			await page.keyboard.press('Escape');
			await expect(card).toHaveCount(0);
			await expect(picker).toBeFocused();
			assert.equal(await page.evaluate(() => window.ashChatInputIntegration.dropState().text), 'Unsent draft');
			await expect(page.getByLabel('Submission', { exact: true })).toBeEmpty();
		});
	}

	test('changing Agent, switching mode and disposing the input retire the old hover', async () => {
		const { page } = browser;
		await page.goto('/chatInput.html?inlineCode');
		await page.evaluate(agent => window.ashChatInputIntegration.setAgent(agent), agent);
		const picker = page.locator('[data-action-id="ash.chat.input.mode"] button');
		await picker.hover();
		await expect(page.locator('.ash-chat-agent-hover')).toContainText('Reviewer');
		await page.evaluate(() => window.ashChatInputIntegration.setAgent({ name: 'Writer', description: '<img src=x onerror=alert(1)>', sourceId: 'user' }));
		await expect(page.locator('.ash-chat-agent-hover')).toHaveCount(0);
		await picker.focus();
		await page.evaluate(() => window.ashChatInputIntegration.showAgentHover());
		await expect(page.locator('.ash-chat-agent-hover')).toContainText('<img src=x onerror=alert(1)>');
		await expect(page.locator('.ash-chat-agent-hover img')).toHaveCount(0);
		await page.evaluate(() => window.ashChatInputIntegration.setAgent(undefined, 'ask'));
		await expect(page.locator('.ash-chat-agent-hover')).toHaveCount(0);
		await page.evaluate(agent => window.ashChatInputIntegration.setAgent(agent), agent);
		await picker.focus();
		await page.evaluate(() => window.ashChatInputIntegration.showAgentHover());
		await expect(page.locator('.ash-chat-agent-hover')).toBeVisible();
		await page.evaluate(() => window.ashChatInputIntegration.setVisible(false));
		await expect(page.locator('.ash-chat-agent-hover')).toHaveCount(0);
		await page.evaluate(() => window.ashChatInputIntegration.setVisible(true));
		await picker.focus();
		await page.evaluate(() => window.ashChatInputIntegration.showAgentHover());
		await expect(page.locator('.ash-chat-agent-hover')).toBeVisible();
		await page.evaluate(() => window.ashChatInputIntegration.dispose());
		await expect(page.locator('.ash-hover')).toHaveCount(0);
	});

	test('long Agent metadata wraps inside a narrow hover', async () => {
		const { page } = browser;
		await page.setViewportSize({ width: 400, height: 640 });
		await page.goto('/chatInput.html?inlineCode');
		await page.locator('main').evaluate(element => { element.style.width = '320px'; });
		await page.evaluate(() => window.ashChatInputIntegration.setAgent({
			name: 'LongAgentName'.repeat(8), description: '描述'.repeat(120), sourceId: 'internal-directory-id',
		}));
		await page.locator('[data-action-id="ash.chat.input.mode"] button').focus();
		await page.evaluate(() => window.ashChatInputIntegration.showAgentHover());
		const card = page.locator('.ash-chat-agent-hover');
		await expect(card).toBeVisible();
		const bounds = await card.evaluate(element => ({
			left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
			overflow: element.scrollWidth > element.clientWidth + 1,
		}));
		assert.ok(bounds.left >= 0 && bounds.right <= 400, JSON.stringify(bounds));
		assert.equal(bounds.overflow, false);
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`the input Agent reference uses the same card and retires with its selection in ${locale}`, async () => {
			const { page } = browser;
			await page.goto(`/chatInput.html?inlineCode&locale=${locale}`);
			await page.evaluate(agent => window.ashChatInputIntegration.setAgent(agent), agent);
			const input = page.getByRole('textbox', { name: 'Chat message', exact: true });
			await input.pressSequentially('@Reviewer inspect this change');
			await input.press('Escape');
			await input.press('Home');
			await input.press('ArrowRight');
			await input.press('ControlOrMeta+k');
			await input.press('ControlOrMeta+i');
			const card = page.locator('.stanza-editor-hover .ash-chat-agent-hover');
			await expect(card).toBeFocused();
			await expect(card).toContainText(agent.description);
			const accessible = await page.evaluate(() => window.ashChatInputIntegration.contextAccessibility());
			assert.ok(accessible.content?.includes(agent.description), JSON.stringify(accessible));
			assert.ok(!accessible.content?.includes(agent.sourceId));
			assert.ok(accessible.help?.includes(locale === 'zh-CN' ? '消息开头的 @名称' : 'a leading @name'));
			await page.keyboard.press('Escape');
			await expect(card).toHaveCount(0);
			await expect(input).toBeFocused();
			assert.equal(await page.evaluate(() => window.ashChatInputIntegration.dropState().text), '@Reviewer inspect this change');
			await page.locator('.stanza-editor-line-text').first().hover({ position: { x: 20, y: 8 } });
			await expect(card).toContainText(agent.description);
			await page.evaluate(() => window.ashChatInputIntegration.setAgent({ name: 'Writer', description: 'A different Agent', sourceId: 'other-source' }));
			await expect(card).toHaveCount(0);
			await expect(page.getByLabel('Submission', { exact: true })).toBeEmpty();
		});
	}
});
