import { expect, test } from '@playwright/test';

for (const locale of ['en', 'zh-CN']) {
	test(`model and effort buttons share typography, pill corners and adjacent spacing in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const mode = page.locator('.ash-chat-input-mode-action');
		const model = page.locator('.ash-chat-input-model-action');
		const effort = page.locator('.ash-chat-input-configuration-action');
		for (const width of [800, 400, 280]) {
			await page.setViewportSize({ width, height: 600 });
			await expect.poll(async () => {
				const metrics = await Promise.all([mode, model, effort].map(trigger => trigger.evaluate(element => {
					const style = getComputedStyle(element);
					const bounds = element.getBoundingClientRect();
					return {
						left: bounds.left, right: bounds.right, height: bounds.height,
						fontSize: style.fontSize, fontWeight: style.fontWeight,
						radius: style.borderRadius, padding: style.padding,
					};
				})));
				const [modeMetrics, modelMetrics, effortMetrics] = metrics;
				return {
					matchingTypography: modelMetrics.fontSize === effortMetrics.fontSize && modelMetrics.fontWeight === effortMetrics.fontWeight,
					matchingPillCorners: modelMetrics.radius === effortMetrics.radius && parseFloat(effortMetrics.radius) >= effortMetrics.height / 2,
					matchingPadding: modelMetrics.padding === effortMetrics.padding,
					matchingSpacing: Math.abs((modelMetrics.left - modeMetrics.right) - (effortMetrics.left - modelMetrics.right)) < 1,
					fits: effortMetrics.right <= width,
				};
			}).toEqual({ matchingTypography: true, matchingPillCorners: true, matchingPadding: true, matchingSpacing: true, fits: true });
		}
	});
}

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

for (const { locale, surface } of ['en', 'zh-CN'].flatMap(locale => ['chat', 'cowork'].map(surface => ({ locale, surface })))) {
	test(`model picker describes acceleration and retains keyboard state in ${surface} ${locale}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/chatInput.html?locale=${locale}&surface=${surface}`);
		expect(errors).toEqual([]);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const trigger = page.locator('.ash-chat-input-model-action');
		await trigger.press('ArrowDown');
		const picker = page.locator('.ash-chat-model-picker');
		const search = picker.getByRole('combobox');
		await expect(picker.getByRole('menuitemradio', { name: 'Test Model', exact: true })).toHaveText('Test Model');
		await expect(picker).toHaveClass(/ash-action-widget/);
		expect(await picker.evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(320);
		await expect(picker.locator('.ash-quick-pick-row-description')).toHaveCount(0);
		await expect(picker).not.toContainText('A model for everyday tasks');
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

for (const { locale, surface } of ['en', 'zh-CN'].flatMap(locale => ['chat', 'cowork'].map(surface => ({ locale, surface })))) {
	test(`thinking levels retain catalog descriptions and keyboard selection in ${surface} ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}&surface=${surface}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const trigger = page.locator('.ash-chat-input-configuration-action');
		const lowCopy = locale === 'zh-CN' ? '较轻的推理，更快的响应' : 'Fast responses with lighter reasoning';
		const highCopy = locale === 'zh-CN' ? '为复杂问题提供更深入的推理' : 'Greater reasoning depth for complex problems';
		await expect(trigger).toHaveAttribute('aria-description', lowCopy);
		await trigger.press('ArrowDown');
		const menu = page.locator('.ash-chat-model-configuration-menu');
		const low = menu.locator('[data-action-id="ash.chat.input.effort.low"] button');
		const high = menu.locator('[data-action-id="ash.chat.input.effort.high"] button');
		await expect(low).toBeFocused();
		await expect(low).toHaveAttribute('aria-description', lowCopy);
		await page.keyboard.press('ArrowDown');
		await expect(high).toBeFocused();
		await expect(high).toHaveAttribute('aria-description', highCopy);
		await page.keyboard.press('Enter');
		await expect(menu).toHaveCount(0);
		await expect(trigger).toBeFocused();
		await expect(trigger).toHaveAttribute('aria-description', highCopy);
	});
}

for (const { locale, surface } of ['en', 'zh-CN'].flatMap(locale => ['chat', 'cowork'].map(surface => ({ locale, surface })))) {
	test(`model options select effort and context independently in ${surface} ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}&surface=${surface}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const chinese = locale === 'zh-CN';
		const trigger = page.locator('.ash-chat-input-configuration-action');
		const menu = page.locator('.ash-chat-model-configuration-menu');
		await expect(trigger).toHaveText(chinese ? '低' : 'Low');
		await trigger.press('ArrowDown');
		await expect(menu.locator('.ash-chat-model-configuration-heading')).toHaveText(chinese ? ['推理强度', '上下文大小'] : ['Thinking Level', 'Context Size']);
		await expect(menu.getByRole('separator')).toHaveCount(1);
		const contextDefault = menu.locator('[data-action-id="ash.chat.input.context.false"] button');
		const expanded = menu.locator('[data-action-id="ash.chat.input.context.true"] button');
		await expect(contextDefault).toHaveAttribute('aria-checked', 'true');
		await expect(contextDefault).toHaveText(chinese ? '关闭长上下文' : 'Long context off');
		await expect(expanded).toHaveText(chinese ? '开启长上下文' : 'Long context on');
		const high = menu.locator('[data-action-id="ash.chat.input.effort.high"] button');
		await page.keyboard.press('ArrowDown');
		await expect(high).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(trigger).toHaveText(chinese ? '高' : 'High');
		await expect(trigger).toBeFocused();
		await trigger.press('ArrowDown');
		await expect(high).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(contextDefault).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(expanded).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(trigger).toHaveText(chinese ? '高' : 'High');
		await expect(trigger).toBeFocused();
		await trigger.press('ArrowDown');
		await expect(high).toHaveAttribute('aria-checked', 'true');
		await expect(expanded).toHaveAttribute('aria-checked', 'true');
		await expect(contextDefault).toHaveAttribute('aria-checked', 'false');
		await expect(menu.getByRole('menuitemradio')).toHaveCount(4);
		const geometry = await menu.evaluate(element => ({ overflow: element.scrollWidth - element.clientWidth, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }));
		expect(geometry.overflow).toBe(0);
		expect(geometry.left).toBeGreaterThanOrEqual(0);
		expect(geometry.right).toBeLessThanOrEqual(page.viewportSize()!.width);
		await contextDefault.click();
		await expect(trigger).toHaveText(chinese ? '高' : 'High');
		await trigger.press('ArrowDown');
		await menu.locator('[data-action-id="ash.chat.input.effort.low"] button').click();
		await expect(trigger).toHaveText(chinese ? '低' : 'Low');
		await trigger.press('ArrowDown');
		await page.keyboard.press('Escape');
		await expect(trigger).toBeFocused();
		await expect(trigger).toHaveAttribute('aria-expanded', 'false');
	});
}

for (const { modelOptions, surface } of ['effort', 'context', 'none'].flatMap(modelOptions => ['chat', 'cowork'].map(surface => ({ modelOptions, surface })))) {
	test(`model options only show supported ${modelOptions} controls in ${surface}`, async ({ page }) => {
		await page.goto(`/chatInput.html?modelOptions=${modelOptions}&surface=${surface}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const trigger = page.locator('.ash-chat-input-configuration-action');
		if (modelOptions === 'none') {
			await expect(trigger).toBeHidden();
			return;
		}
		await expect(trigger).toHaveText(modelOptions === 'effort' ? 'Low' : 'Model options');
		await expect(trigger).toHaveAccessibleName(modelOptions === 'effort' ? 'Model options: Low' : 'Model options');
		await trigger.press('ArrowDown');
		const menu = page.locator('.ash-chat-model-configuration-menu');
		await expect(menu.locator('.ash-chat-model-configuration-heading')).toHaveText(modelOptions === 'effort' ? 'Thinking Level' : 'Context Size');
		await expect(menu.getByRole('separator')).toHaveCount(0);
		await expect(menu.getByRole('menuitemradio')).toHaveCount(2);
		await page.keyboard.press('End');
		await page.keyboard.press('Enter');
		await expect(trigger).toHaveText(modelOptions === 'effort' ? 'High' : 'Model options');
		await expect(trigger).toBeFocused();
		await trigger.press('ArrowDown');
		await expect(menu.getByRole('menuitemradio').last()).toHaveAttribute('aria-checked', 'true');
		await page.keyboard.press('Escape');
	});
}


test('Mode picker keeps its Tab stop and shares menu activation, placement and dismissal', async ({ page }) => {
	await page.goto('/chatInput.html');
	await page.evaluate(() => {
		window.ashChatInputIntegration.showModels();
		document.querySelector<HTMLElement>('main')!.style.marginTop = '300px';
	});
	const mode = page.locator('.ash-chat-input-mode-action');
	const model = page.locator('.ash-chat-input-model-action');
	const menu = page.locator('.ash-chat-input-mode-menu');
	await expect(mode).toHaveAttribute('tabindex', '0');
	await mode.focus();
	await page.keyboard.press('Tab');
	await expect(model).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await expect(mode).toBeFocused();
	await mode.hover();
	await page.mouse.down();
	await expect(menu).toBeVisible();
	await page.mouse.up();
	await expect(menu).toBeVisible();
	const trigger = (await mode.boundingBox())!;
	const popup = (await menu.boundingBox())!;
	expect(popup.y + popup.height).toBeLessThanOrEqual(trigger.y);
	await expect(menu.getByRole('menuitemradio')).toHaveCount(5);
	await page.keyboard.press('Escape');
	await expect(mode).toBeFocused();
	await expect(mode).toHaveAttribute('aria-expanded', 'false');
	for (const key of ['Enter', 'Space']) {
		await page.keyboard.down(key);
		await expect(menu).toBeVisible();
		await page.keyboard.up(key);
		await expect(menu).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(mode).toBeFocused();
	}
	await mode.press('ArrowDown');
	await menu.getByRole('menuitemradio', { name: 'Plan', exact: true }).click();
	await expect(menu).toBeHidden();
});

for (const surface of ['chat', 'cowork']) {
	test(`Picker focus rings follow keyboard and pointer input in ${surface}`, async ({ page }) => {
		await page.goto(`/chatInput.html?surface=${surface}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const model = page.locator('.ash-chat-input-model-action');
		const options = page.locator('.ash-chat-input-configuration-action');
		await model.focus();
		await page.keyboard.press('Tab');
		await expect(options).toBeFocused();
		await expect(options).toHaveCSS('outline-style', 'solid');
		await options.press('Enter');
		await page.keyboard.press('Escape');
		await expect(options).toBeFocused();
		await expect(options).toHaveCSS('outline-style', 'solid');
		await page.mouse.click(0, 0);
		await options.focus();
		await expect(options).toHaveCSS('outline-style', 'none');
		await page.keyboard.press('Shift+Tab');
		await expect(model).toBeFocused();
		await expect(model).toHaveCSS('outline-style', 'solid');
	});

	test(`model picker preserves width, Auto state and popup ownership in ${surface}`, async ({ page }) => {
		await page.goto(`/chatInput.html?surface=${surface}&modelSet=multiple`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const trigger = page.locator('.ash-chat-input-model-action');
		await trigger.press('ArrowDown');
		const picker = page.getByRole('dialog', { name: 'Choose a chat model' });
		const search = picker.getByRole('combobox');
		const width = await picker.evaluate(element => element.getBoundingClientRect().width);
		expect(width).toBeGreaterThan(320);
		expect(width).toBeLessThanOrEqual(page.viewportSize()!.width * 0.8);
		await search.fill('test-model');
		await expect(picker.getByRole('menuitemradio')).toHaveCount(1);
		await expect(picker.getByRole('menuitemradio')).toHaveText('Test Model');
		expect(await picker.evaluate(element => element.getBoundingClientRect().width)).toBe(width);
		await search.press('ArrowRight');
		const fast = picker.getByRole('region', { name: 'Test Model', exact: true }).getByRole('switch', { name: 'Fast', exact: true });
		await fast.press('Space');
		await expect(fast).toBeChecked();
		await expect(fast).toBeFocused();
		await expect(search).toHaveValue('test-model');
		expect(await picker.evaluate(element => element.getBoundingClientRect().width)).toBe(width);
		await fast.press('Alt+ArrowLeft');
		await expect(search).toBeFocused();
		await search.fill('extended-model');
		await search.press('Enter');
		await expect(picker).toHaveCount(0);
		await expect(trigger).toHaveText('Extended model with a longer display name for coding');
		await expect(trigger).toBeFocused();
		await trigger.press('ArrowDown');
		await expect(picker.getByRole('menuitemradio', { name: 'Extended model with a longer display name for coding', exact: true })).toBeChecked();
		const auto = picker.getByRole('switch', { name: 'Auto', exact: true });
		await auto.press('Space');
		await expect(auto).toBeChecked();
		await expect(auto).toBeFocused();
		await expect(search).toBeHidden();
		await expect(picker.getByRole('menuitemradio')).toHaveCount(0);
		await expect(picker.getByRole('menuitem', { name: 'Add Models' })).toHaveCount(0);
		await auto.press('ControlOrMeta+f');
		await expect(auto).toBeFocused();
		await auto.press('Space');
		await expect(auto).not.toBeChecked();
		await expect(auto).toBeFocused();
		await expect(search).toBeVisible();
		await expect(picker.getByRole('menuitemradio')).toHaveCount(2);
		await page.locator('.ash-chat-input-configuration-action').click();
		await expect(picker).toHaveCount(0);
		await expect(trigger).toHaveAttribute('aria-expanded', 'false');
		await trigger.click();
		await expect(picker).toBeVisible();
		await page.evaluate(() => window.ashChatInputIntegration.dispose());
		await expect(page.locator('.ash-action-widget')).toHaveCount(0);
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`model picker selects Fast and Ultra Fast independently in ${locale}`, async ({ page }) => {
		await page.goto(`/chatInput.html?locale=${locale}&acceleration=multiple`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		await page.locator('.ash-chat-input-model-action').press('ArrowDown');
		await page.getByRole('combobox').press('ArrowRight');
		const card = page.locator('.ash-chat-model-card');
		const fast = card.getByRole('switch', { name: locale === 'zh-CN' ? '快速' : 'Fast', exact: true });
		const ultra = card.getByRole('switch', { name: locale === 'zh-CN' ? '超快速' : 'Ultra Fast', exact: true });
		await expect(fast).toBeFocused();
		await fast.press('Space');
		await expect(fast).toBeChecked();
		await fast.press('Tab');
		await expect(ultra).toBeFocused();
		await ultra.press('Space');
		await expect(ultra).toBeChecked();
		await expect(fast).not.toBeChecked();
		await expect(ultra).toBeFocused();
		await page.evaluate(() => window.ashChatInputIntegration.denyAcceleration('priority'));
		await expect(fast).toHaveCount(0);
		await expect(ultra).toBeChecked();
		await expect(ultra).toBeFocused();
		await ultra.press('Space');
		await expect(ultra).not.toBeChecked();
		await ultra.press('Escape');
		await expect(page.locator('.ash-chat-model-picker')).toHaveCount(0);
	});
}


for (const surface of ['chat', 'cowork']) {
	test(`Split picker activates on mouse down and keyboard press without a second activation in ${surface}`, async ({ page }) => {
		await page.goto(`/chatInput.html?surface=${surface}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const control = page.locator('.ash-chat-model-picker-control');
		await expect(control).toHaveAttribute('role', 'group');
		await expect(control.locator(':scope > a[role="button"]')).toHaveCount(2);
		await page.evaluate(() => window.ashChatInputIntegration.openModels());
		await expect(page.getByRole('dialog', { name: 'Choose a chat model' })).toBeVisible();
		await page.keyboard.press('Escape');
		for (const { trigger, popup } of [
			{ trigger: control.locator('.ash-chat-input-model-action'), popup: page.getByRole('dialog', { name: 'Choose a chat model' }) },
			{ trigger: control.locator('.ash-chat-input-configuration-action'), popup: page.getByRole('menu', { name: 'Model options', exact: true }) },
		]) {
			await trigger.hover();
			await page.mouse.down({ button: 'right' });
			await expect(popup).toBeHidden();
			await page.mouse.up({ button: 'right' });
			await page.mouse.down();
			await expect(popup).toBeVisible();
			await page.mouse.up();
			await expect(popup).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(trigger).toBeFocused();
			for (const key of ['Enter', 'Space']) {
				await page.keyboard.down(key);
				await expect(popup).toBeVisible();
				await page.keyboard.up(key);
				await expect(popup).toBeVisible();
				await page.keyboard.press('Escape');
				await expect(trigger).toBeFocused();
			}
		}
	});

	test(`Split picker handles touch and pen taps and rejects drags and cancelled touches in ${surface}`, async ({ browser, baseURL }) => {
		const context = await browser.newContext({ baseURL, hasTouch: true });
		try {
			const page = await context.newPage();
			await page.goto(`/chatInput.html?surface=${surface}&gestureAncestor=1`);
			await page.evaluate(() => window.ashChatInputIntegration.showModels());
			const control = page.locator('.ash-chat-model-picker-control');
			const model = control.locator('.ash-chat-input-model-action');
			const options = control.locator('.ash-chat-input-configuration-action');
			const picker = page.getByRole('dialog', { name: 'Choose a chat model' });
			const menu = page.getByRole('menu', { name: 'Model options', exact: true });
			const triggers = [{ trigger: model, popup: picker }, { trigger: options, popup: menu }];
			if (surface === 'chat') { triggers.push({ trigger: page.locator('.ash-chat-input-mode-action'), popup: page.locator('.ash-chat-input-mode-menu') }); }
			for (const { trigger, popup } of triggers) {
				await trigger.tap();
				await expect(popup).toBeVisible();
				await page.keyboard.press('Escape');
				await expect(trigger).toBeFocused();
			}
			await expect(page.locator('output[aria-label="Decision"]')).toBeEmpty();
			const bounds = (await model.boundingBox())!;
			const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
			const input = await context.newCDPSession(page);
			await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
			await expect(picker).toBeHidden();
			await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, x: point.x + 30 }] });
			await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
			await expect(picker).toBeHidden();
			await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
			await input.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
			await expect(picker).toBeHidden();
			await model.tap();
			await expect(picker).toBeVisible();
			await page.keyboard.press('Escape');
			await input.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, pointerType: 'pen' });
			await input.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, pointerType: 'pen', button: 'left', clickCount: 1 });
			await expect(picker).toBeHidden();
			await input.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, pointerType: 'pen', button: 'left', clickCount: 1 });
			await expect(picker).toBeVisible();
			await input.detach();
		} finally {
			await context.close();
		}
	});

	test(`Model widget highlights only the hovered trigger in ${surface}`, async ({ page }) => {
		await page.goto(`/chatInput.html?surface=${surface}`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const control = page.locator('.ash-chat-model-picker-control');
		const model = control.locator('.ash-chat-input-model-action');
		const options = control.locator('.ash-chat-input-configuration-action');
		await page.mouse.move(0, 0);
		await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		for (const background of ['rgb(45, 45, 45)', 'rgb(225, 225, 225)', 'rgb(255, 255, 0)']) {
			await control.evaluate((element, value) => element.style.setProperty('--ash-toolbar-hover-background', value), background);
			await model.hover();
			await expect(model).toHaveCSS('background-color', background);
			await expect(options).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await options.hover();
			await expect(options).toHaveCSS('background-color', background);
			await expect(model).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			const modelBounds = (await model.boundingBox())!;
			const optionsBounds = (await options.boundingBox())!;
			expect(optionsBounds.x - modelBounds.x - modelBounds.width).toBeGreaterThan(0);
			await page.mouse.move((modelBounds.x + modelBounds.width + optionsBounds.x) / 2, modelBounds.y + modelBounds.height / 2);
			await expect(model).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(options).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await page.mouse.move(0, 0);
			await expect(model).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(options).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		}
	});

	test(`Both model triggers retain independent Tab stops and toolbar navigation in ${surface}`, async ({ page }) => {
		await page.goto(`/chatInput.html?surface=${surface}&modelSet=multiple`);
		await page.evaluate(() => window.ashChatInputIntegration.showModels());
		const control = page.locator('.ash-chat-model-picker-control');
		const model = control.locator('.ash-chat-input-model-action');
		const options = control.locator('.ash-chat-input-configuration-action');
		const retainedModel = await model.elementHandle();
		const retainedOptions = await options.elementHandle();
		await expect(control.getByRole('button')).toHaveCount(2);
		await expect(model).toHaveAttribute('tabindex', '0');
		await expect(options).toHaveAttribute('tabindex', '0');
		await model.focus();
		await page.keyboard.press('Tab');
		await expect(options).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(model).toBeFocused();
		await model.press('ArrowRight');
		await expect(options).toBeFocused();
		await expect(options).toHaveAttribute('tabindex', '0');
		await expect(model).toHaveAttribute('tabindex', '0');
		await expect(options).toHaveAccessibleName('Model options: Low');
		await options.press('ArrowDown');
		await page.getByRole('menuitemradio', { name: 'High', exact: true }).click();
		await expect(options).toHaveText('High');
		await expect(options).toBeFocused();
		expect(await options.evaluate((current, retained) => current === retained, retainedOptions)).toBe(true);
		expect(await model.evaluate((current, retained) => current === retained, retainedModel)).toBe(true);
		await options.press('ArrowLeft');
		await expect(model).toBeFocused();
		await expect(model).toHaveAttribute('tabindex', '0');
		await expect(options).toHaveAttribute('tabindex', '0');
		await model.press('ArrowDown');
		const picker = page.getByRole('dialog', { name: 'Choose a chat model' });
		await picker.getByRole('switch', { name: 'Auto', exact: true }).press('Space');
		await expect(options).toBeHidden();
		await expect(options).toHaveAttribute('tabindex', '-1');
		await page.keyboard.press('Escape');
		await expect(model).toBeFocused();
		await model.press('ArrowDown');
		await picker.getByRole('switch', { name: 'Auto', exact: true }).press('Space');
		await page.keyboard.press('Escape');
		await expect(options).toBeVisible();
		await expect(options).toHaveAttribute('tabindex', '0');
		await page.setViewportSize({ width: 280, height: 600 });
		const geometry = await control.evaluate(element => ({ overflow: element.scrollWidth - element.clientWidth, right: element.getBoundingClientRect().right }));
		expect(geometry.overflow).toBe(0);
		expect(geometry.right).toBeLessThanOrEqual(280);
		await retainedModel?.dispose();
		await retainedOptions?.dispose();
	});

}
