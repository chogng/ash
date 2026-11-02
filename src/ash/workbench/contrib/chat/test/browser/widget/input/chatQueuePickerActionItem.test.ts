import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../../../test/unit/browser/context.js';
import type { } from '../../../../../../../../../test/fixtures/browser/chatInput.page.js';

suite('Chat follow-up picker', () => {
	const browserTests = useBrowserTests();

	for (const compact of [false, true]) for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
		test(`keyboard menu, focus, Chinese descriptions and queue submission (${compact ? 'compact' : 'regular'}, ${theme})`, async () => {
			const { page } = browserTests;
			await page.goto(`/chatInput.html?inlineCode&locale=zh-CN&theme=${theme}${compact ? '&compact' : ''}`);
			await page.evaluate(() => {
				window.ashChatInputIntegration.showModels();
				window.ashChatInputIntegration.setRunning(true);
			});
			const editor = page.locator('.ash-chat-input-container .stanza-editor-input');
			await editor.pressSequentially('Queued follow-up');
			const picker = page.getByRole('group', { name: '发送追加消息' });
			const primary = picker.getByRole('button', { name: '用消息引导', exact: true });
			const more = picker.getByRole('button', { name: '更多发送选项' });
			await expect(primary).toBeVisible();
			await primary.focus();
			expect(await primary.evaluate(button => getComputedStyle(button).outlineStyle)).not.toBe('none');
			await primary.press('ArrowRight');
			await expect(more).toBeFocused();
			await more.press('ArrowLeft');
			await expect(primary).toBeFocused();
			await primary.press('ArrowRight');
			await more.press('ArrowDown');
			await expect(more).toHaveAttribute('aria-expanded', 'true');
			const menu = page.locator('.ash-action-widget');
			await expect(menu.getByRole('menuitemradio', { name: '用消息引导', exact: true })).toHaveAttribute('aria-checked', 'true');
			await expect(menu).toContainText('等当前任务完成后发送，不中断当前任务。');
			const bounds = await picker.boundingBox();
			expect(bounds!.width).toBeGreaterThan(35);
			await page.keyboard.press('Escape');
			await expect(more).toHaveAttribute('aria-expanded', 'false');
			await expect(more).toBeFocused();
			await more.press('Enter');
			const menuBounds = await menu.boundingBox();
			expect(menuBounds!.x).toBeGreaterThanOrEqual(0);
			expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(1280);
			await page.screenshot({ path: browserTests.info.outputPath(`queue-picker-${compact ? 'compact' : 'regular'}-${theme}.png`) });
			await menu.getByRole('menuitemradio', { name: '加入队列', exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.queueState())).toEqual([{ kind: 'send', text: 'Queued follow-up', queue: 'queued' }]);
			await expect(picker).toHaveCount(0);
			await editor.pressSequentially('Draft for disposal');
			await page.getByRole('button', { name: '更多发送选项' }).click();
			await page.evaluate(() => window.ashChatInputIntegration.dispose());
			await expect(menu).toHaveCount(0);
		});
	}

	for (const locale of ['en', 'zh-CN']) for (const surface of ['code', 'cowork']) test(`Side Chat menu and registered /btw submit the same question in ${locale} ${surface}`, async () => {
		const { page } = browserTests;
		await page.goto(`/chatInput.html?inlineCode&sideChat&hostInputCompletions&locale=${locale}&surface=${surface}`);
		await page.evaluate(() => { window.ashChatInputIntegration.showModels(); window.ashChatInputIntegration.setRunning(true); });
		const editor = page.locator('.ash-chat-input-container .stanza-editor-input');
		await editor.pressSequentially('Menu question');
		await page.getByRole('button', { name: locale === 'en' ? 'More Send Options' : '更多发送选项' }).click();
		const side = page.getByRole('menuitem', { name: locale === 'en' ? 'Ask in Side Chat' : '在旁支对话中提问', exact: true });
		await expect(side).toBeVisible();
		await expect(page.locator('.ash-action-widget')).toContainText(locale === 'en' ? 'Ask a side question without adding it to this conversation' : '另开旁支提问，不将问题加入当前对话');
		await page.screenshot({ path: browserTests.info.outputPath(`side-chat-menu-${locale}.png`) });
		await side.click();
		await editor.pressSequentially('/bt');
		await expect(page.getByRole('option').filter({ hasText: '/btw' })).toBeVisible();
		await editor.press('Tab');
		await editor.pressSequentially('Slash question');
		await editor.press('Escape');
		await editor.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.queueState())).toEqual([{ kind: 'sideChat', query: 'Menu question' }, { kind: 'sideChat', query: 'Slash question' }]);
	});

	test('configuration, Alt, Enter and stop choices reach the composer', async () => {
		const { page } = browserTests;
		await page.goto('/chatInput.html?inlineCode');
		await page.evaluate(async () => {
			window.ashChatInputIntegration.showModels();
			window.ashChatInputIntegration.setRunning(true);
			await window.ashChatInputIntegration.setQueueDefault('queue');
		});
		const editor = page.locator('.ash-chat-input-container .stanza-editor-input');
		await editor.pressSequentially('Default queue');
		await page.getByRole('button', { name: 'Add to Queue', exact: true }).click();
		await editor.pressSequentially('Alt steer');
		await page.keyboard.down('Alt');
		await page.getByRole('button', { name: 'Steer with Message', exact: true }).click();
		await page.keyboard.up('Alt');
		await editor.pressSequentially('Enter queue');
		await editor.press('Enter');
		await editor.pressSequentially('Alt Enter steer');
		await editor.press('Alt+Enter');
		await editor.pressSequentially('Stop then send');
		await page.getByRole('button', { name: 'More Send Options' }).click();
		await page.getByRole('menuitem', { name: 'Stop and Send', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.queueState())).toEqual([
			{ kind: 'send', text: 'Default queue', queue: 'queued' },
			{ kind: 'send', text: 'Alt steer', queue: 'steering' },
			{ kind: 'send', text: 'Enter queue', queue: 'queued' },
			{ kind: 'send', text: 'Alt Enter steer', queue: 'steering' },
			{ kind: 'interrupt' }, { kind: 'send', text: 'Stop then send' },
		]);
		await editor.pressSequentially('Changed default');
		await page.evaluate(() => window.ashChatInputIntegration.setQueueDefault('steer'));
		await expect(page.getByRole('button', { name: 'Steer with Message', exact: true })).toBeVisible();
		await page.evaluate(() => window.ashChatInputIntegration.setFooterPhase('loading'));
		await expect(page.getByRole('button', { name: 'More Send Options' })).toBeDisabled();
	});

	test('hiding and replacing a conversation dismiss old choices and keep the retained picker usable', async () => {
		const { page } = browserTests;
		await page.goto('/chatInput.html?inlineCode');
		await page.evaluate(() => {
			window.ashChatInputIntegration.showModels();
			window.ashChatInputIntegration.setRunning(true);
		});
		const editor = page.locator('.ash-chat-input-container .stanza-editor-input');
		const more = page.getByRole('button', { name: 'More Send Options' });
		const menu = page.locator('.ash-action-widget');
		await editor.pressSequentially('Retained draft');
		await more.click();
		await page.evaluate(() => window.ashChatInputIntegration.setVisible(false));
		await expect(menu).toHaveCount(0);
		await page.evaluate(() => window.ashChatInputIntegration.setVisible(true));
		await page.getByRole('button', { name: 'Steer with Message', exact: true }).click();
		await editor.pressSequentially('Old conversation draft');
		await more.click();
		await page.evaluate(() => window.ashChatInputIntegration.replaceDropDraft());
		await expect(menu).toHaveCount(0);
		await page.getByRole('button', { name: 'Steer with Message', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.queueState())).toEqual([
			{ kind: 'send', text: 'Retained draft', queue: 'steering' },
			{ kind: 'send', text: 'Replacement draft', queue: 'steering' },
		]);
	});
});
