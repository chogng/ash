import { expect, test } from '../../../automation/test.js';

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

test('Marketplace slash commands open their Workbench owners without sending a chat message', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const input = page.locator('.ash-chat-input-editor .stanza-editor-input');
	for (const [command, selector] of [['/marketplace rust tools', '.ash-marketplace'], ['/plugins', '.ash-marketplace'], ['/skills', '.ash-skills'], ['/lsp rust', '.ash-language-servers'], ['/marketplace', '.ash-marketplace'], ['/lsp', '.ash-language-servers']]) {
		await input.focus();
		await page.keyboard.press('ControlOrMeta+A');
		await page.keyboard.insertText(command);
		await page.keyboard.press('Escape');
		await page.keyboard.press('Enter');
		await expect(page.locator(selector)).toBeVisible();
		if (command === '/plugins') { await expect(page.locator(selector).getByLabel('Package list', { exact: true })).toHaveValue('installed'); }
		if (command === '/marketplace rust tools') { await expect(page.locator(selector).getByLabel('Search packages', { exact: true })).toHaveValue('rust tools'); }
		if (command === '/marketplace') { await expect(page.locator(selector).getByLabel('Search packages', { exact: true })).toHaveValue(''); }
		if (command === '/lsp rust') { await expect(page.locator(selector).getByLabel('Language ID', { exact: true })).toHaveValue('rust'); }
	}
	await expect(page.locator('.ash-chat-item-userMessage')).toHaveCount(0);
	const lsp = page.locator('.ash-language-servers');
	await lsp.getByLabel('Language ID', { exact: true }).focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.getByRole('dialog', { name: 'Language servers help' })).toBeVisible();
	await page.keyboard.press('Escape');
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
