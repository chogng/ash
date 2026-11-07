import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import { StorageScope, StorageTarget, type IStorageService } from '../../../../../platform/storage/common/storage.js';
import { getResponseVote, isResponseHelpful, markResponseHelpful, setResponseVote, chatUpvoteAnimationConfiguration } from '../../common/chatResponseFeedback.js';
import { chatTranscriptListItems } from '../../common/model/chatViewModel.js';
import type { Turn, ThreadTranscriptEntry } from '../../../../services/chat/common/chatService.js';

const target = { sessionId: 'feedback-session', threadId: 'feedback-thread', turnId: 'feedback-turn', itemId: 'feedback-item' };

test('helpful annotations use profile state and keep response identities independent', () => {
	const values = new Map<string, string>();
	const writes: unknown[] = [];
	const storage = {
		get: (key: string, scope: StorageScope) => { assert.equal(scope, StorageScope.PROFILE); return values.get(key); },
		store: (key: string, value: string | boolean, scope: StorageScope, destination: StorageTarget) => { writes.push([scope, destination]); values.set(key, String(value)); },
	} as unknown as IStorageService;
	assert.equal(markResponseHelpful(storage, target), true);
	assert.equal(markResponseHelpful(storage, { ...target }), false);
	assert.equal(isResponseHelpful(storage, target), true);
	for (const key of ['sessionId', 'threadId', 'turnId', 'itemId'] as const) assert.equal(isResponseHelpful(storage, { ...target, [key]: 'other' }), false);
	assert.deepEqual(writes, [[StorageScope.PROFILE, StorageTarget.MACHINE]]);
	assert.equal(setResponseVote(storage, target, 'down'), true);
	assert.equal(setResponseVote(storage, target, 'down'), false);
	assert.equal(getResponseVote(storage, target), 'down');
	assert.equal(isResponseHelpful(storage, target), false);
	assert.equal(markResponseHelpful(storage, target), true);
	assert.equal(getResponseVote(storage, target), 'up');
	for (const option of ['off', 'confetti', 'floatingThumbs', 'pulseWave', 'radiantLines']) assert.equal(chatUpvoteAnimationConfiguration.parse(option), option);
	assert.throws(() => chatUpvoteAnimationConfiguration.parse('invalid'));
});

test('only completed Agent replies carry their canonical helpful-feedback identity', () => {
	const entry = { type: 'item', entryId: 'presentation-id', turnId: target.turnId, transient: false, item: { type: 'agentMessage', itemId: target.itemId, text: 'Reply' } } as ThreadTranscriptEntry;
	for (const status of ['inProgress', 'interrupted', 'failed', 'completed'] as const) {
		const turn = { turnId: target.turnId, status, items: [] } as unknown as Turn;
		assert.deepEqual(chatTranscriptListItems([entry], undefined, [turn], target)[0]!.feedbackSource, status === 'completed' ? target : undefined);
	}
});

suite('IDE Chat helpful feedback', () => {
	const browser = useBrowserTests();
	for (const locale of ['en', 'zh-CN']) for (const kind of ['off', 'confetti', 'floatingThumbs', 'pulseWave', 'radiantLines']) {
		test(`${locale} records a local helpful mark and plays ${kind} only for the first successful click`, async () => {
			const { page } = browser;
			await page.goto(`/chatTranscript.html?locale=${locale}&workbench`);
			await page.emulateMedia({ reducedMotion: 'no-preference' });
			await page.evaluate(({ target, kind }) => {
				window.ashChatTranscriptIntegration.setTheme('light');
				window.ashChatTranscriptIntegration.renderItems([{ id: 'helpful-reply', type: 'agentMessage', text: 'Synthetic helpful reply', transient: false, feedbackSource: target }]);
				return window.ashChatTranscriptIntegration.setUpvoteAnimation(kind);
			}, { target, kind });
			const button = page.getByRole('button', { name: locale === 'en' ? 'Helpful' : '有用', exact: true });
			await expect(button).toHaveAttribute('aria-pressed', 'false');
			await button.focus();
			await button.press('Enter');
			await expect(button).toHaveAttribute('aria-pressed', 'true');
			await expect(page.getByRole('status').filter({ hasText: locale === 'en' ? 'Marked helpful in Ash.' : '已在 Ash 中标记为有用。' })).toBeVisible();
			const overlay = page.locator('.ash-click-animation');
			if (kind !== 'off') {
				await expect(overlay).toBeVisible();
				await expect(overlay).toHaveAttribute('aria-hidden', 'true');
				await expect(overlay).toHaveCSS('pointer-events', 'none');
				await overlay.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => { animation.pause(); animation.currentTime = 300; }));
				if (kind === 'floatingThumbs') await expect(overlay.locator('[data-ash-icon-id="thumbsup"]')).toHaveCount(6);
				await page.screenshot({ path: browser.info.outputPath(`${locale}-${kind}.png`) });
				await overlay.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => animation.finish()));
			}
			await expect(overlay).toHaveCount(0);
			await page.evaluate(() => window.ashChatTranscriptIntegration.recreateTranscript());
			await expect(button).toHaveAttribute('aria-pressed', 'true');
			await button.click();
			await expect(overlay).toHaveCount(0);
		});
	}
	for (const theme of ['dark', 'hc', 'hcLight'] as const) {
		test(`Helpful keeps a visible selected state and themed font feedback in ${theme}`, async () => {
			const { page } = browser;
			await page.goto('/chatTranscript.html?workbench');
			await page.emulateMedia({ reducedMotion: 'no-preference' });
			await page.evaluate(({ target, theme }) => {
				window.ashChatTranscriptIntegration.setTheme(theme);
				window.ashChatTranscriptIntegration.renderItems([{ id: 'themed-reply', type: 'agentMessage', text: 'Themed helpful reply', transient: false, feedbackSource: target }]);
			}, { target, theme });
			const button = page.getByRole('button', { name: 'Helpful', exact: true });
			const restingBackground = await button.evaluate(element => getComputedStyle(element).backgroundColor);
			await button.click();
			await expect(button).toHaveAttribute('aria-pressed', 'true');
			const overlay = page.locator('.ash-click-animation');
			await expect(overlay).toBeVisible();
			await overlay.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => { animation.pause(); animation.currentTime = 300; }));
			await page.mouse.move(900, 650);
			assert.notEqual(await button.evaluate(element => getComputedStyle(element).backgroundColor), restingBackground);
			const icon = overlay.locator('[data-ash-icon-id="thumbsup"]').first();
			await expect(icon).toHaveCSS('font-family', '"Ash UI Icons"');
			assert.equal(await icon.evaluate(element => getComputedStyle(element).color), await page.locator('body').evaluate(element => {
				const probe = document.createElement('span');
				probe.style.color = 'var(--ash-focusBorder)';
				element.append(probe);
				const color = getComputedStyle(probe).color;
				probe.remove();
				return color;
			}));
			await page.screenshot({ path: browser.info.outputPath(`${theme}-helpful.png`) });
		});
	}
	test('reduced motion still stores the helpful mark without decorative effects', async () => {
		const { page } = browser;
		await page.goto('/chatTranscript.html?workbench');
		await page.evaluate(async target => {
			await window.ashChatTranscriptIntegration.setReducedMotion(true);
			window.ashChatTranscriptIntegration.renderItems([{ id: 'reduce-reply', type: 'agentMessage', text: 'Reduced motion reply', transient: false, feedbackSource: target }]);
		}, target);
		const button = page.getByRole('button', { name: 'Helpful', exact: true });
		await button.click();
		await expect(button).toHaveAttribute('aria-pressed', 'true');
		await expect(page.locator('.ash-click-animation')).toHaveCount(0);
	});
});
