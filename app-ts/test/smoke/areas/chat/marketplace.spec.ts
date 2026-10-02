import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import type { Page } from '@playwright/test';
import type { BrowserWindow, MessageBoxOptions } from 'electron';
import type { PlaywrightApplication } from '../../../automation/playwrightDriver.js';

test.beforeEach(async ({ target, workbench }) => {
	if (target.workbenchMode === 'code') {
		// Fresh profiles restore Welcome after startup services; earlier input can be replaced during restoration.
		await expect(workbench.page.getByRole('tab', { name: 'Welcome', exact: true })).toBeVisible();
	}
});

async function expectHelp(page: Page, application: PlaywrightApplication, title: string, open: () => Promise<unknown>): Promise<void> {
	if (!('windows' in application)) {
		await open();
		await expect(page.getByRole('dialog', { name: title, exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		return;
	}
	await application.evaluate(({ dialog }) => {
		const original = dialog.showMessageBox.bind(dialog);
		const state = globalThis as typeof globalThis & { ashMarketplaceHelp?: { title?: string; finish?: () => void; restore: () => void } };
		state.ashMarketplaceHelp = { restore: () => { dialog.showMessageBox = original; } };
		dialog.showMessageBox = ((...args: [MessageBoxOptions] | [BrowserWindow, MessageBoxOptions]) => new Promise(resolve => {
			state.ashMarketplaceHelp!.title = (args.length === 1 ? args[0] : args[1]).title;
			state.ashMarketplaceHelp!.finish = () => resolve({ response: 0, checkboxChecked: false });
		})) as typeof dialog.showMessageBox;
	});
	try {
		await open();
		await expect.poll(() => application.evaluate(() => (globalThis as typeof globalThis & { ashMarketplaceHelp?: { title?: string } }).ashMarketplaceHelp?.title)).toBe(title);
	} finally {
		await application.evaluate(() => {
			const state = (globalThis as typeof globalThis & { ashMarketplaceHelp?: { finish?: () => void; restore: () => void } }).ashMarketplaceHelp;
			state?.finish?.();
			state?.restore();
		});
	}
}

test('Skills command opens Settings after the Skills sidebar is removed', async ({ target, application, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	const page = workbench.page;
	await new QuickAccess(page).runCommand('ash.skills.open');
	const settings = page.locator('.ash-settings-editor');
	await expect(settings).toBeVisible();
	const skills = settings.locator('.ash-skills');
	await expect(skills).toBeVisible();
	await expect(page.getByRole('tab', { name: 'Skills', exact: true })).toHaveCount(0);
	const helpButton = skills.getByRole('button', { name: 'Help', exact: true });
	await expectHelp(page, application, 'Skills help', () => helpButton.click());
	await expect(helpButton).toBeFocused();
	await page.locator('.ash-modal-editor-close').click();
});

test('Marketplace view tab uses the extensions icon', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	const page = workbench.page;
	if (!await page.getByRole('region', { name: 'Primary sidebar' }).isVisible()) {
		await page.getByRole('button', { name: 'Show Primary Side Bar', exact: true }).click();
	}
	const marketplaceTab = page.getByRole('tab', { name: 'Marketplace', exact: true });
	await expect(marketplaceTab.locator('svg[data-ash-icon-id="extensions"]')).toBeVisible();
	await marketplaceTab.click();
	await expect(page.locator('.ash-marketplace')).toBeVisible();
	await expect(marketplaceTab).toHaveAttribute('aria-selected', 'true');
});

test('Marketplace slash commands open their Workbench owners without sending a chat message', async ({ target, application, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const input = page.locator('.ash-chat-input-editor .stanza-editor-input');
	const editor = new Editor(page.locator('.ash-chat-input-editor'));
	for (const [command, selector] of [['/marketplace rust tools', '.ash-marketplace'], ['/plugins', '.ash-marketplace'], ['/skills', '.ash-skills'], ['/lsp rust', '.ash-language-server-settings'], ['/marketplace', '.ash-marketplace'], ['/lsp', '.ash-language-server-settings']]) {
		await input.focus();
		await page.keyboard.press('ControlOrMeta+A');
		await page.keyboard.insertText(command);
		await page.keyboard.press('Escape');
		await expect(page.locator('[data-action-id="ash.chat.input.send"] button')).toBeEnabled();
		await page.keyboard.press('Enter');
		await expect(page.locator(selector)).toBeVisible();
		if (command === '/skills') {
			await expect(page.locator('.ash-settings-editor')).toBeVisible();
			await expect(page.getByRole('tab', { name: 'Skills', exact: true })).toHaveCount(0);
			await page.locator('.ash-modal-editor-close').click();
		}
		if (command === '/plugins') { await expect(page.locator(selector).getByLabel('Package list', { exact: true })).toHaveValue('installed'); }
		if (command === '/marketplace rust tools') { await expect(page.locator(selector).getByLabel('Search packages', { exact: true })).toHaveValue('rust tools'); }
		if (command === '/marketplace') { await expect(page.locator(selector).getByLabel('Search packages', { exact: true })).toHaveValue(''); }
		if (command.startsWith('/lsp')) {
			await expect(page.locator('.ash-settings-editor')).toBeVisible();
			await expect(page.locator('[data-settings-container]')).toHaveAttribute('data-active-settings-category', 'editor');
			await expect(page.getByRole('tab', { name: 'Language servers', exact: true })).toHaveCount(0);
			if (command === '/lsp rust') {
				await expect(page.locator(selector).getByLabel('Language ID', { exact: true })).toHaveValue('rust');
				await page.locator('.ash-modal-editor-close').click();
			}
		}
		// Opening a command surface can finish after it first becomes visible.
		await editor.waitForEditorContents(text => text === '');
	}
	await expect(page.locator('.ash-chat-item-userMessage')).toHaveCount(0);
	const lsp = page.locator('.ash-language-server-settings');
	await expect(lsp).toHaveAttribute('aria-busy', 'false');
	await expect(lsp.getByLabel('Language ID', { exact: true })).toBeEnabled();
	await lsp.getByLabel('Language ID', { exact: true }).focus();
	await expect(lsp.getByLabel('Language ID', { exact: true })).toBeFocused();
	await page.keyboard.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/Language Servers[\s\S]*Logs and startup failures are in Output/);
	await help.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(lsp.getByLabel('Language ID', { exact: true })).toBeFocused();
	if (target.appServerMode === 'required') {
		await expect(lsp).toHaveAttribute('aria-busy', 'false');
		await lsp.getByLabel('Server ID', { exact: true }).fill('rust-analyzer');
		await lsp.getByLabel('Server ID', { exact: true }).press('Tab');
		await lsp.getByLabel('Enable server', { exact: true }).uncheck();
		await expect(lsp.getByRole('button', { name: 'Save server configuration', exact: true })).toBeEnabled();
		await lsp.getByRole('button', { name: 'Save server configuration', exact: true }).click();
		await expect(lsp.getByRole('combobox', { name: 'Language servers', exact: true })).toContainText('rust-analyzer');
		await expect(lsp.getByRole('button', { name: 'Use default configuration', exact: true })).toBeEnabled();
		await lsp.getByRole('button', { name: 'Refresh', exact: true }).click();
		await expect(lsp.getByLabel('Enable server', { exact: true })).not.toBeChecked();
		await lsp.getByRole('button', { name: 'Use default configuration', exact: true }).click();
		await expect(lsp).toHaveAttribute('aria-busy', 'false');
		await expect(lsp.getByRole('button', { name: 'Use default configuration', exact: true })).toBeDisabled();
	}
});

test('Language server Settings replaces the sidebar and saves backend configuration', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.languageServers.open');
	const settings = page.locator('.ash-settings-editor');
	const lsp = settings.locator('.ash-language-server-settings');
	await expect(lsp).toBeVisible();
	await expect(settings.locator('[data-settings-container]')).toHaveAttribute('data-active-settings-category', 'editor');
	await expect(page.getByRole('tab', { name: 'Language servers', exact: true })).toHaveCount(0);
	await expect(settings.getByRole('heading', { name: 'Language Servers', exact: true })).toBeInViewport();
	await expect(lsp).toHaveAttribute('aria-busy', 'false');
	if (target.appServerMode === 'required') {
		await expect(lsp.getByRole('status')).not.toContainText('Could not load');
		await lsp.getByLabel('Server ID', { exact: true }).fill('rust-analyzer');
		await lsp.getByLabel('Enable server', { exact: true }).uncheck();
		await lsp.getByRole('button', { name: 'Save server configuration', exact: true }).click();
		await expect(lsp.getByRole('button', { name: 'Use default configuration', exact: true })).toBeEnabled();
		await expect(lsp.getByRole('combobox', { name: 'Language servers', exact: true })).toContainText('rust-analyzer');
		await lsp.getByRole('button', { name: 'Refresh', exact: true }).click();
		await expect(lsp).toHaveAttribute('aria-busy', 'false');
		await expect(lsp.getByLabel('Enable server', { exact: true })).not.toBeChecked();
		await lsp.getByRole('button', { name: 'Use default configuration', exact: true }).click();
		await expect(lsp).toHaveAttribute('aria-busy', 'false');
		await expect(lsp.getByRole('button', { name: 'Use default configuration', exact: true })).toBeDisabled();
	}
	await settings.locator('[data-settings-category-id="general"]').click();
	const locale = settings.locator('[data-settings-item-id="workbench.locale"]').getByRole('combobox');
	await locale.click();
	await page.getByRole('option', { name: '简体中文', exact: true }).click();
	await page.locator('.ash-modal-editor-close').click();
	await workbench.quickaccess.runCommand('ash.languageServers.open');
	await expect(settings.getByRole('heading', { name: '语言服务器', exact: true })).toBeInViewport();
	await expect(lsp).toHaveAttribute('aria-busy', 'false');
	await lsp.getByLabel('语言 ID', { exact: true }).fill('python');
	await lsp.getByRole('button', { name: '在 Marketplace 中查找语言服务器', exact: true }).click();
	await expect(settings).toBeHidden();
	await expect(page.locator('.ash-marketplace').getByLabel('Language server for language ID')).toHaveValue('python');
});
