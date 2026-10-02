import type { ElectronApplication } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';

test('Model picker keeps search quiet and aligns menu rows and the chosen icon', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'required', 'Requires the model catalog.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const selector = page.locator("[data-action-id='ash.chat.input.model'] button");
	await selector.focus();
	await selector.press('Enter');
	const picker = page.getByRole('dialog', { name: 'Choose a chat model' });
	const auto = picker.getByRole('switch', { name: 'Auto' });
	if (await auto.isChecked()) {
		await auto.press('Space');
		await expect(auto).not.toHaveAttribute('aria-busy', 'true');
	}
	const search = picker.getByRole('combobox');
	await search.click();
	await expect(search).toBeFocused();
	await expect(search).toHaveCSS('border-top-width', '0px');
	await expect(search).toHaveCSS('outline-style', 'none');
	await expect(search).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	const rows = picker.getByRole('option');
	await expect(rows.first()).toBeVisible();
	const heights = await picker.evaluate(element => [
		element.querySelector('.ash-chat-model-picker-auto > .ash-switch')!,
		...element.querySelectorAll('.ash-list-row'),
		element.querySelector('.ash-chat-model-picker-footer .ash-button')!,
	].map(row => row.getBoundingClientRect().height));
	expect(heights.every(height => height === 28), JSON.stringify(heights)).toBe(true);
	const edges = await picker.evaluate(element => {
		const model = element.querySelector('.ash-list-row')!.getBoundingClientRect();
		const footer = element.querySelector('.ash-chat-model-picker-footer .ash-button')!.getBoundingClientRect();
		return [model.x, model.right, footer.x, footer.right];
	});
	expect(edges[0]).toBe(edges[2]);
	expect(edges[1]).toBe(edges[3]);
	const chosen = picker.locator('.ash-quick-pick-row-content.picked');
	await expect(chosen).toHaveCount(1);
	const check = chosen.locator('.ash-quick-pick-row-check svg');
	await expect(check).toHaveAttribute('data-ash-icon-id', 'check');
	await expect(check).toBeVisible();
	const chosenBounds = await chosen.boundingBox();
	const checkBounds = await check.boundingBox();
	expect(checkBounds!.width).toBe(16);
	expect(checkBounds!.height).toBe(16);
	expect(Math.abs(checkBounds!.y + 8 - chosenBounds!.y - chosenBounds!.height / 2)).toBeLessThan(1);
	const labels = await picker.locator('.ash-quick-pick-row-label').allTextContents();
	await search.press('ArrowDown');
	await expect(chosen.locator('.ash-quick-pick-row-check')).toBeVisible();
	await search.fill(labels.at(-1)!);
	await expect(rows).toHaveCount(1);
	await search.press('Enter');
	await expect(picker).toBeHidden();
	await expect(selector).toHaveText(labels.at(-1)!);
	await expect(selector).toBeFocused();
	await selector.click();
	await expect(chosen.locator('.ash-quick-pick-row-label')).toHaveText(labels.at(-1)!);
	await picker.getByRole('combobox').press('Escape');
	await expect(selector).toBeFocused();
	for (const [theme, id] of [['Ash Dark', 'ash-dark'], ['Ash High Contrast Dark', 'ash-high-contrast-dark'], ['Ash High Contrast Light', 'ash-high-contrast-light']]) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const themeSearch = page.locator('.ash-quick-pick').getByRole('combobox');
		await themeSearch.fill(theme);
		await themeSearch.press('Enter');
		await expect(page.locator('#app')).toHaveAttribute('data-color-theme', id);
		await selector.click();
		await expect(check).toBeVisible();
		await expect(picker.getByRole('combobox')).toHaveCSS('outline-style', 'none');
		await expect(picker.getByRole('combobox')).toHaveCSS('border-top-width', '0px');
		await picker.getByRole('combobox').press('Escape');
	}
	await selector.click();
	const addModels = picker.getByRole('menuitem', { name: 'Add Models' });
	await addModels.focus();
	await addModels.press('Enter');
	await expect(picker).toBeHidden();
	await expect(page.locator('[data-settings-container]')).toHaveAttribute('data-active-settings-category', 'models');
	const settings = page.locator('.ash-settings-editor');
	for (const name of ['Gemini 3.8 Flash', 'Qwen 3.8 Max', 'Kimi K3', 'DeepSeek V4.1 Flash', 'GLM-5.3']) {
		const show = settings.getByRole('switch', { name: `Show ${name} in model picker`, exact: true });
		await show.focus();
		await show.press('Space');
		await expect(show).not.toHaveAttribute('aria-busy', 'true');
		await expect(show).toBeChecked();
	}
	await page.locator('.ash-modal-editor-close').click();
	await selector.focus();
	await selector.press('Enter');
	await expect(picker.locator('.ash-quick-pick-list-compact-menu')).toHaveClass(/scrolling/);
	const scrollingEdges = await picker.evaluate(element => {
		const row = element.querySelector('.ash-list-row')!.getBoundingClientRect();
		const footer = element.querySelector('.ash-chat-model-picker-footer .ash-button')!.getBoundingClientRect();
		return [row.x, row.right, footer.x, footer.right];
	});
	expect(scrollingEdges[0]).toBe(scrollingEdges[2]);
	expect(scrollingEdges[1]).toBe(scrollingEdges[3]);
	await picker.getByRole('combobox').press('Escape');
});

test('Disconnected model picker explains the empty catalog and opens settings', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'disabled', 'This state requires a disconnected backend.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const selector = page.locator("[data-action-id='ash.chat.input.model'] button");
	await expect(selector).toBeEnabled();
	await expect(selector.locator('.ash-dropdown-menu-indicator')).toHaveCount(0);
	const modeSelector = page.locator("[data-action-id='ash.chat.input.mode'] button");
	const selectorPadding = await selector.evaluate(button => {
		const style = getComputedStyle(button);
		return [style.paddingLeft, style.paddingRight];
	});
	const modePadding = await modeSelector.evaluate(button => {
		const style = getComputedStyle(button);
		return [style.paddingLeft, style.paddingRight];
	});
	expect(selectorPadding).toEqual(modePadding);
	await selector.click();
	const picker = page.getByRole('dialog', { name: 'Choose a chat model' });
	await expectModelPickerAnchored(picker, selector);
	await expect(picker.getByRole('status')).toHaveText('Could not load models');
	await expect(picker.getByText('Set up models in Settings')).toBeVisible();
	await expect(picker.getByRole('combobox')).toHaveCount(0);
	await expect(picker.getByRole('option')).toHaveCount(0);
	const openSettings = picker.getByRole('button', { name: 'Open Settings' });
	await expect(openSettings).toBeFocused();
	await openSettings.press('Escape');
	await expect(picker).toBeHidden();
	await expect(selector).toBeFocused();
	await selector.click();
	await openSettings.click();
	await expect(page.locator('.ash-settings-editor')).toBeVisible();
});

test('Model picker saves Fast and context settings separately from thinking effort', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'required', 'The model catalog requires the product backend.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	// Close the startup editor before checking focus across asynchronous saves.
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	const selector = page.locator("[data-action-id='ash.chat.input.model'] button");
	await selector.focus();
	await selector.press('Enter');
	const picker = page.getByRole('dialog', { name: 'Choose a chat model' });
	await expectModelPickerAnchored(picker, selector);
	const auto = picker.getByRole('switch', { name: 'Auto' });
	if (await auto.isChecked()) {
		await auto.press('Space');
		await expect(auto).not.toHaveAttribute('aria-busy', 'true');
	}
	await expect(picker.getByText(/^GPT-6\.1[- ]Sol$/)).toBeVisible();
	await expect(picker.getByText(/^GPT-6[- ]Luna$/)).toBeVisible();
	const search = picker.getByRole('combobox');
	await search.fill('Astra');
	await search.press('Enter');
	await expect(selector).toHaveText(/^GPT-6[- ]Astra$/);
	await selector.click();
	await search.fill('Astra');
	await search.press('ArrowRight');
	const card = picker.getByRole('region', { name: /^GPT-6[- ]Astra$/ });
	const fast = card.getByRole('switch', { name: 'Fast', exact: true });
	const context = card.getByRole('switch', { name: '1M context', exact: true });
	await expect(fast).toBeFocused();
	await expect(card.getByRole('switch')).toHaveCount(2);
	await expect(card.getByRole('radio')).toHaveCount(0);
	await expect(card).toHaveText('Fast1M');
	const surfaces = await picker.evaluate(element => {
		const main = element.getBoundingClientRect();
		const side = element.querySelector('.ash-chat-model-picker-details-menu')!.getBoundingClientRect();
		return { gap: side.x >= main.right ? side.x - main.right : main.x - side.right };
	});
	expect(surfaces.gap).toBeGreaterThanOrEqual(0);
	expect(surfaces.gap).toBeLessThanOrEqual(5);
	await card.locator('.ash-switch-track').first().click();
	await expect(fast).not.toHaveAttribute('aria-busy', 'true');
	await expect(fast).toBeChecked();
	await expect(fast).toBeFocused();
	await context.focus();
	await context.press('Space');
	await expect(context).not.toHaveAttribute('aria-busy', 'true');
	await expect(context).toBeChecked();
	await expect(context).toBeFocused();
	await expect(card).toHaveText('Fast1M');
	await expect(search).toHaveValue('Astra');
	await context.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help' });
	await expect(help.getByRole('textbox')).toHaveValue(/Right Arrow opens model settings/);
	await help.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(context).toBeFocused();
	await context.press('Alt+F2');
	const view = page.getByRole('dialog', { name: 'Accessible View', exact: true });
	await expect(view.getByRole('textbox')).toHaveValue(/Fast[\s\S]*1M/);
	await expect(view.getByRole('textbox')).not.toHaveValue(/Thinking Level/);
	await view.getByRole('textbox').press('Escape');
	await expect(context).toBeFocused();
	await context.press('Alt+ArrowLeft');
	await expect(search).toBeFocused();
	await search.press('Escape');
	await expect(selector).toBeFocused();
	// Recreate the popup, then save from the full list to exercise active-row restoration.
	await selector.click();
	await search.fill('');
	await picker.getByRole('option', { name: /GPT-6[- ]Astra/ }).hover();
	await search.press('ArrowRight');
	await expect(fast).toBeChecked();
	await expect(context).toBeChecked();
	await context.press('Space');
	await expect(context).not.toHaveAttribute('aria-busy', 'true');
	await expect(context).not.toBeChecked();
	await expect(context).toBeFocused();
	await expect(card).toHaveText('Fast1M');
	await fast.press('Space');
	await expect(fast).not.toHaveAttribute('aria-busy', 'true');
	await expect(fast).not.toBeChecked();
	await fast.press('Escape');
	await selector.click();
	await search.fill('Grok 4.7');
	await search.press('ArrowRight');
	const grokCard = picker.getByRole('region', { name: 'Grok 4.7' });
	await expect(grokCard.getByRole('switch')).toHaveCount(1);
	await expect(grokCard.locator('.ash-chat-model-card-context')).toBeHidden();
	await expect(grokCard).toHaveText('Fast');
	await grokCard.getByRole('switch', { name: 'Fast', exact: true }).press('Escape');
	const effort = page.locator("[data-action-id='ash.chat.input.effort'] button");
	await expect(effort).toHaveText('Default');
	await effort.press('ArrowDown');
	const effortMenu = page.locator('.ash-chat-model-configuration-menu');
	await expectModelPickerAnchored(effortMenu, effort);
	await expect(effortMenu.locator('.ash-chat-model-configuration-heading')).toHaveText('Thinking Level');
	await expect(effortMenu.getByRole('menuitemradio')).toHaveText(['Default', 'Low', 'Medium', 'High', 'Extra High', 'Max']);
	await effortMenu.getByRole('menuitemradio', { name: 'High', exact: true }).click();
	await expect(effort).toHaveText('High');
	await expect(effort).toBeFocused();
	await selector.click();
	const finalPicker = page.getByRole('dialog', { name: 'Choose a chat model' });
	await expect(finalPicker.getByRole('switch', { name: 'Auto' })).not.toBeChecked();
	await expect(finalPicker.locator('.ash-quick-pick-row-content.picked')).toHaveCount(1);
	const autoSwitch = finalPicker.getByRole('switch', { name: 'Auto' });
	await autoSwitch.press('Space');
	await expect(selector).toHaveText('Auto');
	await expect(effort).toHaveCount(0);
	await expect(autoSwitch).toHaveAttribute('aria-checked', 'true');
	await expect(autoSwitch).toBeFocused();
	await expect(finalPicker.getByRole('combobox')).toHaveCount(0);
	await expect(finalPicker.getByRole('option')).toHaveCount(0);
	await expect(finalPicker.getByRole('menuitem', { name: 'Add Models' })).toHaveCount(0);
	await expect(finalPicker.locator('.ash-switch-track')).toBeVisible();
	await autoSwitch.press('Escape');
	await expect(selector).toBeFocused();
	await selector.click();
	await expect(autoSwitch).toBeChecked();
	await expect(autoSwitch).toBeFocused();
	await expect(finalPicker.getByRole('combobox')).toHaveCount(0);
	await autoSwitch.press('Space');
	await expect(autoSwitch).not.toBeChecked();
	await expect(autoSwitch).toBeFocused();
	await expect(finalPicker.getByRole('combobox')).toBeVisible();
	await expect(finalPicker.getByRole('option').first()).toBeVisible();
	await page.getByRole('dialog', { name: 'Choose a chat model' }).getByRole('menuitem', { name: 'Add Models' }).click();
	await expect(page.locator('[data-settings-container]')).toHaveAttribute('data-active-settings-category', 'models');
});

test('Model picker details and keyboard help follow the Chinese display language', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'required', 'The model catalog requires the product backend.');
	const page = workbench.page;
	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('Configure Display Language');
	await page.keyboard.press('Enter');
	const language = page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	await expect(language).toHaveCount(0);
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: '显示辅助侧栏', exact: true }).click();
	}
	const selector = page.locator("[data-action-id='ash.chat.input.model'] button");
	await selector.click();
	const picker = page.getByRole('dialog', { name: '选择聊天模型' });
	const auto = picker.getByRole('switch', { name: '自动' });
	if (await auto.isChecked()) { await auto.press('Space'); }
	const search = picker.getByRole('combobox');
	await search.fill('Astra');
	await search.press('Enter');
	await expect(selector).toHaveText(/^GPT-6[- ]Astra$/);
	await selector.click();
	await search.fill('Astra');
	await search.press('ArrowRight');
	const card = picker.getByRole('region', { name: /^GPT-6[- ]Astra$/ });
	const fast = card.getByRole('switch', { name: '快速', exact: true });
	await expect(fast).toBeFocused();
	await expect(card.getByRole('switch', { name: '1M 上下文', exact: true })).toBeVisible();
	await expect(card.getByRole('radio')).toHaveCount(0);
	await fast.press('Alt+F1');
	const help = page.getByRole('dialog', { name: '无障碍帮助' });
	await expect(help.getByRole('textbox')).toHaveValue(/右方向键进入模型设置/);
	await help.getByRole('button', { name: '关闭', exact: true }).click();
	await expect(fast).toBeFocused();
	await fast.press('Escape');
	await expect(selector).toBeFocused();
});

test('New Chat starts with the last model chosen in the picker', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'required', 'The model catalog requires the product backend.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const selector = page.locator('.ash-chat-pane-host > .ash-chat:not([hidden]) [data-action-id="ash.chat.input.model"] button');
	await expect(selector).toBeEnabled();
	await selector.click();
	const auto = page.getByRole('dialog', { name: 'Choose a chat model' }).getByRole('switch', { name: 'Auto' });
	if (await auto.isChecked()) {
		await auto.press('Space');
		await expect(auto).not.toHaveAttribute('aria-busy', 'true');
	}
	const search = page.getByRole('dialog', { name: 'Choose a chat model' }).getByRole('combobox', { name: 'Choose a chat model' });
	await search.fill('GPT-5.4');
	await search.press('Enter');
	await expect(selector).toHaveText('GPT-5.4');
	await page.locator('.ash-chat-title-actions').getByRole('button', { name: 'New Chat' }).click();
	await expect(selector).toHaveText('GPT-5.4');
});

async function expectModelPickerAnchored(picker: import('@playwright/test').Locator, selector: import('@playwright/test').Locator): Promise<void> {
	const button = await selector.boundingBox();
	const popup = await picker.boundingBox();
	expect(button).not.toBeNull();
	expect(popup).not.toBeNull();
	const verticalGap = Math.min(
		Math.abs(popup!.y + popup!.height - button!.y),
		Math.abs(popup!.y - button!.y - button!.height),
	);
	expect(verticalGap).toBeLessThan(16);
	expect(popup!.x).toBeLessThan(button!.x + button!.width);
	expect(popup!.x + popup!.width).toBeGreaterThan(button!.x);
}

test('Advisor settings and direct questions use one chat command', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'required', 'Advisor configuration requires the product backend.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	await expect(page.locator('.ash-chat-status')).not.toHaveText('Loading chat...');
	const input = page.locator('.ash-chat-input-editor .stanza-editor-input');
	const command = async (text: string): Promise<void> => {
		await input.focus();
		await page.keyboard.press('ControlOrMeta+A');
		await page.keyboard.insertText(text);
		await page.keyboard.press('Escape');
		await page.keyboard.press('Enter');
	};
	await command('/advisor');
	const picker = page.getByRole('dialog', { name: 'Chat settings and advisor model' });
	await expect(picker).toBeVisible();
	await expect(picker.getByPlaceholder('Choose an advisor model or open all settings')).toBeVisible();
	await expect(picker.getByText('Manage Model Connections')).toBeVisible();
	await expect(picker.getByText('GPT-5.6 Sol', { exact: true })).toBeVisible();
	await expect(page.locator('.ash-chat-item-userMessage')).toHaveCount(0);
	await page.keyboard.press('Escape');
	await command('/advisor Check cancellation');
	const status = page.locator('.ash-chat:visible .ash-chat-status');
	await expect(status).toHaveText('Configure an advisor model in Chat Settings before asking for a second opinion');
	await expect(page.locator('.ash-chat-item-userMessage')).toHaveCount(0);
});

test('Model provider key entry uses the App Server and shows only saved status', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'required', 'Model provider keys require the product backend.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	await expect(page.locator('.ash-chat-status')).not.toHaveText('Loading chat...');
	const electron = target.kind === 'electron' ? application as ElectronApplication : undefined;
	const chatInput = page.locator('.ash-chat-input-editor .stanza-editor-input');
	await chatInput.focus();
	await page.keyboard.insertText('/config');
	await page.keyboard.press('Escape');
	await page.keyboard.press('Enter');
	const settings = page.getByRole('dialog', { name: 'Chat settings and advisor model' });
	await settings.locator('input').fill('Manage Model Connections');
	await settings.locator('input').press('Enter');

	const providers = page.getByRole('dialog', { name: 'Model connections' });
	await expect(providers).toBeVisible();
	await providers.locator('input').fill('OpenAI');
	await providers.locator('input').press('Enter');
	const keyEntry = page.getByRole('dialog', { name: 'API key for OpenAI' });
	const keyInput = keyEntry.locator('input[type="password"]');
	await expect(keyInput).toBeVisible();
	await keyInput.fill('ash-smoke-test-key');
	await keyInput.press('Enter');
	await expect(keyEntry).toBeHidden();
	await expect(page.locator('body')).not.toContainText('ash-smoke-test-key');
	if (!electron) await page.getByRole('button', { name: 'OK', exact: true }).click();

	await chatInput.focus();
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.insertText('/config');
	await page.keyboard.press('Escape');
	await page.keyboard.press('Enter');
	const reopened = page.getByRole('dialog', { name: 'Chat settings and advisor model' });
	await reopened.locator('input').fill('Manage Model Connections');
	await reopened.locator('input').press('Enter');
	const savedProviders = page.getByRole('dialog', { name: 'Model connections' });
	await savedProviders.locator('input').fill('OpenAI');
	await expect(savedProviders.getByRole('option', { name: 'Save key for OpenAI API key saved', exact: true })).toBeVisible();
	await expect(savedProviders.getByRole('option', { name: /Use OpenAI/ })).toHaveCount(0);
});


test('Model connections support Chinese labels and keyboard navigation', async ({ target, workbench }) => {
    test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'required', 'Model connections require the product backend.');
    const page = workbench.page;
    if (!await page.locator('.ash-chat-view-pane').isVisible()) {
        await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
    }
    await page.keyboard.press('F1');
    let picker = page.locator('.ash-quick-pick');
    await picker.getByRole('combobox').fill('Configure Display Language');
    await picker.getByRole('combobox').press('Enter');
    picker = page.getByRole('dialog', { name: 'Select Display Language' });
    await picker.getByRole('combobox').fill('简体中文');
    await picker.getByRole('combobox').press('Enter');
    const input = page.locator('.ash-chat-input-editor .stanza-editor-input');
    await input.focus();
    await page.keyboard.insertText('/config');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    picker = page.locator('.ash-quick-pick');
    await picker.getByRole('combobox').fill('管理模型接入');
    await picker.getByRole('combobox').press('Enter');
    const connections = page.getByRole('dialog', { name: '模型接入', exact: true });
    await expect(connections).toBeVisible();
    await expect(connections.getByRole('combobox')).toBeFocused();
    await expect(connections).toContainText('OpenAI');
    await page.keyboard.press('Escape');
    await expect(connections).toBeHidden();
});
