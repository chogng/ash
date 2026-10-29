import { expect, test } from '@playwright/test';

for (const locale of ['en', 'zh-CN']) {
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
		test(`Voice window reads the original transcript and controls in ${locale} ${theme}`, async ({ page }) => {
			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/agentsVoice.html?connected=1&locale=${locale}&theme=${theme}`);
			const popupPromise = page.waitForEvent('popup');
			await page.getByRole('button', { name: 'Open voice window' }).click();
			const popup = await popupPromise;
			popup.on('pageerror', error => errors.push(error.message));
			const openChat = popup.getByRole('button', {
				name: locale === 'en' ? 'Open Chat' : '打开聊天',
				exact: true,
			});
			await expect(openChat).toBeFocused();
			await expect(popup.getByRole('status')).toContainText('Original Chat');
			await expect.poll(() => page.evaluate(() => window.ashAgentsVoice.owners().active)).toBe(1);
			await page.evaluate(() => window.ashAgentsVoice.update('<script>unsafe()</script>'));
			const transcript = popup.getByRole('region', { name: locale === 'en' ? 'Voice transcript' : '语音转写' });
			await expect(transcript).toContainText('<script>unsafe()</script>');
			await expect(transcript.locator('script')).toHaveCount(0);
			await page.evaluate(() => window.ashAgentsVoice.update('Updated spoken text'));
			await expect(transcript.locator('p')).toHaveCount(1);
			await expect(transcript).toContainText('Updated spoken text');
			await transcript.focus();
			const help = await page.evaluate(() => window.ashAgentsVoice.help());
			expect(help.help).toContain('Tab');
			expect(help.view).toContain('Updated spoken text');
			const style = await transcript.evaluate(element => {
				const style = getComputedStyle(element);
				return {
					color: style.color,
					outline: style.outlineStyle,
					border: style.borderTopStyle,
					overflow: style.overflowY,
				};
			});
			expect(style.color).not.toBe('rgba(0, 0, 0, 0)');
			expect(style.overflow).toBe('auto');
			if (theme.startsWith('hc')) expect(style.border).toBe('solid');
			await popup.getByRole('button', { name: locale === 'en' ? 'Interrupt reply' : '打断回复', exact: true }).press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashAgentsVoice.controls())).toEqual(['interrupt']);
			await popup.getByRole('button', { name: locale === 'en' ? 'Disconnect' : '断开连接', exact: true }).press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashAgentsVoice.controls())).toEqual(['interrupt', 'stop']);
			await expect(popup.getByRole('button', { name: locale === 'en' ? 'Disconnect' : '断开连接', exact: true })).toBeDisabled();
			await expect(openChat).toBeFocused();
			await popup.locator('.ash-agents-voice').screenshot({ path: test.info().outputPath('voice-window.png') });
			await openChat.press('Escape').catch(error => {
				if (!popup.isClosed()) throw error;
			});
			await expect.poll(() => popup.isClosed()).toBe(true);
			await expect(page.getByRole('button', { name: 'Open voice window' })).toBeFocused();
			await expect.poll(() => page.evaluate(() => window.ashAgentsVoice.owners().active)).toBe(0);
			expect(await page.evaluate(() => window.ashAgentsVoice.notifications())).toEqual([]);
			expect(errors).toEqual([]);
		});
	}
}

test('Closing and reopening voice does not let a late acquisition release the new subscription', async ({ page }) => {
	await page.goto('/agentsVoice.html?connected=1&hold=1');
	const firstPopupPromise = page.waitForEvent('popup');
	await page.getByRole('button', { name: 'Open voice window' }).click();
	const first = await firstPopupPromise;
	await expect.poll(() => page.evaluate(() => window.ashAgentsVoice.owners().acquisitions)).toBe(1);
	await first.getByRole('button', { name: 'Close window' }).click();
	await expect.poll(() => first.isClosed()).toBe(true);
	const secondPopupPromise = page.waitForEvent('popup');
	await page.getByRole('button', { name: 'Open voice window' }).click();
	const second = await secondPopupPromise;
	await expect.poll(() => page.evaluate(() => window.ashAgentsVoice.owners().active)).toBe(1);
	await page.evaluate(() => window.ashAgentsVoice.release());
	await expect.poll(() => page.evaluate(() => window.ashAgentsVoice.owners().releases)).toBe(2);
	expect(await page.evaluate(() => window.ashAgentsVoice.owners().active)).toBe(1);
	expect(await page.evaluate(() => window.ashAgentsVoice.controls())).toEqual([]);
	await second.getByRole('button', { name: 'Close window' }).click();
});

test('Voice introduction is profile-owned and opening the window never starts media', async ({ page }) => {
	await page.goto('/agentsVoice.html');
	const firstPopupPromise = page.waitForEvent('popup');
	await page.getByRole('button', { name: 'Open voice window' }).click();
	const first = await firstPopupPromise;
	await first.getByRole('button', { name: 'Got it' }).click();
	await expect(first.locator('.ash-agents-voice-introduction')).toBeHidden();
	await first.getByRole('button', { name: 'Conversations', exact: true }).click();
	await page.getByRole('combobox', { name: 'Conversations' }).fill('Other');
	await page.getByRole('combobox', { name: 'Conversations' }).press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashAgentsVoice.navigations())).toEqual(['second/second-thread']);
	await first.getByRole('button', { name: 'Close window' }).click();
	const secondPopupPromise = page.waitForEvent('popup');
	await page.getByRole('button', { name: 'Open voice window' }).click();
	const second = await secondPopupPromise;
	await expect(second.locator('.ash-agents-voice-introduction')).toBeHidden();
	expect(await page.evaluate(() => window.ashAgentsVoice.controls())).toEqual([]);
	await second.getByRole('button', { name: 'Close window' }).click();
});

test('A transcript revision gap refreshes the canonical snapshot', async ({ page }) => {
	await page.goto('/agentsVoice.html?connected=1');
	const popupPromise = page.waitForEvent('popup');
	await page.getByRole('button', { name: 'Open voice window' }).click();
	const popup = await popupPromise;
	await expect.poll(() => page.evaluate(() => window.ashAgentsVoice.owners().active)).toBe(1);
	await page.evaluate(() => window.ashAgentsVoice.update('Recovered canonical speech', 5));
	await expect(popup.getByRole('region', { name: 'Voice transcript' })).toContainText('Recovered canonical speech');
	await popup.getByRole('button', { name: 'Close window' }).click();
});

for (const locale of ['en', 'zh-CN']) {
	test(`Voice microphone mute and held input release on keyup, pointer cancel and close in ${locale}`, async ({ page }) => {
		await page.goto(`/agentsVoice.html?connected=1&locale=${locale}`);
		const opened = page.waitForEvent('popup');
		await page.getByRole('button', { name: 'Open voice window' }).click();
		const popup = await opened;
		await popup.getByRole('button', { name: locale === 'en' ? 'Mute microphone' : '静音麦克风', exact: true }).click();
		await expect(popup.getByRole('status')).toContainText(locale === 'en' ? 'Microphone muted' : '麦克风已静音');
		const held = popup.getByRole('button', { name: locale === 'en' ? 'Hold to speak' : '按住说话', exact: true });
		await expect(held).toBeDisabled();
		await popup.getByRole('button', { name: locale === 'en' ? 'Unmute microphone' : '取消麦克风静音', exact: true }).click();
		await popup.getByRole('button', { name: locale === 'en' ? 'Use push to talk' : '使用按住说话', exact: true }).click();
		await expect(held).toBeEnabled();
		await held.focus();
		await popup.keyboard.down('Space');
		await expect(held).toHaveAttribute('aria-pressed', 'true');
		await popup.keyboard.up('Space');
		await expect(held).toHaveAttribute('aria-pressed', 'false');
		// Browser-generated pointer events establish capture; cancellation must retire the same hold.
		const bounds = await held.boundingBox();
		if (!bounds) throw new Error('Missing held input control');
		await popup.mouse.move(bounds.x + 4, bounds.y + 4);
		await popup.mouse.down();
		await expect(held).toHaveAttribute('aria-pressed', 'true');
		await held.dispatchEvent('pointercancel');
		await expect(held).toHaveAttribute('aria-pressed', 'false');
		await popup.mouse.up();
		await held.focus();
		await popup.keyboard.down('Enter');
		await expect(held).toHaveAttribute('aria-pressed', 'true');
		await page.evaluate(() => window.ashAgentsVoice.close());
		await expect.poll(() => popup.isClosed()).toBe(true);
		await expect.poll(() => page.evaluate(() => window.ashAgentsVoice.controls())).toEqual(['mute:true', 'mute:false', 'mode:pushToTalk', 'hold', 'release', 'hold', 'release', 'hold', 'release']);
		expect(await page.evaluate(() => window.ashAgentsVoice.notifications())).toEqual([]);
	});
}

test('Starting voice in the floating window uses the original Chat navigation controller', async ({ page }) => {
	await page.goto('/agentsVoice.html');
	const opened = page.waitForEvent('popup');
	await page.getByRole('button', { name: 'Open voice window' }).click();
	const popup = await opened;
	await popup.getByRole('button', { name: 'Start voice', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashAgentsVoice.controls())).toEqual(['startFromChat']);
	expect(await page.evaluate(() => window.ashAgentsVoice.notifications())).toEqual([]);
	await popup.close();
});
