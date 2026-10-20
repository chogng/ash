import { expect, test } from '@playwright/test';

for (const labels of [
	{ locale: 'en', add: 'Add MCP server', http: 'HTTP server', id: 'Server ID', name: 'Display name', url: 'HTTP or HTTPS server URL', credential: 'Credential reference (optional)', save: 'Save', disabled: 'Disabled', enable: 'Enable', disconnect: 'Disconnect', disconnected: 'Disconnected', connect: 'Connect', connected: 'Connected', edit: 'Edit MCP server', remove: 'Remove MCP server', confirm: 'Remove', cancel: 'Cancel' },
	{ locale: 'zh-CN', add: '添加 MCP 服务器', http: 'HTTP 服务器', id: '服务器标识符', name: '显示名称', url: 'HTTP 或 HTTPS 服务器地址', credential: '凭据引用（可选）', save: '保存', disabled: '已禁用', enable: '启用', disconnect: '断开', disconnected: '已断开', connect: '连接', connected: '已连接', edit: '编辑 MCP 服务器', remove: '移除 MCP 服务器', confirm: '移除', cancel: '取消' },
]) {
	test(`Independent MCP configuration and lifecycle actions refresh the pane and details in ${labels.locale}`, async ({ page }) => {
		await page.goto(`/extensions.html?locale=${labels.locale}`);
		const mcp = page.locator('[data-view-id="ash.extensions.mcp"]');
		await mcp.getByRole('button', { name: /^(Connections|连接)$/u }).click();
		await mcp.getByRole('button', { name: labels.add, exact: true }).click();
		const add = page.getByRole('dialog', { name: labels.add, exact: true });
		await add.getByRole('button', { name: labels.http, exact: true }).click();
		await expect(add.getByPlaceholder(labels.id, { exact: true })).toBeFocused();
		await add.getByPlaceholder(labels.id, { exact: true }).fill('standalone');
		await add.getByPlaceholder(labels.name, { exact: true }).fill('Standalone test');
		await add.getByPlaceholder(labels.url, { exact: true }).fill('https://example.test/mcp');
		await add.getByPlaceholder(labels.credential, { exact: true }).fill('stored-token');
		await add.getByRole('button', { name: labels.save, exact: true }).click();
		const details = page.locator('.ash-extension-editor');
		await expect(details.getByRole('heading', { name: 'Standalone test', exact: true })).toBeVisible();
		await expect(details.getByRole('status')).toHaveText(labels.disabled);
		await expect(details.getByRole('button', { name: labels.connect, exact: true })).toBeDisabled();
		await expect(details.getByRole('button', { name: labels.edit, exact: true })).toBeFocused();
		await details.getByRole('button', { name: labels.enable, exact: true }).press('Enter');
		await expect(details.getByRole('status')).toHaveText(labels.disconnected);
		await details.getByRole('button', { name: labels.connect, exact: true }).click();
		await expect(details.getByRole('status')).toHaveText(labels.connected);
		await expect(mcp.getByRole('option').filter({ hasText: 'Standalone test' })).toContainText(labels.connected);
		await details.getByRole('button', { name: labels.disconnect, exact: true }).click();
		await expect(details.getByRole('status')).toHaveText(labels.disconnected);
		await details.getByRole('button', { name: labels.edit, exact: true }).click();
		const edit = page.getByRole('dialog', { name: labels.edit, exact: true });
		await edit.getByRole('button', { name: labels.http, exact: true }).click();
		await expect(edit.getByPlaceholder(labels.url, { exact: true })).toHaveValue('https://example.test/mcp');
		await expect(edit.getByPlaceholder(labels.credential, { exact: true })).toHaveValue('stored-token');
		await edit.getByPlaceholder(labels.name, { exact: true }).fill('Renamed standalone');
		await edit.getByRole('button', { name: labels.save, exact: true }).click();
		await expect(details.getByRole('heading', { name: 'Renamed standalone', exact: true })).toBeVisible();
		await expect(mcp.getByRole('option').filter({ hasText: 'Renamed standalone' })).toHaveCount(1);
		await details.getByRole('button', { name: labels.remove, exact: true }).click();
		await page.getByRole('dialog', { name: labels.remove, exact: true }).getByRole('button', { name: labels.cancel, exact: true }).click();
		expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'mcp/server/remove'))).toEqual([]);
		await details.getByRole('button', { name: labels.remove, exact: true }).click();
		await page.getByRole('dialog', { name: labels.remove, exact: true }).getByRole('button', { name: labels.confirm, exact: true }).click();
		await expect(mcp.getByRole('option').filter({ hasText: 'Renamed standalone' })).toHaveCount(0);
		await expect(details.getByRole('button', { name: labels.edit, exact: true })).toHaveCount(0);
		const mutations = await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => ['mcp/server/upsert', 'mcp/server/enablement/set', 'mcp/server/connect', 'mcp/server/disconnect', 'mcp/server/remove'].includes(entry[0])));
		expect(mutations).toMatchObject([
			['mcp/server/upsert', { expectedRevision: 1, server: { id: 'user:mcp:standalone', displayName: 'Standalone test', enablement: 'disabled', credential: { type: 'reference', credentialRef: 'stored-token' } } }],
			['mcp/server/enablement/set', { expectedRevision: 2, serverId: 'user:mcp:standalone', enablement: 'enabled' }],
			['mcp/server/connect', { serverId: 'user:mcp:standalone' }],
			['mcp/server/disconnect', { serverId: 'user:mcp:standalone' }],
			['mcp/server/upsert', { expectedRevision: 3, server: { id: 'user:mcp:standalone', displayName: 'Renamed standalone', enablement: 'enabled' } }],
			['mcp/server/remove', { expectedRevision: 4, serverId: 'user:mcp:standalone' }],
		]);
	});
}

test('MCP stdio arguments are validated without losing the draft and Escape cancels editing', async ({ page }) => {
	await page.goto('/extensions.html');
	const mcp = page.locator('[data-view-id="ash.extensions.mcp"]');
	await mcp.getByRole('button', { name: /^(Connections|连接)$/u }).click();
	await mcp.getByRole('button', { name: 'Add MCP server', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Add MCP server', exact: true });
	await dialog.getByRole('button', { name: 'Local process (stdio)', exact: true }).click();
	await dialog.getByPlaceholder('Server ID', { exact: true }).fill('local');
	await dialog.getByPlaceholder('Display name', { exact: true }).fill('Local test');
	await dialog.getByPlaceholder('Executable path', { exact: true }).fill('/bin/mcp-server');
	await dialog.getByPlaceholder('Arguments (JSON array of strings)', { exact: true }).fill('[1]');
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(dialog).toContainText('Arguments must be a JSON array');
	await expect(dialog.getByPlaceholder('Executable path', { exact: true })).toHaveValue('/bin/mcp-server');
	await dialog.getByPlaceholder('Arguments (JSON array of strings)', { exact: true }).fill('["--path", "a b"]');
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	const details = page.locator('.ash-extension-editor');
	await expect(details.getByRole('heading', { name: 'Local test', exact: true })).toBeVisible();
	expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'mcp/server/upsert'))).toMatchObject([
		['mcp/server/upsert', { server: { transport: { type: 'stdio', command: '/bin/mcp-server', args: ['--path', 'a b'] } } }],
	]);
	await details.getByRole('button', { name: 'Edit MCP server', exact: true }).click();
	await page.getByRole('dialog', { name: 'Edit MCP server', exact: true }).getByRole('button', { name: 'Local process (stdio)', exact: true }).click();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toBeHidden();
	await expect(details.getByRole('button', { name: 'Edit MCP server', exact: true })).toBeFocused();
	expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'mcp/server/upsert'))).toHaveLength(1);
});

test('MCP failed mutations refresh actual state and stale revisions never overwrite configuration', async ({ page }) => {
	await page.goto('/extensions.html');
	await page.evaluate(() => window.ashExtensionsIntegration.configureMcp({
		id: 'user:mcp:reviewed', displayName: 'Reviewed server', transport: { type: 'streamableHttp', url: 'https://example.test/mcp' },
		credential: { type: 'unauthenticated' }, enablement: 'enabled',
	}));
	const mcp = page.locator('[data-view-id="ash.extensions.mcp"]');
	await mcp.getByRole('button', { name: /^(Connections|连接)$/u }).click();
	await mcp.getByRole('option').filter({ hasText: 'Reviewed server' }).click();
	const details = page.locator('.ash-extension-editor');
	await expect(details.getByRole('button', { name: 'Disable', exact: true })).toBeVisible();
	await page.evaluate(() => window.ashExtensionsIntegration.changeMcpRevision());
	await details.getByRole('button', { name: 'Disable', exact: true }).click();
	await expect(details.getByRole('status')).toContainText('MCP configuration changed.');
	await expect(details.getByRole('button', { name: 'Disable', exact: true })).toBeVisible();
	expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'mcp/server/enablement/set'))).toHaveLength(1);
	await page.evaluate(() => window.ashExtensionsIntegration.deferMcpConnection());
	await details.getByRole('button', { name: 'Connect', exact: true }).click();
	await expect(details.getByRole('status')).toHaveText('Disconnected');
	await page.evaluate(() => window.ashExtensionsIntegration.setMcpConnectFailure());
	await details.getByRole('button', { name: 'Connect', exact: true }).click();
	await expect(details.getByRole('status')).toContainText('Connection refused');
	await expect(details.getByRole('status')).toContainText('MCP server management is unavailable.');
	await expect(mcp.getByRole('option').filter({ hasText: 'Reviewed server' })).toContainText('Connection refused');
});

for (const [locale, title, discover, sourceLabel, allSources, loadMore] of [
	['en', 'Skills', 'Discover skills', 'Marketplace source', 'All sources', 'Load more'],
	['zh-CN', '技能', '发现技能', '市场来源', '全部来源', '加载更多'],
]) {
	test(`Marketplace continues beyond 100 results and source selection starts a new cursor in ${locale}`, async ({ page }) => {
		await page.goto(`/extensions.html?marketplace&pagedDiscovery&locale=${locale}`);
		const pane = page.locator('[data-view-id="ash.extensions.skills"]');
		await pane.getByRole('button', { name: title, exact: true }).click();
		await pane.getByRole('button', { name: discover, exact: true }).click();
		const count = (shown: number, total: number) => locale === 'en' ? `Showing ${shown} of ${total} results` : `显示 ${shown} 条，共 ${total} 条结果`;
		await expect(pane.getByRole('status')).toHaveText(count(30, 146));
		for (const shown of [60, 90, 120, 146]) {
			const more = pane.getByRole('button', { name: loadMore, exact: true });
			await more.focus();
			await page.keyboard.press('Enter');
			await expect(pane.getByRole('status')).toHaveText(count(shown, 146));
		}
		await expect(pane.getByRole('button', { name: loadMore, exact: true })).toBeHidden();
		await expect(pane.getByRole('listbox')).toBeFocused();
		const picker = pane.getByRole('combobox', { name: sourceLabel, exact: true });
		await picker.focus(); await page.keyboard.press('Enter');
		await expect(page.getByRole('option', { name: allSources, exact: true })).toBeVisible();
		await expect(page.getByRole('option', { name: 'open-vsx', exact: true })).toHaveCount(0);
		await page.getByRole('option', { name: 'other', exact: true }).click();
		await expect(pane.getByRole('status')).toHaveText(count(30, 73));
		const requests = await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'searchPage'));
		const last = requests.at(-1) as any;
		expect(last[1]).toMatchObject({ sourceId: 'other', cursor: null });
		await pane.getByRole('searchbox').fill('Item 7');
		await pane.getByRole('searchbox').press('Enter');
		await expect(pane.getByRole('status')).toHaveText(count(4, 4));
		await expect(pane.getByRole('button', { name: loadMore, exact: true })).toBeHidden();
	});
}

for (const [locale, installedLabel, installLabel] of [['en', 'Installed', 'Install'], ['zh-CN', '已安装', '安装']]) {
	for (const [view, paneTitle, discoveryLabel, query, name, packageId] of [
		['skills', locale === 'zh-CN' ? '技能' : 'Skills', locale === 'zh-CN' ? '发现技能' : 'Discover skills', 'Web', 'Web tools', 'example/web'],
		['mcp', locale === 'zh-CN' ? '连接' : 'Connections', locale === 'zh-CN' ? '发现连接' : 'Discover connections', 'Docs', 'Docs MCP', 'catalog/docs@ash'],
	]) {
		test(`Marketplace ${view} discovery opens reviewed package installation and updates its row in ${locale}`, async ({ page }) => {
			await page.goto(`/extensions.html?marketplace&locale=${locale}`);
			const pane = page.locator(`[data-view-id="ash.extensions.${view}"]`);
			await pane.getByRole('button', { name: paneTitle, exact: true }).click();
			await pane.getByRole('button', { name: discoveryLabel, exact: true }).focus();
			await page.keyboard.press('Enter');
			const search = pane.getByRole('searchbox');
			await search.fill(query);
			await search.press('Enter');
			await expect(pane.getByRole('option')).toHaveCount(1);
			await expect(pane.getByRole('option')).toContainText(name);
			await search.press('ArrowDown');
			await page.keyboard.press('Enter');
			const editor = page.locator('.ash-extension-editor');
			await expect(editor.locator('.extension-detail-header')).toContainText(name);
			expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.some((entry: any) => entry[0] === 'install'))).toBe(false);
			await editor.getByRole('button', { name: installLabel, exact: true }).click();
			const review = page.getByRole('dialog', { name: installLabel, exact: true });
			await expect(review).toContainText(packageId);
			await review.getByRole('button', { name: installLabel, exact: true }).click();
			await expect(pane.getByRole('option')).toContainText(installedLabel);
			const requests = await page.evaluate(() => window.ashExtensionsIntegration.requests);
			expect(requests).toContainEqual(['install', { packageId, version: '1.0.0' }]);
			expect(requests.some((entry: any) => entry[0] === 'searchPage' && entry[1].query === query && entry[1].capabilityKind === (view === 'skills' ? 'skill' : 'mcp'))).toBe(true);
			const showInstalled = pane.getByRole('button', { name: locale === 'zh-CN' ? '显示已安装' : 'Show installed', exact: true });
			await pane.getByRole('button', { name: paneTitle, exact: true }).focus();
			await showInstalled.focus();
			await page.keyboard.press('Enter');
			await search.fill('');
			await expect(pane.getByRole('button', { name: discoveryLabel, exact: true })).toBeVisible();
			await expect(pane.getByRole('option').filter({ hasText: view === 'skills' ? 'review' : 'docs-server' })).toHaveCount(1);
		});
	}
}

test('Marketplace source failures preserve healthy discovery results', async ({ page }) => {
	await page.goto('/extensions.html?marketplace&partialDiscoveryFailure');
	const pane = page.locator('[data-view-id="ash.extensions.skills"]');
	await pane.getByRole('button', { name: 'Skills', exact: true }).click();
	await pane.getByRole('button', { name: 'Discover skills', exact: true }).click();
	await expect(pane.getByRole('option')).toContainText('Web tools');
	await expect(pane.getByRole('status')).toContainText('Catalog unavailable');
});

test('Marketplace navigation retires a late failed discovery read', async ({ page }) => {
	await page.goto('/extensions.html?marketplace');
	const pane = page.locator('[data-view-id="ash.extensions.skills"]');
	await pane.getByRole('button', { name: 'Skills', exact: true }).click();
	await expect(pane.getByRole('option')).toContainText('review');
	await page.evaluate(() => window.ashExtensionsIntegration.holdDiscoverySearch());
	await pane.getByRole('button', { name: 'Discover skills', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.discoverySearchStarted())).toBe(true);
	await pane.getByRole('button', { name: 'Show installed', exact: true }).click();
	await expect(pane.getByRole('option')).toContainText('review');
	const status = await pane.getByRole('status').textContent();
	await page.evaluate(() => window.ashExtensionsIntegration.failHeldSearch());
	await expect(pane.getByRole('status')).toHaveText(status!);
	await expect(pane.getByRole('option')).not.toContainText('Web tools');
});

test('Marketplace visibility changes clear discovery while preserving installed resources', async ({ page }) => {
	await page.goto('/extensions.html?marketplace');
	const pane = page.locator('[data-view-id="ash.extensions.skills"]');
	await pane.getByRole('button', { name: 'Skills', exact: true }).click();
	await pane.getByRole('button', { name: 'Discover skills', exact: true }).click();
	await expect(pane.getByRole('option')).toContainText('Web tools');
	await page.evaluate(() => window.ashExtensionsIntegration.setDiscoveryEnabled(false));
	await expect(pane.getByRole('option')).toHaveCount(0);
	await expect(pane.getByRole('status')).toContainText('Discovery is disabled in Settings.');
	await pane.getByRole('button', { name: 'Show installed', exact: true }).click();
	await expect(pane.getByRole('option')).toContainText('review');
});

for (const theme of ['light', 'dark', 'hc']) {
	test(`Marketplace discovery preserves keyboard focus and pane layout in ${theme}`, async ({ page }) => {
		await page.goto(`/extensions.html?marketplace&theme=${theme}`);
		const pane = page.locator('[data-view-id="ash.extensions.skills"]');
		await pane.getByRole('button', { name: 'Skills', exact: true }).click();
		const discovery = pane.getByRole('button', { name: 'Discover skills', exact: true });
		await discovery.focus();
		await expect(discovery).toBeFocused();
		expect(await discovery.evaluate(element => Number.parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThanOrEqual(1);
		await page.keyboard.press('Enter');
		await expect(pane.getByRole('option')).toContainText('Web tools');
		expect(await pane.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
		await pane.getByRole('searchbox').focus();
		await page.keyboard.press('ArrowDown');
		await expect(pane.getByRole('listbox')).toBeFocused();
	});
}

for (const [locale, title, urlLabel, refLabel, pathLabel] of [
	['en', 'Install extension from Git repository', 'Git repository URL', 'Branch, tag or full commit ID (optional)', 'Package directory (optional)'],
	['zh-CN', '从 Git 仓库安装扩展', 'Git 仓库地址', '分支、标签或完整提交 ID（可选）', '包目录（可选）'],
]) {
	test(`Git plugin installation inputs are localized and keyboard cancellable in ${locale}`, async ({ page }) => {
		await page.goto(`/extensions.html?locale=${locale}`);
		await page.evaluate(() => window.ashExtensionsIntegration.startCommand('ash.extensions.installFromGit'));
		const dialog = page.getByRole('dialog', { name: title, exact: true });
		const url = dialog.getByPlaceholder(urlLabel, { exact: true });
		await expect(url).toBeFocused();
		await url.fill('https://example.test/plugin.git');
		await url.press('Tab');
		await expect(dialog.getByPlaceholder(refLabel, { exact: true })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(dialog.getByPlaceholder(pathLabel, { exact: true })).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await page.evaluate(() => window.ashExtensionsIntegration.waitCommand());
		expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => ['pluginInstall', 'commandError'].includes(entry[0])))).toEqual([]);
	});
}

test('Git plugin installation Escape cancels the running host operation before installing a package', async ({ page }) => {
	await page.goto('/extensions.html?holdGitClone');
	await page.evaluate(() => window.ashExtensionsIntegration.startCommand('ash.extensions.installFromGit'));
	const dialog = page.getByRole('dialog', { name: 'Install extension from Git repository', exact: true });
	await dialog.getByPlaceholder('Git repository URL', { exact: true }).fill('https://example.test/plugin.git');
	await dialog.getByPlaceholder('Branch, tag or full commit ID (optional)', { exact: true }).fill('release');
	await dialog.getByPlaceholder('Package directory (optional)', { exact: true }).press('Enter');
	await expect(page.getByRole('option', { name: 'Cancel installation', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.evaluate(() => window.ashExtensionsIntegration.waitCommand());
	const requests = await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => ['gitClone', 'gitCancel', 'pluginInstall', 'commandError'].includes(entry[0])));
	expect(requests).toHaveLength(2);
	expect(requests[0]).toMatchObject(['gitClone', { url: 'https://example.test/plugin.git', reference: 'release' }]);
	const cloneRequest = requests[0] as [string, { operationId: string; }];
	expect(requests[1]).toEqual(['gitCancel', cloneRequest[1].operationId]);
});

for (const [locale, detailsLabel, featuresLabel, informationLabel, identifierLabel] of [
	['en', 'Details', 'Features', 'Additional information', 'Identifier'],
	['zh-CN', '详情', '功能', '其他信息', '标识符'],
]) {
	test(`Registered extension editor renders its README, header, tabs and metadata in ${locale}`, async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto(`/extensions.html?preview&locale=${locale}&theme=light&unsafeReadme`);
		await page.evaluate(() => window.ashExtensionsIntegration.openEditorExtension());
		const editor = page.locator('.ash-extension-editor');
		await expect(editor.locator('.extension-detail-header')).toContainText('Fixture publisher');
		await expect(editor.locator('.extension-detail-icon img')).toBeVisible();
		await expect.poll(() => editor.locator('.extension-detail-icon img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
		await expect(editor.getByRole('tabpanel', { name: detailsLabel, exact: true }).getByRole('heading', { name: 'Getting started', exact: true })).toBeVisible();
		await expect(editor.getByRole('complementary', { name: informationLabel, exact: true })).toContainText(identifierLabel);
		await expect(editor.getByRole('complementary')).toContainText('publisher.sample@ash');
		await expect(editor.locator('.extension-detail-content').getByRole('link', { name: 'Unsafe', exact: true })).toHaveCount(0);
		expect(await page.evaluate(() => (window as any).fixtureUnsafe)).toBeUndefined();
		const details = editor.getByRole('tab', { name: detailsLabel, exact: true });
		await details.focus(); await details.press('ArrowRight');
		const features = editor.getByRole('tab', { name: featuresLabel, exact: true });
		await expect(features).toBeFocused(); await expect(details).toHaveAttribute('aria-selected', 'true');
		await features.press('Enter');
		await expect(features).toHaveAttribute('aria-selected', 'true');
		await expect(editor.getByRole('tabpanel', { name: featuresLabel, exact: true })).toContainText('editorExtension');
		await expect(editor.getByRole('tabpanel', { name: detailsLabel, exact: true })).toBeHidden();
		await details.click();
		await editor.locator('.extension-detail-links').getByRole('link', { name: 'README.md', exact: true }).click();
		expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'document').at(-1))).toMatchObject(['document', { readOnly: true, languageId: 'markdown', initialText: expect.stringContaining('# Sample editor extension') }]);
	});
}

test('Uninstalled Ash editor details show verified metadata without reading package resources', async ({ page }) => {
	await page.goto('/extensions.html?uninstalled&theme=light');
	await page.evaluate(() => window.ashExtensionsIntegration.openEditorExtension());
	const editor = page.locator('.ash-extension-editor');
	await expect(editor.locator('.extension-detail-header')).toContainText('Sample editor extension');
	await expect(editor.locator('.extension-detail-icon img')).toBeHidden();
	await expect(editor.locator('.extension-detail-icon img')).not.toHaveAttribute('src');
	await expect(editor.getByRole('button', { name: 'Install', exact: true })).toBeEnabled();
	const requests = await page.evaluate(() => window.ashExtensionsIntegration.requests);
	expect(requests.filter((entry: any) => entry[0] === 'extensionResource')).toEqual([]);
	expect(requests.some((entry: any) => entry[0] === 'get' && entry[1].packageId === 'publisher.sample@ash')).toBe(true);
	expect(requests.some((entry: any) => entry[0] === 'install')).toBe(false);
});

test('Plugins, Skills and MCP use the registered editor with their own content tabs', async ({ page }) => {
	await page.goto('/extensions.html');
	await page.evaluate(() => window.ashExtensionsIntegration.addSkillOnlyPlugin());
	const plugins = page.locator('[data-view-id="ash.extensions.plugins"]');
	await plugins.getByRole('button', { name: 'Installed Extensions', exact: true }).click();
	await plugins.getByRole('option').filter({ hasText: 'Skill-only plugin' }).click();
	const editor = page.locator('.ash-extension-editor');
	await editor.getByRole('tab', { name: 'Permissions', exact: true }).click();
	await expect(editor.getByRole('tabpanel', { name: 'Permissions', exact: true })).toContainText('sha256:');
	await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('workbench.action.chat.configure.skills'));
	await page.locator('[data-view-id="ash.extensions.skills"]').getByRole('option').click();
	await editor.getByRole('tab', { name: 'Instructions', exact: true }).click();
	await expect(editor.getByRole('tabpanel', { name: 'Instructions', exact: true })).toContainText('Review changes carefully.');
	await expect(editor.getByRole('tabpanel', { name: 'Instructions', exact: true })).not.toContainText('description:');
	await editor.getByRole('tab', { name: 'Diagnostics', exact: true }).click();
	await expect(editor.getByRole('tabpanel', { name: 'Diagnostics', exact: true })).toContainText('Invalid metadata');
	await page.evaluate(() => window.ashExtensionsIntegration.addMcpPackage());
	const mcp = page.locator('[data-view-id="ash.extensions.mcp"]');
	await mcp.getByRole('button', { name: /^(Connections|连接)$/u }).click();
	await mcp.getByRole('option').click();
	await editor.getByRole('tab', { name: 'Tools', exact: true }).click();
	await expect(editor.getByRole('tabpanel', { name: 'Tools', exact: true })).toContainText('fixture_search');
	await expect(editor.getByRole('complementary')).toContainText('Contract version');
	const registrations = await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'editorPane'));
	expect(registrations).toEqual([['editorPane', 'ash.extensions.editor'], ['editorPane', 'ash.extensions.editor'], ['editorPane', 'ash.extensions.editor']]);
});

test('A late README cannot replace another capability in the editor', async ({ page }) => {
	await page.goto('/extensions.html');
	await page.evaluate(() => { window.ashExtensionsIntegration.holdReadme(); });
	await page.evaluate(() => window.ashExtensionsIntegration.openEditorExtension());
	await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.readmeStarted())).toBe(true);
	await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('workbench.action.chat.configure.skills'));
	await page.locator('[data-view-id="ash.extensions.skills"]').getByRole('option').click();
	await page.evaluate(() => window.ashExtensionsIntegration.completeReadme());
	await expect(page.locator('.ash-extension-editor .extension-detail-header')).toContainText('review');
	await expect(page.locator('.ash-extension-editor')).not.toContainText('Retired README');
	await expect(page.locator('.extension-detail-document .ash-markdown')).toHaveCount(0);
});

for (const theme of ['light', 'dark', 'hc']) {
	test(`Extension detail columns, responsive layout and focus remain usable in ${theme}`, async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto(`/extensions.html?preview&theme=${theme}`);
		await page.evaluate(() => window.ashExtensionsIntegration.openEditorExtension());
		const editor = page.locator('.ash-extension-editor');
		await expect(editor.locator('.ash-markdown')).toContainText('Getting started');
		const content = await editor.locator('.extension-detail-content').boundingBox();
		const info = await editor.locator('.extension-detail-info').boundingBox();
		expect(info!.x).toBeGreaterThan(content!.x + content!.width);
		await editor.getByRole('tab', { name: 'Details', exact: true }).focus();
		await expect.poll(() => editor.getByRole('tab', { name: 'Details', exact: true }).evaluate(element => Number.parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThanOrEqual(1);
		await page.screenshot({ path: `.build/desktop/ui-previews/extension-details-${theme}.png` });
		await page.locator('#details').evaluate(element => { element.style.width = '360px'; });
		await expect(editor).toHaveClass(/compact/u);
		await expect.poll(() => editor.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
		const narrowContent = await editor.locator('.extension-detail-content').boundingBox();
		const narrowInfo = await editor.locator('.extension-detail-info').boundingBox();
		expect(narrowInfo!.y).toBeGreaterThanOrEqual(narrowContent!.y + narrowContent!.height);
	});
}

for (const [locale, title, reason] of [['en', 'Recommended', 'Recommended by this workspace'], ['zh-CN', '推荐', '此工作区推荐']]) {
	test(`Workspace recommendations open package details by keyboard in ${locale}`, async ({ page }) => {
		await page.goto(`/extensions.html?locale=${locale}`);
		await page.locator('#extensions').getByRole('button', { name: title, exact: true }).click();
		const recommended = page.locator('[data-view-id="ash.extensions.recommended"]');
		await expect(recommended.getByRole('option')).toHaveCount(2);
		await expect(recommended.getByRole('option').filter({ hasText: reason })).toHaveCount(2);
		await expect(recommended).not.toContainText('excluded/tool');
		await recommended.getByRole('searchbox').fill('Sample');
		await expect(recommended.getByRole('option')).toHaveCount(1);
		await recommended.getByRole('searchbox').press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect(page.locator('.ash-extension-editor')).toContainText('Sample editor extension');
		expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.some((entry: any) => entry[0] === 'get' && entry[1].packageId === 'publisher.sample@ash'))).toBe(true);
	});
}

test('Recommendations follow file edits, preserve valid declarations during invalid edits and clear on workspace replacement', async ({ page }) => {
	await page.goto('/extensions.html');
	await page.locator('#extensions').getByRole('button', { name: 'Recommended', exact: true }).click();
	const recommended = page.locator('[data-view-id="ash.extensions.recommended"]');
	await expect(recommended.getByRole('option')).toHaveCount(2);
	await page.evaluate(() => window.ashExtensionsIntegration.setRecommendations('{"recommendations":["example/web"]}'));
	await expect(recommended.getByRole('option')).toHaveCount(1);
	await page.evaluate(() => window.ashExtensionsIntegration.setRecommendations('{'));
	await expect(recommended.getByRole('status')).toContainText('Could not read recommendations');
	await expect(recommended.getByRole('option')).toHaveCount(1);
	await page.evaluate(() => window.ashExtensionsIntegration.setRecommendations('{"recommendations":["missing/tool"]}'));
	await expect(recommended.getByRole('option')).toContainText('missing/tool');
	await expect(recommended.getByRole('option')).toContainText('Unavailable from enabled sources');
	await recommended.getByRole('option').click();
	await expect(recommended.getByRole('status')).toContainText('This recommendation is currently unavailable');
	await expect(page.locator('.ash-extension-editor')).toHaveCount(0);
	await page.evaluate(() => window.ashExtensionsIntegration.leaveWorkspace());
	await expect(recommended.getByRole('option')).toHaveCount(0);
	await expect(recommended.getByRole('status')).toContainText('Open a workspace');
});

test('Recommendations retain declared IDs when the catalog is offline', async ({ page }) => {
	await page.goto('/extensions.html');
	await page.evaluate(() => window.ashExtensionsIntegration.setOffline());
	await page.locator('#extensions').getByRole('button', { name: 'Recommended', exact: true }).click();
	const recommended = page.locator('[data-view-id="ash.extensions.recommended"]');
	await expect(recommended.getByRole('option')).toHaveCount(2);
	await expect(recommended).toContainText('example/web');
	await expect(recommended).toContainText('publisher.sample');
	await expect(recommended.getByRole('option').filter({ hasText: 'Unavailable from enabled sources' })).toHaveCount(2);
});

test('Extensions retains its list when wrapped filters share a short view container', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/extensions.html?paneLayout');
	const view = page.locator('[data-view-id="ash.extensions.view"] .ash-extensions');
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
		await page.locator('[data-view-id="ash.extensions.plugins"] .ash-extensions').getByRole('option').filter({ hasText: 'SDK fixture' }).click();
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
	await expect(page.locator('[data-view-id="ash.extensions.view"] .ash-extensions').getByRole('option')).toHaveCount(1);
	await expect(page.locator('[data-view-id="ash.extensions.view"] .ash-extensions').getByRole('option')).toContainText('Web tools');
	await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.requests.some((entry: any) => entry[0] === 'search' && entry[1].languageId === 'typescriptreact' && entry[1].capabilityKind === 'executable' && entry[1].packageType === null))).toBe(true);
	await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('workbench.action.chat.configure.skills'));
	const skills = page.locator('[data-view-id="ash.extensions.skills"]');
	await skills.getByRole('option').filter({ hasText: 'review' }).click();
	const details = page.locator('.ash-extension-editor');
	await expect(details).toContainText('workspace / bad-skill: Invalid metadata');
	await details.getByRole('button', { name: 'Disable skill', exact: true }).click();
	await expect(details.getByRole('button', { name: 'Enable skill', exact: true })).toBeEnabled();
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
	await page.evaluate(() => window.ashExtensionsIntegration.dispose());
	await expect(page.locator('.ash-extensions, .ash-language-server-settings')).toHaveCount(0);
});

for (const locale of ['en', 'zh-CN']) {
	test(`Open VSX extension details and execution review work in ${locale}`, async ({ page }) => {
		await page.goto(`/extensions.html?locale=${locale}`);
		await page.evaluate(() => window.ashExtensionsIntegration.open({ capabilityKind: 'editorExtension' }));
		const view = page.locator('[data-view-id="ash.extensions.view"] .ash-extensions');
		await view.getByRole('option').click();
		const editor = page.locator('.ash-extension-editor');
		await expect(editor).toContainText('Sample editor extension');
		await expect(editor).toContainText(locale === 'en' ? 'without running scripts' : '不运行脚本');
		const install = locale === 'en' ? 'Install' : '安装';
		await editor.getByRole('button', { name: install, exact: true }).click();
		const review = page.getByRole('dialog', { name: install, exact: true });
		await expect(review).toContainText('publisher.sample@ash');
		await review.getByRole('button', { name: install, exact: true }).click();
		await expect(editor).toContainText(locale === 'en' ? 'Enabled' : '已启用');
		for (const [action, policyAction] of locale === 'en' ? [['Disable', 'disable'], ['Authorize execution', 'grant'], ['Revoke execution authorization', 'revoke'], ['Enable', 'enable']] : [['禁用', 'disable'], ['授权执行', 'grant'], ['撤销执行授权', 'revoke'], ['启用', 'enable']]) {
			await editor.getByRole('button', { name: action, exact: true }).click();
			if (policyAction === 'grant' || policyAction === 'revoke') {
				await page.getByRole('dialog', { name: 'publisher.sample@ash', exact: true }).getByRole('button', { name: action, exact: true }).click();
			}
			await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'editorPolicy').map((entry: any) => entry[1].action).at(-1))).toBe(policyAction);
		}
		expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'editorPolicy').map((entry: any) => [entry[1].action, entry[1].expectedRevision, entry[1].installationId]))).toEqual([['disable', 1, 'version-one'], ['grant', 2, 'version-one'], ['revoke', 3, 'version-one'], ['enable', 4, 'version-one']]);
	});
}

test('Extensions execution can be revoked when its entry becomes unavailable', async ({ page }) => {
	await page.goto('/extensions.html');
	await page.evaluate(() => window.ashExtensionsIntegration.open({ capabilityKind: 'editorExtension' }));
	await page.locator('[data-view-id="ash.extensions.view"] .ash-extensions').getByRole('option').click();
	const editor = page.locator('.ash-extension-editor');
	await editor.getByRole('button', { name: 'Install', exact: true }).click();
	await page.getByRole('dialog', { name: 'Install', exact: true }).getByRole('button', { name: 'Install', exact: true }).click();
	await editor.getByRole('button', { name: 'Authorize execution', exact: true }).click();
	await page.getByRole('dialog', { name: 'publisher.sample@ash', exact: true }).getByRole('button', { name: 'Authorize execution', exact: true }).click();
	await expect(editor.getByRole('button', { name: 'Revoke execution authorization', exact: true })).toBeVisible();
	await page.evaluate(() => window.ashExtensionsIntegration.removeEditorEntrypoint());
	await editor.getByRole('button', { name: 'Revoke execution authorization', exact: true }).click();
	await page.getByRole('dialog', { name: 'publisher.sample@ash', exact: true }).getByRole('button', { name: 'Revoke execution authorization', exact: true }).click();
	await expect(editor.getByRole('button', { name: 'Authorize execution', exact: true })).toHaveCount(0);
	await editor.getByRole('button', { name: 'Disable', exact: true }).click();
	await expect(editor.getByRole('button', { name: 'Enable', exact: true })).toBeVisible();
});

for (const trigger of ['command', 'view']) {
	test(`Extensions ${trigger} navigation ignores a failed stale search`, async ({ page }) => {
		await page.goto('/extensions.html');
		const view = page.locator('[data-view-id="ash.extensions.view"] .ash-extensions');
		await expect(view.getByRole('option')).toHaveCount(1);
		await page.evaluate(trigger => trigger === 'command' ? window.ashExtensionsIntegration.startHeldCommand() : window.ashExtensionsIntegration.startHeldSearch(), trigger);
		await expect(view.getByRole('status')).toHaveText('Loading Extensions…');
		await page.evaluate(() => window.ashExtensionsIntegration.open({ mode: 'installed' }));
		await expect(view).toHaveAttribute('aria-busy', 'false');
		await expect(view.getByRole('option').filter({ hasText: 'ash.language-pack-zh-cn' })).toBeVisible();
		const status = await view.getByRole('status').textContent();
		await page.evaluate(() => window.ashExtensionsIntegration.failHeldSearch());
		await expect(view.getByRole('status')).toHaveText(status!);
		await expect(view.locator('[data-package-id="example/web"]')).toHaveCount(0);
	});
}

async function installFixture(page: import('@playwright/test').Page): Promise<void> {
	await page.locator('[data-view-id="ash.extensions.view"] .ash-extensions').getByRole('button', { name: 'Install', exact: true }).click();
	await page.getByRole('dialog', { name: 'Install', exact: true }).getByRole('button', { name: 'Install', exact: true }).click();
	await expect(page.locator('[data-view-id="ash.extensions.view"] .ash-extensions').getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
}

test('Extensions updates the selected exact installation to the reviewed version', async ({ page }) => {
	await page.goto('/extensions.html');
	await installFixture(page);
	await page.evaluate(() => { window.ashExtensionsIntegration.addOtherPackage(); return window.ashExtensionsIntegration.open({ mode: 'installed' }); });
	await page.locator('[data-view-id="ash.extensions.view"] .ash-extensions').getByRole('option').filter({ hasText: 'example/web' }).click();
	const editor = page.locator('.ash-extension-editor');
	await editor.getByRole('button', { name: 'Update', exact: true }).click();
	const review = page.getByRole('dialog', { name: 'Update', exact: true });
	await expect(review).toContainText('2.0.0');
	await review.getByRole('button', { name: 'Update', exact: true }).click();
	await expect(page.locator('[data-view-id="ash.extensions.view"] .ash-extensions')).toContainText('2.0.0');
	expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'update'))).toEqual([['update', { installationId: 'version-one', version: '2.0.0' }]]);
});

test('Extensions reviews bundled capabilities and uninstalls a selected version offline', async ({ page }) => {
	await page.goto('/extensions.html');
	const view = page.locator('[data-view-id="ash.extensions.view"] .ash-extensions');
	await view.getByRole('button', { name: 'Install', exact: true }).click();
	const review = page.getByRole('dialog', { name: 'Install', exact: true });
	await expect(review).toContainText('executable: typescript-language-server');
	await expect(review).toContainText('skill: review');
	await expect(review).toContainText('Requested permissions: process');
	await review.getByRole('button', { name: 'Cancel', exact: true }).click();
	expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'install'))).toEqual([]);
	await installFixture(page);
	await page.evaluate(() => { window.ashExtensionsIntegration.addSecondVersion(); window.ashExtensionsIntegration.setOffline(); return window.ashExtensionsIntegration.open({ mode: 'installed' }); });
	const versions = view.getByRole('option').filter({ hasText: 'example/web' });
	await expect(versions).toHaveCount(2);
	await versions.filter({ hasText: '2.0.0' }).click();
	const editor = page.locator('.ash-extension-editor');
	await expect(editor).toContainText('2.0.0');
	await editor.getByRole('button', { name: 'Uninstall', exact: true }).click();
	await page.getByRole('dialog', { name: 'Uninstall extension', exact: true }).getByRole('button', { name: 'Uninstall', exact: true }).click();
	await expect(versions).toHaveCount(1);
	await expect(view.getByRole('option').filter({ hasText: 'ash.language-pack-zh-cn' })).toBeVisible();
	expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'uninstall'))).toEqual([['uninstall', { installationId: 'version-two', mode: 'whenUnused' }]]);
});

test('Third-party Ash sources can be added, paused and resumed through Extensions', async ({ page }) => {
	await page.goto('/extensions.html');
	await page.evaluate(() => window.ashExtensionsIntegration.startCommand('ash.extensions.manageSources'));
	await expect(page.getByRole('dialog', { name: 'Manage extension sources', exact: true })).not.toContainText('open-vsx');
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
	test(`Built-in language pack list and details use backend metadata in ${locale}`, async ({ page }) => {
		await page.goto(`/extensions.html?rustBuiltIn&locale=${locale}`);
		await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('ash.extensions.manageBuiltIn'));
		const languagePack = page.locator('[data-view-id="ash.extensions.view"] .ash-extensions').getByRole('option').filter({ hasText: 'ash.language-pack-zh-cn' });
		await expect(languagePack).toContainText('中文语言包（Rust 目录）');
		await languagePack.click();
		const editor = page.locator('.ash-extension-editor');
		await expect(editor.getByRole('heading', { name: '中文语言包（Rust 目录）', exact: true })).toBeVisible();
		await expect(editor.getByRole('status')).toContainText(languagePackReason);
		await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'extensionResource' && entry[1].extensionId === 'ash.language-pack-zh-cn').length)).toBeGreaterThan(0);
	});

	test(`Installed extensions include the built-in Chinese language pack in ${locale}`, async ({ page }) => {
		await page.goto(`/extensions.html?locale=${locale}`);
		await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('ash.extensions.open'));
		const view = page.locator('[data-view-id="ash.extensions.view"] .ash-extensions');
		const languagePack = view.getByRole('option').filter({ hasText: 'ash.language-pack-zh-cn' });
		await expect(languagePack).toContainText(locale === 'en' ? 'Built-in' : '内置');
		await expect(languagePack).toHaveAccessibleName(new RegExp(locale === 'en' ? 'Built-in' : '内置'));
		await expect(languagePack.getByRole('button')).toHaveCount(0);
		await languagePack.click();
		await expect(page.locator('.ash-extension-editor').getByRole('status')).toContainText(languagePackReason);
	});

	test(`All built-in extensions share enablement management and preserve language-pack behavior in ${locale}`, async ({ page }) => {
		await page.goto(`/extensions.html?locale=${locale}`);
		await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('ash.extensions.manageBuiltIn'));
		const view = page.locator('[data-view-id="ash.extensions.view"] .ash-extensions');
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
		const provider = page.locator('[data-view-id="ash.extensions.view"] .ash-extensions').getByRole('option').filter({ hasText: 'ash.github-authentication' });
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

	test(`Built-in Rust provider details remain readable without management authority in ${locale}`, async ({ page }) => {
		await page.goto(`/extensions.html?locale=${locale}&readOnlyProviders`);
		await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('ash.extensions.manageBuiltIn'));
		const provider = page.locator('[data-view-id="ash.extensions.view"] .ash-extensions').getByRole('option').filter({ hasText: 'ash.github-authentication' });
		await expect(provider).toHaveAccessibleName(new RegExp(locale === 'en' ? 'Enabled' : '已启用', 'u'));
		await expect(provider.getByRole('button')).toHaveCount(0);
		await provider.click();
		const editor = page.locator('.ash-extension-editor');
		const reason = locale === 'en' ? 'This connection cannot enable or disable backend providers.' : '此连接无权启用或禁用后端提供程序。';
		await expect(editor.getByRole('status')).toContainText(running);
		await expect(editor.getByRole('status')).toContainText(reason);
		await expect(editor.getByRole('button', { name: disable, exact: true })).toBeDisabled();
		// A native disabled control must also reject keyboard activation.
		await editor.getByRole('button', { name: disable, exact: true }).press('Enter');
		await expect(editor.getByRole('status')).toContainText(running);
		expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'builtInPolicy'))).toEqual([]);
	});
}

for (const [locale, skillsTitle, disable, enable, openInstructions] of [
	['en', 'Skills', 'Disable skill', 'Enable skill', 'Open instructions'],
	['zh-CN', '技能', '禁用技能', '启用技能', '打开说明'],
]) {
	test(`Extensions panes open scoped Skills details and readonly instructions in ${locale}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/extensions.html?locale=${locale}`);
		await expect(page.locator('#extensions .ash-pane-view-header-button')).toHaveCount(5);
		const skills = page.locator('[data-view-id="ash.extensions.skills"]');
		const header = skills.getByRole('button', { name: skillsTitle, exact: true });
		await expect(header).toHaveAttribute('aria-expanded', 'false');
		await page.evaluate(() => window.ashExtensionsIntegration.setSession('session-scope'));
		await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('workbench.action.chat.configure.skills'));
		await expect(header).toHaveAttribute('aria-expanded', 'true');
		const list = skills.getByRole('listbox');
		await list.focus();
		await list.press('Enter');
		const details = page.locator('.ash-extension-editor');
		await expect(details).toContainText('workspace / bad-skill: Invalid metadata');
		await details.getByRole('button', { name: disable, exact: true }).click();
		await expect(details.getByRole('button', { name: enable, exact: true })).toBeVisible();
		expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'skill'))).toEqual([['skill', { source: 'marketplace:example/web', name: 'review' }, false, 3, 'session-scope']]);
		await details.getByRole('button', { name: openInstructions, exact: true }).click();
		expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'document').map((entry: any) => [entry[0], { ...entry[1], resource: { scheme: entry[1].resource.scheme, authority: entry[1].resource.authority, path: entry[1].resource.path } }])[0])).toMatchObject(['document', { resource: { scheme: 'private', authority: 'skill', path: '/review/SKILL.md' }, readOnly: true, languageId: 'markdown' }]);
		expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.find((entry: any) => entry[0] === 'documentOptions'))).toMatchObject(['documentOptions', { selection: { startLineNumber: 5, startColumn: 1, endLineNumber: 5, endColumn: 1 } }]);
		await header.focus();
		await header.press('ArrowLeft');
		await expect(header).toHaveAttribute('aria-expanded', 'false');
		await header.press('ArrowRight');
		await expect(header).toHaveAttribute('aria-expanded', 'true');
		await expect(skills.getByRole('option').filter({ hasText: 'review' })).toBeVisible();
		expect(errors).toEqual([]);
	});
}

test('MCP pane merges installed and registered servers and opens owning package details', async ({ page }) => {
	await page.goto('/extensions.html');
	await page.evaluate(() => window.ashExtensionsIntegration.addMcpPackage());
	const mcp = page.locator('[data-view-id="ash.extensions.mcp"]');
	await mcp.getByRole('button', { name: /^(Connections|连接)$/u }).click();
	await expect(mcp.getByRole('option')).toHaveCount(1);
	await mcp.getByRole('option').click();
	const details = page.locator('.ash-extension-editor');
	await expect(details).toContainText('fixture_search');
	await expect(details).toContainText('Search fixture records');
	await expect(details).toContainText('network');
	await details.getByRole('button', { name: 'Open package', exact: true }).click();
	await expect(details.getByRole('heading', { name: 'Web tools', exact: true })).toBeVisible();
});

for (const [locale, states, statusLabel, diagnosticLabel, refreshLabel] of [
	['en', ['Disabled', 'Disconnected', 'Connected', 'Tool catalog out of date', 'Unavailable'], 'Status', 'Diagnostic', 'Refresh'],
	['zh-CN', ['已禁用', '已断开', '已连接', '工具目录已过期', '不可用'], '状态', '诊断', '刷新'],
] as const) {
	test(`MCP lists backend servers without tools and shows status and diagnostics in ${locale}`, async ({ page }) => {
		await page.goto(`/extensions.html?locale=${locale}`);
		await page.evaluate(() => window.ashExtensionsIntegration.setMcpServers(
			(['disabled', 'disconnected', 'connected', 'stale', 'unavailable'] as const).map((status, index) => ({
				id: `configured-${index}`, displayName: `Configured ${index}`, httpOrigin: index === 4 ? 'https://example.com' : null,
				state: status === 'unavailable' ? { status, reason: 'Connection refused <script>unsafe()</script>' } : { status },
				catalogGeneration: 7, connectionGeneration: status === 'connected' ? 2 : null, toolCount: index === 2 ? 17 : 0,
			}))
		));
		const mcp = page.locator('[data-view-id="ash.extensions.mcp"]');
		await mcp.getByRole('button', { name: /^(Connections|连接)$/u }).click();
		await expect(mcp.getByRole('option')).toHaveCount(5);
		for (let index = 0; index < states.length; index++) {
			await expect(mcp.getByRole('option').filter({ hasText: `Configured ${index}` })).toContainText(states[index]);
		}
		const list = mcp.getByRole('listbox');
		await list.focus();
		await list.press('Home');
		await list.press('Enter');
		const details = page.locator('.ash-extension-editor');
		await expect(details.getByRole('heading', { name: 'Configured 0', exact: true })).toBeVisible();
		await expect(details.getByRole('status')).toHaveText(states[0]);
		await mcp.getByRole('option').filter({ hasText: 'Configured 2' }).click();
		await expect(details.locator('dt').filter({ hasText: /^Tools$|^工具$/ }).locator('xpath=following-sibling::dd[1]')).toHaveText('17');
		await mcp.getByRole('option').filter({ hasText: 'Configured 4' }).click();
		await expect(details.locator('dt').filter({ hasText: diagnosticLabel }).locator('xpath=following-sibling::dd[1]')).toHaveText('Connection refused <script>unsafe()</script>');
		await expect(details).toContainText('https://example.com');
		await expect(details.locator('script')).toHaveCount(0);
		await page.evaluate(() => window.ashExtensionsIntegration.setMcpServers([{ id: 'configured-4', displayName: 'Recovered server', httpOrigin: 'https://example.com', state: { status: 'connected' }, catalogGeneration: 8, connectionGeneration: 3, toolCount: 0 }]));
		await details.getByRole('button', { name: refreshLabel, exact: true }).click();
		await expect(details.getByRole('status')).toHaveText(states[2]);
		await expect(details.getByRole('heading', { name: 'Recovered server', exact: true })).toBeVisible();
		await expect(details.getByRole('button', { name: refreshLabel, exact: true })).toBeFocused();
		await expect(details.locator('dt').filter({ hasText: statusLabel }).locator('xpath=following-sibling::dd[1]')).toHaveText(states[2]);
		await expect(details).not.toContainText('Connection refused');
		await page.evaluate(() => window.ashExtensionsIntegration.refreshMcp());
		await expect(mcp.getByRole('option')).toHaveCount(1);
		await expect(mcp.getByRole('option')).toContainText('Recovered server');
		expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.some((entry: any) => entry[0] === 'mcp/server/status' && Object.keys(entry[1]).length === 0))).toBe(true);
	});
}

test('MCP status failures retain installed packages and never infer connection state from tools', async ({ page }) => {
	await page.goto('/extensions.html');
	await page.evaluate(() => { window.ashExtensionsIntegration.addMcpPackage(); window.ashExtensionsIntegration.failMcpStatus(); });
	const mcp = page.locator('[data-view-id="ash.extensions.mcp"]');
	await mcp.getByRole('button', { name: /^(Connections|连接)$/u }).click();
	await expect(mcp.getByRole('option')).toHaveCount(1);
	await expect(mcp.getByRole('status')).toContainText('Could not load MCP server status: Error: Status connection lost');
	await expect(mcp.getByRole('option')).not.toContainText('Connected');
	await mcp.getByRole('option').click();
	const details = page.locator('.ash-extension-editor');
	await expect(details.getByRole('status')).toContainText('MCP server status is unavailable.');
	await expect(details).toContainText('Status connection lost');
	await details.getByRole('tab', { name: 'Tools', exact: true }).click();
	await expect(details).toContainText('fixture_search');
	await expect(details.getByRole('status')).not.toContainText('Connected');
	await details.getByRole('button', { name: 'Open package', exact: true }).click();
	await expect(details.getByRole('heading', { name: 'Web tools', exact: true })).toBeVisible();
});

test('MCP server status remains visible when tool descriptions fail and unsupported backends do not receive status requests', async ({ page }) => {
	await page.goto('/extensions.html');
	await page.evaluate(() => window.ashExtensionsIntegration.failMcpTools());
	const mcp = page.locator('[data-view-id="ash.extensions.mcp"]');
	await mcp.getByRole('button', { name: /^(Connections|连接)$/u }).click();
	await mcp.getByRole('option').click();
	const details = page.locator('.ash-extension-editor');
	await expect(details.getByRole('status')).toHaveText('Connected');
	await details.getByRole('tab', { name: 'Tools', exact: true }).click();
	await expect(details).toContainText('Could not load tool descriptions: Error: Tool catalog unavailable');
	await page.evaluate(() => { window.ashExtensionsIntegration.addMcpPackage(); window.ashExtensionsIntegration.setMcpSupported(false); window.ashExtensionsIntegration.requests.length = 0; });
	await page.evaluate(() => window.ashExtensionsIntegration.refreshMcp());
	await expect(mcp.getByRole('status')).toContainText('MCP server status is unavailable.');
	expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'mcp/server/status'))).toEqual([]);
});

test('MCP detail changes discard a delayed status response for the previous server', async ({ page }) => {
	await page.goto('/extensions.html');
	await page.evaluate(() => window.ashExtensionsIntegration.setMcpServers([
		{ id: 'first', displayName: 'First server', httpOrigin: null, state: { status: 'unavailable', reason: 'Retired diagnostic' }, catalogGeneration: 1, connectionGeneration: null, toolCount: 0 },
		{ id: 'second', displayName: 'Second server', httpOrigin: null, state: { status: 'disabled' }, catalogGeneration: 1, connectionGeneration: null, toolCount: 0 },
	]));
	const mcp = page.locator('[data-view-id="ash.extensions.mcp"]');
	await mcp.getByRole('button', { name: /^(Connections|连接)$/u }).click();
	await expect(mcp.getByRole('option')).toHaveCount(2);
	await page.evaluate(() => window.ashExtensionsIntegration.holdMcpStatus());
	await mcp.getByRole('option').filter({ hasText: 'First server' }).click();
	await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.mcpStatusStarted())).toBe(true);
	await mcp.getByRole('option').filter({ hasText: 'Second server' }).click();
	const details = page.locator('.ash-extension-editor');
	await expect(details.getByRole('heading', { name: 'Second server', exact: true })).toBeVisible();
	await expect(details.getByRole('status')).toHaveText('Disabled');
	await page.evaluate(() => window.ashExtensionsIntegration.completeMcpStatus());
	await expect(details.getByRole('heading', { name: 'Second server', exact: true })).toBeVisible();
	await expect(details).not.toContainText('Retired diagnostic');
});

test('Installed Extensions includes packages with different capabilities and retains independent search', async ({ page }) => {
	await page.goto('/extensions.html');
	await page.evaluate(() => window.ashExtensionsIntegration.addSkillOnlyPlugin());
	await page.evaluate(() => window.ashExtensionsIntegration.openEditorExtension());
	await page.locator('.ash-extension-editor').getByRole('button', { name: 'Install', exact: true }).click();
	await page.getByRole('dialog', { name: 'Install', exact: true }).getByRole('button', { name: 'Install', exact: true }).click();
	await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('ash.extensions.installed'));
	const plugins = page.locator('[data-view-id="ash.extensions.plugins"]');
	await expect(plugins.getByRole('option').filter({ hasText: 'publisher.sample' })).toHaveCount(1);
	await plugins.getByRole('option').filter({ hasText: 'Skill-only plugin' }).click();
	await expect(page.locator('.ash-extension-editor')).toContainText('acme/skills');
	await plugins.getByRole('searchbox').fill('skills');
	await plugins.getByRole('button', { name: 'Installed Extensions', exact: true }).click();
	await plugins.getByRole('button', { name: 'Installed Extensions', exact: true }).click();
	await expect(plugins.getByRole('searchbox')).toHaveValue('skills');
	await expect(page.locator('[data-view-id="ash.extensions.view"]').getByRole('searchbox')).toHaveValue('');
});

test('Changing the selected capability aborts a pending instructions read and discards its document', async ({ page }) => {
	await page.goto('/extensions.html');
	await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('workbench.action.chat.configure.skills'));
	await page.locator('[data-view-id="ash.extensions.skills"]').getByRole('option').click();
	await page.evaluate(() => window.ashExtensionsIntegration.holdInstructions());
	await page.locator('.ash-extension-editor').getByRole('button', { name: 'Open instructions', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.instructionsStarted())).toBe(true);
	const mcp = page.locator('[data-view-id="ash.extensions.mcp"]');
	await mcp.getByRole('button', { name: /^(Connections|连接)$/u }).click();
	await mcp.getByRole('option').click();
	await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.instructionsAborted())).toBe(true);
	await page.evaluate(() => window.ashExtensionsIntegration.completeInstructions());
	await expect(page.locator('.ash-extension-editor')).toContainText('fixture_search');
	expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'document'))).toEqual([]);
});

for (const theme of ['light', 'dark', 'hc']) {
	test(`Extensions pane layout and details remain usable in ${theme}`, async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 840 });
		await page.goto(`/extensions.html?preview&theme=${theme}`);
		await page.evaluate(() => { window.ashExtensionsIntegration.addMcpPackage(); window.ashExtensionsIntegration.addSkillOnlyPlugin(); });
		for (const name of ['Installed Extensions', 'Skills', 'Connections']) {
			await page.locator('#extensions').getByRole('button', { name, exact: true }).click();
		}
		await page.locator('[data-view-id="ash.extensions.mcp"]').getByRole('option').click();
		await expect(page.locator('.ash-extension-editor')).toContainText('fixture_search');
		for (const viewId of ['view', 'plugins', 'skills', 'mcp']) {
			const view = page.locator(`[data-view-id="ash.extensions.${viewId}"]`);
			await expect(view.getByRole('listbox')).toBeVisible();
			await expect.poll(() => view.locator('.extensions-list').evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(64);
		}
		const boundary = page.locator('#extensions .ash-split-view-pane').nth(1);
		const separator = await boundary.evaluate(element => { const style = getComputedStyle(element, '::before'); return { height: style.height, color: style.backgroundColor }; });
		expect(separator.height).toBe('1px');
		expect(separator.color).not.toBe('rgba(0, 0, 0, 0)');
		await page.screenshot({ path: `.build/desktop/ui-previews/extensions-panes-${theme}.png` });
	});
}

for (const theme of ['light', 'dark', 'hc']) {
	test(`extension settings support keyboard navigation and shared controls in Chinese (${theme})`, async ({ page }) => {
		await page.goto(`/extensions.html?locale=zh-CN&theme=${theme}`);
		await page.evaluate(() => window.ashExtensionsIntegration.prepareSettings());
		const settings = page.locator('#extension-settings');
		const tree = settings.getByRole('tree');
		await expect(tree).toBeFocused();
		await expect(tree.getByText('扩展', { exact: true })).toBeVisible();
		await tree.press('ArrowRight');
		await tree.press('ArrowDown');
		await tree.press('Enter');
		await expect(tree.getByRole('treeitem', { name: 'Sample extension' })).toHaveAttribute('aria-selected', 'true');
		const toggle = settings.getByRole('switch', { name: 'sample.enabled', exact: true });
		await toggle.focus();
		await toggle.press('Space');
		await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.readSetting('sample.enabled'))).toBe(true);
		await expect(toggle).toBeFocused();
		const count = settings.getByRole('spinbutton', { name: 'sample.count', exact: true });
		await count.fill('4');
		await count.press('Tab');
		await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.readSetting('sample.count'))).toBe(4);
		const text = settings.getByRole('textbox', { name: 'sample.text', exact: true });
		await text.fill('updated');
		await text.press('Tab');
		await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.readSetting('sample.text'))).toBe('updated');
		const mode = settings.getByRole('combobox', { name: 'sample.mode', exact: true });
		await mode.focus();
		await mode.press('Enter');
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.readSetting('sample.mode'))).toBe('second');
		const complex = settings.locator('[data-configuration-key="sample.rules"]');
		await complex.getByRole('button', { name: '在 JSON 中编辑', exact: true }).click();
		expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'settingsJson'))).toEqual([['settingsJson', 'sample.rules']]);
		await page.evaluate(() => window.ashExtensionsIntegration.dispose());
		await expect(settings).toHaveCount(0);
	});
}

for (const labels of [
	{ locale: 'en', signIn: 'Sign in', signOut: 'Sign out', cancel: 'Cancel sign-in', waiting: 'Complete sign-in in your browser.', connected: 'Connected', disconnected: 'Disconnected' },
	{ locale: 'zh-CN', signIn: '登录', signOut: '退出登录', cancel: '取消登录', waiting: '请在浏览器中完成登录。', connected: '已连接', disconnected: '已断开' },
]) {
	test(`MCP OAuth sign-in, cancellation and local logout in ${labels.locale}`, async ({ page }) => {
		await page.goto(`/extensions.html?locale=${labels.locale}`);
		await page.evaluate(() => {
			window.ashExtensionsIntegration.enableMcpOAuth();
			window.ashExtensionsIntegration.configureMcp({ id: 'user:mcp:oauth', displayName: 'OAuth fixture', transport: { type: 'streamableHttp', url: 'https://mcp.test/rpc' }, credential: { type: 'unauthenticated' }, enablement: 'enabled' });
		});
		const mcp = page.locator('[data-view-id="ash.extensions.mcp"]');
		await mcp.getByRole('button', { name: /^(Connections|连接)$/u }).click();
		await mcp.getByRole('option').filter({ hasText: 'OAuth fixture' }).click();
		const details = page.locator('.ash-extension-editor');
		await details.getByRole('button', { name: labels.signIn, exact: true }).focus();
		await page.keyboard.press('Enter');
		await expect(details).toContainText(labels.waiting);
		await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.mcpLoginWaiting())).toBe(true);
		await details.getByRole('button', { name: labels.cancel, exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'mcp/oauth/cancel').length)).toBe(1);
		await expect(details).toHaveAttribute('aria-busy', 'false');
		await details.getByRole('button', { name: labels.signIn, exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.mcpLoginWaiting())).toBe(true);
		await page.evaluate(() => window.ashExtensionsIntegration.completeMcpLogin());
		await expect(details).toHaveAttribute('aria-busy', 'false');
		await expect(mcp.getByRole('option').filter({ hasText: 'OAuth fixture' })).toContainText(labels.connected);
		await details.getByRole('button', { name: labels.signOut, exact: true }).click();
		await expect(mcp.getByRole('option').filter({ hasText: 'OAuth fixture' })).toContainText(labels.disconnected);
		expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'mcp/oauth/complete'))).toEqual([
			['mcp/oauth/complete', { flowId: 'synthetic-flow', state: 'synthetic-state', authorizationCode: 'synthetic-code', issuer: 'https://issuer.test' }],
		]);
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`custom LSP configuration supports keyboard editing and localized validation in ${locale}`, async ({ page }) => {
		await page.goto(`/extensions.html?locale=${locale}`);
		const lsp = page.locator('.ash-language-server-settings');
		const advanced = lsp.getByLabel(locale === 'en' ? 'Advanced configuration (JSON)' : '高级配置（JSON）', { exact: true });
		await expect(advanced).toBeVisible();
		await advanced.focus();
		await page.keyboard.press('ControlOrMeta+A');
		await page.keyboard.insertText('{"languageIds":["python"],"args":["--stdio"],"environment":{"EXAMPLE":"enabled"},"initializationOptions":{"feature":true},"settings":{"python":{"strict":true}}}');
		const save = lsp.getByRole('button', { name: locale === 'en' ? 'Save server configuration' : '保存服务器配置', exact: true });
		await page.keyboard.press('Tab');
		await expect(save).toBeFocused();
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'configure').length)).toBe(1);
		const request = await page.evaluate(() => window.ashExtensionsIntegration.requests.find((entry: any) => entry[0] === 'configure'));
		expect(request).toEqual(['configure', expect.any(String), expect.objectContaining({ languageIds: ['python'], args: ['--stdio'], environment: { EXAMPLE: 'enabled' }, initializationOptions: { feature: true }, settings: { python: { strict: true } } }), expect.any(Number)]);
		await advanced.fill('{"args":42}');
		await save.click();
		await expect(advanced).toBeFocused();
		await expect(lsp.getByRole('status')).toContainText(locale === 'en' ? 'Enter valid JSON' : '请输入有效的 JSON');
		expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'configure').length)).toBe(1);
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`Native editor packages show their document and accurate execution review in ${locale}`, async ({ page }) => {
		await page.goto(`/extensions.html?locale=${locale}&nativeEditor`);
		await page.evaluate(() => window.ashExtensionsIntegration.open({ capabilityKind: 'editorExtension' }));
		await page.locator('[data-view-id="ash.extensions.view"] .ash-extensions').getByRole('option').click();
		const editor = page.locator('.ash-extension-editor');
		await expect(editor.getByRole('heading', { name: 'Academy', exact: true })).toBeVisible();
		await expect(editor).toContainText('Tools for working with your project.');
		const install = locale === 'en' ? 'Install' : '安装';
		await editor.getByRole('button', { name: install, exact: true }).click();
		await page.getByRole('dialog', { name: install, exact: true }).getByRole('button', { name: install, exact: true }).click();
		const authorize = locale === 'en' ? 'Authorize execution' : '授权执行';
		await editor.getByRole('button', { name: authorize, exact: true }).press('Enter');
		const review = page.getByRole('dialog', { name: 'ash.academic@ash', exact: true });
		await expect(review).toContainText(locale === 'en' ? 'native program and trusted editor client' : '原生程序和可信编辑器客户端');
		await expect(review).toContainText(locale === 'en' ? 'unsaved text' : '未保存文本');
		await expect(review).not.toContainText('Node');
		await review.getByRole('button', { name: authorize, exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.requests.some((entry: any) => entry[0] === 'editorPolicy' && entry[1].action === 'grant'))).toBe(true);
		await expect(editor.getByRole('button', { name: locale === 'en' ? 'Revoke execution authorization' : '撤销执行授权', exact: true })).toBeVisible();
	});
}
