import type { ElectronApplication } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';

test('Model options combine thinking effort and context size and save the context choice', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const model = page.locator(".ash-chat-input-model-action");
	await model.click();
	const picker = page.getByRole('dialog', { name: 'Choose a chat model' });
	const auto = picker.getByRole('switch', { name: 'Auto' });
	if (await auto.isChecked()) {
		await auto.press('Space');
		await expect(auto).not.toHaveAttribute('aria-busy', 'true');
	}
	const search = picker.getByRole('combobox');
	await search.fill('Astra');
	await search.press('Enter');
	await expect(model).toHaveText(/^GPT-6[- ]Astra$/);
	const configuration = page.locator(".ash-chat-input-configuration-action");
	await expect(configuration).not.toContainText(/\d/u);
	await configuration.press('ArrowDown');
	const menu = page.locator('.ash-chat-model-configuration-menu');
	await expect(menu.locator('.ash-chat-model-configuration-heading')).toHaveText(['Thinking Level', 'Context Size']);
	await expect(menu.getByRole('separator')).toHaveCount(1);
	const high = menu.getByRole('menuitemradio', { name: 'High', exact: true });
	await high.click();
	await expect(menu).toBeHidden();
	await expect(configuration).toHaveText('High');
	await configuration.press('ArrowDown');
	await menu.getByRole('menuitemradio', { name: 'Long context on', exact: true }).click();
	await expect(menu).toBeHidden();
	await expect(configuration).toHaveText('High');
	await expect(configuration).toBeFocused();
	await configuration.press('ArrowDown');
	await expect(high).toHaveAttribute('aria-checked', 'true');
	await expect(menu.getByRole('menuitemradio', { name: 'Long context on', exact: true })).toHaveAttribute('aria-checked', 'true');
	await expect(menu.locator('.ash-menu-badge')).toHaveCount(0);
	await page.keyboard.press('Escape');
	await configuration.press('ArrowDown');
	await menu.getByRole('menuitemradio', { name: 'Long context off', exact: true }).click();
	await expect(menu).toBeHidden();
	await expect(configuration).toHaveText('High');
	await expect(configuration).toBeFocused();
});

test('Model visibility changes in Settings refresh the existing Chat catalog', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const selector = page.locator('.ash-chat-input-model-action');
	await selector.press('Enter');
	const picker = page.getByRole('dialog', { name: 'Choose a chat model' });
	const auto = picker.getByRole('switch', { name: 'Auto' });
	if (await auto.isChecked()) {
		await auto.press('Space');
		await expect(auto).not.toHaveAttribute('aria-busy', 'true');
	}
	await picker.getByRole('menuitem', { name: 'Add Models' }).click();
	await expect(page.locator('[data-settings-container]')).toHaveAttribute('data-active-settings-category', 'models');
	const visible = page.locator('.ash-settings-editor').getByRole('switch', { name: 'Show Gemini 3.8 Flash in model picker', exact: true });
	await visible.press('Space');
	await expect(visible).not.toHaveAttribute('aria-busy', 'true');
	await expect(visible).toBeChecked();
	await page.locator('.ash-modal-editor-close').click();
	await selector.press('Enter');
	await picker.getByRole('combobox').fill('Gemini 3.8 Flash');
	await picker.getByRole('combobox').press('Enter');
	await expect(selector).toHaveText('Gemini 3.8 Flash');
	await expect(selector).toBeFocused();
});

test('Disconnected model picker explains the empty catalog and opens settings', { tag: ['@browser-ui', '@electron-ui'] }, async ({ target, workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const selector = page.locator(".ash-chat-input-model-action");
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
	await expect(picker.getByRole('menuitemradio')).toHaveCount(0);
	const openSettings = picker.getByRole('button', { name: 'Open Settings' });
	await expect(openSettings).toBeFocused();
	await openSettings.press('Escape');
	await expect(picker).toBeHidden();
	await expect(selector).toBeFocused();
	await selector.click();
	await openSettings.click();
	await expect(page.locator('.ash-settings-editor')).toBeVisible();
});

test('Model catalog descriptions reach keyboard help and accessible view', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await workbench.quickaccess.runCommand('workbench.action.toggleAuxiliaryBar');
	}
	const selector = page.locator('.ash-chat-input-model-action');
	await selector.press('Enter');
	const picker = page.getByRole('dialog', { name: 'Choose a chat model' });
	await expectModelPickerAnchored(picker, selector);
	const auto = picker.getByRole('switch', { name: 'Auto' });
	if (await auto.isChecked()) {
		await auto.press('Space');
		await expect(auto).not.toHaveAttribute('aria-busy', 'true');
	}
	const search = picker.getByRole('combobox');
	await search.fill('Astra');
	await search.press('ArrowRight');
	const card = picker.getByRole('region', { name: /^GPT-6[- ]Astra$/ });
	const description = 'Frontier intelligence for the most demanding work.';
	await expect(card).toBeFocused();
	await expect(card).toHaveText(description);
	await expect(card).toHaveAttribute('aria-description', new RegExp(description));
	await card.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help' });
	await expect(help.getByRole('textbox')).toHaveValue(/Right Arrow reads the model description/);
	await help.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(card).toBeFocused();
	await card.press('Alt+F2');
	const view = page.getByRole('dialog', { name: 'Accessible View', exact: true });
	await expect(view.getByRole('textbox')).toHaveValue(new RegExp(description));
	await view.getByRole('textbox').press('Escape');
	await expect(card).toBeFocused();
	await card.press('Escape');
	await expect(selector).toBeFocused();
	const effort = page.locator('.ash-chat-input-configuration-action');
	await selector.click();
	const finalPicker = page.getByRole('dialog', { name: 'Choose a chat model' });
	await expect(finalPicker.getByRole('switch', { name: 'Auto' })).not.toBeChecked();
	await expect(finalPicker.locator('[role=menuitemradio][aria-checked=true]')).toHaveCount(1);
	const autoSwitch = finalPicker.getByRole('switch', { name: 'Auto' });
	await autoSwitch.press('Space');
	await expect(selector).toHaveText('Auto');
	await expect(effort).toBeHidden();
	await expect(autoSwitch).toHaveAttribute('aria-checked', 'true');
	await expect(autoSwitch).toBeFocused();
	await autoSwitch.press('Escape');
	await expect(selector).toBeFocused();
});

test('Model picker details and keyboard help follow the Chinese display language', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench, restartWorkbench }) => {
	let page = workbench.page;
	await page.keyboard.press('F1');
	await page.locator('.ash-quick-pick').getByRole('combobox').fill('Configure Display Language');
	await page.keyboard.press('Enter');
	const language = page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	await expect(language).toHaveCount(0);
	({ workbench } = await restartWorkbench());
	page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: '显示辅助侧栏', exact: true }).click();
	}
	const selector = page.locator(".ash-chat-input-model-action");
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
	await expect(card).toBeFocused();
	await expect(card).toHaveText('Frontier intelligence for the most demanding work.');
	await expect(card.getByRole('switch')).toHaveCount(0);
	await card.press('Alt+F1');
	const help = page.getByRole('dialog', { name: '无障碍帮助' });
	await expect(help.getByRole('textbox')).toHaveValue(/右方向键阅读模型描述/);
	await help.getByRole('button', { name: '关闭', exact: true }).click();
	await expect(card).toBeFocused();
	await card.press('Escape');
	await expect(selector).toBeFocused();
});

test('New Chat starts with the last model chosen in the picker', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const selector = page.locator('.ash-chat-pane-host > .ash-chat:not([hidden]) .ash-chat-input-model-action');
	await expect(selector).toBeEnabled();
	await selector.click();
	const auto = page.getByRole('dialog', { name: 'Choose a chat model' }).getByRole('switch', { name: 'Auto' });
	if (await auto.isChecked()) {
		await auto.press('Space');
		await expect(auto).not.toHaveAttribute('aria-busy', 'true');
	}
	const search = page.getByRole('dialog', { name: 'Choose a chat model' }).getByRole('combobox', { name: 'Choose a chat model' });
	const picker = page.getByRole('dialog', { name: 'Choose a chat model' });
	const currentName = await selector.textContent();
	// Catalog names change. Retain a different enabled row's identity before
	// selection reorders the picker, then assert New Chat preserves that choice.
	const options = picker.getByRole('menuitemradio').filter({ visible: true });
	await expect(options.first()).toBeVisible();
	const names = await options.locator('.ash-icon-label-text').allTextContents();
	const chosen = names.find(name => name !== currentName);
	expect(chosen).toBeTruthy();
	await search.fill(chosen!);
	await search.press('Enter');
	await expect(selector).toHaveText(chosen!);
	await page.locator('.ash-chat-title-actions').getByRole('button', { name: 'New Chat' }).click();
	await expect(selector).toHaveText(chosen!);
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

test('Advisor settings and direct questions use one chat command', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench }) => {
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
	await expect(picker.getByText('GPT-6.1 Sol', { exact: true })).toBeVisible();
	await expect(page.locator('.ash-chat-item-userMessage')).toHaveCount(0);
	await page.keyboard.press('Escape');
	await command('/advisor Check cancellation');
	const status = page.locator('.ash-chat:visible .ash-chat-status');
	await expect(status).toHaveText('Configure an advisor model in Chat Settings before asking for a second opinion');
	await expect(page.locator('.ash-chat-item-userMessage')).toHaveCount(0);
});

test('Model provider key entry uses the App Server and shows only saved status', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ application, target, workbench }) => {
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


test('Model connections support Chinese labels and keyboard navigation', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench, restartWorkbench }) => {
	let page = workbench.page;
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
	({ workbench } = await restartWorkbench());
	page = workbench.page;
	picker = page.locator('.ash-quick-pick');
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
