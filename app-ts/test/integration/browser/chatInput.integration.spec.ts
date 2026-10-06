import { expect, test } from '@playwright/test';

for (const locale of ['en', 'zh-CN']) {
	test(`mode menu fits its contents and retains keyboard selection in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const trigger = page.locator('[data-action-id="ash.chat.input.mode"] button');
		await trigger.press('ArrowDown');
		const menu = page.locator('.ash-chat-input-mode-menu');
		await expect(menu.getByRole('menuitemradio')).toHaveCount(5);
		const geometry = await menu.evaluate(element => ({
			width: element.getBoundingClientRect().width,
			overflow: element.scrollWidth - element.clientWidth,
		}));
		expect(geometry.width).toBeGreaterThanOrEqual(100);
		expect(geometry.width).toBeLessThan(240);
		expect(geometry.overflow).toBe(0);
		await expect(menu.getByRole('menuitemradio').first()).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(menu.getByRole('menuitemradio').nth(1)).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(menu).toHaveCount(0);
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`approval targets and keyboard decisions use ${locale}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(locale === 'en' ? '/chatInput.html' : `/chatInput.html?locale=${locale}`);
		expect(errors).toEqual([]);
		const chinese = locale === 'zh-CN';
		const targets = page.getByRole('list', { name: chinese ? '请求的操作与目标' : 'Requested actions and targets' });
		await expect(targets.getByRole('listitem')).toHaveCount(10);
		await expect(targets.locator('code')).toHaveText(['/workspace/file with spaces.ts', String.raw`C:\Users\name\file.ts`, String.raw`\\server\share\file.ts`, 'pnpm test <script>', 'https://api.example.test', 'provider-key', 'issue:42', 'git.user.email', 'current window', `/workspace/${'a'.repeat(160)}.ts`]);
		await expect(targets.getByRole('listitem').first()).toHaveText(chinese ? '读取文件: /workspace/file with spaces.ts' : 'Read file: /workspace/file with spaces.ts');
		const decline = page.getByRole('button', { name: chinese ? '拒绝' : 'Decline', exact: true });
		const approve = page.getByRole('button', { name: chinese ? '批准一次' : 'Approve once', exact: true });
		await decline.focus();
		await page.evaluate(() => window.ashChatInputIntegration.refresh());
		await expect(decline).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('status', { name: 'Decision' })).toHaveText('decline');
		await page.keyboard.press('Tab');
		await expect(approve).toBeFocused();
		await page.keyboard.press('Space');
		await expect(page.getByRole('status', { name: 'Decision' })).toHaveText('approveOnce');
		await page.setViewportSize({ width: 320, height: 600 });
		expect(await targets.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
		expect(errors).toEqual([]);
	});
}


test('question controls resolve the editor background variable for each palette', async ({ page }) => {
	await page.goto('/chatInput.html');
	await page.evaluate(() => window.ashChatInputIntegration.showQuestions());
	for (const background of ['rgb(30, 30, 30)', 'rgb(255, 255, 255)', 'rgb(0, 0, 0)']) {
		await page.locator('main').evaluate((element, value) => element.style.setProperty('--ash-editor-background', value), background);
		await expect(page.getByRole('textbox', { name: 'Your answer' })).toHaveCSS('background-color', background);
		await expect(page.getByRole('combobox', { name: 'Your choice' })).toHaveCSS('background-color', background);
	}
});

for (const locale of ['en', 'zh-CN']) {
	test(`model picker describes acceleration and retains keyboard state in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const trigger = page.locator('[data-action-id="ash.chat.input.model"] button');
		await trigger.press('ArrowDown');
		const picker = page.locator('.ash-chat-model-picker');
		const search = picker.getByRole('combobox');
		await expect(picker).toContainText('A model for everyday tasks');
		await search.press('ArrowRight');
		const card = picker.locator('.ash-chat-model-card');
		const fast = card.getByRole('switch', { name: locale === 'zh-CN' ? '快速' : 'Fast', exact: true });
		const description = locale === 'zh-CN' ? '响应更快，用量增加' : 'Faster responses, increased usage';
		await expect(card.locator('.ash-chat-model-card-description')).toHaveText(description);
		await expect(fast).toHaveAttribute('aria-description', description);
		await expect(fast).toBeFocused();
		await fast.press('Space');
		await expect(fast).toBeChecked();
		await expect(fast).toBeFocused();
		await fast.press('Space');
		await expect(fast).not.toBeChecked();
		await page.setViewportSize({ width: 320, height: 600 });
		const explanation = card.locator('.ash-chat-model-card-description');
		expect(await explanation.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
		await fast.press('Escape');
		await expect(picker).toHaveCount(0);
		await expect(trigger).toBeFocused();
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`thinking levels retain catalog descriptions and keyboard selection in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const trigger = page.locator('[data-action-id="ash.chat.input.effort"] button');
		const lowCopy = locale === 'zh-CN' ? '较轻的推理，更快的响应' : 'Fast responses with lighter reasoning';
		const highCopy = locale === 'zh-CN' ? '为复杂问题提供更深入的推理' : 'Greater reasoning depth for complex problems';
		await expect(trigger).toHaveAttribute('aria-description', lowCopy);
		await trigger.press('ArrowDown');
		const menu = page.locator('.ash-chat-model-configuration-menu');
		const low = menu.locator('[data-action-id="ash.chat.input.effort.low"] button');
		const high = menu.locator('[data-action-id="ash.chat.input.effort.high"] button');
		await expect(low).toBeFocused();
		await expect(low).toHaveAttribute('aria-description', `${lowCopy} ${locale === 'zh-CN' ? '默认' : 'Default'}`);
		await page.keyboard.press('ArrowDown');
		await expect(high).toBeFocused();
		await expect(high).toHaveAttribute('aria-description', highCopy);
		await page.keyboard.press('Enter');
		await expect(menu).toHaveCount(0);
		await expect(trigger).toBeFocused();
		await expect(trigger).toHaveAttribute('aria-description', highCopy);
	});
}
