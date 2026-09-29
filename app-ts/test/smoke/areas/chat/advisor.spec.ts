import type { ElectronApplication } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';

test('Disconnected model picker explains the empty catalog and opens settings', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'disabled', 'This state requires a disconnected backend.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const selector = page.locator("[data-action-id='ash.chat.input.model'] button");
	await expect(selector).toBeEnabled();
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

test('Desktop model picker searches fixed models before account setup', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'required', 'The model catalog requires the product backend.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	await expect(page.locator('.ash-chat-status')).not.toHaveText('Loading chat...');
	const selector = page.locator("[data-action-id='ash.chat.input.model'] button");
	await expect(selector).toBeEnabled();
	await selector.click();
	const picker = page.getByRole('dialog', { name: 'Choose a chat model' });
	await expectModelPickerAnchored(picker, selector);
	await expect(picker.getByText('GPT-5.6 Sol', { exact: true })).toBeVisible();
	await expect(picker.getByText('GPT-6 Astra', { exact: true })).toBeVisible();
	await expect(picker.getByText('GPT-5.4', { exact: true })).toBeVisible();
	const activeRow = picker.locator('.ash-quick-pick-list-menu .ash-list-row.is-active');
	await expect(activeRow).toBeVisible();
	const activeColors = await activeRow.evaluate(row => {
		const probe = row.ownerDocument.createElement('span');
		probe.style.backgroundColor = 'var(--ash-menu-selection-background)';
		row.append(probe);
		const colors = {
			foreground: getComputedStyle(row).color,
			label: getComputedStyle(row.querySelector('.ash-quick-pick-row-label')!).color,
			background: getComputedStyle(row).backgroundColor,
			menuBackground: getComputedStyle(probe).backgroundColor,
		};
		probe.remove();
		return colors;
	});
	expect(activeColors.label).toBe(activeColors.foreground);
	expect(activeColors.background).toBe(activeColors.menuBackground);
	await picker.getByRole('option', { name: /GPT-6 Astra/ }).hover();
	const detailsMenu = picker.getByRole('region', { name: 'GPT-6 Astra' });
	await expect(detailsMenu).toBeVisible();
	await expect(detailsMenu).toContainText('GPT-6 Astra');
	const menuStyles = await detailsMenu.evaluate(element => {
		const menu = element.closest('.ash-context-view-menu')!;
		const detailsStyle = getComputedStyle(element);
		const menuStyle = getComputedStyle(menu);
		return {
			background: detailsStyle.backgroundColor === menuStyle.backgroundColor,
			foreground: detailsStyle.color === menuStyle.color,
			borderWidth: detailsStyle.borderTopWidth,
			pointerEvents: detailsStyle.pointerEvents,
		};
	});
	expect(menuStyles).toEqual({ background: true, foreground: true, borderWidth: '1px', pointerEvents: 'auto' });
	const detailsBounds = await detailsMenu.boundingBox();
	const pickerBounds = await picker.boundingBox();
	expect(detailsBounds).not.toBeNull();
	expect(pickerBounds).not.toBeNull();
	expect(detailsBounds!.x + detailsBounds!.width <= pickerBounds!.x || detailsBounds!.x >= pickerBounds!.x + pickerBounds!.width).toBe(true);
	await detailsMenu.hover();
	await expect(detailsMenu).toBeVisible();
	await expect(picker.getByRole('switch', { name: 'Auto' })).toBeVisible();
	await picker.getByRole('combobox', { name: 'Choose a chat model' }).fill('GPT-6 Astra');
	await expect(picker.getByRole('option', { name: /GPT-6 Astra/ })).toBeVisible();
	await picker.getByRole('option', { name: /GPT-6 Astra/ }).click();
	await expect(selector).toHaveText('GPT-6 Astra');
	await expect(page.locator('.ash-chat-input-model-access-badge')).toHaveCount(0);
	const effort = page.locator("[data-action-id='ash.chat.input.effort'] button");
	await expect(effort).toHaveText('Default');
	await expect(effort).toHaveAttribute('aria-label', 'Thinking Effort: Default');
	await effort.press('ArrowDown');
	const effortMenu = page.locator('.ash-chat-model-configuration-menu');
	await expect(effortMenu).toBeVisible();
	await expectModelPickerAnchored(effortMenu, effort);
	await expect(effortMenu.locator('.ash-chat-model-configuration-heading')).toHaveText('Thinking Level');
	await expect(effortMenu.getByRole('menuitemradio')).toHaveText(['Default', 'Low', 'Medium', 'High', 'Extra High', 'Max']);
	await expect(effortMenu.getByRole('menuitemradio', { name: 'Default' })).toHaveAttribute('aria-checked', 'true');
	await effortMenu.getByRole('menuitemradio', { name: 'High', exact: true }).click();
	await expect(effortMenu).toBeHidden();
	await expect(effort).toHaveText('High');
	await expect(effort).toBeFocused();
	await effort.click();
	await expect(effortMenu.getByRole('menuitemradio', { name: 'High', exact: true })).toHaveAttribute('aria-checked', 'true');
	await effortMenu.getByRole('menuitemradio', { name: 'High', exact: true }).press('Escape');
	await expect(effort).toBeFocused();
	await effort.press('Alt+F1');
	const effortHelp = page.getByRole('dialog', { name: 'Accessibility Help' });
	await expect(effortHelp.getByRole('textbox', { name: 'Accessibility Help' })).toHaveValue(/Thinking level menu/);
	await effortHelp.getByRole('button', { name: 'Close' }).click();
	await expect(effort).toBeFocused();
	await selector.click();
	const search = page.getByRole('dialog', { name: 'Choose a chat model' }).getByRole('combobox', { name: 'Choose a chat model' });
	await expect(page.getByRole('button', { name: 'GPT-6 Astra Details' })).toHaveCount(0);
	await expect(page.getByRole('combobox', { name: 'Thinking Effort' })).toHaveCount(0);
	await search.fill('GPT-5.6 Sol');
	await search.press('Enter');
	await expect(selector).toHaveText('GPT-5.6 Sol');
	await expect(effort).toHaveText('Medium');
	await effort.click();
	const defaultLevel = effortMenu.getByRole('menuitemradio', { name: 'Medium', exact: true });
	await expect(defaultLevel).toHaveAttribute('aria-checked', 'true');
	await expect(defaultLevel).toHaveAttribute('aria-description', 'Default');
	await expect(defaultLevel).toContainText('Default');
	await effortMenu.getByRole('menuitemradio', { name: 'High', exact: true }).click();
	await expect(effort).toHaveText('High');
	await effort.click();
	await defaultLevel.click();
	await expect(effort).toHaveText('Medium');
	await selector.click();
	await search.fill('GPT-5.4');
	await search.press('Enter');
	await expect(selector).toHaveText('GPT-5.4');
	await selector.click();
	await page.getByRole('dialog', { name: 'Choose a chat model' }).getByRole('combobox', { name: 'Choose a chat model' }).press('Escape');
	await expect(selector).toHaveAttribute('aria-expanded', 'false');
	await selector.click();
	const finalPicker = page.getByRole('dialog', { name: 'Choose a chat model' });
	await expect(finalPicker.getByRole('switch', { name: 'Auto' })).not.toBeChecked();
	await expect(finalPicker.locator('.ash-chat-model-picker-current')).toHaveCount(1);
	await finalPicker.getByRole('switch', { name: 'Auto' }).click();
	await expect(selector).toHaveText('Auto');
	await expect(effort).toHaveCount(0);
	await selector.click();
	await page.getByRole('dialog', { name: 'Choose a chat model' }).getByRole('button', { name: 'Add Models' }).click();
	await expect(page.locator('[data-settings-container]')).toHaveAttribute('data-active-settings-category', 'models');
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
