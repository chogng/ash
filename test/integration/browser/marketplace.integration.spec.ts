import { expect, test } from '@playwright/test';

for (const [locale, installTitle, manageTitle, enable, grant, permission, disable, revoke, uninstall] of [
	['en', 'Install extension from workspace', 'Manage local extensions', 'Enable', 'Grant permissions', 'Read workspace files', 'Disable', 'Revoke permissions', 'Uninstall'],
	['zh-CN', '从工作区安装扩展', '管理本地扩展', '启用', '授予权限', '读取工作区文件', '禁用', '撤销权限', '卸载'],
]) {
	test(`Local SDK extension installation and permission review work in ${locale}`, async ({ page }) => {
		await page.goto(`/marketplace.html?locale=${locale}`);
		await page.evaluate(() => window.ashMarketplaceIntegration.startCommand('ash.extensions.installLocal'));
		const installation = page.getByRole('dialog', { name: installTitle, exact: true });
		await expect(installation).toContainText('.ash-plugin/plugin.json');
		await installation.getByRole('textbox').fill('.build/extension-sdk');
		await installation.getByRole('textbox').press('Enter');
		const installedMessage = page.getByRole('dialog').filter({ hasText: 'acme/sdk 1.0.0' });
		await expect(installedMessage).toBeVisible();
		await page.keyboard.press('Enter');
		await page.evaluate(() => window.ashMarketplaceIntegration.waitCommand());
		expect(await page.evaluate(() => window.ashMarketplaceIntegration.localPackages().map(({ enabled, granted }) => ({ enabled, granted })))).toEqual([{ enabled: false, granted: false }]);
		const request = await page.evaluate(() => window.ashMarketplaceIntegration.requests.find((entry: any) => entry[0] === 'pluginInstall')) as [string, Record<string, unknown>];
		expect(request[1]).toMatchObject({ expectedRevision: 0, path: '.build/extension-sdk', dirId: null });
		expect(request[1].commandId).toMatch(/^desktop-plugin-install-/u);
		for (const action of [enable, grant]) {
			await page.evaluate(() => window.ashMarketplaceIntegration.startCommand('ash.extensions.manageLocal'));
			const picker = page.getByRole('dialog', { name: manageTitle, exact: true });
			await expect(picker).toContainText('SDK fixture');
			await page.keyboard.press('Enter');
			const review = page.getByRole('dialog', { name: 'SDK fixture', exact: true });
			await expect(review).toContainText(permission);
			await expect(review).toContainText('sha256:' + 'b'.repeat(64));
			await review.getByRole('button', { name: action, exact: true }).click();
			await page.evaluate(() => window.ashMarketplaceIntegration.waitCommand());
		}
		expect(await page.evaluate(() => window.ashMarketplaceIntegration.localPackages().map(({ enabled, granted }) => ({ enabled, granted })))).toEqual([{ enabled: true, granted: true }]);
		for (const action of [disable, revoke, uninstall]) {
			await page.evaluate(() => window.ashMarketplaceIntegration.startCommand('ash.extensions.manageLocal'));
			await expect(page.getByRole('dialog', { name: manageTitle, exact: true })).toBeVisible();
			await page.keyboard.press('Enter');
			const review = page.getByRole('dialog', { name: 'SDK fixture', exact: true });
			if (action !== uninstall) { await expect(review.getByRole('button', { name: uninstall, exact: true })).toHaveCount(0); }
			await review.getByRole('button', { name: action, exact: true }).click();
			await page.evaluate(() => window.ashMarketplaceIntegration.waitCommand());
		}
		expect(await page.evaluate(() => window.ashMarketplaceIntegration.localPackages())).toEqual([]);
		await page.evaluate(() => window.ashMarketplaceIntegration.dispose());
		await expect(page.locator('.ash-quick-input-host')).toHaveCount(0);
	});
}

test('Local extension installation cancellation does not copy or grant a package', async ({ page }) => {
	await page.goto('/marketplace.html');
	await page.evaluate(() => window.ashMarketplaceIntegration.startCommand('ash.extensions.installLocal'));
	await expect(page.getByRole('dialog', { name: 'Install extension from workspace', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.evaluate(() => window.ashMarketplaceIntegration.waitCommand());
	expect(await page.evaluate(() => window.ashMarketplaceIntegration.requests.filter((entry: any) => entry[0].startsWith('plugin')))).toEqual([]);
});

for (const [locale, label, notice] of [
	['en', 'Editor extensions (Open VSX)', 'Installation loads supported themes, syntax and snippets without running scripts. Use Manage Marketplace extension execution to enable and authorize JavaScript separately.'],
	['zh-CN', '编辑器扩展（Open VSX）', '安装时加载受支持的主题、语法和代码片段，不执行脚本。使用“管理市场扩展执行”单独启用和授权 JavaScript。'],
]) {
	test(`Open VSX installation shows the supported scope in ${locale}`, async ({ page }) => {
		await page.goto(`/marketplace.html?locale=${locale}`);
		const view = page.locator('.ash-marketplace');
		await expect(view.getByRole('button', { name: 'Install package', exact: true })).toBeEnabled();
		await view.getByLabel('Capability', { exact: true }).selectOption({ label });
		await expect(view.getByLabel('Package details', { exact: true })).toContainText(notice);
		await view.getByRole('button', { name: 'Install package', exact: true }).click();
		const confirmation = page.getByRole('dialog', { name: 'Install package', exact: true });
		await expect(confirmation).toContainText(notice);
		await expect(confirmation).toContainText('publisher.sample@open-vsx');
		await confirmation.getByRole('button', { name: 'Install', exact: true }).click();
		expect(await page.evaluate(() => window.ashMarketplaceIntegration.requests.filter((entry: any) => entry[0] === 'install'))).toEqual([['install', { packageId: 'publisher.sample@open-vsx', version: '1.0.0' }]]);
		const manageTitle = locale === 'en' ? 'Manage Marketplace extension execution' : '管理市场扩展执行';
		const actions = locale === 'en' ? ['Enable', 'Authorize execution', 'Revoke execution authorization', 'Disable'] : ['启用', '授权执行', '撤销执行授权', '禁用'];
		for (const action of actions) {
			await page.evaluate(() => window.ashMarketplaceIntegration.startCommand('ash.extensions.manageMarketplace'));
			await expect(page.getByRole('dialog', { name: manageTitle, exact: true })).toBeVisible();
			await page.keyboard.press('Enter');
			const review = page.getByRole('dialog', { name: 'publisher.sample@open-vsx', exact: true });
			await expect(review).toContainText(locale === 'en' ? 'A new package version requires new authorization.' : '新版本需要重新授权。');
			await review.getByRole('button', { name: action, exact: true }).click();
			await page.evaluate(() => window.ashMarketplaceIntegration.waitCommand());
		}
		const policyCalls = await page.evaluate(() => window.ashMarketplaceIntegration.requests.filter((entry: any) => entry[0] === 'editorPolicy').map((entry: any) => entry[1]));
		expect(policyCalls.map((call: any) => [call.action, call.expectedRevision])).toEqual([['enable', 1], ['grant', 2], ['revoke', 3], ['disable', 4]]);
		expect(policyCalls.every((call: any) => call.installationId === 'version-one' && call.packageDigest.startsWith('sha256:'))).toBe(true);
		await view.getByRole('button', { name: 'Show installed versions', exact: true }).click();
		await expect(view.getByLabel('Packages', { exact: true })).toHaveValue('version-one');
		await view.getByRole('button', { name: 'Uninstall package', exact: true }).click();
		await page.getByRole('dialog', { name: 'Uninstall package', exact: true }).getByRole('button', { name: 'Uninstall', exact: true }).click();
		await expect(view.getByLabel('Packages', { exact: true }).locator('option')).toHaveCount(0);
		await page.evaluate(() => window.ashMarketplaceIntegration.dispose());
	});
}

test('Marketplace execution can be revoked when its entry becomes unavailable', async ({ page }) => {
	await page.goto('/marketplace.html');
	const view = page.locator('.ash-marketplace');
	await view.getByLabel('Capability', { exact: true }).selectOption({ label: 'Editor extensions (Open VSX)' });
	await view.getByRole('button', { name: 'Install package', exact: true }).click();
	await page.getByRole('dialog', { name: 'Install package', exact: true }).getByRole('button', { name: 'Install', exact: true }).click();
	for (const action of ['Enable', 'Authorize execution', 'Revoke execution authorization', 'Disable']) {
		if (action === 'Revoke execution authorization') {
			await page.evaluate(() => window.ashMarketplaceIntegration.removeEditorEntrypoint());
		}
		await page.evaluate(() => window.ashMarketplaceIntegration.startCommand('ash.extensions.manageMarketplace'));
		await expect(page.getByRole('dialog', { name: 'Manage Marketplace extension execution', exact: true })).toBeVisible();
		await page.keyboard.press('Enter');
		const review = page.getByRole('dialog', { name: 'publisher.sample@open-vsx', exact: true });
		if (action === 'Disable') {
			await expect(review.getByRole('button', { name: 'Authorize execution', exact: true })).toHaveCount(0);
		}
		await review.getByRole('button', { name: action, exact: true }).click();
		await page.evaluate(() => window.ashMarketplaceIntegration.waitCommand());
	}
	const actions = await page.evaluate(() => window.ashMarketplaceIntegration.requests.filter((entry: any) => entry[0] === 'editorPolicy').map((entry: any) => entry[1].action));
	expect(actions).toEqual(['enable', 'grant', 'revoke', 'disable']);
	await page.evaluate(() => window.ashMarketplaceIntegration.dispose());
});

test('Marketplace navigation completes while the catalog request is pending', async ({ page }) => {
	await page.goto('/marketplace.html');
	const view = page.locator('.ash-marketplace');
	await expect(view.getByRole('button', { name: 'Install package', exact: true })).toBeEnabled();
	await page.evaluate(() => window.ashMarketplaceIntegration.startHeldCommand());
	await expect(view.getByLabel('Search packages', { exact: true })).toHaveValue('held query');
	await expect(view.getByRole('status')).toHaveText('Loading packages…');
	await page.evaluate(() => window.ashMarketplaceIntegration.executeCommand('ash.plugins.open'));
	await expect(view.getByLabel('Package list', { exact: true })).toHaveValue('installed');
	await expect(view.getByRole('status')).toHaveText('0 packages.');
	await page.evaluate(() => window.ashMarketplaceIntegration.failHeldSearch());
	await expect(view.getByRole('status')).toHaveText('0 packages.');
});

test('Marketplace ignores a failed browse request after switching to installed packages', async ({ page }) => {
	await page.goto('/marketplace.html');
	const view = page.locator('.ash-marketplace');
	await expect(view.getByRole('button', { name: 'Install package', exact: true })).toBeEnabled();
	await page.evaluate(() => window.ashMarketplaceIntegration.startHeldSearch());
	await page.evaluate(() => window.ashMarketplaceIntegration.open({ mode: 'installed' }));
	await expect(view.getByRole('status')).toHaveText('0 packages.');
	await page.evaluate(() => window.ashMarketplaceIntegration.failHeldSearch());
	await expect(view.getByRole('status')).toHaveText('0 packages.');
	await expect(view.getByRole('button', { name: 'Install package', exact: true })).toBeDisabled();
});

test('Marketplace updates the selected installation to the reviewed version', async ({ page }) => {
	await page.goto('/marketplace.html');
	const view = page.locator('.ash-marketplace');
	await view.getByRole('button', { name: 'Install package', exact: true }).click();
	await page.getByRole('dialog', { name: 'Install package', exact: true }).getByRole('button', { name: 'Install', exact: true }).click();
	await page.evaluate(() => window.ashMarketplaceIntegration.addOtherPackage());
	await page.evaluate(() => window.ashMarketplaceIntegration.open({ mode: 'installed' }));
	await view.getByLabel('Packages', { exact: true }).selectOption('version-one');
	await view.getByRole('button', { name: 'Update package', exact: true }).click();
	const confirmation = page.getByRole('dialog', { name: 'Update package', exact: true });
	await expect(confirmation).toContainText('2.0.0');
	await confirmation.getByRole('button', { name: 'Update', exact: true }).click();
	await expect(view.getByLabel('Packages', { exact: true })).toContainText('2.0.0');
	await expect(view.getByLabel('Packages', { exact: true })).toHaveValue('updated-installation');
	expect(await page.evaluate(() => window.ashMarketplaceIntegration.requests.filter((entry: any) => entry[0] === 'update'))).toEqual([['update', { installationId: 'version-one', version: '2.0.0' }]]);
});

test('Marketplace reviews the whole package and manages the selected installation offline', async ({ page }) => {
	await page.goto('/marketplace.html');
	const view = page.locator('.ash-marketplace');
	await expect(view.getByRole('button', { name: 'Install package', exact: true })).toBeEnabled();
	await view.getByRole('button', { name: 'Install package', exact: true }).click();
	const confirmation = page.getByRole('dialog', { name: 'Install package', exact: true });
	await expect(confirmation).toContainText('executable: typescript-language-server');
	await expect(confirmation).toContainText('skill: review');
	await expect(confirmation).toContainText('Permissions: process');
	await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
	expect(await page.evaluate(() => window.ashMarketplaceIntegration.requests.filter((entry: any) => entry[0] === 'install'))).toEqual([]);
	await view.getByRole('button', { name: 'Install package', exact: true }).click();
	await confirmation.getByRole('button', { name: 'Install', exact: true }).click();
	await expect(view.getByRole('button', { name: 'Show installed versions', exact: true })).toBeEnabled();
	await page.evaluate(() => window.ashMarketplaceIntegration.addSecondVersion());
	await view.getByRole('button', { name: 'Show installed versions', exact: true }).click();
	await expect(view.getByLabel('Packages', { exact: true }).locator('option')).toHaveCount(2);
	await view.getByLabel('Packages', { exact: true }).selectOption('version-two');
	await expect(view.getByLabel('Package details', { exact: true })).toContainText('2.0.0');
	await page.evaluate(() => window.ashMarketplaceIntegration.setOffline());
	await view.getByRole('button', { name: 'Refresh', exact: true }).click();
	await expect(view.getByRole('status')).toHaveText('Catalog unavailable');
	await view.getByRole('button', { name: 'Uninstall package', exact: true }).click();
	await page.getByRole('dialog', { name: 'Uninstall package', exact: true }).getByRole('button', { name: 'Uninstall', exact: true }).click();
	await expect(view.getByLabel('Packages', { exact: true }).locator('option')).toHaveCount(1);
	expect(await page.evaluate(() => window.ashMarketplaceIntegration.requests.filter((entry: any) => entry[0] === 'uninstall'))).toEqual([['uninstall', { installationId: 'version-two', mode: 'whenUnused' }]]);
});

test('LSP and Skills share capability discovery while retaining their own configuration', async ({ page }) => {
	await page.goto('/marketplace.html');
	const lsp = page.locator('.ash-language-server-settings');
	await expect(lsp.getByLabel('Language ID', { exact: true })).toHaveValue('typescriptreact');
	await expect(lsp.getByRole('status')).toContainText('1 servers available.');
	await lsp.getByRole('button', { name: 'Find language servers in Marketplace', exact: true }).click();
	await expect(page.locator('.ash-marketplace').getByLabel('Language server for language ID')).toHaveValue('typescriptreact');
	await expect.poll(() => page.evaluate(() => window.ashMarketplaceIntegration.requests.some((entry: any) => entry[0] === 'search' && entry[1].languageId === 'typescriptreact' && entry[1].capabilityKind === 'executable' && entry[1].packageType === null))).toBe(true);
	const skills = page.locator('.ash-skills');
	await expect(skills.getByLabel('Skill diagnostics', { exact: true })).toContainText('workspace / bad-skill: Invalid metadata');
	await skills.getByRole('button', { name: 'Get skills from Marketplace', exact: true }).click();
	await expect(page.locator('.ash-marketplace').getByLabel('Capability', { exact: true })).toHaveValue('skill');
	await expect(page.locator('.ash-marketplace').getByLabel('Language server for language ID')).toHaveValue('');
	await skills.getByRole('button', { name: 'Disable skill', exact: true }).click();
	await expect(skills.getByRole('button', { name: 'Enable skill', exact: true })).toBeEnabled();
	expect(await page.evaluate(() => window.ashMarketplaceIntegration.requests.filter((entry: any) => entry[0] === 'skill'))).toEqual([['skill', { source: 'marketplace:example/web', name: 'review' }, false, 3]]);
	await lsp.getByRole('button', { name: 'Save server configuration', exact: true }).click();
	await expect(lsp.getByRole('status')).toContainText('Refresh before saving again.');
	await expect(lsp.getByRole('button', { name: 'Save server configuration', exact: true })).toBeDisabled();
	await lsp.getByRole('button', { name: 'Refresh', exact: true }).click();
	await expect(lsp.getByRole('status')).toContainText('1 servers available.');
	await lsp.getByLabel('Executable path (optional)', { exact: true }).fill('/tools/server');
	await lsp.getByRole('button', { name: 'Save server configuration', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashMarketplaceIntegration.requests.filter((entry: any) => entry[0] === 'configure').length)).toBe(2);
	expect(await page.evaluate(() => window.ashMarketplaceIntegration.requests.filter((entry: any) => entry[0] === 'configure').at(-1))).toEqual(['configure', 'typescript-language-server', { mode: 'enabled', executable: '/tools/server' }, 4]);
	await skills.getByLabel('Skills', { exact: true }).focus();
	await skills.getByRole('button', { name: 'Help', exact: true }).click();
	await expect(page.getByRole('dialog', { name: 'Skills help' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(skills.getByRole('button', { name: 'Help', exact: true })).toBeFocused();
	await page.evaluate(() => window.ashMarketplaceIntegration.dispose());
	await expect(page.locator('.ash-marketplace, .ash-skills, .ash-language-server-settings')).toHaveCount(0);
});
