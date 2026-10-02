import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import type { Page } from '@playwright/test';
import type { BrowserWindow, MessageBoxOptions } from 'electron';
import type { PlaywrightApplication } from '../../../automation/playwrightDriver.js';

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
	for (const [command, selector] of [['/marketplace rust tools', '.ash-marketplace'], ['/plugins', '.ash-marketplace'], ['/skills', '.ash-skills'], ['/lsp rust', '.ash-language-servers'], ['/marketplace', '.ash-marketplace'], ['/lsp', '.ash-language-servers']]) {
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
		if (command === '/lsp rust') { await expect(page.locator(selector).getByLabel('Language ID', { exact: true })).toHaveValue('rust'); }
		// Opening a command surface can finish after it first becomes visible.
		await editor.waitForEditorContents(text => text === '');
	}
	await expect(page.locator('.ash-chat-item-userMessage')).toHaveCount(0);
	const lsp = page.locator('.ash-language-servers');
	await lsp.getByLabel('Language ID', { exact: true }).focus();
	await expectHelp(page, application, 'Language servers help', () => page.keyboard.press('Alt+F1'));
	await expect(lsp.getByLabel('Language ID', { exact: true })).toBeFocused();
	if (target.appServerMode === 'required') {
		await expect(lsp.getByRole('button', { name: 'Save server configuration', exact: true })).toBeEnabled();
		await lsp.getByLabel('Server ID', { exact: true }).fill('rust-analyzer');
		await lsp.getByLabel('Server ID', { exact: true }).press('Tab');
		await lsp.getByLabel('Enable server', { exact: true }).uncheck();
		await lsp.getByRole('button', { name: 'Save server configuration', exact: true }).click();
		await expect(lsp.getByLabel('Language servers', { exact: true })).toHaveValue('rust-analyzer');
		await expect(lsp.getByRole('button', { name: 'Use default configuration', exact: true })).toBeEnabled();
		await lsp.getByRole('button', { name: 'Refresh', exact: true }).click();
		await expect(lsp.getByLabel('Enable server', { exact: true })).not.toBeChecked();
		await lsp.getByRole('button', { name: 'Use default configuration', exact: true }).click();
		await expect(lsp.getByRole('button', { name: 'Use default configuration', exact: true })).toBeDisabled();
	}
});
