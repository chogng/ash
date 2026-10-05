import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';

test('Network Settings supports search, keyboard help and Chinese labels while disconnected', async ({ target, workbench, restartWorkbench }) => {
	test.skip(target.appServerMode === 'required', 'Exercises disconnected Workbench Settings.');
	let page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	const settings = page.locator('.ash-settings-editor');
	await workbench.settingsEditor.selectCategory('network');
	await expect(settings.getByRole('combobox', { name: 'HTTP compatibility mode', exact: true })).toBeDisabled();
	await expect(settings.locator('.ash-network-settings [role="status"]')).toHaveText('Could not read network configuration. Connect to App Server and refresh.');
	await expect(settings.getByRole('button', { name: 'Run diagnostic', exact: true })).toBeDisabled();
	const refresh = settings.getByRole('button', { name: 'Refresh', exact: true });
	await refresh.focus();
	await refresh.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/HTTP\/1.1 restricts subsequent application HTTP requests/);
	await help.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(refresh).toBeFocused();
	const search = settings.getByRole('searchbox', { name: 'Search settings', exact: true });
	await search.fill('HTTP/1.1');
	await expect(settings.getByRole('combobox', { name: 'HTTP compatibility mode', exact: true })).toBeVisible();
	await search.fill('DNS');
	await expect(settings.getByRole('button', { name: 'Run diagnostic', exact: true })).toBeVisible();
	await search.fill('');
	await workbench.settingsEditor.selectCategory('general');
	await settings.getByRole('combobox', { name: 'Interface language', exact: true }).click();
	await page.getByRole('option', { name: '简体中文', exact: true }).click();
	({ workbench } = await restartWorkbench());
	page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	const chineseSettings = page.getByRole('dialog', { name: 'Ash 设置' });
	await workbench.settingsEditor.selectCategory('network');
	await expect(chineseSettings.getByRole('heading', { name: '所需域名', exact: true })).toBeVisible();
	await expect(chineseSettings.getByRole('combobox', { name: 'HTTP 兼容模式', exact: true })).toBeDisabled();
	const chineseRefresh = chineseSettings.getByRole('button', { name: '刷新', exact: true });
	await chineseRefresh.focus();
	await chineseRefresh.press('Alt+F1');
	await expect(page.getByRole('dialog', { name: '无障碍帮助' }).getByRole('textbox')).toHaveValue(/HTTP\/1.1 将后续应用 HTTP 请求限制为 HTTP\/1.1/);
});

test('Network Settings persists HTTP mode, copies configured domains and reports real HTTP reachability', async ({ target, workbench, application }) => {
	test.skip(target.appServerMode !== 'required', 'Uses the real backend transport and isolated provider configuration.');
	const requests: { url: string; authorization: string | undefined; version: string }[] = [];
	const server = createServer((request, response) => {
		requests.push({ url: request.url!, authorization: request.headers.authorization, version: request.httpVersion });
		response.writeHead(request.url === '/' ? 401 : 200, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ data: [{ id: 'network-test-model' }] }));
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		const address = server.address();
		if (!address || typeof address === 'string') { throw new Error('Local network test server has no port'); }
		const page = workbench.page;
		await workbench.settingsEditor.openUserSettingsUI();
		const settings = page.locator('.ash-settings-editor');
		await workbench.settingsEditor.selectGroup('agents');
		await workbench.settingsEditor.selectCategory('models');
		await settings.getByRole('button', { name: 'New provider', exact: true }).click();
		const card = settings.locator('.ash-chat-models-widget').first();
		await card.getByRole('textbox', { name: 'Provider name', exact: true }).fill('Network test gateway');
		const url = card.getByRole('textbox', { name: 'Base URL', exact: true });
		await url.fill(`http://127.0.0.1:${address.port}/v1`);
		await url.press('Tab');
		const key = card.locator('input[type="password"]');
		await key.fill('isolated-network-key');
		await key.press('Tab');
		await expect(key).toHaveValue('••••••••');
		await workbench.settingsEditor.selectCategory('network');
		const mode = settings.getByRole('combobox', { name: 'HTTP compatibility mode', exact: true });
		await expect(mode).toBeEnabled();
		await mode.click();
		await page.getByRole('option', { name: 'HTTP/1.1', exact: true }).click();
		await expect(settings.locator('.ash-network-settings [role="status"]')).toHaveText('HTTP compatibility mode saved. Subsequent requests use the selected mode.');
		await expect(mode).toContainText('HTTP/1.1');
		const show = settings.getByRole('button', { name: 'Show', exact: true });
		await show.focus();
		await show.press('Enter');
		await expect(settings.locator('.ash-network-settings-details')).toContainText(`127.0.0.1:${address.port}`);
		await expect(settings.getByRole('button', { name: 'Hide', exact: true })).toHaveAttribute('aria-expanded', 'true');
		if (target.kind === 'browser') { await page.context().grantPermissions(['clipboard-read', 'clipboard-write']); }
		await settings.getByRole('button', { name: 'Copy domains', exact: true }).click();
		const copied = target.kind === 'electron'
			? await (application as ElectronApplication).evaluate(({ clipboard }) => clipboard.readText())
			: await page.evaluate(() => navigator.clipboard.readText());
		expect(copied.split('\n')).toContain('127.0.0.1');
		expect(copied).not.toContain('isolated-network-key');
		const run = settings.getByRole('button', { name: 'Run diagnostic', exact: true });
		await run.focus();
		await run.press('Enter');
		await expect(settings.locator('.ash-network-settings [role="status"]')).toHaveText('Network diagnostic completed.', { timeout: 30_000 });
		await expect(settings.locator('.ash-network-settings-results')).toContainText('Reachable (HTTP 401)');
		expect(requests.filter(request => request.url === '/')).toEqual([{ url: '/', authorization: undefined, version: '1.1' }]);
		await run.press('Alt+F2');
		const accessible = page.getByRole('dialog', { name: 'Accessible View', exact: true });
		await expect(accessible.getByRole('textbox')).toHaveValue(/HTTP\/1.1[\s\S]*127\.0\.0\.1[\s\S]*Reachable \(HTTP 401\)/);
		await accessible.getByRole('button', { name: 'Close', exact: true }).click();
		await page.locator('.ash-modal-editor-close').click();
		// Editor restoration opens Welcome and closes modal editors; reopen Settings after it finishes.
		await page.reload();
		await workbench.waitForReady();
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectCategory('network');
		await expect(mode).toContainText('HTTP/1.1');
		await expect(mode).toBeEnabled();
		await mode.click();
		await page.getByRole('option', { name: 'HTTP/2 (recommended)', exact: true }).click();
		await expect(settings.locator('.ash-network-settings [role="status"]')).toHaveText('HTTP compatibility mode saved. Subsequent requests use the selected mode.');
		await expect(mode).toContainText('HTTP/2');
		if (target.kind === 'electron') {
			const profile = await (application as ElectronApplication).evaluate(() => process.env.ASH_HOME);
			if (!profile) { throw new Error('The test application has no isolated profile'); }
			const configurationPath = join(profile, 'config.toml');
			const original = await readFile(configurationPath, 'utf8');
			expect(original).toContain('httpMode = "http2"');
			try {
				await writeFile(configurationPath, original.replace('httpMode = "http2"', 'httpMode = "http1"'));
				await settings.getByRole('button', { name: 'Refresh', exact: true }).click();
				await expect(mode).toContainText('HTTP/1.1');
				await expect(mode).toBeEnabled();
			} finally { await writeFile(configurationPath, original); }
		}
	} finally {
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});
