import { expect, test } from '@playwright/test';

test('Extensions retains its list when wrapped filters share a short view container', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/extensions.html?paneLayout');
	const view = page.locator('#extensions .ash-extensions');
	await expect(view.locator('.extension-row')).not.toHaveCount(0);
	await expect.poll(() => view.locator('.extensions-list').evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(22);
	await expect.poll(() => view.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
	expect(errors).toEqual([]);
});

for (const [locale, installTitle, enable, grant, permission, disable, revoke, uninstall] of [
	['en', 'Install extension from workspace', 'Enable', 'Grant permissions', 'Read workspace files', 'Disable', 'Revoke permissions', 'Uninstall'],
	['zh-CN', '从工作区安装扩展', '启用', '授予权限', '读取工作区文件', '禁用', '撤销权限', '卸载'],
]) {
	test(`Local SDK extension installation and permission review work in ${locale}`, async ({ page }) => {
		await page.goto(`/extensions.html?locale=${locale}`);
		await page.evaluate(() => window.ashExtensionsIntegration.startCommand('ash.extensions.installLocal'));
		const installation = page.getByRole('dialog', { name: installTitle, exact: true });
		await expect(installation).toContainText('.ash-plugin/plugin.json');
		await installation.getByRole('textbox').fill('examples/extensions/inspect');
		await installation.getByRole('textbox').press('Enter');
		const installedMessage = page.getByRole('dialog').filter({ hasText: 'acme/sdk 1.0.0' });
		await expect(installedMessage).toBeVisible();
		await page.keyboard.press('Enter');
		await page.evaluate(() => window.ashExtensionsIntegration.waitCommand());
		expect(await page.evaluate(() => window.ashExtensionsIntegration.localPackages().map(({ enabled, granted }) => ({ enabled, granted })))).toEqual([{ enabled: false, granted: false }]);
		const request = await page.evaluate(() => window.ashExtensionsIntegration.requests.find((entry: any) => entry[0] === 'pluginInstall')) as [string, Record<string, unknown>];
		expect(request[1]).toMatchObject({ expectedRevision: 0, path: 'examples/extensions/inspect', dirId: null });
		expect(request[1].commandId).toMatch(/^desktop-plugin-install-/u);
		await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('ash.extensions.manageLocal'));
		await page.locator('.ash-extensions').getByRole('option').filter({ hasText: 'SDK fixture' }).click();
		const editor = page.locator('.ash-extension-editor');
		await editor.getByRole('button', { name: enable, exact: true }).click();
		await expect(editor.getByRole('button', { name: disable, exact: true })).toBeVisible();
		await editor.getByRole('button', { name: grant, exact: true }).click();
		const permissions = page.getByRole('dialog', { name: 'SDK fixture', exact: true });
		await expect(permissions).toContainText(permission);
		await expect(permissions).toContainText('sha256:' + 'b'.repeat(64));
		await permissions.getByRole('button', { name: grant, exact: true }).click();
		await expect(editor.getByRole('button', { name: revoke, exact: true })).toBeVisible();
		expect(await page.evaluate(() => window.ashExtensionsIntegration.localPackages().map(({ enabled, granted }) => ({ enabled, granted })))).toEqual([{ enabled: true, granted: true }]);
		await expect(editor.getByRole('button', { name: uninstall, exact: true })).toBeDisabled();
		await editor.getByRole('button', { name: disable, exact: true }).click();
		await expect(editor.getByRole('button', { name: enable, exact: true })).toBeVisible();
		await editor.getByRole('button', { name: revoke, exact: true }).click();
		await page.getByRole('dialog', { name: 'SDK fixture', exact: true }).getByRole('button', { name: revoke, exact: true }).click();
		await expect(editor.getByRole('button', { name: uninstall, exact: true })).toBeEnabled();
		await editor.getByRole('button', { name: uninstall, exact: true }).click();
		await page.getByRole('dialog', { name: locale === 'en' ? 'Uninstall extension' : '卸载扩展', exact: true }).getByRole('button', { name: uninstall, exact: true }).click();
		expect(await page.evaluate(() => window.ashExtensionsIntegration.localPackages())).toEqual([]);
		await page.evaluate(() => window.ashExtensionsIntegration.dispose());
		await expect(page.locator('.ash-quick-input-host')).toHaveCount(0);
	});
}

test('Local extension installation cancellation does not copy or grant a package', async ({ page }) => {
	await page.goto('/extensions.html');
	await page.evaluate(() => window.ashExtensionsIntegration.startCommand('ash.extensions.installLocal'));
	await expect(page.getByRole('dialog', { name: 'Install extension from workspace', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.evaluate(() => window.ashExtensionsIntegration.waitCommand());
	expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0].startsWith('plugin')))).toEqual([]);
});

test('LSP and Skills share capability discovery while retaining their own configuration', async ({ page }) => {
	await page.goto('/extensions.html');
	const lsp = page.locator('.ash-language-server-settings');
	await expect(lsp.getByLabel('Language ID', { exact: true })).toHaveValue('typescriptreact');
	await expect(lsp.getByRole('status')).toContainText('1 servers available.');
	await lsp.getByRole('button', { name: 'Find language servers in Extensions', exact: true }).click();
	await expect(page.locator('.ash-extensions').getByRole('button', { name: 'Providers · typescriptreact', exact: true })).toBeVisible();
	await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.requests.some((entry: any) => entry[0] === 'search' && entry[1].languageId === 'typescriptreact' && entry[1].capabilityKind === 'executable' && entry[1].packageType === null))).toBe(true);
	const skills = page.locator('.ash-skills');
	await expect(skills.getByLabel('Skill diagnostics', { exact: true })).toContainText('workspace / bad-skill: Invalid metadata');
	await skills.getByRole('button', { name: 'Get skills from Extensions', exact: true }).click();
	await expect(page.locator('.ash-extensions').getByRole('button', { name: 'Skills', exact: true })).toBeVisible();
	await skills.getByRole('button', { name: 'Disable skill', exact: true }).click();
	await expect(skills.getByRole('button', { name: 'Enable skill', exact: true })).toBeEnabled();
	expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'skill'))).toEqual([['skill', { source: 'marketplace:example/web', name: 'review' }, false, 3]]);
	await lsp.getByRole('button', { name: 'Save server configuration', exact: true }).click();
	await expect(lsp.getByRole('status')).toContainText('Refresh before saving again.');
	await expect(lsp.getByRole('button', { name: 'Save server configuration', exact: true })).toBeDisabled();
	await lsp.getByRole('button', { name: 'Refresh', exact: true }).click();
	await expect(lsp.getByRole('status')).toContainText('1 servers available.');
	await lsp.getByLabel('Executable path (optional)', { exact: true }).fill('/tools/server');
	await lsp.getByRole('button', { name: 'Save server configuration', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'configure').length)).toBe(2);
	expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'configure').at(-1))).toEqual(['configure', 'typescript-language-server', { mode: 'enabled', executable: '/tools/server' }, 4]);
	await skills.getByLabel('Skills', { exact: true }).focus();
	await skills.getByRole('button', { name: 'Help', exact: true }).click();
	await expect(page.getByRole('dialog', { name: 'Skills help' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(skills.getByRole('button', { name: 'Help', exact: true })).toBeFocused();
	await page.evaluate(() => window.ashExtensionsIntegration.dispose());
	await expect(page.locator('.ash-extensions, .ash-skills, .ash-language-server-settings')).toHaveCount(0);
});

for (const locale of ['en', 'zh-CN']) {
	test(`Open VSX extension details and execution review work in ${locale}`, async ({ page }) => {
		await page.goto(`/extensions.html?locale=${locale}`);
		await page.evaluate(() => window.ashExtensionsIntegration.open({ capabilityKind: 'editorExtension' }));
		const view = page.locator('.ash-extensions');
		await view.getByRole('option').click();
		const editor = page.locator('.ash-extension-editor');
		await expect(editor).toContainText('Sample editor extension');
		await expect(editor).toContainText(locale === 'en' ? 'without running scripts' : '不运行脚本');
		const install = locale === 'en' ? 'Install' : '安装';
		await editor.getByRole('button', { name: install, exact: true }).click();
		const review = page.getByRole('dialog', { name: install, exact: true });
		await expect(review).toContainText('publisher.sample@open-vsx');
		await review.getByRole('button', { name: install, exact: true }).click();
		await expect(editor).toContainText(locale === 'en' ? 'Enabled' : '已启用');
		for (const [action, policyAction] of locale === 'en' ? [['Disable', 'disable'], ['Authorize execution', 'grant'], ['Revoke execution authorization', 'revoke'], ['Enable', 'enable']] : [['禁用', 'disable'], ['授权执行', 'grant'], ['撤销执行授权', 'revoke'], ['启用', 'enable']]) {
			await editor.getByRole('button', { name: action, exact: true }).click();
			if (policyAction === 'grant' || policyAction === 'revoke') {
				await page.getByRole('dialog', { name: 'publisher.sample@open-vsx', exact: true }).getByRole('button', { name: action, exact: true }).click();
			}
			await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'editorPolicy').map((entry: any) => entry[1].action).at(-1))).toBe(policyAction);
		}
		expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'editorPolicy').map((entry: any) => [entry[1].action, entry[1].expectedRevision, entry[1].installationId]))).toEqual([['disable', 1, 'version-one'], ['grant', 2, 'version-one'], ['revoke', 3, 'version-one'], ['enable', 4, 'version-one']]);
	});
}

test('Extensions execution can be revoked when its entry becomes unavailable', async ({ page }) => {
	await page.goto('/extensions.html');
	await page.evaluate(() => window.ashExtensionsIntegration.open({ capabilityKind: 'editorExtension' }));
	await page.locator('.ash-extensions').getByRole('option').click();
	const editor = page.locator('.ash-extension-editor');
	await editor.getByRole('button', { name: 'Install', exact: true }).click();
	await page.getByRole('dialog', { name: 'Install', exact: true }).getByRole('button', { name: 'Install', exact: true }).click();
	await editor.getByRole('button', { name: 'Authorize execution', exact: true }).click();
	await page.getByRole('dialog', { name: 'publisher.sample@open-vsx', exact: true }).getByRole('button', { name: 'Authorize execution', exact: true }).click();
	await expect(editor.getByRole('button', { name: 'Revoke execution authorization', exact: true })).toBeVisible();
	await page.evaluate(() => window.ashExtensionsIntegration.removeEditorEntrypoint());
	await editor.getByRole('button', { name: 'Revoke execution authorization', exact: true }).click();
	await page.getByRole('dialog', { name: 'publisher.sample@open-vsx', exact: true }).getByRole('button', { name: 'Revoke execution authorization', exact: true }).click();
	await expect(editor.getByRole('button', { name: 'Authorize execution', exact: true })).toHaveCount(0);
	await editor.getByRole('button', { name: 'Disable', exact: true }).click();
	await expect(editor.getByRole('button', { name: 'Enable', exact: true })).toBeVisible();
});

for (const trigger of ['command', 'view']) {
	test(`Extensions ${trigger} navigation ignores a failed stale search`, async ({ page }) => {
		await page.goto('/extensions.html');
		const view = page.locator('.ash-extensions');
		await expect(view.getByRole('option')).toHaveCount(1);
		await page.evaluate(trigger => trigger === 'command' ? window.ashExtensionsIntegration.startHeldCommand() : window.ashExtensionsIntegration.startHeldSearch(), trigger);
		await expect(view.getByRole('status')).toHaveText('Loading Extensions…');
		await page.evaluate(() => window.ashExtensionsIntegration.open({ mode: 'installed' }));
		await expect(view.getByRole('status')).toHaveText('No matching extensions.');
		await page.evaluate(() => window.ashExtensionsIntegration.failHeldSearch());
		await expect(view.getByRole('status')).toHaveText('No matching extensions.');
		await expect(view.getByRole('option')).toHaveCount(0);
	});
}

async function installFixture(page: import('@playwright/test').Page): Promise<void> {
	await page.locator('.ash-extensions').getByRole('button', { name: 'Install', exact: true }).click();
	await page.getByRole('dialog', { name: 'Install', exact: true }).getByRole('button', { name: 'Install', exact: true }).click();
	await expect(page.locator('.ash-extensions').getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
}

test('Extensions updates the selected exact installation to the reviewed version', async ({ page }) => {
	await page.goto('/extensions.html');
	await installFixture(page);
	await page.evaluate(() => { window.ashExtensionsIntegration.addOtherPackage(); return window.ashExtensionsIntegration.open({ mode: 'installed' }); });
	await page.locator('.ash-extensions').getByRole('option').filter({ hasText: 'example/web' }).click();
	const editor = page.locator('.ash-extension-editor');
	await editor.getByRole('button', { name: 'Update', exact: true }).click();
	const review = page.getByRole('dialog', { name: 'Update', exact: true });
	await expect(review).toContainText('2.0.0');
	await review.getByRole('button', { name: 'Update', exact: true }).click();
	await expect(page.locator('.ash-extensions')).toContainText('2.0.0');
	expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'update'))).toEqual([['update', { installationId: 'version-one', version: '2.0.0' }]]);
});

test('Extensions reviews bundled capabilities and uninstalls a selected version offline', async ({ page }) => {
	await page.goto('/extensions.html');
	const view = page.locator('.ash-extensions');
	await view.getByRole('button', { name: 'Install', exact: true }).click();
	const review = page.getByRole('dialog', { name: 'Install', exact: true });
	await expect(review).toContainText('executable: typescript-language-server');
	await expect(review).toContainText('skill: review');
	await expect(review).toContainText('Requested permissions: process');
	await review.getByRole('button', { name: 'Cancel', exact: true }).click();
	expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'install'))).toEqual([]);
	await installFixture(page);
	await page.evaluate(() => { window.ashExtensionsIntegration.addSecondVersion(); window.ashExtensionsIntegration.setOffline(); return window.ashExtensionsIntegration.open({ mode: 'installed' }); });
	await expect(view.getByRole('option')).toHaveCount(2);
	await view.getByRole('option').filter({ hasText: '2.0.0' }).click();
	const editor = page.locator('.ash-extension-editor');
	await expect(editor).toContainText('2.0.0');
	await editor.getByRole('button', { name: 'Uninstall', exact: true }).click();
	await page.getByRole('dialog', { name: 'Uninstall extension', exact: true }).getByRole('button', { name: 'Uninstall', exact: true }).click();
	await expect(view.getByRole('option')).toHaveCount(1);
	expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'uninstall'))).toEqual([['uninstall', { installationId: 'version-two', mode: 'whenUnused' }]]);
});

test('Third-party Ash sources can be added, paused and resumed through Extensions', async ({ page }) => {
	await page.goto('/extensions.html');
	await page.evaluate(() => window.ashExtensionsIntegration.startCommand('ash.extensions.manageSources'));
	await expect(page.getByRole('dialog', { name: 'Manage extension sources', exact: true })).toContainText('open-vsx');
	await page.keyboard.press('Enter');
	const setup = page.getByRole('dialog', { name: 'Add Ash open source…', exact: true });
	const inputs = setup.getByRole('textbox');
	for (const [index, value] of ['community', 'https://extensions.example/metadata/', 'https://extensions.example/targets/', '{"signed":{}}'].entries()) { await inputs.nth(index).fill(value); }
	await setup.getByRole('button', { name: 'Add', exact: true }).click();
	await page.evaluate(() => window.ashExtensionsIntegration.waitCommand());
	for (const state of ['Enabled · select to pause', 'Paused · select to resume']) {
		await page.evaluate(() => window.ashExtensionsIntegration.startCommand('ash.extensions.manageSources'));
		const picker = page.getByRole('dialog', { name: 'Manage extension sources', exact: true });
		await expect(picker).toContainText(state);
		await picker.getByRole('option').filter({ hasText: 'community' }).click();
		await page.evaluate(() => window.ashExtensionsIntegration.waitCommand());
	}
	expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'setSourceEnabled').map((entry: any) => entry[1]))).toEqual([{ sourceId: 'community', enabled: false, expectedRevision: 1 }, { sourceId: 'community', enabled: true, expectedRevision: 2 }]);
});

for (const [locale, disable, enable, disabled, languagePackReason] of [
	['en', 'Disable', 'Enable', 'Disabled', 'cannot be disabled'],
	['zh-CN', '禁用', '启用', '已禁用', '不能禁用'],
]) {
	test(`All built-in extensions share enablement management and preserve language-pack behavior in ${locale}`, async ({ page }) => {
		await page.goto(`/extensions.html?locale=${locale}`);
		await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('ash.extensions.manageBuiltIn'));
		const view = page.locator('.ash-extensions');
		const extension = view.getByRole('option').filter({ hasText: 'vscode.javascript' });
		await expect(extension.getByRole('button', { name: disable, exact: true })).toBeVisible();
		await extension.getByRole('button', { name: disable, exact: true }).focus();
		await page.keyboard.press('Enter');
		await expect(extension.getByRole('button', { name: enable, exact: true })).toBeVisible();
		await expect(page.locator('.ash-extension-editor')).toHaveCount(0);
		await extension.click();
		const editor = page.locator('.ash-extension-editor');
		await expect(editor.getByRole('status')).toContainText(disabled);
		await page.reload();
		await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('ash.extensions.manageBuiltIn'));
		await expect(extension.getByRole('button', { name: enable, exact: true })).toBeVisible();
		await extension.click();
		await editor.getByRole('button', { name: enable, exact: true }).click();
		await expect(extension.getByRole('button', { name: disable, exact: true })).toBeVisible();
		const languagePack = view.getByRole('option').filter({ hasText: 'ash.language-pack-zh-cn' });
		await expect(languagePack.getByRole('button')).toHaveCount(0);
		await languagePack.click();
		await expect(editor.getByRole('status')).toContainText(languagePackReason);
		await expect(editor.getByRole('button')).toHaveCount(0);
	});
}

for (const [locale, disable, enable, disabled, running, onDemand] of [
	['en', 'Disable', 'Enable', 'Disabled', 'Enabled · running', 'Enabled · starts on demand'],
	['zh-CN', '禁用', '启用', '已禁用', '已启用 · 正在运行', '已启用 · 按需启动'],
]) {
	test(`Built-in Rust provider controls use backend authority and report on-demand activation in ${locale}`, async ({ page }) => {
		await page.goto(`/extensions.html?locale=${locale}`);
		await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('ash.extensions.manageBuiltIn'));
		const provider = page.locator('.ash-extensions').getByRole('option').filter({ hasText: 'ash.github-authentication' });
		await provider.click();
		const editor = page.locator('.ash-extension-editor');
		await expect(editor.getByRole('status')).toHaveText(running);
		await editor.getByRole('button', { name: disable, exact: true }).click();
		await expect(provider.getByRole('button', { name: enable, exact: true })).toBeVisible();
		await expect(editor.getByRole('status')).toHaveText(disabled);
		await provider.getByRole('button', { name: enable, exact: true }).click();
		await expect(editor.getByRole('status')).toHaveText(onDemand);
		expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'builtInPolicy'))).toEqual([
			['builtInPolicy', { id: 'ash.github-authentication', enabled: false, expectedRevision: 1 }],
			['builtInPolicy', { id: 'ash.github-authentication', enabled: true, expectedRevision: 2 }],
		]);
	});
}
