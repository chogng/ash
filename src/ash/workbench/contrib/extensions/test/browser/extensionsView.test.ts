import { expect } from '@playwright/test';
import type { ConnectorView } from '../../../../../platform/connectors/common/connectorService.js';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('extensions browser component', () => {
	const browserTests = useBrowserTests();
	function serviceAccount(id: string, displayName: string, oauth = false): ConnectorView {
		return {
			id, displayName, description: `Authorize ${displayName}`, mcpDeclarationId: `fixture:${id}:mcp:tools`, mcpServerId: null,
			connectionGeneration: 0, enabled: false, state: { status: 'disconnected' }, oauthMethods: oauth ? ['browser'] : [],
			canConnectOAuth: oauth, canConnectApiToken: !oauth, canDisconnect: false, canRefreshOAuth: false, canRevokeOAuth: false,
		};
	}

	for (const locale of ['en', 'zh-CN']) {
		const zh = locale === 'zh-CN';
		const labels = { add: zh ? '添加连接' : 'Add connection', account: zh ? '服务账号' : 'Service account', choose: zh ? '选择服务账号' : 'Choose a service account', token: zh ? '使用 API 令牌连接' : 'Connect with API token', cancel: zh ? '取消' : 'Cancel' };
		test(`Add connection authorizes a service account with a token even without MCP management in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?classification&locale=${locale}`);
			const github = serviceAccount('github', 'GitHub account');
			const docs = serviceAccount('documents', 'Cloud documents', true);
			await page.evaluate(entries => { window.ashExtensionsIntegration.setConnectors(entries); window.ashExtensionsIntegration.setMcpSupported(false); }, [github, docs]);
			const pane = page.locator('[data-view-id="ash.extensions.mcp"]');
			await pane.locator('.ash-pane-view-header-button').press('ArrowRight');
			const add = pane.getByRole('button', { name: labels.add, exact: true });
			const choose = async () => {
				await add.click();
				const root = page.getByRole('dialog', { name: labels.add, exact: true });
				await expect(root.getByRole('option').filter({ hasText: zh ? '自定义 MCP 服务器' : 'Custom MCP server' })).toHaveCount(0);
				await root.getByRole('option', { name: new RegExp(labels.account, 'u') }).click();
				return page.getByRole('combobox', { name: labels.choose, exact: true });
			};
			const picker = await choose();
			await expect(picker).toBeFocused();
			await expect(page.getByRole('dialog', { name: labels.choose, exact: true }).getByRole('option')).toHaveCount(2);
			await picker.press('Escape');
			await expect(add).toBeFocused();
			await choose();
			await picker.fill('GitHub');
			await picker.press('Enter');
			const authorization = page.getByRole('dialog', { name: github.displayName, exact: true });
			await expect(authorization.getByRole('button', { name: zh ? '登录' : 'Sign in', exact: true })).toHaveCount(0);
			await authorization.getByRole('button', { name: labels.token, exact: true }).click();
			await authorization.getByRole('button', { name: labels.cancel, exact: true }).click();
			await expect(add).toBeFocused();
			expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0].startsWith('connector/')))).toEqual([]);
			await choose();
			await picker.fill('GitHub');
			await picker.press('Enter');
			await authorization.getByRole('button', { name: labels.token, exact: true }).click();
			await authorization.getByPlaceholder(zh ? '账户标识符' : 'Account ID', { exact: true }).fill('octocat');
			await authorization.getByPlaceholder(zh ? '账户名称' : 'Account name', { exact: true }).fill('Octocat');
			const token = authorization.getByPlaceholder(zh ? 'API 令牌' : 'API token', { exact: true });
			await expect(token).toHaveAttribute('type', 'password');
			await token.fill('synthetic-token');
			await authorization.getByRole('button', { name: zh ? '连接' : 'Connect', exact: true }).click();
			const details = page.locator('.ash-extension-editor');
			await expect(details.getByRole('heading', { name: github.displayName, exact: true })).toBeVisible();
			await expect(details.getByRole('status')).toHaveText(zh ? '已连接 · Octocat' : 'Connected · Octocat');
			await expect(pane.getByRole('option').filter({ hasText: github.displayName })).toHaveCount(1);
			await expect(pane.getByRole('option').filter({ hasText: github.displayName })).toContainText(zh ? '已连接 · Octocat' : 'Connected · Octocat');
			expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0].startsWith('connector/') || entry[0] === 'mcp/server/upsert'))).toEqual([['connector/connect', 'github', 'octocat']]);
		});

		test(`Add connection signs in with current service permissions in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?classification&locale=${locale}`);
			const account = serviceAccount('documents', 'Cloud documents');
			await page.evaluate(entry => window.ashExtensionsIntegration.setConnectors([entry]), account);
			const pane = page.locator('[data-view-id="ash.extensions.mcp"]');
			await pane.locator('.ash-pane-view-header-button').press('ArrowRight');
			await pane.getByRole('button', { name: labels.add, exact: true }).click();
			await page.getByRole('dialog', { name: labels.add, exact: true }).getByRole('option', { name: new RegExp(labels.account, 'u') }).click();
			const picker = page.getByRole('combobox', { name: labels.choose, exact: true });
			await expect(picker).toBeFocused();
			// Permission changes while the picker is open must be read before showing authorization actions.
			await page.evaluate(entry => window.ashExtensionsIntegration.setConnectors([entry]), serviceAccount('documents', 'Cloud documents', true));
			await picker.press('Enter');
			const authorization = page.getByRole('dialog', { name: account.displayName, exact: true });
			await expect(authorization.getByRole('button', { name: labels.token, exact: true })).toHaveCount(0);
			await page.screenshot({ path: `.build/desktop/ui-previews/add-connection-account-auth-${locale}.png` });
			await authorization.getByRole('button', { name: zh ? '登录' : 'Sign in', exact: true }).click();
			await expect(page.locator('.ash-extension-editor').getByRole('status')).toHaveText(zh ? '已连接 · OAuth user' : 'Connected · OAuth user');
			expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'connector/oauth'))).toEqual([['connector/oauth', 'documents', 3]]);
		});

		test(`Add connection explains an empty service catalog and recovers from a failed read in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?classification&locale=${locale}`);
			const pane = page.locator('[data-view-id="ash.extensions.mcp"]');
			await pane.locator('.ash-pane-view-header-button').press('ArrowRight');
			const add = pane.getByRole('button', { name: labels.add, exact: true });
			const openAccounts = async () => {
				await add.click();
				await page.getByRole('dialog', { name: labels.add, exact: true }).getByRole('option', { name: new RegExp(labels.account, 'u') }).click();
			};
			await openAccounts();
			const empty = page.getByRole('dialog').filter({ hasText: zh ? '暂无可用的服务账号。' : 'No service accounts are available.' });
			await expect(empty).toContainText(zh ? '先安装提供服务账号的插件' : 'Install a plugin that provides a service account');
			await empty.getByRole('button').click();
			await expect(add).toBeFocused();
			await page.evaluate(() => window.ashExtensionsIntegration.failConnectorList(true));
			await openAccounts();
			await expect(pane.locator('.extensions-status')).toContainText('Service catalog unavailable');
			await expect(add).toBeEnabled();
			await page.evaluate(entry => { window.ashExtensionsIntegration.failConnectorList(false); window.ashExtensionsIntegration.setConnectors([entry]); }, serviceAccount('documents', 'Cloud documents', true));
			await openAccounts();
			await page.getByRole('combobox', { name: labels.choose, exact: true }).press('Escape');
			await expect(add).toBeFocused();
		});
	}

	test('Add connection refuses stale account authorization and closes its picker on disposal', async function () {
		const { page } = browserTests;

		await page.goto('/extensions.html?classification');
		await page.evaluate(entry => window.ashExtensionsIntegration.setConnectors([entry]), serviceAccount('github', 'GitHub account', true));
		const pane = page.locator('[data-view-id="ash.extensions.mcp"]');
		await pane.locator('.ash-pane-view-header-button').press('ArrowRight');
		const add = pane.getByRole('button', { name: 'Add connection', exact: true });
		const openAccounts = async () => {
			await add.click();
			await page.getByRole('dialog', { name: 'Add connection', exact: true }).getByRole('option').filter({ hasText: 'Service account' }).click();
		};
		await openAccounts();
		await page.getByRole('combobox', { name: 'Choose a service account', exact: true }).press('Enter');
		await page.evaluate(() => window.ashExtensionsIntegration.notifyConnectorsChanged());
		await page.getByRole('dialog', { name: 'GitHub account', exact: true }).getByRole('button', { name: 'Sign in', exact: true }).click();
		await expect(pane.locator('.extensions-status')).toContainText('Connection changed. Refresh before saving.');
		await openAccounts();
		await expect(page.getByRole('combobox', { name: 'Choose a service account', exact: true })).toBeFocused();
		await page.evaluate(() => window.ashExtensionsIntegration.dispose());
		await expect(page.locator('.ash-quick-input-host')).toHaveCount(0);
		expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'connector/oauth'))).toEqual([]);
	});

	test('Empty Connections remains responsive after pointer and keyboard expansion', async function () {
		const { page } = browserTests;

		await page.goto('/extensions.html?classification');
		await page.evaluate(async () => {
			window.ashExtensionsIntegration.setMcpServers([]);
			await window.ashExtensionsIntegration.refreshMcp();
		});
		const pane = page.locator('[data-view-id="ash.extensions.mcp"]');
		const header = pane.locator('.ash-pane-view-header-button');
		for (const button of await page.locator('#extensions .ash-pane-view-header-button').all()) {
			await button.press('ArrowLeft');
		}
		await expect(pane.getByRole('option')).toHaveCount(0);
		await header.click();
		await expect(header).toHaveAttribute('aria-expanded', 'true');
		await expect(pane.locator('.ash-pane-view-content')).toHaveAttribute('aria-busy', 'false');
		const heights = await pane.evaluate(async element => {
			const heights: number[] = [];
			for (let frame = 0; frame < 30; frame++) {
				await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
				heights.push(element.getBoundingClientRect().height);
			}
			return heights;
		});
		expect(Math.max(...heights.slice(-10)) - Math.min(...heights.slice(-10))).toBeLessThan(1);
		await header.press('ArrowLeft');
		await expect(header).toHaveAttribute('aria-expanded', 'false');
		await header.press('ArrowRight');
		await pane.getByRole('button', { name: 'Add connection', exact: true }).click();
		await expect(page.getByRole('dialog', { name: 'Add connection', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toBeHidden();
	});

	for (const locale of ['en', 'zh-CN']) {
		test(`Connections coalesces change bursts and reads the latest state in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?classification&locale=${locale}`);
			const pane = page.locator('[data-view-id="ash.extensions.mcp"]');
			await pane.locator('.ash-pane-view-header-button').press('ArrowRight');
			const content = pane.locator('.ash-pane-view-content');
			await expect(content).toHaveAttribute('aria-busy', 'false');
			await page.evaluate(() => {
				window.ashExtensionsIntegration.holdMcpStatus();
				void window.ashExtensionsIntegration.refreshMcp();
			});
			await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.mcpStatusStarted())).toBe(true);
			const before = await page.evaluate(() => window.ashExtensionsIntegration.managementReads().connectors);
			await page.evaluate(() => {
				window.ashExtensionsIntegration.setMcpServers([{ id: 'latest', displayName: 'Latest server', httpOrigin: null, state: { status: 'disconnected' }, catalogGeneration: 2, connectionGeneration: null, toolCount: 0 }]);
				for (let index = 0; index < 25; index++) { window.ashExtensionsIntegration.notifyConnectorsChanged(); }
			});
			try {
				await pane.locator('.ash-pane-view-header-button').press('ArrowLeft');
				await pane.locator('.ash-pane-view-header-button').press('ArrowRight');
				expect(await page.evaluate(() => window.ashExtensionsIntegration.managementReads().connectors)).toBe(before);
				await expect(content).toHaveAttribute('aria-busy', 'true');
			} finally {
				await page.evaluate(() => window.ashExtensionsIntegration.completeMcpStatus());
			}
			await expect(content).toHaveAttribute('aria-busy', 'false');
			await expect(pane.getByRole('option')).toHaveCount(1);
			await expect(pane.getByRole('option')).toContainText('Latest server');
			expect(await page.evaluate(() => window.ashExtensionsIntegration.managementReads().connectors)).toBe(before + 1);
		});

		test(`Hiding Connections drops its queued refresh in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?classification&locale=${locale}`);
			const pane = page.locator('[data-view-id="ash.extensions.mcp"]');
			await pane.locator('.ash-pane-view-header-button').press('ArrowRight');
			await expect(pane.locator('.ash-pane-view-content')).toHaveAttribute('aria-busy', 'false');
			await page.evaluate(() => {
				window.ashExtensionsIntegration.holdMcpStatus();
				void window.ashExtensionsIntegration.refreshMcp();
			});
			await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.mcpStatusStarted())).toBe(true);
			const before = await page.evaluate(() => window.ashExtensionsIntegration.managementReads().connectors);
			try {
				await page.evaluate(async () => {
					window.ashExtensionsIntegration.notifyConnectorsChanged();
					await window.ashExtensionsIntegration.open({ view: 'skills', mode: 'browse' });
				});
				await expect(pane).toHaveCount(0);
			} finally {
				await page.evaluate(() => window.ashExtensionsIntegration.completeMcpStatus());
			}
			await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
			expect(await page.evaluate(() => window.ashExtensionsIntegration.managementReads().connectors)).toBe(before);
			await page.evaluate(() => window.ashExtensionsIntegration.open({ view: 'mcp', mode: 'installed' }));
			await expect(pane.locator('.ash-pane-view-content')).toHaveAttribute('aria-busy', 'false');
			await expect(pane.getByRole('option')).toHaveCount(1);
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		for (const theme of ['light', 'dark', 'hc']) {
			test(`Connections lists all connections together and explains their details (${locale}, ${theme})`, async function () {
				const { page } = browserTests;

				await page.goto(`/extensions.html?classification&locale=${locale}&theme=${theme}`);
				await page.evaluate(() => {
					window.ashExtensionsIntegration.addMcpPackage();
					window.ashExtensionsIntegration.addConnector({ declarationId: 'marketplace:example/web:mcp:fixture-server', serverId: 'github:connector:account:mcp:tools' });
					window.ashExtensionsIntegration.setMcpServers([
						{ id: 'marketplace:example/web:mcp:fixture-server', displayName: 'Declared service server', httpOrigin: null, state: { status: 'connected' }, catalogGeneration: 1, connectionGeneration: 1, toolCount: 4 },
						{ id: 'github:connector:account:mcp:tools', displayName: 'Account runtime server', httpOrigin: null, state: { status: 'disconnected' }, catalogGeneration: 1, connectionGeneration: null, toolCount: 0 },
						{ id: 'user:mcp:same-name', displayName: 'GitHub account', httpOrigin: null, state: { status: 'disabled' }, catalogGeneration: 1, connectionGeneration: null, toolCount: 0 },
						{ id: 'independent', displayName: 'Independent server', httpOrigin: null, state: { status: 'connected' }, catalogGeneration: 1, connectionGeneration: 1, toolCount: 1 },
					]);
					window.ashExtensionsIntegration.notifyConnectorsChanged();
				});
				const pane = page.locator('[data-view-id="ash.extensions.mcp"]');
				await pane.getByRole('button', { name: locale === 'en' ? 'Connections' : '连接', exact: true }).press('ArrowRight');
				await expect(pane.locator('.ash-pane-view-content')).toHaveAttribute('aria-busy', 'false');
				const list = pane.getByRole('listbox', { name: locale === 'en' ? 'Connections' : '连接', exact: true });
				await expect(pane.getByRole('listbox')).toHaveCount(1);
				await expect(list.getByRole('option')).toHaveCount(3);
				await expect(list.getByRole('option').filter({ hasText: 'GitHub account' })).toHaveCount(2);
				await expect(list.getByRole('option').filter({ hasText: 'Account runtime server' })).toHaveCount(0);
				await expect(list.getByRole('option').filter({ hasText: 'Declared service server' })).toHaveCount(0);
				await expect(pane.locator('.ash-count-badge')).toHaveText('3');
				await expect(pane.locator('.ash-pane-view-header-actions button')).toHaveCount(1);
				await page.screenshot({ path: `.build/desktop/ui-previews/connections-flat-${locale}-${theme}.png` });
				const search = page.locator('#extensions').getByRole('searchbox');
				await search.fill('@connections GitHub'); await search.press('Enter');
				await expect(pane.locator('.ash-pane-view-header > .ash-count-badge')).toHaveText('2');
				await search.press('Escape');
				await expect(pane.locator('.ash-pane-view-header > .ash-count-badge')).toHaveText('3');
				await list.focus();
				await page.keyboard.press('Home'); await page.keyboard.press('Enter');
				const details = page.locator('.ash-extension-editor');
				await expect(details.getByRole('heading', { name: 'GitHub account', exact: true })).toBeVisible();
				await expect(details.locator('.extension-detail-heading')).toContainText(locale === 'en' ? 'This connection uses a service account.' : '此连接通过服务账号授权。');
				await expect(details.locator('.extension-detail-info')).toContainText('octocat');
				await expect(details.getByRole('status')).toHaveText(locale === 'en' ? 'Connected · Octocat' : '已连接 · Octocat');
				await expect(details.locator('.extension-detail-info')).toContainText('github:connector:account:mcp:tools');
				await expect(details.locator('.extension-detail-info')).toContainText(locale === 'en' ? 'MCP server' : 'MCP 服务器');
				await details.getByRole('tab', { name: locale === 'en' ? 'MCP server' : 'MCP 服务器', exact: true }).click();
				await expect(details.locator('.extension-capabilities')).toContainText('github:connector:account:mcp:tools');
				await page.screenshot({ path: `.build/desktop/ui-previews/connection-flat-details-${locale}-${theme}.png` });
				await details.getByRole('button', { name: locale === 'en' ? 'Open MCP server details' : '打开 MCP 服务器详情', exact: true }).click();
				await expect(details.getByRole('heading', { name: 'Account runtime server', exact: true })).toBeVisible();
				await expect(details.locator('.extension-detail-heading > .extension-metadata')).toHaveText('github:connector:account:mcp:tools');
				await expect(details.getByRole('status')).toHaveText(locale === 'en' ? 'Disconnected' : '已断开');
				await list.getByRole('option').filter({ hasText: 'GitHub account' }).nth(1).click();
				await expect(details.locator('.extension-detail-heading > .extension-metadata')).toHaveText('user:mcp:same-name');
				await expect(details.locator('.extension-detail-heading')).toContainText(locale === 'en' ? 'This connection uses an MCP server.' : '此连接通过 MCP 服务器提供工具。');
				await expect(details.getByRole('status')).toHaveText(locale === 'en' ? 'Disabled' : '已禁用');
				await expect(details.getByRole('button', { name: locale === 'en' ? 'Connect with API token' : '使用 API 令牌连接', exact: true })).toHaveCount(0);
			});
		}

		test(`Connections keeps account-bound declarations out of the list before runtime starts in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?classification&locale=${locale}`);
			await page.evaluate(() => {
				window.ashExtensionsIntegration.addMcpPackage();
				window.ashExtensionsIntegration.addConnector({ declarationId: 'marketplace:example/web:mcp:fixture-server', serverId: 'github:connector:account:mcp:tools' });
				window.ashExtensionsIntegration.setMcpServers([]);
				window.ashExtensionsIntegration.notifyConnectorsChanged();
			});
			const pane = page.locator('[data-view-id="ash.extensions.mcp"]');
			await pane.locator('.ash-pane-view-header-button').press('ArrowRight');
			await expect(pane.getByRole('option')).toHaveCount(1);
			await pane.getByRole('option').click();
			const details = page.locator('.ash-extension-editor');
			await expect(details.locator('.extension-detail-info')).toContainText(locale === 'en' ? 'No runtime status reported' : '未报告运行状态');
			await details.getByRole('switch').press('Space');
			await expect(details.getByRole('status')).toHaveText(locale === 'en' ? 'Disconnected' : '已断开');
			await expect(pane.getByRole('option')).toHaveCount(1);
		});
	}

	for (const labels of [
		{ locale: 'en', add: 'Add connection', http: 'HTTP server', id: 'Server ID', name: 'Display name', url: 'HTTP or HTTPS server URL', credential: 'Credential reference (optional)', save: 'Save', disabled: 'Disabled', enable: 'Enable', disconnect: 'Disconnect', disconnected: 'Disconnected', connect: 'Connect', connected: 'Connected', edit: 'Edit MCP server', remove: 'Remove MCP server', confirm: 'Remove', cancel: 'Cancel' },
		{ locale: 'zh-CN', add: '添加连接', http: 'HTTP 服务器', id: '服务器标识符', name: '显示名称', url: 'HTTP 或 HTTPS 服务器地址', credential: '凭据引用（可选）', save: '保存', disabled: '已禁用', enable: '启用', disconnect: '断开', disconnected: '已断开', connect: '连接', connected: '已连接', edit: '编辑 MCP 服务器', remove: '移除 MCP 服务器', confirm: '移除', cancel: '取消' },
	]) {
		test(`Independent MCP configuration and lifecycle actions refresh the pane and details in ${labels.locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?locale=${labels.locale}`);
			const mcp = page.locator('[data-view-id="ash.extensions.mcp"]');
			await mcp.getByRole('button', { name: /^(Connections|连接)$/u }).click();
			await mcp.getByRole('button', { name: labels.add, exact: true }).click();
			const add = page.getByRole('dialog', { name: labels.add, exact: true });
			await expect(add.getByRole('combobox')).toHaveAttribute('placeholder', labels.locale === 'en' ? 'How would you like to connect?' : '你想如何建立连接？');
			await expect(add.getByRole('option').filter({ hasText: labels.locale === 'en' ? 'Service account' : '服务账号' })).toBeVisible();
			await page.screenshot({ path: `.build/desktop/ui-previews/add-connection-accounts-${labels.locale}.png` });
			await add.getByRole('option').filter({ hasText: labels.locale === 'en' ? 'Custom MCP server' : '自定义 MCP 服务器' }).click();
			await expect(add).toContainText(labels.locale === 'en' ? 'Choose a connection method.' : '选择接入方式。');
			await expect(add).toContainText(labels.locale === 'en' ? 'for a service URL' : '有服务地址时');
			await expect(add).toContainText(labels.locale === 'en' ? 'on this computer' : '本机运行服务');
			await expect(add.getByRole('button', { name: labels.locale === 'en' ? 'Local process (stdio)' : '本地进程（stdio）', exact: true })).toBeVisible();
			await page.screenshot({ path: `.build/desktop/ui-previews/add-connection-${labels.locale}.png` });
			await add.getByRole('button', { name: labels.http, exact: true }).click();
			await expect(add).toContainText(labels.locale === 'en' ? 'Configure HTTP server.' : '配置HTTP 服务器。');
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
			await expect(details.getByRole('switch')).toBeFocused();
			await details.getByRole('switch').press('Space');
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

	test('MCP stdio arguments are validated without losing the draft and Escape cancels editing', async function () {
		const { page } = browserTests;

		await page.goto('/extensions.html');
		const mcp = page.locator('[data-view-id="ash.extensions.mcp"]');
		await mcp.getByRole('button', { name: /^(Connections|连接)$/u }).click();
		await mcp.getByRole('button', { name: 'Add connection', exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'Add connection', exact: true });
		await dialog.getByRole('option').filter({ hasText: 'Custom MCP server' }).click();
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

	test('MCP failed mutations refresh actual state and stale revisions never overwrite configuration', async function () {
		const { page } = browserTests;

		await page.goto('/extensions.html');
		await page.evaluate(() => window.ashExtensionsIntegration.configureMcp({
			id: 'user:mcp:reviewed', displayName: 'Reviewed server', transport: { type: 'streamableHttp', url: 'https://example.test/mcp' },
			credential: { type: 'unauthenticated' }, enablement: 'enabled',
		}));
		const mcp = page.locator('[data-view-id="ash.extensions.mcp"]');
		await mcp.getByRole('button', { name: /^(Connections|连接)$/u }).click();
		await mcp.getByRole('option').filter({ hasText: 'Reviewed server' }).click();
		const details = page.locator('.ash-extension-editor');
		await expect(details.getByRole('switch')).toBeChecked();
		await page.evaluate(() => window.ashExtensionsIntegration.changeMcpRevision());
		await details.getByRole('switch').press('Space');
		await expect(details.getByRole('status')).toContainText('MCP configuration changed.');
		await expect(details.getByRole('switch')).toBeChecked();
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
		test(`Marketplace continues beyond 100 results and source selection starts a new cursor in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?marketplace&pagedDiscovery&locale=${locale}`);
			const pane = page.locator('[data-view-id="ash.extensions.skills"]');
			await pane.getByRole('button', { name: title, exact: true }).click();
			await page.evaluate(() => window.ashExtensionsIntegration.open({ view: 'skills', mode: 'browse' }));
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
			await page.locator('#extensions').getByRole('searchbox').fill('Item 7');
			await page.locator('#extensions').getByRole('searchbox').press('Enter');
			await expect(pane.getByRole('status')).toHaveText(count(4, 4));
			await expect(pane.getByRole('button', { name: loadMore, exact: true })).toBeHidden();
		});
	}

	for (const [locale, installedLabel, installLabel] of [['en', 'Installed', 'Install'], ['zh-CN', '已安装', '安装']]) {
		for (const [view, paneTitle, discoveryLabel, query, name, packageId] of [
			['skills', locale === 'zh-CN' ? '技能' : 'Skills', locale === 'zh-CN' ? '发现技能' : 'Discover skills', 'Web', 'Web tools', 'example/web'],
			['mcp', locale === 'zh-CN' ? '连接' : 'Connections', locale === 'zh-CN' ? '发现连接' : 'Discover connections', 'Docs', 'Docs MCP', 'catalog/docs@ash'],
		]) {
			test(`Marketplace ${view} discovery opens reviewed package installation and updates its row in ${locale}`, async function () {
				const { page } = browserTests;

				await page.goto(`/extensions.html?marketplace&locale=${locale}`);
				const pane = page.locator(`[data-view-id="ash.extensions.${view}"]`);
				await pane.getByRole('button', { name: paneTitle, exact: true }).click();
				await page.evaluate(view => window.ashExtensionsIntegration.open({ view: view as 'skills' | 'mcp', mode: 'browse' }), view);
				const search = page.locator('#extensions').getByRole('searchbox');
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
				await page.evaluate(view => window.ashExtensionsIntegration.open({ view: view as 'skills' | 'mcp', mode: 'installed' }), view);
				await search.fill('');
				await expect(page.locator('#extensions').getByRole('searchbox')).toBeVisible();
				await expect(pane.getByRole('option').filter({ hasText: view === 'skills' ? 'review' : 'docs-server' })).toHaveCount(1);
			});
		}
	}

	test('Marketplace source failures preserve healthy discovery results', async function () {
		const { page } = browserTests;

		await page.goto('/extensions.html?marketplace&partialDiscoveryFailure');
		const pane = page.locator('[data-view-id="ash.extensions.skills"]');
		await pane.getByRole('button', { name: 'Skills', exact: true }).click();
		await page.evaluate(() => { void window.ashExtensionsIntegration.open({ view: 'skills', mode: 'browse' }); });
		await expect(pane.getByRole('option')).toContainText('Web tools');
		await expect(pane.getByRole('status')).toContainText('Catalog unavailable');
	});

	test('Marketplace navigation retires a late failed discovery read', async function () {
		const { page } = browserTests;

		await page.goto('/extensions.html?marketplace');
		const pane = page.locator('[data-view-id="ash.extensions.skills"]');
		await pane.getByRole('button', { name: 'Skills', exact: true }).click();
		await expect(pane.getByRole('option')).toContainText('review');
		await page.evaluate(() => window.ashExtensionsIntegration.holdDiscoverySearch());
		await page.evaluate(() => { void window.ashExtensionsIntegration.open({ view: 'skills', mode: 'browse' }); });
		await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.discoverySearchStarted())).toBe(true);
		const progress = pane.locator('.ash-view-pane-progress-indicator');
		await expect(progress).toBeVisible();
		await page.evaluate(() => window.ashExtensionsIntegration.open({ view: 'skills', mode: 'installed' }));
		await expect(progress).toBeHidden();
		await expect(pane.getByRole('option')).toContainText('review');
		const status = await pane.locator('.extensions-status').textContent();
		await page.evaluate(() => window.ashExtensionsIntegration.failHeldSearch());
		await expect(progress).toBeHidden();
		await expect(pane.locator('.extensions-status')).toHaveText(status!);
		await expect(pane.getByRole('option')).not.toContainText('Web tools');
	});

	test('Marketplace visibility changes clear discovery while preserving installed resources', async function () {
		const { page } = browserTests;

		await page.goto('/extensions.html?marketplace');
		const pane = page.locator('[data-view-id="ash.extensions.skills"]');
		await pane.getByRole('button', { name: 'Skills', exact: true }).click();
		await page.evaluate(() => { void window.ashExtensionsIntegration.open({ view: 'skills', mode: 'browse' }); });
		await expect(pane.getByRole('option')).toContainText('Web tools');
		await page.evaluate(() => window.ashExtensionsIntegration.setDiscoveryEnabled(false));
		await expect(pane.getByRole('option')).toHaveCount(0);
		await expect(pane.getByRole('status')).toContainText('Discovery is disabled in Settings.');
		await page.evaluate(() => window.ashExtensionsIntegration.open({ view: 'skills', mode: 'installed' }));
		await expect(pane.getByRole('option')).toContainText('review');
	});

	for (const theme of ['light', 'dark', 'hc']) {
		test(`Marketplace discovery preserves keyboard focus and pane layout in ${theme}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?marketplace&theme=${theme}`);
			const pane = page.locator('[data-view-id="ash.extensions.skills"]');
			await pane.getByRole('button', { name: 'Skills', exact: true }).click();
			await page.evaluate(() => window.ashExtensionsIntegration.open({ view: 'skills', mode: 'browse' }));
			const search = page.locator('#extensions').getByRole('searchbox');
			await expect(search).toBeFocused();
			expect(await search.evaluate(element => element.closest('.ash-input-box')!.classList.contains('is-focused'))).toBe(true);
			await expect(pane.getByRole('option')).toContainText('Web tools');
			expect(await pane.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
			await page.locator('#extensions').getByRole('searchbox').focus();
			await page.keyboard.press('ArrowDown');
			await expect(pane.getByRole('listbox')).toBeFocused();
		});
	}

	for (const [locale, title, urlLabel, refLabel, pathLabel] of [
		['en', 'Install extension from Git repository', 'Git repository URL', 'Branch, tag or full commit ID (optional)', 'Package directory (optional)'],
		['zh-CN', '从 Git 仓库安装扩展', 'Git 仓库地址', '分支、标签或完整提交 ID（可选）', '包目录（可选）'],
	]) {
		test(`Git plugin installation inputs are localized and keyboard cancellable in ${locale}`, async function () {
			const { page } = browserTests;

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

	test('Git plugin installation Escape cancels the running host operation before installing a package', async function () {
		const { page } = browserTests;

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
		test(`Extension details reuse the shared viewport and resize observation in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?preview&longReadme&locale=${locale}&theme=light`);
			await page.evaluate(() => window.ashExtensionsIntegration.openEditorExtension());
			const root = page.locator('.ash-extension-editor-scrollable');
			const viewport = root.locator(':scope > .ash-scrollbar-viewport');
			const track = root.locator(':scope > .ash-scrollbar-track-vertical');
			const editor = root.locator('.ash-extension-editor');
			await expect(editor.getByRole('heading', { name: 'Documentation section 39', exact: true })).toHaveCount(1);
			await expect(root).toHaveCount(1);
			await expect(viewport).toHaveCSS('scrollbar-width', 'none');
			await expect(editor).toHaveCSS('overflow-y', 'visible');
			await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
			const bounds = await root.evaluate(element => ({ viewport: element.clientHeight, host: element.parentElement!.clientHeight }));
			expect(bounds.viewport).toBe(bounds.host);
			await track.press('End');
			await expect.poll(async () => Number(await track.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
			const remaining = await viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
			expect(remaining).toBeLessThanOrEqual(1);
			await editor.getByRole('tab', { name: detailsLabel, exact: true }).focus();
			await expect(editor.getByRole('tab', { name: detailsLabel, exact: true })).toBeInViewport();
			await editor.getByRole('tab', { name: detailsLabel, exact: true }).press('ArrowRight');
			await editor.getByRole('tab', { name: featuresLabel, exact: true }).press('Enter');
			await expect(editor.getByRole('tabpanel', { name: featuresLabel, exact: true })).toBeVisible();
			await editor.getByRole('tab', { name: detailsLabel, exact: true }).press('Enter');
			await page.locator('#details').evaluate(element => { element.style.width = '360px'; });
			await expect(editor).toHaveClass(/compact/u);
			const content = (await editor.locator('.extension-detail-content').boundingBox())!;
			const info = (await editor.locator('.extension-detail-info').boundingBox())!;
			expect(info.y).toBeGreaterThanOrEqual(content.y + content.height);
			await expect.poll(() => viewport.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
			await root.hover();
			await page.mouse.wheel(0, 400);
			await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
			await expect(track).toHaveCSS('opacity', '1');
			await page.screenshot({ path: `.build/desktop/ui-previews/extension-details-shared-${locale}.png` });
		});

		test(`Registered extension editor renders its README, header, tabs and metadata in ${locale}`, async function () {
			const { page } = browserTests;

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

	test('Uninstalled Ash editor details show verified metadata without reading package resources', async function () {
		const { page } = browserTests;

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

	test('Plugins, Skills and MCP use the registered editor with their own content tabs', async function () {
		const { page } = browserTests;

		await page.goto('/extensions.html');
		await page.evaluate(() => window.ashExtensionsIntegration.addSkillOnlyPlugin());
		const plugins = page.locator('[data-view-id="ash.extensions.plugins"]');
		await plugins.getByRole('button', { name: 'Plugins', exact: true }).click();
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

	test('A late README cannot replace another capability in the editor', async function () {
		const { page } = browserTests;

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
		test(`Extension detail columns, responsive layout and focus remain usable in ${theme}`, async function () {
			const { page } = browserTests;

			await page.setViewportSize({ width: 1440, height: 900 });
			await page.goto(`/extensions.html?classification&preview&theme=${theme}`);
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
			await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('workbench.action.chat.configure.skills'));
			await page.locator('[data-view-id="ash.extensions.skills"]').getByRole('option').click();
			const toggle = editor.getByRole('switch', { name: 'Enable skill', exact: true });
			await expect(toggle).toBeChecked();
			for (const width of [360, 850]) {
				await page.locator('#details').evaluate((element, width) => { element.style.width = `${width}px`; }, width);
				if (width < 720) { await expect(editor).toHaveClass(/compact/u); } else { await expect(editor).not.toHaveClass(/compact/u); }
				const description = await editor.locator('.extension-detail-description > p').boundingBox();
				const row = await editor.locator('.extension-detail-description').boundingBox();
				const track = editor.locator('.ash-switch-track');
				const bounds = await track.boundingBox();
				expect(bounds!.x).toBeGreaterThan(description!.x + description!.width);
				expect(Math.abs(bounds!.x + bounds!.width - row!.x - row!.width)).toBeLessThanOrEqual(1);
				expect(Math.abs(bounds!.y + bounds!.height / 2 - row!.y - row!.height / 2)).toBeLessThanOrEqual(1);
				await expect.poll(() => editor.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
				await toggle.focus();
				await expect.poll(() => track.evaluate(element => Number.parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThanOrEqual(1);
				await page.screenshot({ path: `.build/desktop/ui-previews/skill-enablement-${theme}-${width}.png` });
			}
		});
	}

	for (const [locale, title, reason] of [['en', 'Recommended', 'Recommended by this workspace'], ['zh-CN', '推荐', '此工作区推荐']]) {
		test(`Workspace recommendations open package details by keyboard in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?locale=${locale}`);
			await page.locator('#extensions').getByRole('button', { name: title, exact: true }).click();
			const recommended = page.locator('[data-view-id="ash.extensions.recommended"]');
			await expect(recommended.getByRole('option')).toHaveCount(2);
			await expect(recommended.getByRole('option').filter({ hasText: reason })).toHaveCount(2);
			await expect(recommended).not.toContainText('excluded/tool');
			await page.evaluate(() => window.ashExtensionsIntegration.open({ view: 'recommended', mode: 'installed', query: 'Sample' }));
			await expect(recommended.getByRole('option')).toHaveCount(1);
			await page.locator('#extensions').getByRole('searchbox').press('ArrowDown');
			await page.keyboard.press('Enter');
			await expect(page.locator('.ash-extension-editor')).toContainText('Sample editor extension');
			expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.some((entry: any) => entry[0] === 'get' && entry[1].packageId === 'publisher.sample@ash'))).toBe(true);
		});
	}

	test('Recommendations follow file edits, preserve valid declarations during invalid edits and clear on workspace replacement', async function () {
		const { page } = browserTests;

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

	test('Recommendations retain declared IDs when the catalog is offline', async function () {
		const { page } = browserTests;

		await page.goto('/extensions.html');
		await page.evaluate(() => window.ashExtensionsIntegration.setOffline());
		await page.locator('#extensions').getByRole('button', { name: 'Recommended', exact: true }).click();
		const recommended = page.locator('[data-view-id="ash.extensions.recommended"]');
		await expect(recommended.getByRole('option')).toHaveCount(2);
		await expect(recommended).toContainText('example/web');
		await expect(recommended).toContainText('publisher.sample');
		await expect(recommended.getByRole('option').filter({ hasText: 'Unavailable from enabled sources' })).toHaveCount(2);
	});

	test('Extensions retains its list when wrapped filters share a short view container', async function () {
		const { page } = browserTests;

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
		test(`Local SDK extension installation and permission review work in ${locale}`, async function () {
			const { page } = browserTests;

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
			await editor.getByRole('switch').press('Space');
			await expect(editor.getByRole('switch')).toBeChecked();
			await editor.getByRole('button', { name: grant, exact: true }).click();
			const permissions = page.getByRole('dialog', { name: 'SDK fixture', exact: true });
			await expect(permissions).toContainText(permission);
			await expect(permissions).toContainText('sha256:' + 'b'.repeat(64));
			await permissions.getByRole('button', { name: grant, exact: true }).click();
			await expect(editor.getByRole('button', { name: revoke, exact: true })).toBeVisible();
			expect(await page.evaluate(() => window.ashExtensionsIntegration.localPackages().map(({ enabled, granted }) => ({ enabled, granted })))).toEqual([{ enabled: true, granted: true }]);
			await expect(editor.getByRole('button', { name: uninstall, exact: true })).toBeDisabled();
			await editor.getByRole('switch').press('Space');
			await expect(editor.getByRole('switch')).not.toBeChecked();
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

	test('Local extension installation cancellation does not copy or grant a package', async function () {
		const { page } = browserTests;

		await page.goto('/extensions.html');
		await page.evaluate(() => window.ashExtensionsIntegration.startCommand('ash.extensions.installLocal'));
		await expect(page.getByRole('dialog', { name: 'Install extension from workspace', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await page.evaluate(() => window.ashExtensionsIntegration.waitCommand());
		expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0].startsWith('plugin')))).toEqual([]);
	});

	test('LSP and Skills share capability discovery while retaining their own configuration', async function () {
		const { page } = browserTests;

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
		await details.locator('.extension-detail-enablement .ash-switch-track').click();
		await expect(details.getByRole('switch', { name: 'Enable skill', exact: true })).not.toBeChecked();
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
		test(`Ash plugin installation and execution authorization remain separate in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?locale=${locale}`);
			await page.evaluate(() => window.ashExtensionsIntegration.open({ capabilityKind: 'editorExtension' }));
			const view = page.locator('[data-view-id="ash.extensions.view"] .ash-extensions');
			await view.getByRole('option').click();
			const editor = page.locator('.ash-extension-editor');
			await expect(editor).toContainText('Sample editor extension');
			expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'editorPolicy'))).toEqual([]);
			const install = locale === 'en' ? 'Install' : '安装';
			await editor.getByRole('button', { name: install, exact: true }).click();
			const review = page.getByRole('dialog', { name: install, exact: true });
			await expect(review).toContainText('publisher.sample@ash');
			await review.getByRole('button', { name: install, exact: true }).click();
			await expect(editor.getByRole('switch')).toBeChecked();
			await expect(editor.locator('.extension-detail-header [role="status"]')).toBeEmpty();
			await expect(editor.getByRole('button', { name: locale === 'en' ? 'Authorize execution' : '授权执行', exact: true })).toBeVisible();
			expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'editorPolicy'))).toEqual([]);
			for (const [action, policyAction] of locale === 'en' ? [['Disable', 'disable'], ['Authorize execution', 'grant'], ['Revoke execution authorization', 'revoke'], ['Enable', 'enable']] : [['禁用', 'disable'], ['授权执行', 'grant'], ['撤销执行授权', 'revoke'], ['启用', 'enable']]) {
				if (policyAction === 'enable' || policyAction === 'disable') { await editor.getByRole('switch').press('Space'); }
				else { await editor.getByRole('button', { name: action, exact: true }).click(); }
				if (policyAction === 'grant' || policyAction === 'revoke') {
					await page.getByRole('dialog', { name: 'publisher.sample@ash', exact: true }).getByRole('button', { name: action, exact: true }).click();
				}
				await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'editorPolicy').map((entry: any) => entry[1].action).at(-1))).toBe(policyAction);
			}
			expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'editorPolicy').map((entry: any) => [entry[1].action, entry[1].expectedRevision, entry[1].installationId]))).toEqual([['disable', 1, 'version-one'], ['grant', 2, 'version-one'], ['revoke', 3, 'version-one'], ['enable', 4, 'version-one']]);
		});
	}

	test('Extensions execution can be revoked when its entry becomes unavailable', async function () {
		const { page } = browserTests;

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
		await editor.getByRole('switch').press('Space');
		await expect(editor.getByRole('switch')).not.toBeChecked();
	});

	for (const trigger of ['command', 'view']) {
		test(`Extensions ${trigger} navigation ignores a failed stale search`, async function () {
			const { page } = browserTests;

			await page.goto('/extensions.html');
			const view = page.locator('[data-view-id="ash.extensions.view"] .ash-extensions');
			await expect(view.getByRole('option')).toHaveCount(1);
			await page.evaluate(trigger => trigger === 'command' ? window.ashExtensionsIntegration.startHeldCommand() : window.ashExtensionsIntegration.startHeldSearch(), trigger);
			await expect(view.getByRole('status')).toHaveText('Loading Extensions…');
			await page.evaluate(() => window.ashExtensionsIntegration.open({ mode: 'installed' }));
			const installedView = page.locator('[data-view-id="ash.extensions.plugins"] .ash-extensions');
			await expect(installedView).toHaveAttribute('aria-busy', 'false');
			await expect(installedView.locator('[data-package-id="ash.language-pack-zh-cn"]')).toBeVisible();
			const status = await view.locator('.extensions-status').textContent();
			await page.evaluate(() => window.ashExtensionsIntegration.failHeldSearch());
			await expect(view.locator('.extensions-status')).toHaveText(status!);
			await expect(view.locator('[data-package-id="example/web"]')).toHaveCount(0);
		});
	}

	async function installFixture(page: import('@playwright/test').Page): Promise<void> {
		await page.locator('[data-view-id="ash.extensions.view"] .ash-extensions').getByRole('button', { name: 'Install', exact: true }).click();
		await page.getByRole('dialog', { name: 'Install', exact: true }).getByRole('button', { name: 'Install', exact: true }).click();
		await expect(page.locator('[data-view-id="ash.extensions.view"] .ash-extensions').getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
	}

	test('Extensions updates the selected exact installation to the reviewed version', async function () {
		const { page } = browserTests;

		await page.goto('/extensions.html');
		await installFixture(page);
		await page.evaluate(() => { window.ashExtensionsIntegration.addOtherPackage(); return window.ashExtensionsIntegration.open({ mode: 'installed' }); });
		await page.locator('[data-view-id="ash.extensions.plugins"] .ash-extensions').getByRole('option').filter({ hasText: 'example/web' }).click();
		const editor = page.locator('.ash-extension-editor');
		await editor.getByRole('button', { name: 'Update', exact: true }).click();
		const review = page.getByRole('dialog', { name: 'Update', exact: true });
		await expect(review).toContainText('2.0.0');
		await review.getByRole('button', { name: 'Update', exact: true }).click();
		const updated = page.locator('[data-view-id="ash.extensions.plugins"] [data-installation-id="updated-installation"]');
		await expect(updated).toBeVisible();
		await updated.click();
		await expect(editor).toContainText('2.0.0');
		expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'update'))).toEqual([['update', { installationId: 'version-one', version: '2.0.0' }]]);
	});

	test('Extensions reviews bundled capabilities and uninstalls a selected version offline', async function () {
		const { page } = browserTests;

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
		const installedView = page.locator('[data-view-id="ash.extensions.plugins"] .ash-extensions');
		const versions = installedView.locator('[data-package-id="example/web"]');
		await expect(versions).toHaveCount(2);
		await installedView.locator('[data-installation-id="version-two"]').click();
		const editor = page.locator('.ash-extension-editor');
		await expect(editor).toContainText('2.0.0');
		await editor.getByRole('button', { name: 'Uninstall', exact: true }).click();
		await page.getByRole('dialog', { name: 'Uninstall extension', exact: true }).getByRole('button', { name: 'Uninstall', exact: true }).click();
		await expect(versions).toHaveCount(1);
		await expect(installedView.locator('[data-package-id="ash.language-pack-zh-cn"]')).toBeVisible();
		expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'uninstall'))).toEqual([['uninstall', { installationId: 'version-two', mode: 'whenUnused' }]]);
	});

	test('Third-party Ash sources can be added, paused and resumed through Extensions', async function () {
		const { page } = browserTests;

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

	for (const [locale, disabled, languagePackReason] of [
		['en', 'Disabled', 'cannot be disabled'],
		['zh-CN', '已禁用', '不能禁用'],
	]) {
		test(`Built-in language pack list and details use backend metadata in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?rustBuiltIn&locale=${locale}`);
			await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('ash.extensions.manageBuiltIn'));
			const languagePack = page.locator('[data-view-id="ash.extensions.plugins"] .ash-extensions').locator('[data-package-id="ash.language-pack-zh-cn"]');
			await expect(languagePack).toContainText('中文语言包（Rust 目录）');
			await languagePack.click();
			const editor = page.locator('.ash-extension-editor');
			await expect(editor.getByRole('heading', { name: '中文语言包（Rust 目录）', exact: true })).toBeVisible();
			await expect(editor.getByRole('status')).toContainText(languagePackReason);
			await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'extensionResource' && entry[1].extensionId === 'ash.language-pack-zh-cn').length)).toBeGreaterThan(0);
		});

		test(`Installed extensions include the built-in Chinese language pack in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?locale=${locale}`);
			await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('ash.extensions.open'));
			const view = page.locator('[data-view-id="ash.extensions.plugins"] .ash-extensions');
			const languagePack = view.locator('[data-package-id="ash.language-pack-zh-cn"]');
			await expect(languagePack.locator('.extension-metadata')).toHaveText('Ash');
			await expect(languagePack).toHaveAccessibleName(/Ash/u);
			await expect(languagePack.getByRole('button')).toHaveCount(0);
			await languagePack.click();
			await expect(page.locator('.ash-extension-editor').getByRole('status')).toContainText(languagePackReason);
		});

		test(`All built-in extensions share enablement management and preserve language-pack behavior in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?locale=${locale}`);
			await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('ash.extensions.manageBuiltIn'));
			const view = page.locator('[data-view-id="ash.extensions.plugins"] .ash-extensions');
			const extension = view.locator('[data-package-id="vscode.javascript"]');
			await expect(extension.getByRole('button')).toHaveCount(0);
			await extension.click();
			const editor = page.locator('.ash-extension-editor');
			await expect(editor.getByRole('switch')).toBeChecked();
			await editor.getByRole('switch').press('Space');
			await expect(editor.getByRole('switch')).not.toBeChecked();
			await expect(editor.locator('.extension-detail-header [role="status"]')).toBeEmpty();
			await page.reload();
			await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('ash.extensions.manageBuiltIn'));
			await expect(extension).toHaveAccessibleName(new RegExp(disabled, 'u'));
			await extension.click();
			await expect(editor.getByRole('switch')).not.toBeChecked();
			await editor.getByRole('switch').press('Space');
			await expect(editor.getByRole('switch')).toBeChecked();
			const languagePack = view.locator('[data-package-id="ash.language-pack-zh-cn"]');
			await expect(languagePack.getByRole('button')).toHaveCount(0);
			await languagePack.click();
			await expect(editor.getByRole('status')).toContainText(languagePackReason);
			await expect(editor.getByRole('button')).toHaveCount(0);
		});
	}

	for (const [locale, disabled] of [
		['en', 'Disabled'],
		['zh-CN', '已禁用'],
	]) {
		test(`Plain extension search finds and disables rust-analyzer in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?classification&locale=${locale}`);
			const search = page.locator('#extensions').getByRole('searchbox');
			await search.fill('rust');
			await search.press('Enter');
			const plugins = page.locator('[data-view-id="ash.extensions.plugins"]');
			const provider = plugins.locator('[data-package-id="vscode.rust"]');
			await expect(provider).toBeVisible();
			await expect(provider.getByRole('button')).toHaveCount(0);
			await provider.click();
			const editor = page.locator('.ash-extension-editor');
			await editor.getByRole('switch').press('Space');
			await expect(provider).toHaveAccessibleName(new RegExp(disabled, 'u'));
			for (const query of ['rust-analyzer', '@installed rust-analyzer', '@builtin rust-analyzer']) {
				await search.fill(query);
				await search.press('Enter');
				await expect(provider).toHaveAccessibleName(new RegExp(disabled, 'u'));
				await expect(plugins.getByRole('option')).toHaveCount(1);
			}
			await search.press('ArrowDown');
			await expect(plugins.getByRole('listbox')).toBeFocused();
			await plugins.getByRole('listbox').press('Enter');
			await expect(editor.getByRole('switch')).not.toBeChecked();
			await expect(editor.locator('.extension-detail-header [role="status"]')).toBeEmpty();
			await editor.getByRole('switch').press('Space');
			await expect(editor.locator('.extension-detail-header [role="status"]')).toBeEmpty();
			await expect(editor.getByRole('switch')).toBeChecked();
			expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'builtInPolicy'))).toEqual([
				['builtInPolicy', { id: 'vscode.rust', enabled: false, expectedRevision: 1 }],
				['builtInPolicy', { id: 'vscode.rust', enabled: true, expectedRevision: 2 }],
			]);
		});

		test(`Built-in Rust provider switches use backend authority without duplicate status in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?locale=${locale}`);
			await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('ash.extensions.manageBuiltIn'));
			const provider = page.locator('[data-view-id="ash.extensions.plugins"] .ash-extensions').locator('[data-package-id="ash.github-authentication"]');
			await provider.click();
			const editor = page.locator('.ash-extension-editor');
			await expect(editor.getByRole('switch')).toBeChecked();
			await expect(editor.locator('.extension-detail-header [role="status"]')).toBeEmpty();
			await editor.getByRole('switch').press('Space');
			await expect(provider).toHaveAccessibleName(new RegExp(disabled, 'u'));
			await expect(editor.getByRole('switch')).not.toBeChecked();
			await expect(editor.locator('.extension-detail-header [role="status"]')).toBeEmpty();
			await editor.getByRole('switch').press('Space');
			await expect(editor.locator('.extension-detail-header [role="status"]')).toBeEmpty();
			expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'builtInPolicy'))).toEqual([
				['builtInPolicy', { id: 'ash.github-authentication', enabled: false, expectedRevision: 1 }],
				['builtInPolicy', { id: 'ash.github-authentication', enabled: true, expectedRevision: 2 }],
			]);
		});

		test(`Built-in Rust provider details remain readable without management authority in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?locale=${locale}&readOnlyProviders`);
			await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('ash.extensions.manageBuiltIn'));
			const provider = page.locator('[data-view-id="ash.extensions.plugins"] .ash-extensions').locator('[data-package-id="ash.github-authentication"]');
			await expect(provider).toHaveAccessibleName(new RegExp(locale === 'en' ? 'Enabled' : '已启用', 'u'));
			await expect(provider.getByRole('button')).toHaveCount(0);
			await provider.click();
			const editor = page.locator('.ash-extension-editor');
			const reason = locale === 'en' ? 'This connection cannot enable or disable backend providers.' : '此连接无权启用或禁用后端提供程序。';
			await expect(editor.getByRole('switch')).toBeChecked();
			await expect(editor.getByRole('status')).toContainText(reason);
			await expect(editor.getByRole('switch')).toBeDisabled();
			// A native disabled control must also reject keyboard activation.
			await editor.getByRole('switch').press('Space');
			await expect(editor.getByRole('switch')).toBeChecked();
			expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'builtInPolicy'))).toEqual([]);
		});
	}

	for (const [locale, skillsTitle, enable, instructions] of [
		['en', 'Skills', 'Enable skill', 'Instructions'],
		['zh-CN', '技能', '启用技能', '说明'],
	]) {
		test(`Extensions panes open scoped Skills details and readonly instructions in ${locale}`, async function () {
			const { page } = browserTests;

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
			await expect(list.getByRole('option').locator('.extension-description')).toHaveText('Review changes.');
			await expect(list.getByRole('option').locator('.extension-metadata')).toHaveText(locale === 'en' ? 'Acme · Enabled' : 'Acme · 已启用');
			await expect(list.getByRole('option')).not.toContainText('marketplace:example/web');
			await list.focus();
			await list.press('Enter');
			const details = page.locator('.ash-extension-editor');
			await expect(details).toContainText('workspace / bad-skill: Invalid metadata');
			await expect(details.locator('.extension-metadata')).toHaveText(locale === 'en'
				? 'Developer: Acme · Version: 2.1.0 · Updated: 2026-10-20'
				: '开发方：Acme · 版本：2.1.0 · 更新于：2026-10-20');
			await expect(details.locator('.extension-detail-description > p')).toHaveText('Review changes.');
			await expect(details.getByRole('tabpanel', { name: locale === 'en' ? 'Details' : '详情', exact: true })).toContainText('Use when reviewing a project before release.');
			await expect(details.locator('.extension-actions')).toBeHidden();
			await expect(details.locator('.extension-actions button')).toHaveCount(0);
			const toggle = details.getByRole('switch', { name: enable, exact: true });
			await expect(toggle).toBeChecked();
			await toggle.focus();
			await toggle.press('Space');
			await expect(toggle).not.toBeChecked();
			await expect(toggle).toBeFocused();
			expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'skill'))).toEqual([['skill', { source: 'marketplace:example/web', name: 'review' }, false, 3, 'session-scope']]);
			await toggle.press('Space');
			await expect(toggle).toBeChecked();
			await expect(toggle).toBeEnabled();
			expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'skill').at(-1))).toEqual(['skill', { source: 'marketplace:example/web', name: 'review' }, true, 4, 'session-scope']);
			await page.evaluate(() => window.ashExtensionsIntegration.changeRevision());
			await toggle.press('Space');
			await expect(details.getByRole('status')).toContainText('Configuration changed. Refresh before saving.');
			await expect(toggle).toBeChecked();
			await expect(toggle).toBeEnabled();
			await expect(toggle).toBeFocused();
			await details.getByRole('tab', { name: instructions, exact: true }).focus();
			await details.getByRole('tab', { name: instructions, exact: true }).press('Enter');
			await expect(details.getByRole('tabpanel', { name: instructions, exact: true })).toContainText('Review changes carefully.');
			await expect(details.getByRole('tabpanel', { name: instructions, exact: true })).not.toContainText('metadata:');
			await header.focus();
			await header.press('ArrowLeft');
			await expect(header).toHaveAttribute('aria-expanded', 'false');
			await header.press('ArrowRight');
			await expect(header).toHaveAttribute('aria-expanded', 'true');
			await expect(skills.getByRole('option').filter({ hasText: 'review' })).toBeVisible();
			expect(errors).toEqual([]);
		});
	}

	test('MCP pane merges installed and registered servers and opens owning package details', async function () {
		const { page } = browserTests;

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
		test(`MCP lists backend servers without tools and shows status and diagnostics in ${locale}`, async function () {
			const { page } = browserTests;

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

	test('MCP status failures retain installed packages and never infer connection state from tools', async function () {
		const { page } = browserTests;

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

	test('MCP server status remains visible when tool descriptions fail and unsupported backends do not receive status requests', async function () {
		const { page } = browserTests;

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

	test('MCP detail changes discard a delayed status response for the previous server', async function () {
		const { page } = browserTests;

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

	test('Installed Extensions includes packages with different capabilities and uses the shared installed search', async function () {
		const { page } = browserTests;

		await page.goto('/extensions.html');
		await page.evaluate(() => window.ashExtensionsIntegration.addSkillOnlyPlugin());
		await page.evaluate(() => window.ashExtensionsIntegration.openEditorExtension());
		await page.locator('.ash-extension-editor').getByRole('button', { name: 'Install', exact: true }).click();
		await page.getByRole('dialog', { name: 'Install', exact: true }).getByRole('button', { name: 'Install', exact: true }).click();
		await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('ash.extensions.installed'));
		const plugins = page.locator('[data-view-id="ash.extensions.plugins"]');
		await expect(plugins.locator('[data-package-id="publisher.sample@ash"]')).toHaveCount(1);
		await plugins.getByRole('option').filter({ hasText: 'Skill-only plugin' }).click();
		await expect(page.locator('.ash-extension-editor')).toContainText('acme/skills');
		await page.locator('#extensions').getByRole('searchbox').fill('@installed skills');
		await plugins.getByRole('button', { name: 'Plugins', exact: true }).click();
		await plugins.getByRole('button', { name: 'Plugins', exact: true }).click();
		await expect(page.locator('#extensions').getByRole('searchbox')).toHaveValue('@installed skills');
		await expect(page.locator('#extensions').getByRole('searchbox')).toHaveCount(1);
	});

	test('Changing the selected capability aborts a pending instructions read and discards its document', async function () {
		const { page } = browserTests;

		await page.goto('/extensions.html');
		await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('workbench.action.chat.configure.skills'));
		await page.evaluate(() => window.ashExtensionsIntegration.holdInstructions());
		await page.locator('[data-view-id="ash.extensions.skills"]').getByRole('option').click();
		await page.locator('.ash-extension-editor').getByRole('tab', { name: 'Instructions', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.instructionsStarted())).toBe(true);
		const mcp = page.locator('[data-view-id="ash.extensions.mcp"]');
		await mcp.getByRole('button', { name: /^(Connections|连接)$/u }).click();
		await mcp.getByRole('option').click();
		await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.instructionsAborted())).toBe(true);
		await page.evaluate(() => window.ashExtensionsIntegration.completeInstructions());
		await expect(page.locator('.ash-extension-editor')).toContainText('fixture_search');
		await expect(page.locator('.ash-extension-editor')).not.toContainText('Retired instructions');
		expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'document'))).toEqual([]);
	});

	for (const theme of ['light', 'dark', 'hc']) {
		test(`Extensions pane layout and details remain usable in ${theme}`, async function () {
			const { page } = browserTests;

			await page.setViewportSize({ width: 1280, height: 840 });
			await page.goto(`/extensions.html?classification&preview&theme=${theme}`);
			await page.evaluate(() => { window.ashExtensionsIntegration.addMcpPackage(); window.ashExtensionsIntegration.addSkillOnlyPlugin(); });
			for (const name of ['Skills', 'Connections', 'Recommended']) {
				await page.locator('#extensions').getByRole('button', { name, exact: true }).press('ArrowRight');
			}
			await page.locator('[data-view-id="ash.extensions.mcp"]').getByRole('option').click();
			await expect(page.locator('.ash-extension-editor')).toContainText('fixture_search');
			for (const viewId of ['plugins', 'skills', 'mcp', 'recommended']) {
				const view = page.locator(`[data-view-id="ash.extensions.${viewId}"]`);
				await expect(view.getByRole('listbox')).toBeVisible();
				await expect.poll(() => view.locator('.extensions-list').evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(64);
				await expect.poll(() => view.locator('.ash-pane-view-header-title').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
			}
			const boundary = page.locator('#extensions .ash-split-view-pane').nth(1);
			const separator = await boundary.evaluate(element => { const style = getComputedStyle(element, '::before'); return { height: style.height, color: style.backgroundColor }; });
			expect(separator.height).toBe('1px');
			expect(separator.color).not.toBe('rgba(0, 0, 0, 0)');
			await page.screenshot({ path: `.build/desktop/ui-previews/extensions-panes-${theme}.png` });
		});
	}

	for (const theme of ['light', 'dark', 'hc']) {
		test(`extension settings support keyboard navigation and shared controls in Chinese (${theme})`, async function () {
			const { page } = browserTests;

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
		test(`MCP OAuth sign-in, cancellation and local logout in ${labels.locale}`, async function () {
			const { page } = browserTests;

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
		test(`custom LSP configuration supports keyboard editing and localized validation in ${locale}`, async function () {
			const { page } = browserTests;

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
		test(`Native editor packages show their document and accurate execution review in ${locale}`, async function () {
			const { page } = browserTests;

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
			const review = page.getByRole('dialog', { name: 'ash.academy@ash', exact: true });
			await expect(review).toContainText(locale === 'en' ? 'native program and trusted editor client' : '原生程序和可信编辑器客户端');
			await expect(review).toContainText(locale === 'en' ? 'unsaved text' : '未保存文本');
			await expect(review).not.toContainText('Node');
			await review.getByRole('button', { name: authorize, exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.requests.some((entry: any) => entry[0] === 'editorPolicy' && entry[1].action === 'grant'))).toBe(true);
			await expect(editor.getByRole('button', { name: locale === 'en' ? 'Revoke execution authorization' : '撤销执行授权', exact: true })).toBeVisible();
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`Extension refresh keeps existing rows in place in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?classification&locale=${locale}&theme=light`);
			const pane = page.locator('[data-view-id="ash.extensions.mcp"]');
			await pane.locator('.ash-pane-view-header-button').press('ArrowRight');
			const content = pane.locator('.ash-pane-view-content');
			await expect(content).toHaveAttribute('aria-busy', 'false');
			const row = pane.getByRole('option').first();
			await expect(row).toBeVisible();
			const rowOffset = () => row.evaluate(element => element.getBoundingClientRect().top - element.closest('.ash-pane-view-content')!.getBoundingClientRect().top);
			const initialOffset = await rowOffset();
			await page.evaluate(() => {
				window.ashExtensionsIntegration.holdMcpStatus();
				void window.ashExtensionsIntegration.refreshMcp();
			});
			await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.mcpStatusStarted())).toBe(true);
			await expect(content).toHaveAttribute('aria-busy', 'true');
			expect(await rowOffset()).toBeCloseTo(initialOffset);
			await page.evaluate(() => window.ashExtensionsIntegration.completeMcpStatus());
			await expect(content).toHaveAttribute('aria-busy', 'false');
			expect(await rowOffset()).toBeCloseTo(initialOffset);
		});

		for (const [view, theme] of [['plugins', 'light'], ['skills', 'dark'], ['mcp', 'hc']]) {
			test(`Extensions use the shared scrollbar for ${view} in ${locale}`, async function () {
				const { page } = browserTests;

				await page.goto(`/extensions.html?classification&marketplace&pagedDiscovery&locale=${locale}&theme=${theme}`);
				const pane = page.locator(`[data-view-id="ash.extensions.${view}"]`);
				if (view === 'skills') {
					await page.evaluate(() => window.ashExtensionsIntegration.open({ view: 'skills', mode: 'browse' }));
				} else if (view === 'mcp') {
					await page.evaluate(async () => {
						window.ashExtensionsIntegration.setMcpServers(Array.from({ length: 30 }, (_, index) => ({
							id: `scroll-server-${index}`, displayName: `Scroll server ${index}`, httpOrigin: null,
							state: { status: 'disconnected' }, catalogGeneration: 1, connectionGeneration: null, toolCount: 0,
						})));
						await window.ashExtensionsIntegration.refreshMcp();
					});
					await pane.locator('.ash-pane-view-header-button').press('ArrowRight');
				}
				const root = pane.locator('.extensions-list > .ash-list-scrollable');
				const viewport = root.locator('.ash-scrollbar-viewport');
				const track = root.locator('.ash-scrollbar-track-vertical');
				const list = pane.getByRole('listbox');
				const name = list.getByRole('option').first().locator('.extension-name.ash-icon-label');
				await expect(name).toHaveCount(1);
				await expect(name).toHaveAttribute('title', (await name.locator('.ash-icon-label-text').textContent())!);
				await expect(name.locator('.ash-icon-label-text')).toHaveCSS('text-overflow', 'ellipsis');
				if (view === 'plugins') {
					const row = list.getByRole('option').first();
					const nameBox = (await name.boundingBox())!;
					const contentBox = (await row.locator('.extension-row').boundingBox())!;
					const metadataBox = (await row.locator('.extension-metadata').boundingBox())!;
					expect(contentBox.x + contentBox.width - nameBox.x - nameBox.width).toBeCloseTo(12);
					expect(metadataBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height);
					await expect(row.locator('.extension-row-actions')).toHaveCount(0);
					expect(await row.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
				}
				await expect(root).toHaveCount(1);
				await expect(list).toHaveCSS('overflow-y', 'visible');
				await expect(viewport).toHaveCSS('scrollbar-width', 'none');
				await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
				const bounds = await root.evaluate(element => ({ root: element.getBoundingClientRect().toJSON(), host: element.parentElement!.getBoundingClientRect().toJSON() }));
				expect(bounds.root.height).toBeCloseTo(bounds.host.height);
				expect(bounds.root.width).toBeCloseTo(bounds.host.width);
				await list.press('Home');
				const firstId = await list.getByRole('option').first().getAttribute('id');
				await list.getByRole('option').nth(1).hover();
				await expect(list).toHaveAttribute('aria-activedescendant', firstId!);

				await list.press('End');
				await expect(list).toBeFocused();
				await expect(list.getByRole('option').last()).toHaveAttribute('aria-selected', 'true');
				await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
				const lastBottom = (await list.getByRole('option').last().boundingBox())!;
				const viewportBox = (await viewport.boundingBox())!;
				expect(lastBottom.y + lastBottom.height).toBeLessThanOrEqual(viewportBox.y + viewportBox.height + 1);
				await list.press('Home');
				await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0);
				await root.hover();
				const beforeWheel = await viewport.evaluate(element => element.scrollTop);
				await page.mouse.wheel(0, 200);
				await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(beforeWheel);
				await expect(list.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
				await list.press('Home');
				await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0);
				await root.hover();
				await expect(track).toHaveCSS('opacity', '1');
				const thumb = (await track.locator('.ash-scrollbar-thumb').boundingBox())!;
				await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
				await page.mouse.down();
				await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2 + 40, { steps: 5 });
				await page.mouse.up();
				await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
				await expect.poll(async () => Number(await track.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
				await page.screenshot({ path: `.build/desktop/ui-previews/extensions-scrollbar-${view}-${locale}.png` });
				if (view === 'plugins') {
					const search = page.locator('#extensions').getByRole('searchbox');
					await search.fill('@installed ash.bat');
					await search.press('Enter');
					await expect(list.getByRole('option')).toHaveCount(1);
					await expect(track).toBeHidden();
					await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0);
				}
			});
		}

		for (const theme of ['light', 'dark', 'hc']) {
			test(`Extension header badges follow filtering and collapse in ${locale} ${theme}`, async function () {
				const { page } = browserTests;

				await page.goto(`/extensions.html?classification&locale=${locale}&theme=${theme}`);
				const skills = page.locator('[data-view-id="ash.extensions.skills"]');
				const plugins = page.locator('[data-view-id="ash.extensions.plugins"]');
				const header = skills.locator('.ash-pane-view-header');
				const toggle = skills.getByRole('button', { name: locale === 'en' ? 'Skills' : '技能', exact: true });
				const badge = header.locator('.ash-count-badge');
				await expect(toggle).toHaveAttribute('aria-expanded', 'false');
				await expect(badge).toHaveText('1');
				await toggle.press('ArrowRight');
				await expect(badge).toHaveText('1');
				await expect(header).toHaveAccessibleDescription(locale === 'en' ? '1 items' : '1 项');
				await expect(skills.locator('.extensions-status')).toContainText('Invalid metadata');
				await expect(skills.locator('.extensions-status')).not.toContainText(locale === 'en' ? '1 items' : '1 项');
				await expect(plugins.locator('.extensions-status')).toBeHidden();

				await toggle.press('ArrowLeft');
				await expect(toggle).toHaveAttribute('aria-expanded', 'false');
				await expect(badge).toBeVisible();
				await expect(badge).toHaveText('1');
				await expect(badge).toHaveJSProperty('tabIndex', -1);
				await toggle.press('ArrowRight');
				await expect(toggle).toBeFocused();

				const connectors = page.locator('[data-view-id="ash.extensions.mcp"]');
				await expect(connectors.locator('.ash-pane-view-content')).toHaveAttribute('aria-busy', 'false');
				const connectorBadge = connectors.locator('.ash-pane-view-header > .ash-count-badge');
				const previous = Number(await connectorBadge.textContent());
				await page.evaluate(() => window.ashExtensionsIntegration.addConnector());
				await expect(connectorBadge).toHaveText(String(previous + 1));
				await connectors.getByRole('button', { name: locale === 'en' ? 'Connections' : '连接', exact: true }).press('ArrowRight');
				await page.mouse.move(900, 600);
				const before = await badge.boundingBox();
				await skills.hover();
				expect((await badge.boundingBox())!.x).toBe(before!.x);
				for (const pane of [skills, plugins, connectors]) {
					const bounds = await pane.locator('.ash-pane-view-header').evaluate(element => {
						const badge = element.querySelector<HTMLElement>('.ash-count-badge')!;
						const actions = element.querySelector<HTMLElement>('.ash-pane-view-header-actions')!;
						const style = getComputedStyle(badge);
						return { header: element.getBoundingClientRect().toJSON(), badge: badge.getBoundingClientRect().toJSON(), actions: actions.getBoundingClientRect().toJSON(), background: style.backgroundColor, foreground: style.color, outline: style.outlineColor };
					});
					expect(bounds.badge.right).toBeCloseTo(bounds.header.right - 12);
					expect(bounds.badge.top + bounds.badge.height / 2).toBeCloseTo(bounds.header.top + bounds.header.height / 2);
					expect(bounds.actions.right).toBeLessThanOrEqual(bounds.badge.left);
					expect(bounds.background).not.toBe('rgba(0, 0, 0, 0)');
					expect(bounds.foreground).not.toBe(bounds.background);
					if (theme === 'hc') { expect(bounds.outline).not.toBe(bounds.background); }
				}
				await page.screenshot({ path: `.build/desktop/ui-previews/extensions-badges-${locale}-${theme}.png` });

				const search = page.locator('#extensions').getByRole('searchbox');
				await search.fill('@installed no-such-skill');
				await search.press('Enter');
				await expect(badge).toHaveText('0');
				await expect(header).toHaveAccessibleDescription(locale === 'en' ? '0 items' : '0 项');
				await expect(plugins.locator('.ash-count-badge')).toHaveText('0');
				await search.fill('@installed ash.bat');
				await search.press('Enter');
				await expect(plugins.getByRole('option')).toHaveCount(1);
				const bat = plugins.locator('[data-package-id="ash.bat"]');
				await expect(bat.locator('.extension-body > .ash-icon-label')).toHaveText(['bat', 'Ash']);
				await expect(bat.locator('.extension-footer, .extension-state, .extension-description')).toHaveCount(0);
				await expect(bat.getByRole('button')).toHaveCount(0);
				await expect(plugins.locator('.ash-count-badge')).toHaveText('1');
				await expect(plugins.locator('.ash-count-badge')).toHaveAttribute('aria-label', locale === 'en' ? '1 plugins' : '1 个插件');
				await expect(plugins.locator('.extensions-status')).toBeHidden();
				await page.evaluate(() => window.ashExtensionsIntegration.dispose());
				await expect(page.locator('#extensions .ash-count-badge')).toHaveCount(0);
			});
		}

		test(`Extensions defaults to installed categories and returns from Marketplace in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?classification&nativeEditor&locale=${locale}`);
			const titles = page.locator('#extensions .ash-pane-view-header-title');
			const labels = locale === 'en' ? ['Skills', 'Plugins', 'Connections', 'Recommended'] : ['技能', '插件', '连接', '推荐'];
			await expect(titles).toHaveText(labels);
			await expect(page.locator('[data-view-id="ash.extensions.view"]')).toHaveCount(0);
			await page.evaluate(() => window.ashExtensionsIntegration.openEditorExtension());
			const install = locale === 'en' ? 'Install' : '安装';
			await page.locator('.ash-extension-editor').getByRole('button', { name: install, exact: true }).click();
			await page.getByRole('dialog', { name: install, exact: true }).getByRole('button', { name: install, exact: true }).click();
			const plugins = page.locator('[data-view-id="ash.extensions.plugins"]');
			await expect(plugins.getByRole('option').filter({ hasText: 'Academy' })).toHaveCount(1);
			await expect(plugins.getByRole('option').filter({ hasText: 'Academy' }).locator('.extension-metadata')).toHaveText('Fixture publisher');
			await page.locator('#extensions').getByRole('searchbox').fill('@installed Academy');
			const installations = await page.evaluate(() => window.ashExtensionsIntegration.installationSnapshot());
			await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('ash.extensions.browse'));
			await expect(titles).toHaveText([locale === 'en' ? 'Marketplace' : '扩展市场']);
			await expect(page.locator('#extensions').getByRole('searchbox')).toBeFocused();
			await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('ash.extensions.showInstalled'));
			await expect(titles).toHaveText(labels);
			await expect(page.locator('#extensions').getByRole('searchbox')).toHaveValue('');
			await expect(plugins.getByRole('option').filter({ hasText: 'Academy' })).toHaveCount(1);
			expect(await page.evaluate(() => window.ashExtensionsIntegration.installationSnapshot())).toEqual(installations);
		});

		test(`Skill and Connector operations preserve their installed bundle in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?classification&connectorBundle&locale=${locale}`);
			await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('ash.extensions.browse'));
			const install = locale === 'en' ? 'Install' : '安装';
			await page.locator('[data-view-id="ash.extensions.view"]').getByRole('button', { name: install, exact: true }).click();
			await page.getByRole('dialog', { name: install, exact: true }).getByRole('button', { name: install, exact: true }).click();
			await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('ash.extensions.showInstalled'));
			const installed = await page.evaluate(() => { window.ashExtensionsIntegration.addConnector(); return window.ashExtensionsIntegration.installationSnapshot(); });
			await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('workbench.action.chat.configure.skills'));
			await page.locator('[data-view-id="ash.extensions.skills"]').getByRole('option').click();
			const details = page.locator('.ash-extension-editor');
			const skillToggle = details.getByRole('switch', { name: locale === 'en' ? 'Enable skill' : '启用技能', exact: true });
			await skillToggle.press('Space');
			await expect(skillToggle).not.toBeChecked();
			const connectors = page.locator('[data-view-id="ash.extensions.mcp"]');
			await connectors.getByRole('button', { name: locale === 'en' ? 'Connections' : '连接', exact: true }).press('ArrowRight');
			await connectors.getByRole('option').filter({ hasText: 'GitHub account' }).click();
			await details.getByRole('switch').press('Space');
			await expect(connectors.getByRole('option').filter({ hasText: 'GitHub account' })).toContainText(locale === 'en' ? 'Disconnected' : '已断开');
			await expect(details.locator('.extension-detail-info')).toContainText('octocat');
			await expect(details.getByRole('switch')).not.toBeChecked();
			await details.getByRole('switch').press('Space');
			await expect(details.getByRole('status')).toHaveText(locale === 'en' ? 'Connected · Octocat' : '已连接 · Octocat');
			expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'connector/enablement/set'))).toEqual([
				['connector/enablement/set', 'github', false], ['connector/enablement/set', 'github', true],
			]);
			expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'connector/connect' || entry[0] === 'connector/oauth'))).toEqual([]);
			const tokenButton = details.getByRole('button', { name: locale === 'en' ? 'Connect with API token' : '使用 API 令牌连接', exact: true });
			await tokenButton.press('Enter');
			const tokenDialog = page.getByRole('dialog', { name: 'GitHub account', exact: true });
			await tokenDialog.getByRole('button', { name: locale === 'en' ? 'Cancel' : '取消', exact: true }).click();
			expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'connector/connect'))).toEqual([]);
			await tokenButton.press('Enter');
			await tokenDialog.getByPlaceholder(locale === 'en' ? 'Account ID' : '账户标识符', { exact: true }).fill('octocat');
			await tokenDialog.getByPlaceholder(locale === 'en' ? 'Account name' : '账户名称', { exact: true }).fill('Octocat');
			const token = tokenDialog.getByPlaceholder(locale === 'en' ? 'API token' : 'API 令牌', { exact: true });
			await expect(token).toHaveAttribute('type', 'password');
			await token.fill('fixture-secret-token');
			await tokenDialog.getByRole('button', { name: locale === 'en' ? 'Connect' : '连接', exact: true }).press('Enter');
			await expect(connectors.getByRole('option').filter({ hasText: 'GitHub account' })).toContainText(locale === 'en' ? 'Connected · Octocat' : '已连接 · Octocat');
			expect(await page.evaluate(() => window.ashExtensionsIntegration.installationSnapshot())).toEqual(installed);
			expect(await page.evaluate(() => window.ashExtensionsIntegration.requests.filter((entry: any) => entry[0] === 'uninstall'))).toEqual([]);
		});
	}

	for (const locale of ['en', 'zh-CN']) {
		test(`One global search filters installed content and clears Marketplace results in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?classification&locale=${locale}`);
			const search = page.locator('#extensions').getByRole('searchbox');
			await expect(search).toHaveCount(1);
			await expect(page.locator('#extensions .ash-view-pane input[type="search"]')).toHaveCount(0);
			await search.fill('@installed ash.bat');
			await search.press('Enter');
			const plugins = page.locator('[data-view-id="ash.extensions.plugins"]');
			await expect(plugins.getByRole('option')).toHaveCount(1);
			await expect(plugins.getByRole('option').locator('.extension-name')).toHaveText('bat');
			await search.fill('Web');
			await search.press('Enter');
			await expect(page.locator('[data-view-id="ash.extensions.view"]').getByRole('option')).toContainText('Web tools');
			await expect(search).toBeFocused();
			await search.press('ArrowDown');
			await expect(page.locator('[data-view-id="ash.extensions.view"]').getByRole('listbox')).toBeFocused();
			await search.focus();
			await search.press('Escape');
			await expect(search).toHaveValue('');
			await expect(page.locator('[data-view-id="ash.extensions.view"]')).toHaveCount(0);
			await expect(plugins.locator('[data-package-id="ash.bat"]')).toHaveCount(1);
			await expect(plugins.getByRole('option')).not.toHaveCount(1);
		});

		test(`Extension search filter and clear icons retain terms and support keyboard navigation in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?classification&locale=${locale}`);
			const search = page.locator('#extensions').getByRole('searchbox');
			const filter = page.locator('[data-action-id="ash.extensions.filterSearch"] button');
			const clear = page.locator('[data-action-id="ash.extensions.clearSearch"] button');
			const titles = page.locator('#extensions .ash-pane-view-header-title');
			const names = locale === 'en' ? ['Marketplace', 'Installed', 'Skills', 'Plugins', 'Connections', 'Built-in', 'Recommended'] : ['扩展市场', '已安装', '技能', '插件', '连接', '内置', '推荐'];
			await expect(clear).toBeDisabled();
			await search.fill('@installed ash.bat');
			await search.press('Enter');
			await search.press('Tab');
			await expect(filter).toBeFocused();
			await filter.press('ArrowLeft');
			await expect(clear).toBeFocused();
			await clear.press('ArrowRight');
			await expect(filter).toBeFocused();
			await filter.press('Enter');
			const menu = page.getByRole('menu');
			await expect(menu.getByRole('menuitemcheckbox')).toHaveText(names);
			await expect(menu.getByRole('menuitemcheckbox', { name: names[1], exact: true })).toHaveAttribute('aria-checked', 'true');
			await menu.getByRole('menuitemcheckbox').first().press('Escape');
			await expect(filter).toBeFocused();
			for (const [token, index, title] of [['@skills', 2, names[2]], ['@plugins', 3, names[3]], ['@connections', 4, names[4]], ['@builtin', 5, names[3]], ['@recommended', 6, names[6]], ['@installed', 1, null]]) {
				await filter.click();
				await page.getByRole('menuitemcheckbox', { name: names[index as number], exact: true }).click();
				await expect(search).toHaveValue(`${token} ash.bat`);
				await expect(search).toBeFocused();
				if (title) { await expect(titles).toHaveText([title as string]); }
				else { await expect(titles).toHaveCount(4); }
			}
			await search.fill('@connectors ash.bat');
			await search.press('Enter');
			await expect(titles).toHaveText([names[4]]);
			await filter.click();
			await expect(page.getByRole('menuitemcheckbox', { name: names[4], exact: true })).toHaveAttribute('aria-checked', 'true');
			await page.getByRole('menuitemcheckbox', { name: names[0], exact: true }).click();
			await expect(search).toHaveValue('ash.bat');
			await expect(titles).toHaveText([names[0]]);
			await clear.click();
			await expect(search).toHaveValue('');
			await expect(search).toBeFocused();
			await expect(clear).toBeDisabled();
			await expect(titles).toHaveCount(4);
			await search.press('Tab');
			await expect(filter).toBeFocused();
			await search.fill('@SKILLS review');
			await search.press('Enter');
			await expect(titles).toHaveText([names[2]]);
			await search.press('Escape');
			await expect(titles).toHaveCount(4);
			await page.evaluate(() => window.ashExtensionsIntegration.open({ view: 'skills', mode: 'browse', query: 'review' }));
			await search.fill('@plugins ash.bat');
			await search.press('Enter');
			await search.press('ArrowDown');
			await expect(page.locator('[data-view-id="ash.extensions.plugins"]').getByRole('listbox')).toBeFocused();
		});

		test(`Extensions More Actions menu runs shared commands and restores keyboard focus in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?classification&locale=${locale}`);
			const labels = locale === 'en'
				? ['Browse Marketplace', 'Show installed', 'Manage built-in editor extensions', 'Manage extension sources', 'Install extension from workspace', 'Install extension from Git repository']
				: ['浏览扩展市场', '显示已安装', '管理内置编辑器扩展', '管理扩展来源', '从工作区安装扩展', '从 Git 仓库安装扩展'];
			const more = page.locator('#extensions [data-action-id="ash.toolbar.moreActions"] button');
			await expect(more).toHaveCount(1);
			await more.focus();
			await more.press('Enter');
			const menu = page.getByRole('menu');
			await expect(menu.getByRole('menuitem')).toHaveText(labels);
			await expect(menu.getByRole('separator')).toHaveCount(2);
			await page.screenshot({ path: `.build/desktop/ui-previews/extensions-more-${locale}.png` });
			await expect(more).toHaveAttribute('aria-expanded', 'true');
			await menu.getByRole('menuitem').first().press('End');
			await expect(menu.getByRole('menuitem').last()).toBeFocused();
			await menu.getByRole('menuitem').last().press('Escape');
			await expect(menu).toHaveCount(0);
			await expect(more).toBeFocused();
			await expect(more).toHaveAttribute('aria-expanded', 'false');
			await more.click();
			await page.getByRole('menuitem', { name: labels[0], exact: true }).click();
			await expect(page.locator('[data-view-id="ash.extensions.view"]')).toBeVisible();
			await more.click();
			await page.getByRole('menuitem', { name: labels[1], exact: true }).click();
			await expect(page.locator('[data-view-id="ash.extensions.view"]')).toHaveCount(0);
			await expect(page.locator('#extensions .ash-pane-view-header-title')).toHaveCount(4);
			await more.click();
			await page.getByRole('menuitem', { name: labels[4], exact: true }).click();
			const dialog = page.getByRole('dialog', { name: labels[4], exact: true });
			await expect(dialog).toBeVisible();
			await dialog.getByRole('button', { name: locale === 'en' ? 'Cancel' : '取消', exact: true }).click();
			await expect(dialog).toHaveCount(0);
		});

		test(`Global refresh preserves selection and expansion while actions reveal on intent in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto(`/extensions.html?classification&locale=${locale}`);
			const search = page.locator('#extensions').getByRole('searchbox');
			const refresh = page.locator('#extensions [data-action-id="ash.extensions.refresh"] button');
			const connectors = page.locator('[data-view-id="ash.extensions.mcp"]');
			const add = connectors.getByRole('button', { name: locale === 'en' ? 'Add connection' : '添加连接', exact: true });
			await connectors.getByRole('button', { name: locale === 'en' ? 'Connections' : '连接', exact: true }).press('ArrowRight');
			await page.locator('#details').click();
			await page.mouse.move(900, 600);
			await expect(refresh).toBeHidden();
			await expect(add).toBeHidden();
			await expect(page.locator('#extensions .ash-pane-view-header-actions button')).toHaveCount(1);
			await connectors.hover();
			await expect(add).toBeVisible();
			await page.mouse.move(900, 600);
			await search.focus();
			await expect(add).toBeHidden();
			await expect(refresh).toBeVisible();
			const refreshBox = await refresh.boundingBox();
			const searchBox = await search.boundingBox();
			expect(refreshBox!.y + refreshBox!.height).toBeLessThanOrEqual(searchBox!.y);
			await expect(page.locator('.extensions-global-search button')).toHaveCount(2);
			await connectors.getByRole('button', { name: locale === 'en' ? 'Connections' : '连接', exact: true }).focus();
			await expect(add).toBeVisible();
			const selected = page.locator('[data-view-id="ash.extensions.plugins"]').locator('[data-package-id="ash.bat"]');
			await selected.click();
			await expect(selected).toHaveAttribute('aria-selected', 'true');
			await search.fill('@installed ash.bat');
			await search.press('Enter');
			const headers = page.locator('#extensions .ash-pane-view-header-button');
			const expanded = await headers.evaluateAll(elements => elements.map(element => element.getAttribute('aria-expanded')));
			const before = await page.evaluate(() => window.ashExtensionsIntegration.managementReads());
			await search.focus();
			await refresh.press('Enter');
			await expect(page.locator('.ash-extensions-view-container')).toHaveAttribute('aria-busy', 'false');
			await expect(refresh).toBeEnabled();
			await expect(search).toHaveValue('@installed ash.bat');
			await expect(selected).toHaveAttribute('aria-selected', 'true');
			expect(await headers.evaluateAll(elements => elements.map(element => element.getAttribute('aria-expanded')))).toEqual(expanded);
			const after = await page.evaluate(() => window.ashExtensionsIntegration.managementReads());
			expect(after.installed).toBeGreaterThan(before.installed);
			expect(after.skills).toBeGreaterThan(before.skills);
			expect(after.connectors).toBeGreaterThan(before.connectors);
		});
	}


	test('Saving detail enablement preserves focus moved to the shared search box', async function () {
		const { page } = browserTests;

		await page.goto('/extensions.html');
		await page.evaluate(() => window.ashExtensionsIntegration.executeCommand('workbench.action.chat.configure.skills'));
		await page.locator('[data-view-id="ash.extensions.skills"]').getByRole('option').click();
		const toggle = page.locator('.ash-extension-editor').getByRole('switch');
		await page.evaluate(() => window.ashExtensionsIntegration.holdSkillEnablement());
		await toggle.press('Space');
		await expect(toggle).toBeDisabled();
		await expect.poll(() => page.evaluate(() => window.ashExtensionsIntegration.skillEnablementStarted())).toBe(true);
		const search = page.locator('#extensions').getByRole('searchbox');
		await search.focus();
		await page.evaluate(() => window.ashExtensionsIntegration.completeSkillEnablement());
		await expect(toggle).toBeEnabled();
		await expect(toggle).not.toBeChecked();
		await expect(search).toBeFocused();
	});
});
