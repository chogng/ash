import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('model picker browser component', () => {
	const browserTests = useBrowserTests();

	for (const locale of ['en', 'zh-CN']) {
		test(`provider icons follow the product theme and shared details open documentation in ${locale}`, async () => {
			const { page } = browserTests;
			const chinese = locale === 'zh-CN';
			await page.goto(`/chatInput.html?modelSet=providers&locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const trigger = page.locator('.ash-chat-input-model-action');
			const triggerIcon = trigger.locator('.ash-icon');
			await expect(triggerIcon).toHaveAttribute('data-ash-icon-id', 'chat-model-provider-openai');
			await expect(triggerIcon).toHaveAttribute('aria-hidden', 'true');
			await triggerIcon.evaluate(element => element.setAttribute('data-retained-icon', 'true'));
			const previousGlyph = await triggerIcon.getAttribute('data-ash-icon-character');
			await trigger.press('ArrowDown');
			const picker = page.locator('.ash-chat-model-picker');
			await expect(picker.getByRole('tab', { includeHidden: true })).toHaveCount(0);
			await expect(picker.getByRole('tabpanel')).toHaveCount(0);
			await picker.getByRole('button', { name: chinese ? 'Test Model 详情' : 'Test Model details', exact: true }).click();
			const card = picker.getByRole('region', { name: 'Test Model', exact: true });
			const cardIcon = card.locator('h3 .ash-icon');
			await expect(cardIcon).toHaveAttribute('data-ash-icon-id', 'chat-model-provider-openai');
			await page.evaluate(() => window.ashChatInputIntegration.setProviderIconTheme());
			await expect(triggerIcon).not.toHaveAttribute('data-ash-icon-character', previousGlyph!);
			await expect(triggerIcon).toHaveAttribute('data-retained-icon', 'true');
			const themedGlyph = await triggerIcon.getAttribute('data-ash-icon-character');
			await expect(cardIcon).toHaveAttribute('data-ash-icon-character', themedGlyph!);
			await expect(card).toBeFocused();
			await page.evaluate(() => window.ashChatInputIntegration.setDescription('**Provider** description. [Documentation](https://example.test/model)'));
			await expect(card.locator('strong')).toHaveText('Provider');
			await expect(card).toHaveAttribute('aria-description', 'Provider description. Documentation');
			await card.getByRole('link', { name: 'Documentation', exact: true }).focus();
			await page.keyboard.press('Enter');
			await expect(page.getByLabel('Opened sources')).toHaveText(JSON.stringify([{ resource: 'https://example.test/model', options: { allowCommands: false, fromUserGesture: true } }]));
			await expect(picker).toBeVisible();
			await card.press('Alt+ArrowLeft');
			await picker.getByRole('menuitemradio', { name: 'Test Model', exact: true }).hover();
			const preview = picker.locator('.ash-chat-model-picker-details-menu');
			await expect(preview).toBeVisible();
			await expect(preview.locator('.ash-chat-model-card-context')).toHaveText(chinese ? '最大上下文：872K' : 'Max context: 872K');
			await preview.getByRole('link', { name: 'Documentation', exact: true }).click();
			await expect(page.getByLabel('Opened sources')).toHaveText(JSON.stringify(Array.from({ length: 2 }, () => ({ resource: 'https://example.test/model', options: { allowCommands: false, fromUserGesture: true } }))));
			await page.keyboard.press('Escape');
			await expect(trigger).toBeFocused();
		});

		test(`a provider becoming available refreshes its welcome, model list and Auto controls in ${locale}`, async () => {
			const { page } = browserTests;
			const chinese = locale === 'zh-CN';
			await page.goto(`/chatInput.html?modelSet=providers&unavailableProvider&locale=${locale}`);
			await page.evaluate(() => {
				window.ashChatInputIntegration.showModels();
				window.ashChatInputIntegration.setModelsAvailable(false);
			});
			const trigger = page.locator('.ash-chat-input-model-action');
			await trigger.press('ArrowDown');
			const picker = page.locator('.ash-chat-model-picker');
			const automatic = picker.getByRole('switch', { name: chinese ? '自动' : 'Auto', exact: true });
			await expect(automatic).toBeHidden();
			const welcome = picker.locator('.ash-chat-model-picker-empty');
			await expect(welcome.getByRole('button')).toBeFocused();
			await page.evaluate(() => window.ashChatInputIntegration.restoreProviderModels());
			await expect(welcome).toBeHidden();
			await expect(picker.getByRole('combobox')).toBeVisible();
			await expect(picker.getByRole('combobox')).toBeFocused();
			await expect(automatic).toBeVisible();
			await expect(picker.getByRole('menuitem', { name: chinese ? '添加模型' : 'Add Models', exact: true })).toBeVisible();
			const model = picker.getByRole('menuitemradio', { name: 'Custom fixture', exact: true });
			await expect(model).toBeVisible();
			await model.focus();
			await model.press('Enter');
			await expect(trigger).toHaveText('Custom fixture');
			await expect(trigger).toBeFocused();
		});

		test(`search covers enabled models across providers and management preserves selection in ${locale}`, async () => {
			const { page } = browserTests;
			const chinese = locale === 'zh-CN';
			await page.goto(`/chatInput.html?modelSet=providers&unavailableProvider&locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const before = await page.evaluate(() => window.ashChatInputIntegration.modelState());
			const trigger = page.locator('.ash-chat-input-model-action');
			await trigger.press('ArrowDown');
			const picker = page.locator('.ash-chat-model-picker');
			await expect(picker.getByRole('tab', { includeHidden: true })).toHaveCount(0);
			await expect(picker.getByRole('menuitemradio')).toHaveCount(5);
			for (const name of ['Test Model', 'Claude fixture', 'Gemini fixture', 'DeepSeek fixture', 'Qwen fixture']) {
				await expect(picker.getByRole('menuitemradio', { name, exact: true })).toBeVisible();
			}
			const search = picker.getByRole('combobox');
			await expect(search).toBeFocused();
			await search.fill('fixture');
			await expect(picker.getByRole('menuitemradio')).toHaveText(['Claude fixture', 'Gemini fixture', 'DeepSeek fixture', 'Qwen fixture']);
			await search.fill('Claude');
			await expect(picker.getByRole('menuitemradio')).toHaveText(['Claude fixture']);
			await search.press('Enter');
			await expect(trigger).toHaveText('Claude fixture');
			await expect(trigger).toBeFocused();
			await trigger.press('ArrowDown');
			await expect(picker.getByRole('menuitemradio', { name: 'Claude fixture', exact: true })).toHaveAttribute('aria-checked', 'true');
			await picker.getByRole('menuitem', { name: chinese ? '添加模型' : 'Add Models', exact: true }).click();
			await expect(picker).toHaveCount(0);
			await expect(page.getByRole('status', { name: 'Opened sources', exact: true })).toHaveText(JSON.stringify([{ command: 'workbench.action.chat.manage' }]));
			expect(await page.evaluate(() => window.ashChatInputIntegration.modelState())).toMatchObject({ ...(before as Record<string, unknown>), selectedModel: { provider: 'anthropic', model: 'claude-fixture' } });
		});

		test(`the unified list retains search and configures the chosen model in ${locale}`, async () => {
			const { page } = browserTests;
			const chinese = locale === 'zh-CN';
			await page.goto(`/chatInput.html?modelSet=providers&initialProvider=anthropic&locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const trigger = page.locator('.ash-chat-input-model-action');
			await trigger.press('ArrowDown');
			const picker = page.getByRole('dialog', { name: chinese ? '选择聊天模型' : 'Choose a chat model', exact: true });
			await expect(picker.getByRole('tab', { includeHidden: true })).toHaveCount(0);
			await expect(picker.getByRole('menuitemradio')).toHaveCount(6);
			await expect(picker.getByRole('menuitemradio', { name: 'Claude fixture', exact: true })).toHaveAttribute('aria-checked', 'true');
			const geometry = await picker.locator('.ash-action-widget-action').first().evaluate(row => {
				const primary = row.firstElementChild!.getBoundingClientRect();
				const details = row.lastElementChild!.getBoundingClientRect();
				return { aligned: primary.top === details.top, separate: primary.right <= details.left, height: row.getBoundingClientRect().height };
			});
			expect(geometry).toEqual({ aligned: true, separate: true, height: 22 });
			const search = picker.getByRole('combobox');
			await search.fill('fixture');
			await expect(picker.getByRole('menuitemradio')).toHaveCount(5);
			const before = await page.evaluate(() => window.ashChatInputIntegration.modelState());
			await picker.getByRole('button', { name: chinese ? 'Custom fixture 详情' : 'Custom fixture details', exact: true }).click();
			const card = picker.getByRole('region', { name: 'Custom fixture', exact: true });
			await expect(card).toBeFocused();
			expect(await page.evaluate(() => window.ashChatInputIntegration.modelState())).toEqual(before);
			const high = card.getByRole('radio', { name: chinese ? '高' : 'High', exact: true });
			await high.focus();
			await high.press('Space');
			await expect(high).toBeChecked();
			expect(await page.evaluate(() => window.ashChatInputIntegration.modelState())).toMatchObject({
				selectedModel: { provider: 'private-endpoint', model: 'custom-fixture' }, selectedReasoningEffort: 'high',
			});
			const expanded = card.getByRole('radio', { name: '872K', exact: true });
			await expanded.focus();
			await expanded.press('Space');
			await expect(expanded).toBeChecked();
			await expect(high).toBeChecked();
			expect(await page.evaluate(() => window.ashChatInputIntegration.modelState())).toMatchObject({
				preferenceWrites: [{ model: { provider: 'private-endpoint', model: 'custom-fixture' }, update: { longContext: true } }],
			});
			await card.press('Alt+ArrowLeft');
			await expect(search).toHaveValue('fixture');
			await expect(picker.getByRole('tab', { includeHidden: true })).toHaveCount(0);
			await picker.getByRole('menuitemradio', { name: 'Custom fixture', exact: true }).focus();
			await page.keyboard.press('Enter');
			await expect(picker).toHaveCount(0);
			await expect(trigger).toBeFocused();
			await trigger.press('ArrowDown');
			await expect(picker.getByRole('tab', { includeHidden: true })).toHaveCount(0);
			await page.keyboard.press('Escape');
		});

		test(`failed detail preferences retain checked state and unsupported models expose no settings in ${locale}`, async () => {
			const { page } = browserTests;
			const chinese = locale === 'zh-CN';
			await page.goto(`/chatInput.html?modelSet=providers&modelPreferenceFailure&locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			await page.locator('.ash-chat-input-model-action').press('ArrowDown');
			const picker = page.locator('.ash-chat-model-picker');
			await picker.getByRole('button', { name: chinese ? 'Test Model 详情' : 'Test Model details', exact: true }).click();
			const expanded = picker.getByRole('radio', { name: '872K', exact: true });
			await expanded.focus();
			await expanded.press('Space');
			await expect(picker.getByRole('status')).toHaveText(chinese ? '无法更新模型设置' : 'Could not update model settings');
			await expect(expanded).not.toBeChecked();
			await expect(expanded).toBeEnabled();
			expect(await page.evaluate(() => window.ashChatInputIntegration.modelState())).toMatchObject({ preferenceWrites: [] });
			await picker.getByRole('button', { name: chinese ? '返回模型列表' : 'Back to models', exact: true }).click();
			await picker.getByRole('combobox').fill('Gemini');
			await picker.getByRole('combobox').press('ArrowDown');
			await expect(picker.getByRole('menuitemradio', { name: 'Gemini fixture', exact: true })).toBeFocused();
			await page.keyboard.press('ArrowRight');
			await expect(picker.getByRole('radio')).toHaveCount(0);
			await expect(picker.getByText(chinese ? '此模型没有可配置的选项。' : 'This model has no configurable options.', { exact: true })).toBeVisible();
			await page.keyboard.press('Escape');
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`speed changes persist exact IDs independently of effort and context in ${locale}`, async () => {
			const { page } = browserTests;
			const chinese = locale === 'zh-CN';
			await page.goto(`/chatInput.html?modelSet=providers&acceleration=multiple&locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const before = await page.evaluate(() => window.ashChatInputIntegration.modelState());
			const options = page.locator('.ash-chat-input-configuration-action');
			await options.press('ArrowDown');
			const picker = page.locator('.ash-chat-model-picker');
			const speed = picker.getByRole('radiogroup', { name: chinese ? '速度' : 'Speed', exact: true });
			const standard = speed.getByRole('radio', { name: chinese ? '默认' : 'Default', exact: true });
			const fast = speed.getByRole('radio', { name: chinese ? '快速' : 'Fast', exact: true });
			const ultra = speed.getByRole('radio', { name: chinese ? '极速' : 'Ultra Fast', exact: true });
			await expect(standard).toBeChecked();
			await expect(fast).toHaveAttribute('aria-description', chinese ? '响应更快，用量更高' : 'Faster responses, increased usage');
			await fast.focus();
			await fast.press('Space');
			await expect(fast).toBeChecked();
			await expect(options).toHaveText(chinese ? '低 · 快速' : 'Low · Fast');
			await ultra.focus();
			await ultra.press('Space');
			await expect(ultra).toBeChecked();
			await page.keyboard.press('Escape');
			await options.press('ArrowDown');
			await expect(ultra).toBeChecked();
			const context = picker.getByRole('radiogroup', { name: chinese ? '上下文大小' : 'Context Size', exact: true });
			await expect(context.getByRole('radio').first()).toBeChecked();
			const thinking = picker.getByRole('radiogroup', { name: chinese ? '推理强度' : 'Thinking Level', exact: true });
			await expect(thinking.getByRole('radio').first()).toBeChecked();
			await standard.focus();
			await standard.press('Space');
			await expect(standard).toBeChecked();
			await expect(options).toHaveText(chinese ? '低' : 'Low');
			const after = await page.evaluate(() => window.ashChatInputIntegration.modelState());
			expect(after).toEqual({
				...before as Record<string, unknown>,
				preferenceWrites: ['priority', 'ultrafast', null].map(acceleration => ({ model: { provider: 'openai', model: 'test-model' }, update: { acceleration } })),
			});
			await page.keyboard.press('Escape');
		});

		test(`failed speed writes recover without changing selection and another provider can be configured in ${locale}`, async () => {
			const { page } = browserTests;
			const chinese = locale === 'zh-CN';
			await page.goto(`/chatInput.html?modelSet=providers&modelPreferenceFailure&locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			await page.locator('.ash-chat-input-configuration-action').press('ArrowDown');
			const picker = page.locator('.ash-chat-model-picker');
			const speed = picker.getByRole('radiogroup', { name: chinese ? '速度' : 'Speed', exact: true });
			const fast = speed.getByRole('radio', { name: chinese ? '快速' : 'Fast', exact: true });
			await fast.focus();
			await fast.press('Space');
			await expect(picker.getByRole('status')).toHaveText(chinese ? '无法更新模型设置' : 'Could not update model settings');
			await expect(fast).not.toBeChecked();
			await expect(fast).toBeEnabled();
			await expect(speed.getByRole('radio').first()).toBeChecked();
			expect(await page.evaluate(() => window.ashChatInputIntegration.modelState())).toMatchObject({ preferenceWrites: [] });
			await page.keyboard.press('Escape');
			await page.goto(`/chatInput.html?modelSet=providers&locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			await page.locator('.ash-chat-input-model-action').press('ArrowDown');
			await picker.getByRole('button', { name: chinese ? 'Custom fixture 详情' : 'Custom fixture details', exact: true }).click();
			const customFast = picker.getByRole('radiogroup', { name: chinese ? '速度' : 'Speed', exact: true }).getByRole('radio', { name: chinese ? '快速' : 'Fast', exact: true });
			await customFast.focus();
			await customFast.press('Space');
			await expect(customFast).toBeChecked();
			expect(await page.evaluate(() => window.ashChatInputIntegration.modelState())).toMatchObject({
				selectedModel: { provider: 'private-endpoint', model: 'custom-fixture' },
				preferenceWrites: [{ model: { provider: 'private-endpoint', model: 'custom-fixture' }, update: { acceleration: 'priority' } }],
			});
			await page.keyboard.press('Escape');
		});
	}

	for (const theme of ['light', 'dark', 'hcDark', 'hcLight']) {
		test(`the unified list and detail options fit a narrow popup in ${theme}`, async () => {
			const { page } = browserTests;
			await page.setViewportSize({ width: 320, height: 600 });
			await page.goto(`/chatInput.html?modelSet=providers&unavailableProvider&theme=${theme}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			await page.locator('.ash-chat-input-model-action').press('ArrowDown');
			const picker = page.locator('.ash-chat-model-picker');
			const metrics = await picker.evaluate(element => ({
				left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
				overflow: element.scrollWidth > element.clientWidth, border: getComputedStyle(element).borderTopColor
			}));
			expect(metrics.left).toBeGreaterThanOrEqual(0);
			expect(metrics.right).toBeLessThanOrEqual(320);
			expect(metrics.overflow).toBe(false);
			expect(metrics.border).not.toBe('rgba(0, 0, 0, 0)');
			await picker.getByRole('button', { name: 'Test Model details', exact: true }).click();
			const high = picker.getByRole('radio', { name: 'High', exact: true });
			await high.focus();
			await expect(picker.locator('.ash-chat-model-card-configurable')).toBeVisible();
			expect(await picker.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
			await page.screenshot({ path: browserTests.info.outputPath(`model-details-${theme}.png`) });
			await high.press('Alt+ArrowLeft');
			await page.evaluate(() => window.ashChatInputIntegration.setModelsAvailable(false));
			await expect(picker.locator('.ash-chat-model-picker-empty')).toBeVisible();
			expect(await picker.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
			await page.keyboard.press('Escape');
		});
	}
});
