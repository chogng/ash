import type { ElectronApplication } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';

test('Desktop model picker shows fixed models before account setup', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'required', 'The model catalog requires the product backend.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	await expect(page.locator('.ash-chat-status')).not.toHaveText('Loading chat...');
	const selector = page.locator("[data-action-id='ash.chat.input.model'] button");
    const electron = target.kind === 'electron' && process.platform === 'darwin' ? application as ElectronApplication : undefined;
    if (electron) {
        await electron.evaluate(({ Menu }) => {
            Menu.prototype.popup = function (options) {
                const models = this.items.flatMap(item => item.submenu?.items ?? []);
                (globalThis as typeof globalThis & { ashModelLabels?: string[] }).ashModelLabels = models.map(item => item.label);
                models.find(item => item.label === 'GPT-5.6 Sol')?.click();
                options?.callback?.();
            };
        });
    }
    await expect(selector).toBeEnabled();
    await selector.click();
    if (electron) {
        await expect.poll(() => electron.evaluate(() => (globalThis as typeof globalThis & { ashModelLabels?: string[] }).ashModelLabels ?? [])).toEqual(expect.arrayContaining(['GPT-5.6 Sol', 'GPT-6 Astra', 'GPT-5.4']));
    } else {
        await page.getByRole('menuitem', { name: 'openai', exact: true }).hover();
        const menu = page.getByRole('menu').last();
        await expect(menu.getByRole('menuitemcheckbox', { name: 'GPT-5.6 Sol', exact: true })).toBeVisible();
        await expect(menu.getByRole('menuitemcheckbox', { name: 'GPT-6 Astra', exact: true })).toBeVisible();
        await expect(menu.getByRole('menuitemcheckbox', { name: 'GPT-5.4', exact: true })).toBeVisible();
        await expect(menu.locator('.ash-menu-badge')).toHaveCount(0);
        await menu.getByRole('menuitemcheckbox', { name: 'GPT-5.6 Sol', exact: true }).click();
    }
    await expect(selector).toHaveText('GPT-5.6 Sol');
	await expect(page.locator('.ash-chat-input-model-access-badge')).toHaveCount(0);
});

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
    if (electron) {
        await electron.evaluate(({ dialog }) => {
            dialog.showMessageBox = (async (...args: unknown[]) => {
                const options = args[args.length - 1] as { message: string };
                (globalThis as typeof globalThis & { ashConnectionMessages?: string[] }).ashConnectionMessages ??= [];
                (globalThis as typeof globalThis & { ashConnectionMessages: string[] }).ashConnectionMessages.push(options.message);
                return { response: 0, checkboxChecked: false };
            }) as typeof dialog.showMessageBox;
        });
    }
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
	await expect(savedProviders.getByRole('option', { name: 'Use OpenAI Current connection · Ready', exact: true })).toBeVisible();
	await savedProviders.locator('input').fill('Use OpenAI');
	await savedProviders.locator('input').press('Enter');
	if (electron) {
        await expect.poll(() => electron.evaluate(() => (globalThis as typeof globalThis & { ashConnectionMessages?: string[] }).ashConnectionMessages ?? [])).toContain('Current connection: OpenAI. Applies to the next turn.');
    } else {
        await expect(page.getByText('Current connection: OpenAI. Applies to the next turn.', { exact: true })).toBeVisible();
    }
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
