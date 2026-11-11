import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('model picker browser component', () => {
	const browserTests = useBrowserTests();

	test('the Chat slider exposes Fast and Ultra for eligible built-in models', async () => {
		const { page } = browserTests;
		await page.goto('/chatInput.html?chatModelSlider&holdModelPreference&locale=zh-CN&theme=hcDark');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.locator('.ash-chat-input-model-action').press('ArrowDown');
		const picker = page.getByRole('dialog', { name: '选择聊天模型' });
		const modelButton = picker.locator('.ash-chat-slider-model-button');
		const effortLabel = picker.locator('.ash-chat-slider-effort-label');
		const fast = picker.getByRole('button', { name: '快速模式', exact: true });
		const ultra = picker.getByRole('button', { name: 'Ultra 模式', exact: true });
		const slider = picker.getByRole('slider');
		const expectThumbAt = async (name: string) => {
			const thumb = slider.locator('.ash-chat-slider-thumb');
			const tick = slider.getByRole('button', { name, exact: true });
			await expect.poll(async () => {
				const [handle, stop] = await Promise.all([thumb.boundingBox(), tick.boundingBox()]);
				return Math.abs(handle!.x + handle!.width / 2 - stop!.x - stop!.width / 2);
			}).toBeLessThan(0.5);
		};
		const [fastBounds, modelBounds, ultraBounds] = await Promise.all([fast.boundingBox(), modelButton.boundingBox(), ultra.boundingBox()]);
		expect(fastBounds!.x + fastBounds!.width).toBeLessThan(modelBounds!.x);
		expect(ultraBounds!.x).toBeGreaterThan(modelBounds!.x + modelBounds!.width);
		await expect(fast.locator('.ash-icon-lightning')).toBeVisible();
		await fast.press('Space');
		await page.evaluate(() => window.ashChatInputIntegration.finishModelPreference(false));
		await expect(page.getByLabel('Context error')).toHaveText('无法更新模型设置');
		await expect(fast).toHaveAttribute('aria-pressed', 'false');
		await fast.press('Space');
		await expect(fast).toHaveAttribute('aria-pressed', 'true');
		await expect(fast.locator('.ash-icon-lightning-filled')).toBeVisible();
		await expect(fast).toBeFocused();
		await expect(slider).toHaveAttribute('aria-valuetext', '低');
		await slider.press('ArrowRight');
		await expect(slider).toHaveAttribute('aria-valuetext', '高');
		await expect(slider).toHaveCSS('outline-style', 'solid');
		const ticks = await slider.getByRole('button').count();
		await ultra.click();
		await expect(ultra).toHaveAttribute('aria-pressed', 'true');
		await expect(ultra.locator('.ash-icon-brain')).toBeVisible();
		await expect(fast).toHaveAttribute('aria-pressed', 'true');
		await expect(slider).toHaveAttribute('aria-valuetext', '极高');
		await expectThumbAt('极高');
		await expect(slider).toHaveAccessibleDescription('Ultra 使用极高档。调整推理档位会关闭 Ultra。');
		await expect(modelButton).toHaveAccessibleName('Test Model');
		await expect(modelButton).toHaveAccessibleDescription('极高');
		await expect(effortLabel).toHaveText('极高');
		const modelFontSize = await modelButton.locator('.ash-chat-slider-model-title').evaluate(element => getComputedStyle(element).fontSize);
		await expect(effortLabel).toHaveCSS('font-size', modelFontSize);
		await expect(picker.getByText('推荐', { exact: true })).toHaveCount(0);
		await expect(slider.getByRole('button')).toHaveCount(ticks);
		await expect(ultra).toBeFocused();
		await slider.getByRole('button', { name: '极高' }).click();
		await expect(ultra).toHaveAttribute('aria-pressed', 'true');
		await expect(slider).toHaveCSS('outline-style', 'none');
		await ultra.press('Space');
		await expect(ultra).toHaveAttribute('aria-pressed', 'false');
		await expect(slider).toHaveAttribute('aria-valuetext', '高');
		await expectThumbAt('高');
		await expect(effortLabel).toHaveText('高');
		await slider.press('ArrowLeft');
		await expect(slider).toHaveAttribute('aria-valuetext', '低');
		await ultra.click();
		await expect(slider).toHaveAttribute('aria-valuetext', '极高');
		await slider.press('ArrowLeft');
		await expect(ultra).toHaveAttribute('aria-pressed', 'false');
		await expect(slider).toHaveAttribute('aria-valuetext', '高');
		await expect(slider).toBeFocused();
		await expect(effortLabel).toHaveText('高');
		await fast.press('Space');
		await expect(fast).toHaveAttribute('aria-pressed', 'false');
		expect(await page.evaluate(() => window.ashChatInputIntegration.modelState())).toMatchObject({
			mode: 'agent',
			selectedReasoningEffort: 'high',
			preferenceWrites: [{ acceleration: 'priority' }, { ultra: true }, { ultra: false }, { ultra: true }, { ultra: false }, { acceleration: null }]
				.map(update => ({ model: { provider: 'openai', model: 'test-model' }, update })),
		});

		await modelButton.click();
		await picker.getByRole('menuitemradio', { name: 'Standard model' }).click();
		await expect(fast).toHaveCount(0);
		await expect(ultra).toHaveCount(0);
		await modelButton.click();
		await picker.getByRole('menuitemradio', { name: 'Custom model' }).click();
		await expect(fast).toHaveCount(0);
		await expect(ultra).toHaveCount(0);
		await expect(slider).toBeVisible();

		await modelButton.click();
		await picker.getByRole('menuitemradio', { name: 'Claude Opus 5.5' }).click();
		await expect(modelButton).toHaveAccessibleName('Claude Opus 5.5');
		const [claudeButtonBounds, effortLabelBounds] = await Promise.all([modelButton.boundingBox(), effortLabel.boundingBox()]);
		expect(claudeButtonBounds!.y + claudeButtonBounds!.height).toBeLessThanOrEqual(effortLabelBounds!.y);
		const claudeEffort = await slider.getAttribute('aria-valuetext');
		await ultra.click();
		await expect(ultra).toHaveAttribute('aria-pressed', 'true');
		await expect(slider).toHaveAttribute('aria-valuetext', claudeEffort!);
		await slider.getByRole('button', { name: '极高' }).click();
		await expect(slider).toHaveAttribute('aria-valuetext', '极高');
		await expect(ultra).toHaveAttribute('aria-pressed', 'true');
		expect(await page.evaluate(() => window.ashChatInputIntegration.modelState())).toMatchObject({ selectedReasoningEffort: 'extraHigh' });
		await ultra.press('Space');
		await expect(slider).toHaveAttribute('aria-valuetext', '极高');
	});

	for (const configuration of ['chatModelSlider', 'modelMenuConfiguration']) {
		test(`the ${configuration} picker exposes every declared speed with keyboard selection`, async () => {
			const { page } = browserTests;
			await page.goto(`/chatInput.html?${configuration}&acceleration=multiple&locale=zh-CN`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			await page.locator('.ash-chat-input-model-action').press('ArrowDown');
			const picker = page.getByRole('dialog', { name: '选择聊天模型' });
			const speed = picker.getByRole('menuitem', { name: '速度', exact: true });
			await speed.press('ArrowRight');
			const submenu = page.getByRole('menu', { name: '速度', exact: true });
			await expect(submenu.getByRole('menuitemradio')).toHaveCount(3);
			await expect(submenu.getByRole('menuitemradio', { checked: true })).toHaveText('默认');
			await submenu.getByRole('menuitemradio', { name: '极速', exact: true }).press('Enter');
			const ultraFast = { model: { provider: 'openai', model: 'test-model' }, update: { acceleration: 'ultrafast' } };
			await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.modelState())).toMatchObject({ preferenceWrites: [ultraFast] });
			await speed.press('ArrowRight');
			await expect(submenu.getByRole('menuitemradio', { checked: true })).toHaveText('极速');
			await submenu.getByRole('menuitemradio', { name: '默认', exact: true }).press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashChatInputIntegration.modelState())).toMatchObject({
				preferenceWrites: [ultraFast, { model: ultraFast.model, update: { acceleration: null } }],
			});
		});
	}

	for (const success of [true, false]) {
		test(`reopening the picker unlocks its controls after a ${success ? 'successful' : 'failed'} save`, async () => {
			const { page } = browserTests;
			await page.goto('/chatInput.html?modelMenuConfiguration&holdModelPreference&locale=zh-CN');
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const trigger = page.locator('.ash-chat-input-model-action');
			const picker = page.locator('.ash-chat-model-picker');
			const fast = picker.getByRole('switch', { name: '快速模式' });
			await trigger.press('ArrowDown');
			await fast.press('Space');
			await expect(fast).toHaveAttribute('aria-busy', 'true');
			await picker.getByRole('combobox').press('Escape');
			await expect(picker).toHaveCount(0);
			await trigger.press('ArrowDown');
			await expect(fast).toBeDisabled();

			await page.evaluate(value => window.ashChatInputIntegration.finishModelPreference(value), success);
			await expect(fast).toBeEnabled();
			await expect(fast).toHaveJSProperty('checked', success);
			await picker.getByRole('menuitem', { name: '推理强度' }).press('ArrowRight');
			const high = page.getByRole('menuitemradio', { name: '高', exact: true });
			await expect(high).toBeEnabled();
			await high.press('Enter');
			await expect(picker).toHaveCount(0);
			await expect(trigger).toHaveAccessibleName('Test Model 高');
			await expect(trigger).toBeFocused();
		});
	}

	test('shows the model default without checking an effort when the catalog omits it', async () => {
		const { page } = browserTests;
		await page.goto('/chatInput.html?modelMenuConfiguration&omitEffortDefault&locale=zh-CN');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const trigger = page.locator('.ash-chat-input-model-action');
		await expect(trigger).toHaveAccessibleName('Test Model 模型默认');
		await expect(trigger.locator('.ash-chat-input-model-effort')).toHaveText('模型默认');
		await trigger.press('ArrowDown');
		const picker = page.locator('.ash-chat-model-picker');
		await picker.getByRole('menuitem', { name: '推理强度' }).press('ArrowRight');
		const efforts = page.getByRole('menu', { name: '推理强度' });
		await expect(efforts.getByRole('menuitemradio', { checked: true })).toHaveCount(0);
		await efforts.getByRole('menuitemradio', { name: '高', exact: true }).press('Enter');
		await expect(picker).toHaveCount(0);
		await expect(trigger).toHaveAccessibleName('Test Model 高');
		await expect(trigger).toBeFocused();
	});

	test('effort submenu and model preview replace each other on the same surface', async () => {
		const { page } = browserTests;
		await page.goto('/chatInput.html?modelMenuConfiguration');
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.locator('.ash-chat-input-model-action').press('ArrowDown');
		const picker = page.locator('.ash-chat-model-picker');
		const searchBounds = await picker.locator('.ash-action-widget-filter').boundingBox();
		const autoBounds = await picker.locator('.ash-chat-model-picker-automatic').boundingBox();
		const modelBounds = await picker.getByRole('menuitemradio', { name: 'Test Model', exact: true }).boundingBox();
		expect(searchBounds!.y + searchBounds!.height).toBeLessThanOrEqual(autoBounds!.y);
		expect(autoBounds!.y + autoBounds!.height).toBeLessThanOrEqual(modelBounds!.y);
		const effort = picker.getByRole('menuitem', { name: 'Effort' });
		await effort.press('ArrowRight');
		const submenu = page.getByRole('menu', { name: 'Effort' });
		await expect(submenu.getByRole('menuitemradio', { name: 'Low' })).toBeFocused();
		await submenu.evaluate(element => { element.parentElement!.dataset.testSharedSidePanel = 'true'; });
		const panel = page.locator('[data-test-shared-side-panel]');
		await page.keyboard.press('Tab');
		await expect(picker.getByRole('menuitem', { name: 'More Models' })).toBeFocused();
		await expect(panel).toBeHidden();

		await effort.press('ArrowRight');
		await picker.getByRole('menuitemradio', { name: 'Test Model', exact: true }).hover();
		await expect(panel.locator('.ash-action-widget-side-preview')).toBeVisible();
		await expect(submenu).toHaveCount(0);
		await effort.press('ArrowRight');
		await expect(panel.getByRole('menu', { name: 'Effort' })).toBeVisible();
		await expect(panel.locator('.ash-action-widget-side-preview')).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expect(effort).toBeFocused();
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`model controls and details use model names and open documentation in ${locale}`, async () => {
			const { page } = browserTests;
			const chinese = locale === 'zh-CN';
			await page.goto(`/chatInput.html?modelSet=providers&locale=${locale}`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const trigger = page.locator('.ash-chat-input-model-action');
			await expect(trigger).toHaveText('Test Model');
			await expect(trigger).toHaveAccessibleName('Test Model');
			await expect(trigger.locator('.ash-chat-input-model-action-icon')).toHaveAttribute('aria-hidden', 'true');
			await trigger.press('ArrowDown');
			const picker = page.locator('.ash-chat-model-picker');
			await expect(picker.getByRole('tab', { includeHidden: true })).toHaveCount(0);
			await expect(picker.getByRole('tabpanel')).toHaveCount(0);
			await picker.getByRole('menuitemradio', { name: 'Test Model', exact: true }).focus();
			await page.keyboard.press('ArrowRight');
			const card = picker.getByRole('region', { name: 'Test Model', exact: true });
			await expect(card.getByRole('heading', { name: 'Test Model', exact: true })).toBeVisible();
			await expect(card.locator('h3 .ash-icon')).toHaveCount(0);
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
			const preview = page.locator('.ash-action-widget-side-preview');
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
				const bounds = row.getBoundingClientRect();
				return { fullWidth: primary.left === bounds.left && primary.right === bounds.right, height: bounds.height };
			});
			expect(geometry).toEqual({ fullWidth: true, height: 22 });
			await expect(picker.locator('.ash-action-widget-secondary')).toHaveCount(0);
			await expect(picker.locator('.ash-action-widget-summary, .ash-menu-badge')).toHaveCount(0);
			const search = picker.getByRole('combobox');
			await search.fill('fixture');
			await expect(picker.getByRole('menuitemradio')).toHaveCount(5);
			const before = await page.evaluate(() => window.ashChatInputIntegration.modelState());
			await picker.getByRole('menuitemradio', { name: 'Custom fixture', exact: true }).focus();
			await page.keyboard.press('ArrowRight');
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
			await picker.getByRole('menuitemradio', { name: 'Test Model', exact: true }).focus();
			await page.keyboard.press('ArrowRight');
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
			const thinking = picker.getByRole('radiogroup', { name: chinese ? '推理强度' : 'Effort', exact: true });
			await expect(thinking.getByRole('radio', { checked: true })).toHaveAccessibleName(chinese ? '低' : 'Low');
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
			await picker.getByRole('menuitemradio', { name: 'Custom fixture', exact: true }).focus();
			await page.keyboard.press('ArrowRight');
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
			await picker.getByRole('menuitemradio', { name: 'Test Model', exact: true }).focus();
			await page.keyboard.press('ArrowRight');
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
