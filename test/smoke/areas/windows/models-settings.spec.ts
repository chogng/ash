import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchElectron } from '../../../automation/playwrightElectron.js';
import type { Locator } from '@playwright/test';
import { readUserSettings, writeUserSettings } from '../../../automation/settings.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { expect, test } from '../../../automation/test.js';

const defaultVisibleModelNames = ['GPT-6.1 Sol', 'Claude Sonnet 5.5', 'Grok 4.7', 'Gemini 3.8 Flash', 'Kimi K3', 'DeepSeek V4.1 Flash', 'GLM-5.3', 'Muse Spark 1.3'];
const defaultEnabledModelNames = ['GPT-6.1 Sol', 'GPT-6 Luna', 'GPT-6 Astra', 'Claude Sonnet 5.5', 'Claude Opus 5.5', 'Grok 4.7'];

for (const locale of ['en', 'zh-CN']) {
	test(`Development credentials persist across Desktop restarts and provider deletion removes their files (${locale})`, { tag: ['@electron-app-server'] }, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-development-credentials-'));
		const profile = join(directory, 'profile');
		await mkdir(profile);
		await writeFile(join(profile, 'settings.json'), JSON.stringify({ 'workbench.locale': locale }));
		const chinese = locale === 'zh-CN';
		const credential = 'synthetic-development-key';
		const options = { appServerMode: 'required' as const, userDataDirectory: directory, useInMemorySecretStorage: false, environment: { ...process.env, ASH_DEV_APP_SERVER_RELOAD: '1' } };
		let desktop: Awaited<ReturnType<typeof launchElectron>> | undefined;
		try {
			const openModels = async (): Promise<Locator> => {
				const workbench = desktop!.driver.workbench;
				await workbench.settingsEditor.openUserSettingsUI();
				await workbench.settingsEditor.selectGroup('agents');
				await workbench.settingsEditor.selectCategory('models');
				const settings = workbench.settingsEditor.element;
				await expect(settings.getByRole('status').filter({ hasText: chinese ? '凭据以未加密形式保存在私有文件中' : 'Credentials are stored without encryption in private files' })).toBeVisible();
				await expect(settings.getByRole('button', { name: chinese ? '授权系统钥匙串' : 'Authorize system keyring', exact: true })).toBeHidden();
				return settings;
			};
			desktop = await launchElectron(options);
			const settings = await openModels();
			await settings.getByRole('button', { name: chinese ? '新增供应商' : 'New provider', exact: true }).click();
			const card = settings.locator('.ash-chat-models-widget').first();
			await card.getByRole('textbox', { name: chinese ? '供应商名称' : 'Provider name', exact: true }).fill('Development fixture');
			const url = card.getByRole('textbox', { name: 'Base URL', exact: true });
			await url.fill('https://example.invalid/v1');
			await url.press('Tab');
			const input = card.locator('input[type="password"]');
			await input.fill(credential);
			await input.press('Tab');
			await expect(input).toHaveValue('••••••••');
			const values = join(profile, 'development-secrets/values');
			await expect.poll(async () => {
				const files = await readdir(values);
				return (await Promise.all(files.map(file => readFile(join(values, file))))).some(value => value.includes(credential));
			}).toBe(true);
			if (process.platform !== 'win32') {
				expect((await stat(join(profile, 'development-secrets'))).mode & 0o777).toBe(0o700);
				expect((await stat(values)).mode & 0o777).toBe(0o700);
				for (const file of await readdir(values)) expect((await stat(join(values, file))).mode & 0o777).toBe(0o600);
			}
			await desktop.close();
			desktop = await launchElectron(options);
			const restored = (await openModels()).locator('.ash-chat-models-widget').filter({ has: desktop.driver.workbench.page.getByRole('textbox', { name: chinese ? '供应商名称' : 'Provider name', exact: true }) }).first();
			await expect(restored.getByRole('textbox', { name: chinese ? '供应商名称' : 'Provider name', exact: true })).toHaveValue('Development fixture');
			await expect(restored.locator('input[type="password"]')).toHaveValue('••••••••');
			expect(await readFile(join(profile, 'development-secrets/storage-mode'), 'utf8')).toBe('file');
			await desktop.driver.workbench.settingsEditor.element.locator('.ash-modal-editor-close').click();
			const peer = await desktop.driver.workbench.openAgentsWindow('electron');
			await new QuickAccess(peer).runCommand('workbench.action.chat.manage');
			const peerCard = peer.locator('.ash-chat-models-widget');
			await expect(peerCard.getByRole('textbox', { name: chinese ? '供应商名称' : 'Provider name', exact: true })).toHaveValue('Development fixture');
			await desktop.driver.workbench.quickaccess.runCommand('workbench.action.chat.manage');
			const remove = restored.getByRole('button', { name: chinese ? '删除供应商' : 'Delete provider', exact: true });
			const dialogs = desktop.driver.workbench.dialogs;
			const cancelled = await dialogs.confirm(desktop.application, chinese ? '确认' : 'Confirm', chinese ? '取消' : 'Cancel', () => remove.click());
			expect(cancelled.message).toContain('Development fixture');
			await expect(restored).toBeVisible();
			await expect(remove).toBeEnabled();
			await dialogs.confirm(desktop.application, chinese ? '确认' : 'Confirm', chinese ? '确认' : 'Confirm', () => remove.click());
			await expect(restored).toHaveCount(0);
			await expect(peerCard).toHaveCount(0);
			await expect.poll(async () => {
				const files = await readdir(values);
				return (await Promise.all(files.map(file => readFile(join(values, file))))).some(value => value.includes(credential));
			}).toBe(false);
			await expect(desktop.driver.workbench.settingsEditor.element.getByRole('button', { name: chinese ? '新增供应商' : 'New provider', exact: true })).toBeFocused();

		} finally {
			try { await desktop?.close(); }
			finally { await rm(directory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 }); }
		}
	});
}

for (const locale of ['en', 'zh-CN']) {
	test.describe(`Model management navigation (${locale})`, () => {
		test.use({ electronUserSettings: { 'workbench.locale': locale, 'workbench.settings.editor': 'json' } });
		test('Models management opens Models settings directly and clears previous filters', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ workbench, target }) => {
			const page = workbench.page;
			const chinese = locale === 'zh-CN';
			await workbench.quickaccess.runCommand('workbench.action.chat.manage');
			const settings = page.getByRole('dialog', { name: chinese ? 'Ash 设置' : 'Ash Settings', exact: true });
			await expect(settings).toBeVisible();
			const category = settings.getByRole('treeitem').filter({ has: page.locator('[data-settings-category-id="models"]') });
			await expect(category).toHaveAttribute('aria-selected', 'true');
			await expect(settings.getByRole('button', { name: chinese ? '新增供应商' : 'New provider', exact: true })).toBeVisible();
			await expect(settings.locator('.ash-chat-models-catalog')).toHaveCount(1);
			await expect(page.locator('.ash-models-management-editor')).toHaveCount(0);
			const search = settings.getByRole('searchbox', { name: chinese ? '搜索设置' : 'Search settings', exact: true });
			await expect(settings.getByRole('combobox', { name: chinese ? '搜索模型' : 'Search models', exact: true })).toBeFocused();
			await search.fill('synthetic-missing-model');
			await workbench.quickaccess.runCommand('workbench.action.chat.manage');
			await expect(settings).toHaveCount(1);
			await expect(search).toHaveValue('');
			await expect(settings.getByRole('combobox', { name: chinese ? '搜索模型' : 'Search models', exact: true })).toBeFocused();
			await expect(category).toHaveAttribute('aria-selected', 'true');
			const modelSearch = settings.getByRole('combobox', { name: chinese ? '搜索模型' : 'Search models', exact: true });
			await modelSearch.focus();
			await modelSearch.press('Alt+F1');
			const help = page.getByRole('dialog', { name: chinese ? '无障碍帮助' : 'Accessibility Help', exact: true });
			await expect(help.getByRole('textbox')).toHaveValue(/API key/);
			await help.getByRole('button', { name: chinese ? '关闭' : 'Close', exact: true }).click();
			await expect(modelSearch).toBeFocused();
			if (target.appServerMode === 'required') {
				await settings.getByRole('button', { name: chinese ? '查看所有模型' : 'viewall models', exact: true }).click();
				await expect(settings.locator('.ash-chat-models-filters > summary')).toHaveText(chinese ? '搜索筛选条件' : 'Search filters');
				await expect(settings.getByRole('button', { name: chinese ? '全部折叠' : 'Collapse All', exact: true })).toBeVisible();
				await modelSearch.focus();
				await modelSearch.press('Alt+F1');
				await expect(help.getByRole('textbox')).toHaveValue(chinese ? /供应商开关会修改该连接的全部模型，包括当前搜索结果之外的模型/ : /including models outside the current search/);
				await help.getByRole('button', { name: chinese ? '关闭' : 'Close', exact: true }).click();
				await expect(modelSearch).toBeFocused();
			}
			await test.info().attach(`models-settings-${locale}`, { body: await page.screenshot(), contentType: 'image/png' });
		});
	});
}

test('Add Models in the chat picker opens Models settings directly', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) { await workbench.quickaccess.runCommand('workbench.action.toggleAuxiliaryBar'); }
	await page.locator('.ash-chat-view-pane .ash-chat-input-model-action').press('ArrowDown');
	const picker = page.locator('.ash-chat-model-picker');
	const automatic = picker.getByRole('switch', { name: 'Auto', exact: true });
	if (await automatic.isChecked()) { await automatic.press('Space'); }
	await picker.getByRole('menuitem', { name: 'Add Models', exact: true }).click();
	await expect(picker).toBeHidden();
	const settings = page.getByRole('dialog', { name: 'Ash Settings', exact: true });
	await expect(settings).toBeVisible();
	await expect(settings.getByRole('combobox', { name: 'Search models', exact: true })).toBeFocused();
	await expect(settings.getByRole('button', { name: 'New provider', exact: true })).toBeVisible();
	await expect(settings.locator('.ash-chat-models-catalog')).toHaveCount(1);
	await expect(page.locator('.ash-models-management-editor')).toHaveCount(0);
});

for (const host of ['Workbench', 'Sessions']) {
	test(`${host} Models settings supports provider filters, bulk visibility and overview recovery`, { tag: ['@electron-app-server'] }, async ({ workbench, target }) => {
		const page = host === 'Workbench' ? workbench.page : await workbench.openAgentsWindow(target.kind);
		const commands = new QuickAccess(page);
		await commands.runCommand('workbench.action.chat.manage');
		const settings = page.getByRole('dialog', { name: host === 'Workbench' ? 'Ash Settings' : 'Sessions Settings', exact: true });
		await expect(settings).toBeVisible();
		const catalog = settings.locator('.ash-chat-models-catalog');
		const modelNames = catalog.locator('.ash-models-settings-model-copy > span');
		await expect(modelNames.first()).toBeVisible();
		const overview = await modelNames.allTextContents();
		const expand = catalog.getByRole('button', { name: 'viewall models', exact: true });
		await expand.press('Enter');
		const providers = catalog.locator('.ash-chat-models-provider');
		await expect(providers.nth(1)).toBeVisible();
		const providerCount = await providers.count();
		const provider = providers.first();
		const providerLabel = await provider.getByRole('button').first().innerText();
		const modelName = await modelNames.first().innerText();
		const otherChecked = await providers.nth(1).getByRole('switch').isChecked();
		const search = catalog.getByRole('combobox', { name: 'Search models', exact: true });
		await search.fill(modelName);
		await expect(providers).toHaveCount(1);
		await expect(provider.getByRole('button').first()).toHaveText(providerLabel);
		const groupSwitch = provider.getByRole('switch');
		if (!await groupSwitch.isChecked()) {
			await groupSwitch.press('Space');
			await expect(groupSwitch).not.toHaveAttribute('aria-busy', 'true');
		}
		await groupSwitch.press('Space');
		await expect(groupSwitch).not.toBeChecked();
		await expect(groupSwitch).not.toHaveAttribute('aria-busy', 'true');
		await expect(groupSwitch).toBeFocused();
		await search.fill('');
		await expect(providers).toHaveCount(providerCount);
		await expect(providers.nth(1).getByRole('switch')).toBeChecked({ checked: otherChecked });
		await expect.poll(() => provider.evaluate(element => {
			const states: boolean[] = [];
			for (let row = element.nextElementSibling; row && !row.classList.contains('ash-chat-models-provider'); row = row.nextElementSibling) {
				const input = row.querySelector<HTMLInputElement>('input[role="switch"]');
				if (input) states.push(input.checked);
			}
			return states.length > 1 && states.every(checked => !checked);
		})).toBe(true);
		await groupSwitch.press('Space');
		await expect(groupSwitch).toBeChecked();
		await expect(groupSwitch).not.toHaveAttribute('aria-busy', 'true');
		const filters = catalog.locator('.ash-chat-models-filters');
		await filters.locator('summary').press('Enter');
		await filters.getByRole('button', { name: `@provider:${providerLabel}`, exact: true }).press('Enter');
		await expect(search).toHaveValue(/@provider:/);
		await expect(providers).toHaveCount(1);
		await expect(search).toBeFocused();
		await search.press('Escape');
		await filters.locator('summary').press('Enter');
		await filters.getByRole('button', { name: '@capability:vision', exact: true }).press('Enter');
		await expect(search).toHaveValue('@capability:vision');
		await expect(search).toBeFocused();
		await search.press('Escape');
		const settingsSearch = settings.getByRole('searchbox', { name: 'Search settings', exact: true });
		await settingsSearch.fill(modelName);
		await catalog.getByRole('button', { name: 'Collapse All', exact: true }).press('Enter');
		await expect(modelNames).toHaveCount(0);
		await expect(provider).toBeVisible();
		await settingsSearch.fill('');
		await expect(modelNames.first()).toBeVisible();
		await catalog.getByRole('button', { name: 'Collapse All', exact: true }).press('Enter');
		await expect(providers).toHaveCount(providerCount);
		await expand.press('Enter');
		await expect(providers).toHaveCount(0);
		await expect(modelNames).toHaveText(overview);
		await expect(filters).toBeHidden();
		await expand.press('Enter');
		const themeCommands = workbench.quickaccess;
		for (const theme of ['Ash High Contrast Dark', 'Ash High Contrast Light']) {
			// The Workbench owns theme selection; native Sessions dialogs keep focus in their top layer.
			await page.keyboard.press('Escape');
			await expect(settings).not.toBeVisible();
			await themeCommands.runCommand('workbench.action.selectTheme');
			await themeCommands.search(theme);
			await themeCommands.input.press('Enter');
			await expect(themeCommands.element).toHaveCount(0);
			await commands.runCommand('workbench.action.chat.manage');
			await expect(settings).toBeVisible();
			if (await expand.getAttribute('aria-expanded') === 'false') { await expand.press('Enter'); }
			await search.focus();
			await expect.poll(() => search.locator('..').evaluate(element => {
				const style = getComputedStyle(element);
				return style.borderTopStyle === 'solid' && Number.parseFloat(style.borderTopWidth) > 0;
			})).toBe(true);
			const groupBounds = await provider.boundingBox();
			const buttonBounds = await provider.getByRole('button').first().boundingBox();
			const switchBounds = await groupSwitch.boundingBox();
			expect(buttonBounds!.width).toBeGreaterThan(100);
			expect(buttonBounds!.x + buttonBounds!.width).toBeLessThanOrEqual(switchBounds!.x);
			expect(switchBounds!.x + switchBounds!.width).toBeLessThanOrEqual(groupBounds!.x + groupBounds!.width);
		}
		await test.info().attach(`models-settings-expanded-${host}`, { body: await page.screenshot(), contentType: 'image/png' });
	});
}

test('Models Settings saves enabled choices, preserves keyboard focus and restores Chinese help', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench, restartWorkbench }) => {
	let page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await workbench.settingsEditor.selectGroup('agents');
	await workbench.settingsEditor.selectCategory('models');
	const names = settings.locator('.ash-models-settings-model-copy > span');
	const baseline = defaultVisibleModelNames;
	await expect(names).toHaveText(baseline);
	const gemini = settings.getByRole('switch', { name: 'Show Gemini 3.8 Flash in model picker', exact: true });
	await gemini.focus();
	await gemini.press('Space');
	await expect(gemini).toBeChecked();
	await expect(gemini).not.toHaveAttribute('aria-busy', 'true');
	await expect(gemini).toBeFocused();
	await settings.getByRole('button', { name: 'viewall models', exact: true }).click();
	const search = settings.getByRole('combobox', { name: 'Search models', exact: true });
	await search.fill('Gemini');
	const originalSearchOrder = await names.allTextContents();
	await search.focus();
	await search.press('Alt+F2');
	const accessible = page.getByRole('dialog', { name: 'Accessible View', exact: true });
	const accessibleContent = await accessible.getByRole('textbox').inputValue();
	for (const name of originalSearchOrder) { expect(accessibleContent).toContain(name); }
	expect(accessibleContent).toContain('Enabled');
	await accessible.getByRole('button', { name: 'Close', exact: true }).click();
	await workbench.settingsEditor.selectCategory('general');
	await settings.getByRole('combobox', { name: 'Interface language', exact: true }).click();
	await page.getByRole('option', { name: '简体中文', exact: true }).click();
	({ workbench } = await restartWorkbench());
	page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	const chineseSettings = page.locator('.ash-settings-editor');
	await workbench.settingsEditor.selectGroup('agents');
	await workbench.settingsEditor.selectCategory('models');
	const chineseSearch = chineseSettings.getByRole('combobox', { name: '搜索模型', exact: true });
	await expect(chineseSettings.getByRole('switch', { name: '在模型选择器中显示Gemini 3.8 Flash', exact: true })).toBeChecked();
	await chineseSearch.focus();
	await chineseSearch.press('Alt+F1');
	await expect(page.getByRole('dialog', { name: '无障碍帮助' }).getByRole('textbox')).toHaveValue(/已开启的模型排在前面；各组内部保持目录原序/);
	await page.keyboard.press('Escape');
});

test('Models Settings offers provider creation with compact fields and keyboard navigation', async ({ workbench, target }) => {
	const page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await workbench.settingsEditor.selectGroup('agents');
	await workbench.settingsEditor.selectCategory('models');
	const add = settings.getByRole('button', { name: 'New provider', exact: true });
	await expect(add).toBeVisible();
	const search = settings.getByRole('combobox', { name: 'Search models', exact: true });
	await expect(search).toBeVisible();
	await search.focus();
	await search.press('Alt+F1');
	const searchHelp = page.getByRole('dialog', { name: 'Accessibility Help' });
	await expect(searchHelp.getByRole('textbox')).toHaveValue(/Enabled models appear first[\s\S]*Search models filters the full list/);
	await searchHelp.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(search).toBeFocused();
	const heading = settings.locator('.ash-settings-tree-group-title:has(.ash-models-settings-provider-title)');
	await expect(heading).toContainText('API key');
	await add.focus();
	await add.press('Enter');
	const card = settings.locator('.ash-chat-models-widget').first();
	const name = card.getByRole('textbox', { name: 'Provider name', exact: true });
	await expect(name).toBeFocused();
	await name.fill('Keyboard gateway');
	await name.press('Tab');
	await expect(card.getByRole('textbox', { name: 'Base URL', exact: true })).toBeFocused();
	await page.keyboard.press('Tab');
	if (target.appServerMode === 'required') {
		await expect(card.locator('input[type="password"]')).toBeFocused();
		await page.keyboard.press('Tab');
	} else {
		await expect(card.locator('input[type="password"]')).toBeDisabled();
	}
	await expect(card.getByRole('combobox', { name: 'API format' })).toBeFocused();
	await card.getByRole('button', { name: 'Add model' }).click();
	const model = card.getByRole('textbox', { name: 'Model ID', exact: true });
	await expect(model).toBeFocused();
	await expect(card.getByRole('switch', { name: '1M context' })).toBeVisible();
	const context = card.getByRole('switch', { name: '1M context' });
	await context.locator('..').locator('.ash-switch-track').click();
	await expect(context).toBeChecked();
	await context.press('Space');
	await expect(context).not.toBeChecked();
	await expect(card.getByRole('button', { name: 'Test models', exact: true })).toBeVisible();
	await expect(card.getByRole('spinbutton', { name: 'Context window (tokens)' })).toBeVisible();
	await expect(settings.getByRole('button', { name: /Save API key|Remove API key/ })).toHaveCount(0);
	const bounds = await card.boundingBox();
	const nameBounds = await name.boundingBox();
	expect(bounds).not.toBeNull();
	expect(nameBounds!.x + nameBounds!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
	await model.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help' });
	await expect(help.getByRole('textbox')).toHaveValue(/API keys save when the field loses focus/);
	await help.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(model).toBeFocused();
});

test('Models Settings saves custom model IDs and keys and tests the configured endpoint', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench }) => {
	const requests: { path: string; model?: string; key: string | undefined; }[] = [];
	let rejectDiscovery = false;
	const server = createServer(async (request, response) => {
		if (request.method === 'GET') {
			requests.push({ path: request.url!, key: request.headers.authorization });
			response.writeHead(rejectDiscovery ? 503 : 200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ data: [{ id: 'private-model' }, { id: 'rejected-model' }] }));
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; };
		requests.push({ path: request.url!, model: body.model, key: request.headers.authorization });
		if (body.model === 'rejected-model') { response.writeHead(403); response.end(); return; }
		response.writeHead(200, { 'content-type': 'text/event-stream' });
		response.end('data: {"id":"probe","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"probe","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Test endpoint has no port');
		const page = workbench.page;
		await workbench.settingsEditor.openUserSettingsUI();
		const settings = page.getByRole('dialog', { name: 'Ash Settings' });
		await workbench.settingsEditor.selectGroup('agents');
		await workbench.settingsEditor.selectCategory('models');
		await expect(settings.locator('.ash-models-settings-model-copy > span')).toHaveText(defaultVisibleModelNames);
		const expand = settings.getByRole('button', { name: 'viewall models', exact: true });
		await expand.click();
		await expect(expand).toHaveAttribute('aria-expanded', 'true');
		const rows = settings.locator('.ash-models-settings-model-row');
		const enabledRows = rows.filter({ has: page.locator('[role="switch"][aria-checked="true"]') });
		await expect(enabledRows).toContainText(defaultEnabledModelNames);
		await expect(enabledRows).toHaveCount(defaultEnabledModelNames.length);
		await expect(settings.locator('.ash-models-settings-model-row', { hasText: /^GPT-5\.[1-4]/ })).toHaveCount(0);
		await expect(settings.locator('.ash-models-settings-model-row', { hasText: 'Gemini 3.1 Pro Preview' })).toHaveCount(1);
		await expect(settings.locator('.ash-models-settings-model-row', { hasText: /Gemini 3\.[1-5].*Flash/ })).toHaveCount(0);
		await expand.click();
		await expect(expand).toHaveAttribute('aria-expanded', 'false');
		const search = settings.getByRole('combobox', { name: 'Search models', exact: true });
		await search.fill('openai/gpt-6-astra');
		await expect(rows).toHaveCount(1);
		await expect(rows).toContainText(['GPT-6 Astra']);
		await expect(search).toBeFocused();
		await search.fill('SONNET 5.5');
		await expect(rows).toHaveCount(1);
		await expect(rows).toContainText(['Claude Sonnet 5.5']);
		await search.fill('no-such-model');
		await expect(rows).toHaveCount(0);
		await expect(settings.getByRole('status').filter({ hasText: 'No models found.' })).toBeVisible();
		await expect(settings.locator('.ash-models-settings-api-row').first()).toBeVisible();
		await search.fill('Gemini 3.1 Pro');
		const gemini = rows.getByRole('switch');
		await expect(gemini).not.toBeChecked();
		await gemini.focus();
		await gemini.press('Space');
		await expect(gemini).toBeChecked();
		await search.fill('');
		await expect(rows).toHaveCount(defaultVisibleModelNames.length);
		const builtins = settings.locator('.ash-models-settings-api-row h5');
		await expect(builtins).not.toContainText(['OpenAI-compatible']);
		await settings.getByRole('button', { name: 'New provider', exact: true }).click();
		const card = settings.locator('.ash-chat-models-widget').first();
		await card.getByRole('textbox', { name: 'Provider name', exact: true }).fill('Local test gateway');
		const url = card.getByRole('textbox', { name: 'Base URL', exact: true });
		await url.fill(`http://127.0.0.1:${address.port}/v1`);
		await url.press('Tab');
		const key = card.locator('input[type="password"]');
		await key.fill('isolated-test-key');
		await key.press('Tab');
		await expect(key).toHaveValue('••••••••');
		await card.getByRole('combobox', { name: 'API format' }).click();
		await page.getByRole('option', { name: 'OpenAI Chat Completions', exact: true }).click();
		const testModels = card.getByRole('button', { name: 'Test models', exact: true });
		await testModels.click();
		const table = card.getByRole('table', { name: 'Provider models' });
		const privateRow = table.locator('tr[data-model-id="private-model"]');
		const rejectedRow = table.locator('tr[data-model-id="rejected-model"]');
		await expect(privateRow.locator('.ash-chat-models-test-status')).toHaveClass(/passed/);
		await expect(rejectedRow).toContainText('Model test failed');
		await expect(card.getByRole('status')).toContainText('1 of 2 models passed');
		await expect(page.locator('.ash-notification', { hasText: '1 of 2 models passed' })).toBeVisible();
		expect(requests.filter(request => request.path === '/v1/models')).toHaveLength(1);
		expect(requests.filter(request => request.model).map(request => request.model)).toEqual(['private-model', 'rejected-model']);
		for (const [theme, id] of [['Ash High Contrast Dark', 'ash-high-contrast-dark'], ['Ash High Contrast Light', 'ash-high-contrast-light']]) {
			await workbench.quickaccess.runCommand('workbench.action.selectTheme');
			const themeSearch = page.locator('.ash-quick-pick').getByRole('combobox');
			await themeSearch.fill(theme);
			await themeSearch.press('Enter');
			await expect(page.locator('#app')).toHaveAttribute('data-color-theme', id);
			const statusStyles = await table.locator('.ash-chat-models-test-status').evaluateAll(elements => elements.map(element => {
				const dot = getComputedStyle(element, '::before');
				return { color: dot.backgroundColor, border: dot.borderStyle, width: parseFloat(dot.width) };
			}));
			expect(statusStyles[0]!.color).not.toBe(statusStyles[1]!.color);
			for (const style of statusStyles) {
				expect(style.border).toBe('solid');
				expect(style.width).toBeGreaterThan(0);
			}
			await card.getByRole('button', { name: 'Refresh models', exact: true }).focus();
			await page.keyboard.press('Tab');
			const addModel = card.getByRole('button', { name: 'Add model', exact: true });
			await expect(addModel).toBeFocused();
			await expect(addModel).toHaveCSS('outline-style', 'solid');
			const tableBounds = await table.boundingBox();
			const cardBounds = await card.boundingBox();
			expect(tableBounds!.x + tableBounds!.width).toBeLessThanOrEqual(cardBounds!.x + cardBounds!.width);
		}

		const enabled = privateRow.getByRole('switch', { name: 'Enable private-model', exact: true });
		await expect(enabled).not.toBeChecked();
		await enabled.focus();
		await enabled.press('Space');
		await expect(enabled).toBeChecked();
		await testModels.click();
		await expect(testModels).toBeEnabled();
		expect(requests.filter(request => request.path === '/v1/models')).toHaveLength(1);
		await expect(enabled).toBeChecked();
		await card.getByRole('button', { name: 'Refresh models', exact: true }).click();
		await expect(card.getByRole('status')).toContainText('2 models loaded');
		await expect(enabled).toBeChecked();
		await card.getByRole('button', { name: 'Edit context for private-model', exact: true }).click();
		const context = card.getByRole('switch', { name: '1M context', exact: true });
		await context.focus();
		await context.press('Space');
		await card.getByRole('button', { name: 'Save model', exact: true }).click();
		await expect(privateRow).toContainText('1,000,000 tokens');
		await expect(card.getByRole('button', { name: 'Delete model private-model', exact: true })).toBeVisible();
		await card.getByRole('button', { name: 'Add model', exact: true }).click();
		await card.getByRole('textbox', { name: 'Model ID', exact: true }).fill('manual-model');
		await card.getByRole('textbox', { name: 'Upstream Model ID (optional)', exact: true }).fill('private-model');
		await card.getByRole('spinbutton', { name: 'Context window (tokens)', exact: true }).fill('128000');
		await card.getByRole('button', { name: 'Save model', exact: true }).click();
		const manualRow = table.locator('tr[data-model-id="manual-model"]');
		await expect(manualRow).toContainText('128,000 tokens');
		await expect(manualRow.getByRole('switch')).not.toBeChecked();
		const beforeMappedTest = requests.length;
		await testModels.click();
		await expect(card.getByRole('status')).toContainText('2 of 3 models passed');
		expect(requests.slice(beforeMappedTest).map(request => request.model)).toEqual(['private-model', 'rejected-model', 'private-model']);
		rejectDiscovery = true;
		await card.getByRole('button', { name: 'Refresh models', exact: true }).click();
		await expect(card.getByRole('status')).toContainText('Could not update Local test gateway');
		await expect(table.locator('tbody tr')).toHaveCount(3);
		await expect(page.locator('.ash-notification', { hasText: 'Could not update Local test gateway' })).toBeVisible();
		rejectDiscovery = false;
		await settings.locator('.ash-modal-editor-close').click();
		await expect(settings).not.toBeVisible();
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('agents');
		await workbench.settingsEditor.selectCategory('models');
		await search.fill('Gemini 3.1 Pro');
		await expect(rows.getByRole('switch')).toBeChecked();
		await search.fill('');
		await expect(card.getByRole('textbox', { name: 'Provider name', exact: true })).toHaveValue('Local test gateway');
		await expect(key).toHaveValue('••••••••');
		await expect(enabled).toBeChecked();
		await expect(privateRow).toContainText('1,000,000 tokens');
		await expect(manualRow).toContainText('128,000 tokens');
		await card.getByRole('button', { name: 'Edit context for manual-model', exact: true }).click();
		await expect(card.getByRole('textbox', { name: 'Upstream Model ID (optional)', exact: true })).toHaveValue('private-model');
		await card.getByRole('button', { name: 'Cancel', exact: true }).click();
		await card.getByRole('button', { name: 'Delete model manual-model', exact: true }).click();
		await expect(manualRow).toHaveCount(0);
		await card.getByRole('button', { name: 'Delete model private-model', exact: true }).click();
		await expect(privateRow).toHaveCount(1);
		await expect(enabled).not.toBeChecked();
		await expect(card.getByRole('button', { name: 'Delete model private-model', exact: true })).toHaveCount(0);
		await key.fill('');
		await key.press('Tab');
		await expect(key).toHaveValue('');
		await testModels.click();
		await expect(testModels).toBeEnabled();
		expect(requests.filter(request => request.model).at(-2)?.key).toBeUndefined();
	} finally {
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});


test('Model descriptions retain provider copy after restarting in Chinese', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench, restartWorkbench }) => {
	const openModelCard = async (chinese: boolean): Promise<void> => {
		const page = workbench.page;
		if (!await page.locator('.ash-chat-view-pane').isVisible()) {
			await workbench.quickaccess.runCommand('workbench.action.toggleAuxiliaryBar');
		}
		await page.locator('.ash-chat-view-pane .ash-chat-input-model-action').press('ArrowDown');
		const picker = page.locator('.ash-chat-model-picker');
		const automatic = picker.getByRole('switch', { name: chinese ? '自动' : 'Auto', exact: true });
		if (await automatic.isChecked()) { await automatic.press('Space'); }
		const search = picker.getByRole('combobox');
		await search.fill('GPT-6.1 Sol');
		await search.press('ArrowRight');
		const card = picker.getByRole('region', { name: 'GPT-6.1 Sol', exact: true });
		await expect(card).toBeFocused();
		await expect(card).toHaveText('Latest workhorse model for coding and everyday work.');
		await expect(card.getByRole('switch')).toHaveCount(0);
		await card.press('Escape');
	};
	await openModelCard(false);
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectGroup('agents');
	await workbench.settingsEditor.selectCategory('general');
	const settings = workbench.page.getByRole('dialog', { name: 'Ash Settings' });
	await settings.getByRole('combobox', { name: 'Interface language', exact: true }).click();
	await workbench.page.getByRole('option', { name: '简体中文', exact: true }).click();
	({ workbench } = await restartWorkbench());
	await openModelCard(true);
});


for (const host of ['Workbench', 'Sessions']) {
	test(`${host} model command preserves raw filters and visibility choices survive Desktop restart`, { tag: ['@electron-app-server'] }, async ({ workbench, target, runningApplication }) => {
		await workbench.quickaccess.runCommand('workbench.action.openGlobalKeybindingsFile');
		const editor = workbench.editors.groupAt(0).editor.input;
		await editor.press('ControlOrMeta+A');
		await editor.evaluate((element, source) => {
			const clipboardData = new DataTransfer();
			clipboardData.setData('text/plain', source);
			element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
		}, JSON.stringify([{ key: 'ctrl+alt+y', command: 'workbench.action.chat.manage', args: '@provider:openai @capability:vision' }]));
		await editor.press('ControlOrMeta+S');
		await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'Keyboard Shortcuts (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
		let page = host === 'Workbench' ? workbench.page : await workbench.openAgentsWindow(target.kind);
		await (host === 'Workbench' ? page.getByRole('button', { name: 'Manage', exact: true }) : page.locator('.ash-sessions-activity-bottom button').last()).focus();
		await page.keyboard.press('Control+Alt+Y');
		let settings = page.getByRole('dialog', { name: host === 'Workbench' ? 'Ash Settings' : 'Sessions Settings', exact: true });
		await expect(settings).toBeVisible();
		let catalog = settings.locator('.ash-chat-models-catalog');
		let search = catalog.getByRole('combobox', { name: 'Search models', exact: true });
		await expect(search).toHaveValue('@provider:openai @capability:vision');
		await expect(search).toBeFocused();
		await expect(settings.getByRole('searchbox', { name: 'Search settings', exact: true })).toHaveValue('');
		await search.fill('@pro');
		await search.press('ArrowDown');
		await expect(search).toHaveAttribute('aria-activedescendant', /model-search-/);
		await search.press('Escape');
		await expect(search).toHaveValue('@pro');
		await search.fill('@provider:openai');
		await catalog.getByRole('button', { name: 'viewall models', exact: true }).click();
		await expect(catalog.locator('.ash-chat-models-provider')).toHaveCount(1);
		const rows = catalog.locator('.ash-models-settings-model-row');
		await expect(rows.nth(2)).toBeVisible();
		const chosen = await rows.locator('.ash-models-settings-model-copy > span').allTextContents();
		const names = chosen.slice(-2);
		await catalog.getByRole('checkbox', { name: `Select ${names[0]}`, exact: true }).click();
		await catalog.getByRole('checkbox', { name: `Select ${names[1]}`, exact: true }).click({ modifiers: ['Shift'] });
		await expect(catalog.getByRole('status').filter({ hasText: '2 models selected' })).toBeVisible();
		await catalog.getByRole('button', { name: 'Show selected', exact: true }).click();
		for (const name of names) { await expect(catalog.getByRole('switch', { name: `Show ${name} in model picker`, exact: true })).toBeChecked(); }
		await expect.poll(async () => {
			const settings = JSON.parse((await readUserSettings(page)).content);
			return settings['models.hidden']?.filter((entry: { provider: string; model: string; visible?: boolean; }) => entry.provider === 'openai' && entry.visible === true).length;
		}).toBe(2);
		await expect(catalog.getByRole('button', { name: /^(Pin|Unpin) / })).toHaveCount(0);
		await test.info().attach(`models-selected-visibility-${host}`, { body: await page.screenshot(), contentType: 'image/png' });
		({ workbench } = await runningApplication.reload('quit'));
		page = host === 'Workbench' ? workbench.page : await workbench.openAgentsWindow(target.kind);
		await (host === 'Workbench' ? page.getByRole('button', { name: 'Manage', exact: true }) : page.locator('.ash-sessions-activity-bottom button').last()).focus();
		await page.keyboard.press('Control+Alt+Y');
		settings = page.getByRole('dialog', { name: host === 'Workbench' ? 'Ash Settings' : 'Sessions Settings', exact: true });
		catalog = settings.locator('.ash-chat-models-catalog');
		search = catalog.getByRole('combobox', { name: 'Search models', exact: true });
		await expect(search).toHaveValue('@provider:openai @capability:vision');
		await search.fill('@provider:openai');
		await catalog.getByRole('button', { name: 'viewall models', exact: true }).click();
		for (const name of names) {
			await expect(catalog.getByRole('switch', { name: `Show ${name} in model picker`, exact: true })).toBeChecked();
		}
		await expect(catalog.getByRole('checkbox', { checked: true })).toHaveCount(0);
		await search.fill('');
		await search.press('Escape');
		await expect(settings).toBeHidden();
		if (host === 'Sessions') { await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click(); }
		if (host === 'Workbench' && !await page.locator('.ash-chat-view-pane').isVisible()) { await workbench.quickaccess.runCommand('workbench.action.toggleAuxiliaryBar'); }
		const modelTrigger = page.locator('.ash-chat-input-model-action:visible').first();
		await expect(modelTrigger).toBeVisible();
		await modelTrigger.press('ArrowDown');
		const picker = page.locator('.ash-chat-model-picker');
		await expect(picker).toBeVisible();
		const automatic = picker.getByRole('switch', { name: 'Auto', exact: true });
		await expect(automatic).toBeVisible();
		if (await automatic.isChecked()) { await automatic.press('Space'); }
		await expect(picker.getByRole('tab', { includeHidden: true })).toHaveCount(0);
		await expect(picker.getByRole('menuitemradio').first()).toHaveAccessibleName(chosen[0]);
		for (const name of names) { await expect(picker.getByRole('menuitemradio', { name, exact: true })).toBeVisible(); }
	});
}

for (const host of ['Workbench', 'Sessions']) {
	test(`${host} Models management keeps rows concise and exposes full source and pricing details`, { tag: ['@electron-app-server'] }, async ({ workbench, target }) => {
		const page = host === 'Workbench' ? workbench.page : await workbench.openAgentsWindow(target.kind);
		await new QuickAccess(page).runCommand('workbench.action.chat.manage');
		const settings = page.getByRole('dialog', { name: host === 'Workbench' ? 'Ash Settings' : 'Sessions Settings', exact: true });
		const catalog = settings.locator('.ash-chat-models-catalog');
		await expect(catalog.locator('.ash-models-settings-model-row').first()).toBeVisible();
		await expect(catalog.locator('.ash-models-settings-model-row').filter({ hasText: /Tools|Image input|Agent mode/ })).toHaveCount(0);
		await test.info().attach(`models-overview-${host}`, { body: await page.screenshot({ path: test.info().outputPath(`models-overview-${host}.png`) }), contentType: 'image/png' });
		await catalog.getByRole('button', { name: 'viewall models', exact: true }).click();
		const search = catalog.getByRole('combobox', { name: 'Search models', exact: true });
		await search.fill('@capability:tools');
		const toolModel = catalog.locator('.ash-models-settings-model-row').filter({ has: page.getByRole('switch', { name: 'Show GPT-6.1 Sol in model picker', exact: true }) });
		await expect(toolModel).toBeVisible();
		await expect(toolModel).not.toContainText(/Tools|Image input|Agent mode/);
		await search.fill('@capability:agent');
		await expect(catalog.locator('.ash-models-settings-model-copy > span')).toHaveText(['Muse Spark 1.3']);
		await expect(catalog.locator('.ash-models-settings-model-row')).not.toContainText('Agent mode');
		await search.fill('openai/gpt-5.6-terra');
		await expect(catalog.locator('.ash-models-settings-model-metadata')).toHaveCount(0);
		const modelRow = catalog.locator('.ash-models-settings-model-row');
		await expect(modelRow).not.toContainText(/Tools|Image input|Agent mode|Unknown|Reference prices|Tier:|Source:/);
		const catalogBounds = await catalog.boundingBox();
		const rowBounds = await modelRow.boundingBox();
		expect(rowBounds!.x + rowBounds!.width).toBeLessThanOrEqual(catalogBounds!.x + catalogBounds!.width);
		expect(await modelRow.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

		const modelSwitch = catalog.getByRole('switch', { name: 'Show GPT-5.6 Terra in model picker', exact: true });
		await modelSwitch.focus();
		const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
		await modelSwitch.press(`${modifier}+k`);
		await modelSwitch.press(`${modifier}+i`);
		const hover = page.getByRole('tooltip');
		await expect(hover).toContainText('Tools: Supported; Agent mode: Unknown');
		await expect(hover).toContainText('Image input');
		await expect(hover).toContainText('provider: openai; connection: openai');
		await expect(hover).toContainText('Reference prices (USD per 1M tokens)');
		await expect(hover).toContainText('Tier: default; region: global');
		await expect(hover).toContainText('accelerated-public-2026-09-04');
		await page.keyboard.press('Escape');
		await expect(modelSwitch).toBeFocused();
		await search.focus();
		await search.press('Alt+F2');
		const accessible = page.getByRole('dialog', { name: 'Accessible View', exact: true });
		await expect(accessible.getByRole('textbox')).toHaveValue(/Reference prices[\s\S]*accelerated-public-2026-09-04/);
		await expect(accessible.getByRole('textbox')).toHaveValue(/https:\/\/developers\.openai\.com\/api\/docs\/pricing/);
		await accessible.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(search).toBeFocused();
		await test.info().attach(`models-metadata-${host}`, { body: await page.screenshot({ path: test.info().outputPath(`models-metadata-${host}.png`) }), contentType: 'image/png' });
	});
}

for (const host of ['Workbench', 'Sessions']) {
	test(`${host} Models management configures supported options and keeps keyboard selection and filters`, { tag: ['@electron-app-server'] }, async ({ workbench, target }) => {
		const page = host === 'Workbench' ? workbench.page : await workbench.openAgentsWindow(target.kind);
		await new QuickAccess(page).runCommand('workbench.action.chat.manage');
		const settings = page.getByRole('dialog', { name: host === 'Workbench' ? 'Ash Settings' : 'Sessions Settings', exact: true });
		const catalog = settings.locator('.ash-chat-models-catalog');
		await catalog.getByRole('button', { name: 'viewall models', exact: true }).click();
		const search = catalog.getByRole('combobox', { name: 'Search models', exact: true });
		await search.fill('@provider:openai');
		const selections = catalog.getByRole('checkbox');
		await selections.first().focus();
		await selections.first().press('Shift+ArrowDown');
		await expect(selections.nth(0)).toBeChecked(); await expect(selections.nth(1)).toBeChecked();
		const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
		await selections.nth(1).press(`${modifier}+a`);
		expect(await selections.count()).toBeGreaterThan(2);
		for (const selection of await selections.all()) { await expect(selection).toBeChecked(); }
		await selections.first().press('Shift+F10');
		await page.getByRole('menuitem', { name: 'Hide selected', exact: true }).click();
		for (const modelSwitch of await catalog.getByRole('switch', { name: /^Show / }).all()) { await expect(modelSwitch).not.toBeChecked(); }
		await catalog.getByRole('button', { name: 'Clear selection', exact: true }).click();
		await expect(catalog.getByRole('button', { name: 'Select all results', exact: true })).toBeFocused();
		await expect(catalog.getByRole('button', { name: 'Hide selected', exact: true })).toBeHidden();
		await search.fill('openai/gpt-6.1-sol');
		const modelSwitch = catalog.getByRole('switch', { name: 'Show GPT-6.1 Sol in model picker', exact: true });
		const visible = await modelSwitch.isChecked();
		const filters = catalog.locator('.ash-chat-models-filters');
		await filters.locator('summary').click();
		await filters.getByRole('button', { name: '@capability:vision', exact: true }).click();
		await expect(search).toHaveValue('openai/gpt-6.1-sol @capability:vision');
		await expect(modelSwitch).toBeChecked({ checked: visible });
		await expect(search).toBeFocused();
		const actions = catalog.getByRole('button', { name: 'Actions for GPT-6.1 Sol', exact: true });
		await actions.click();
		await page.getByRole('menuitem', { name: 'Speed', exact: true }).press('ArrowRight');
		await page.getByRole('menuitemcheckbox', { name: 'Fast', exact: true }).click();
		await expect(actions).toBeEnabled();
		await actions.click();
		await page.getByRole('menuitem', { name: 'Speed', exact: true }).press('ArrowRight');
		await expect(page.getByRole('menuitemcheckbox', { name: 'Fast', exact: true })).toHaveAttribute('aria-checked', 'true');
		await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
		await actions.click();
		await page.getByRole('menuitem', { name: 'Context size', exact: true }).press('ArrowRight');
		await expect(page.getByRole('menuitemcheckbox')).toHaveCount(2);
		await page.getByRole('menuitemcheckbox').last().click();
		await expect(actions).toBeEnabled();
		await actions.click();
		await page.getByRole('menuitem', { name: 'Context size', exact: true }).press('ArrowRight');
		await expect(page.getByRole('menuitemcheckbox').last()).toHaveAttribute('aria-checked', 'true');
		await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
		await actions.click();
		await page.getByRole('menuitem', { name: 'Configure provider', exact: true }).click();
		await expect(settings.getByLabel('API key for OpenAI', { exact: true })).toBeFocused();
	});

	test(`${host} Models management retains failed provider catalogs and reveals the matching custom model`, { tag: ['@electron-app-server'] }, async ({ workbench, target }) => {
		let failDiscovery = false;
		const server = createServer((request, response) => {
			if (request.url !== '/v1/models') { response.writeHead(404); response.end(); return; }
			response.writeHead(failDiscovery ? 503 : 200, { 'content-type': 'application/json' });
			response.end(JSON.stringify(failDiscovery ? { error: { message: 'private-fixture-diagnostic' } } : { data: [{ id: 'managed-fixture' }] }));
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		try {
			const address = server.address();
			if (!address || typeof address === 'string') { throw new Error('Fixture has no port'); }
			const page = host === 'Workbench' ? workbench.page : await workbench.openAgentsWindow(target.kind);
			await new QuickAccess(page).runCommand('workbench.action.chat.manage');
			const settings = page.getByRole('dialog', { name: host === 'Workbench' ? 'Ash Settings' : 'Sessions Settings', exact: true });
			await settings.getByRole('button', { name: 'New provider', exact: true }).click();
			const card = settings.locator('.ash-chat-models-widget').first();
			await card.getByRole('textbox', { name: 'Provider name', exact: true }).fill('Managed fixture');
			const url = card.getByRole('textbox', { name: 'Base URL', exact: true });
			await url.fill(`http://127.0.0.1:${address.port}/v1`); await url.press('Tab');
			const key = card.locator('input[type="password"]');
			await key.fill('synthetic-fixture-key'); await key.press('Tab');
			await expect(key).toHaveValue('••••••••');
			await card.getByRole('button', { name: 'Add model', exact: true }).click();
			await card.getByRole('textbox', { name: 'Model ID', exact: true }).fill('managed-fixture');
			await card.getByRole('spinbutton', { name: 'Context window (tokens)', exact: true }).fill('128000');
			await card.getByRole('button', { name: 'Save model', exact: true }).click();
			await card.getByRole('button', { name: 'Refresh models', exact: true }).click();
			await expect(card.getByRole('status')).toContainText(/model/);
			const catalog = settings.locator('.ash-chat-models-catalog');
			await catalog.getByRole('button', { name: 'viewall models', exact: true }).click();
			const search = catalog.getByRole('combobox', { name: 'Search models', exact: true });
			await search.fill('@provider:"Managed fixture"');
			await expect(catalog.getByRole('switch', { name: 'Show managed-fixture in model picker', exact: true })).toBeVisible();
			failDiscovery = true;
			await catalog.getByRole('button', { name: 'Manage Managed fixture', exact: true }).click();
			await page.getByRole('menuitem', { name: 'Refresh models', exact: true }).click();
			await expect(catalog.locator('.ash-models-catalog-connection-status')).toContainText('Previously known models are retained');
			await expect(catalog).not.toContainText('private-fixture-diagnostic');
			await test.info().attach(`models-provider-failure-${host}`, { body: await page.screenshot({ path: test.info().outputPath(`models-provider-failure-${host}.png`) }), contentType: 'image/png' });
			await expect(catalog.getByRole('switch', { name: 'Show managed-fixture in model picker', exact: true })).toBeVisible();
			failDiscovery = false;
			await catalog.getByRole('button', { name: 'Manage Managed fixture', exact: true }).click();
			await page.getByRole('menuitem', { name: 'Refresh models', exact: true }).click();
			await expect(catalog.locator('.ash-models-catalog-connection-status')).toHaveCount(0);
			await search.fill('');
			await expect(catalog.getByRole('switch', { name: 'Show GPT-6.1 Sol in model picker', exact: true })).toBeVisible();
			await search.fill('@provider:"Managed fixture"');
			await catalog.getByRole('button', { name: 'Actions for managed-fixture', exact: true }).click();
			await page.getByRole('menuitem', { name: 'Configure model', exact: true }).click();
			await expect(card.getByRole('spinbutton', { name: 'Context window (tokens)', exact: true })).toBeFocused();
			await expect(card.getByRole('textbox', { name: 'Model ID', exact: true })).toHaveValue('managed-fixture');
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		}
	});
}

for (const host of ['Workbench', 'Sessions']) {
	test(`${host} Chat Input restores its last model and Auto for new chats after Desktop restart`, { tag: ['@electron-app-server'] }, async ({ workbench, target, runningApplication }) => {
		let page = host === 'Workbench' ? workbench.page : await workbench.openAgentsWindow(target.kind);
		const openCode = async (): Promise<void> => {
			if (host === 'Sessions') { await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click(); }
			else if (!await page.locator('.ash-chat-view-pane').isVisible()) { await new QuickAccess(page).runCommand('workbench.action.toggleAuxiliaryBar'); }
		};
		const composer = (): Locator => page.locator(host === 'Workbench' ? '.ash-chat-view-pane .ash-chat:visible' : '.ash-sessions-chat-slot.active:visible .ash-chat');
		const trigger = (): Locator => composer().locator('.ash-chat-input-model-action');
		const newChat = async (): Promise<void> => {
			const previous = await composer().getAttribute('data-untitled-session-id');
			if (host === 'Sessions') { await page.locator('[data-action-id="sessions.newSession"] button').click(); }
			else { await new QuickAccess(page).runCommand('workbench.action.chat.new'); }
			await expect(composer()).toHaveAttribute('data-untitled-session-id', /.+/);
			await expect(composer()).not.toHaveAttribute('data-untitled-session-id', previous!);
		};
		await new QuickAccess(page).runCommand('workbench.action.chat.manage');
		const settings = page.getByRole('dialog', { name: host === 'Workbench' ? 'Ash Settings' : 'Sessions Settings', exact: true });
		await expect(settings.locator('.ash-chat-models-catalog')).toBeVisible();
		await expect(settings.getByRole('textbox', { name: 'Default chat model', exact: true })).toHaveCount(0);
		await expect(settings.locator('[data-settings-item-id="chat.defaultModel"]')).toHaveCount(0);
		const saved = await readUserSettings(page);
		await writeUserSettings(page, JSON.stringify({ ...JSON.parse(saved.content), 'chat.defaultModel': 'openai/gpt-6.1-sol' }), saved.revision);
		await test.info().attach(`models-without-default-${host}`, { body: await page.screenshot({ path: test.info().outputPath(`models-without-default-${host}.png`) }), contentType: 'image/png' });
		await settings.getByRole('combobox', { name: 'Search models', exact: true }).press('Escape');
		await expect(settings).toBeHidden();
		await openCode();
		await trigger().press('ArrowDown');
		let picker = page.getByRole('dialog', { name: 'Choose a chat model', exact: true });
		const automatic = picker.getByRole('switch', { name: 'Auto', exact: true });
		if (await automatic.isChecked()) { await automatic.press('Space'); }
		await picker.getByRole('menuitemradio', { name: 'Claude Sonnet 5.5', exact: true }).click();
		await expect(trigger()).toHaveText('Claude Sonnet 5.5');
		await newChat();
		await expect(trigger()).toHaveText('Claude Sonnet 5.5');
		if (host === 'Sessions') { await page.close(); }
		({ workbench } = await runningApplication.reload('quit'));
		page = host === 'Workbench' ? workbench.page : await workbench.openAgentsWindow(target.kind);
		await openCode();
		await newChat();
		await expect(trigger()).toHaveText('Claude Sonnet 5.5');
		await trigger().press('ArrowDown');
		picker = page.getByRole('dialog', { name: 'Choose a chat model', exact: true });
		await picker.getByRole('switch', { name: 'Auto', exact: true }).press('Space');
		await page.keyboard.press('Escape');
		await expect(trigger()).toHaveText('Auto');
		await newChat();
		await expect(trigger()).toHaveText('Auto');
		if (host === 'Sessions') { await page.close(); }
		({ workbench } = await runningApplication.reload('quit'));
		page = host === 'Workbench' ? workbench.page : await workbench.openAgentsWindow(target.kind);
		await openCode();
		await newChat();
		await expect(trigger()).toHaveText('Auto');
		if (host === 'Sessions') { await page.close(); }
	});
}
