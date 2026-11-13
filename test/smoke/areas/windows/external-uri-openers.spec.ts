import { expect, test } from '../../../automation/test.js';
import { Workbench } from '../../../automation/workbench.js';
import { createServer } from 'node:http';
import type { ElectronApplication } from '@playwright/test';

interface URLRuleSmokeState { readonly urls: string[]; restore(): void; }
type URLRuleSmokeGlobal = typeof globalThis & { urlRuleSmoke: URLRuleSmokeState; };

test('Graphical URL opening rules support suggestions, validation, persistence and Chinese labels', async ({ workbench, restartWorkbench }) => {
	const page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	const settings = workbench.settingsEditor.element;
	await settings.getByRole('searchbox').fill('workbench.externalUriOpeners');
	let rules = page.locator('[data-configuration-key="workbench.externalUriOpeners"]');
	await expect(rules).toContainText('URL opening rules');
	await rules.getByRole('button', { name: 'Add rule', exact: true }).click();
	let row = rules.locator('.ash-string-map-row').last();
	await row.getByRole('textbox', { name: 'URL pattern 1', exact: true }).fill('localhost:*');
	await row.getByRole('textbox').press('Tab');
	let opener = row.getByRole('combobox', { name: 'Open with 1', exact: true });
	await expect(opener).toBeFocused();
	await expect(opener).toHaveAttribute('aria-expanded', 'true');
	const ashBrowser = page.getByRole('option', { name: 'ash.browser.open Open in Ash browser', exact: true });
	await opener.press('ArrowDown');
	await expect(ashBrowser).toHaveAttribute('aria-selected', 'true');
	await expect(ashBrowser).toHaveCSS('outline-style', 'solid');
	await opener.press('Enter');
	await expect(opener).toHaveValue('ash.browser.open');
	await expect(rules.locator('.ash-settings-indicators')).toBeHidden();
	await expect(opener).toBeFocused();

	await rules.getByRole('button', { name: 'Add rule', exact: true }).click();
	row = rules.locator('.ash-string-map-row').last();
	await row.getByRole('textbox').fill('localhost:*');
	await row.getByRole('textbox').press('Tab');
	await page.getByRole('option', { name: 'default Open in default browser', exact: true }).click();
	await expect(settings).toContainText('Each URL pattern must be unique.');
	await expect(row.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
	await row.getByRole('textbox').fill('*');
	await row.getByRole('textbox').press('Tab');
	await expect(rules.locator('.ash-settings-indicators')).toBeHidden();

	await rules.getByRole('button', { name: 'Add rule', exact: true }).click();
	row = rules.locator('.ash-string-map-row').last();
	await row.getByRole('textbox').fill('example.test');
	opener = row.getByRole('combobox');
	await opener.fill('uninstalled.viewer');
	await opener.press('Tab');
	await expect(rules.locator('.ash-settings-indicators')).toBeHidden();
	await row.getByRole('button', { name: 'Remove rule 3', exact: true }).click();
	await expect(rules.locator('.ash-string-map-row')).toHaveCount(2);
	await expect(rules.locator('.ash-settings-indicators')).toBeHidden();
	await settings.locator('.ash-modal-editor-close').click();
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	await workbench.editors.groupAt(0).editor.waitForEditorContents(source => JSON.stringify(JSON.parse(source)['workbench.externalUriOpeners']) === JSON.stringify({ 'localhost:*': 'ash.browser.open', '*': 'default' }));

	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = page.getByRole('dialog', { name: 'Select Display Language' });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	({ workbench } = await restartWorkbench());
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectGroup('workbench');
	await workbench.settingsEditor.selectCategory('browser');
	const localLinks = workbench.settingsEditor.element.getByRole('group', { name: '在浏览器中打开 localhost 链接', exact: true });
	await expect(localLinks.getByRole('switch', { name: '在浏览器中打开 localhost 链接', exact: true })).toBeVisible();
	await expect(localLinks).toContainText('关闭后，这些链接默认由系统浏览器打开。');
	await expect(workbench.settingsEditor.element.getByRole('combobox', { name: '新浏览器标签页的位置', exact: true })).toBeVisible();
	rules = workbench.page.locator('[data-configuration-key="workbench.externalUriOpeners"]');
	await expect(rules).toContainText('网址打开规则');
	await expect(rules).toContainText('用方向键选择打开方式，再按 Enter 确认');
	await expect.poll(() => rules.locator('[data-pattern-part="key"]').evaluateAll(elements => elements.map(element => (element as HTMLInputElement).value))).toEqual(['localhost:*', '*']);
	await expect.poll(() => rules.locator('[data-pattern-part="value"]').evaluateAll(elements => elements.map(element => (element as HTMLInputElement).value))).toEqual(['ash.browser.open', 'default']);
	await rules.getByRole('button', { name: '添加规则', exact: true }).click();
	row = rules.locator('.ash-string-map-row').last();
	await row.getByRole('textbox', { name: '网址模式 3', exact: true }).fill('example.test');
	opener = row.getByRole('combobox', { name: '打开方式 3', exact: true });
	await opener.focus();
	await opener.press('Escape');
	await expect(workbench.settingsEditor.element).toBeVisible();
	await expect(opener).toBeFocused();
	await opener.press('ArrowUp');
	await expect(workbench.page.getByRole('option', { name: 'default 在默认浏览器中打开', exact: true })).toHaveAttribute('aria-selected', 'true');
	await opener.press('Escape');
});

test.describe('browser tab placement', () => {
	test.use({ electronUserSettings: { 'workbench.browser.openLocalhostLinks': true, 'workbench.browser.newTabPlacement': 'window' } });

	test('a dedicated window hosts and reuses native browser tabs', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ application, workbench }) => {
		const server = createServer((_request, response) => {
			response.setHeader('Content-Type', 'text/html');
			response.end('<title>Browser placement fixture</title>');
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Missing fixture endpoint');
		const root = `http://127.0.0.1:${address.port}`;
		const electron = application as ElectronApplication;
		try {
			const main = await electron.browserWindow(workbench.page);
			const open = (url: string) => workbench.page.evaluate(url => { window.open(url, '_blank', 'noopener,noreferrer'); }, url);
			const auxiliaryOpened = workbench.page.context().waitForEvent('page');
			await open(`${root}/first`);
			const auxiliary = await auxiliaryOpened;
			const nativeWindow = await electron.browserWindow(auxiliary);
			const browser = auxiliary.locator('.ash-browser-editor:visible');
			await expect(browser.getByRole('status')).toHaveText('Browser placement fixture');
			const nativeUrls = () => nativeWindow.evaluate((window: Electron.BrowserWindow) => window.contentView.children.filter(child => 'webContents' in child).map(child => (child as Electron.WebContentsView).webContents.getURL()));
			await expect.poll(nativeUrls).toEqual([`${root}/first`]);
			await open(`${root}/second`);
			await expect.poll(nativeUrls).toEqual([`${root}/first`, `${root}/second`]);
			await expect(workbench.page.locator('.ash-browser-editor')).toHaveCount(0);
			expect(await main.evaluate((window: Electron.BrowserWindow) => window.contentView.children.filter(child => 'webContents' in child).length)).toBe(0);

			const copyOpened = auxiliary.context().waitForEvent('page');
			await new Workbench(auxiliary).quickaccess.runCommand('workbench.action.copyEditorToNewWindow');
			const copy = await copyOpened;
			const copyWindow = await electron.browserWindow(copy);
			await expect.poll(() => copyWindow.evaluate((window: Electron.BrowserWindow) => window.contentView.children
				.filter(child => 'webContents' in child).map(child => (child as Electron.WebContentsView).webContents.getURL()))).toEqual([`${root}/second`]);
			const copyClosed = copy.waitForEvent('close');
			await copyWindow.evaluate(window => window.close());
			await copyClosed;
			await expect.poll(nativeUrls).toEqual([`${root}/first`, `${root}/second`]);

			const closed = auxiliary.waitForEvent('close');
			await nativeWindow.evaluate(window => window.close());
			await closed;
			await expect.poll(() => electron.evaluate(({ webContents }, origin) => webContents.getAllWebContents().filter(contents => contents.getURL().startsWith(origin)).length, root)).toBe(0);
		} finally {
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
});

test.describe('browser side placement', () => {
	test.use({ electronUserSettings: { 'workbench.browser.openLocalhostLinks': true, 'workbench.browser.newTabPlacement': 'sideGroup' } });

	test('a link from an auxiliary editor opens in a locked side group in that window', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ application, workbench }) => {
		const server = createServer((_request, response) => {
			response.setHeader('Content-Type', 'text/html');
			response.end('<title>Browser side fixture</title>');
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Missing fixture endpoint');
		const url = `http://127.0.0.1:${address.port}/preview`;
		try {
			const main = workbench.page;
			await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
			const opened = main.context().waitForEvent('page');
			await workbench.quickaccess.runCommand('workbench.action.moveEditorToNewWindow');
			const auxiliary = await opened;
			await expect(auxiliary.getByRole('tab', { name: 'Untitled-1' })).toBeVisible();
			await main.evaluate(url => { window.open(url, '_blank', 'noopener,noreferrer'); }, `${url}?main`);
			await expect(main.locator('.ash-browser-editor:visible').getByRole('status')).toHaveText('Browser side fixture');
			await auxiliary.evaluate(url => { window.open(url, '_blank', 'noopener,noreferrer'); }, url);
			await expect(auxiliary.locator('.ash-browser-editor:visible').getByRole('status')).toHaveText('Browser side fixture');
			await expect(auxiliary.getByRole('tab', { name: 'Untitled-1' })).toBeVisible();
			const nativeWindow = await (application as ElectronApplication).browserWindow(auxiliary);
			await expect.poll(() => nativeWindow.evaluate((window: Electron.BrowserWindow) => window.contentView.children
				.filter(child => 'webContents' in child).map(child => (child as Electron.WebContentsView).webContents.getURL()))).toEqual([url]);
			await expect(main.locator('.ash-browser-editor')).toHaveCount(1);
			await main.evaluate(url => { window.open(url, '_blank', 'noopener,noreferrer'); }, `${url}?main-again`);
			await expect(workbench.editors.groups).toHaveCount(2);
			const mainWindow = await (application as ElectronApplication).browserWindow(main);
			await expect.poll(() => mainWindow.evaluate((window: Electron.BrowserWindow) => window.contentView.children
				.filter(child => 'webContents' in child).map(child => (child as Electron.WebContentsView).webContents.getURL()))).toEqual([`${url}?main`, `${url}?main-again`]);
		} finally {
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
});

test('External URL opener rules accept unregistered IDs and persist after reopening', async ({ workbench, reloadWorkbench }) => {
	const rules = { '*.example.test/docs/*': 'example.viewer', '*': 'default' };
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	const group = workbench.editors.groupAt(0);
	const tab = group.tabs.filter({ hasText: 'User Settings (JSON)' });
	await expect(tab).toHaveCount(1);
	await expect(group.editor.input).toBeFocused();
	await group.editor.input.press('ControlOrMeta+A');
	await group.editor.input.evaluate((element, source) => {
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', source);
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	}, JSON.stringify({ 'workbench.externalUriOpeners': rules }));
	await group.editor.waitForEditorContents(source => JSON.stringify(JSON.parse(source)['workbench.externalUriOpeners']) === JSON.stringify(rules));
	await workbench.quickaccess.runCommand('workbench.action.files.save');
	await expect(tab.locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	const { workbench: restarted } = await reloadWorkbench();
	await restarted.quickaccess.runCommand('workbench.action.openSettingsJson');
	await restarted.editors.groupAt(0).editor.waitForEditorContents(source => JSON.stringify(JSON.parse(source)['workbench.externalUriOpeners']) === JSON.stringify(rules));
});

test('URL opener settings suggest built-in IDs and their names', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	const group = workbench.editors.groupAt(0);
	await group.editor.input.press('ControlOrMeta+A');
	await group.editor.input.evaluate(element => {
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', '{"workbench.externalUriOpeners":{"*":""}}');
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	});
	await group.editor.input.press('ArrowLeft');
	await group.editor.input.press('ArrowLeft');
	await group.editor.input.press('ArrowLeft');
	await group.editor.input.press('Control+Space');
	const choices = group.content.locator('.stanza-editor-completion-option');
	await expect(choices.filter({ hasText: 'ash.browser.open' })).toContainText('Open in Ash browser');
	await expect(choices.filter({ hasText: 'default' })).toContainText('Open in default browser');
	await choices.filter({ hasText: 'default' }).click();
	await group.editor.waitForEditorContents(source => JSON.parse(source)['workbench.externalUriOpeners']['*'] === 'default');
	await workbench.quickaccess.runCommand('workbench.action.files.save');
});

test('Local links follow the window default and the user can choose the system browser in Agents', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ application, target, workbench }) => {
	const server = createServer((_request, response) => {
		response.setHeader('Content-Type', 'text/html');
		response.end('<title>Local Browser Fixture</title>');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') { throw new Error('Missing fixture endpoint'); }
	const root = `http://dev.localhost:${address.port}`;
	const electron = application as ElectronApplication;
	await electron.evaluate(({ shell }) => {
		const original = shell.openExternal;
		Object.assign(globalThis, { urlRuleSmoke: { urls: [] as string[], restore: () => { shell.openExternal = original; } } });
		shell.openExternal = async url => { (globalThis as URLRuleSmokeGlobal).urlRuleSmoke.urls.push(url); };
	});
	const openedExternally = () => electron.evaluate(() => (globalThis as URLRuleSmokeGlobal).urlRuleSmoke.urls);
	try {
		await workbench.page.evaluate(url => { window.open(url, '_blank', 'noopener,noreferrer'); }, `${root}/ide`);
		await expect.poll(openedExternally).toEqual([`${root}/ide`]);
		await expect(workbench.page.locator('.ash-browser-editor')).toHaveCount(0);

		const agents = await workbench.openAgentsWindow(target.kind);
		await agents.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		const { quickaccess, settingsEditor } = new Workbench(agents);
		const openLocalLinkSettings = async () => {
			await quickaccess.runCommand('workbench.action.openSettings2');
			const preferences = agents.getByRole('dialog', { name: 'Settings', exact: true });
			await preferences.getByRole('button', { name: 'Browser', exact: true }).click();
			await preferences.getByRole('button', { name: 'Open Browser settings', exact: true }).click();
		};
		const openAgentLink = async (url: string) => {
			await quickaccess.runCommand('workbench.action.url.openUrl');
			const input = agents.getByRole('textbox', { name: 'URL to Open', exact: true });
			await input.fill(url);
			await input.press('Enter');
		};
		const setting = settingsEditor.element.getByRole('group', { name: 'Open localhost links in Browser', exact: true });
		const toggle = setting.getByRole('switch');
		await openLocalLinkSettings();
		await expect(toggle).toBeChecked();
		await settingsEditor.element.locator('.ash-modal-editor-close').click();

		await openAgentLink(`${root}/agents`);
		const browser = agents.locator('.ash-browser-editor:visible');
		await expect.poll(() => electron.evaluate(({ BrowserWindow }) => ({
			external: (globalThis as URLRuleSmokeGlobal).urlRuleSmoke.urls,
			browser: BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).filter(child => 'webContents' in child).map(child => (child as Electron.WebContentsView).webContents.getURL()),
		}))).toEqual({ external: [`${root}/ide`], browser: [`${root}/agents`] });
		await expect(browser.getByRole('status')).toHaveText('Local Browser Fixture');
		await quickaccess.runCommand('workbench.action.browser.closeAll');
		await expect(browser).toHaveCount(0);

		await openLocalLinkSettings();
		await toggle.press('Space');
		await expect(toggle).not.toBeChecked();
		await expect(setting.locator('.ash-settings-indicators')).toBeHidden();

		await openAgentLink(`${root}/disabled`);
		await expect.poll(openedExternally).toEqual([`${root}/ide`, `${root}/disabled`]);
		await expect(browser).toHaveCount(0);
	} finally {
		await electron.evaluate(() => (globalThis as URLRuleSmokeGlobal).urlRuleSmoke.restore());
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

test('URL rules open editor links in the Ash browser and default links in the system browser', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ application, target, workbench }) => {
	const server = createServer((_request, response) => {
		response.setHeader('Content-Type', 'text/html');
		response.end('<title>Configured URL page</title><h1>Opened through URL rules</h1>');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') { throw new Error('Missing fixture endpoint'); }
	const root = `http://127.0.0.1:${address.port}`;
	const electron = application as ElectronApplication;
	await electron.evaluate(({ shell }) => {
		const original = shell.openExternal;
		Object.assign(globalThis, { urlRuleSmoke: { urls: [] as string[], restore: () => { shell.openExternal = original; } } });
		shell.openExternal = async url => { (globalThis as URLRuleSmokeGlobal).urlRuleSmoke.urls.push(url); };
	});
	try {
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('workbench');
		await workbench.settingsEditor.selectCategory('browser');
		const rules = workbench.page.locator('[data-configuration-key="workbench.externalUriOpeners"]');
		for (const [pattern, id] of [[`${root}/internal`, 'ash.browser.open'], ['*', 'default']]) {
			await rules.getByRole('button', { name: 'Add rule', exact: true }).click();
			const row = rules.locator('.ash-string-map-row').last();
			await row.getByRole('textbox').fill(pattern);
			await row.getByRole('textbox').press('Tab');
			await workbench.page.getByRole('option', { name: new RegExp(`^${id.replaceAll('.', '\\.')} `, 'u') }).click();
			await expect(rules.locator('.ash-settings-indicators')).toBeHidden();
		}
		await workbench.settingsEditor.element.locator('.ash-modal-editor-close').click();
		const group = workbench.editors.groupAt(0);
		await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
		await expect(group.tabs.filter({ hasText: 'Untitled-1' })).toHaveAttribute('aria-selected', 'true');
		await group.editor.input.focus();
		await expect(group.editor.input).toBeFocused();
		await workbench.page.keyboard.insertText(`${root}/external`);
		await expect(group.content.locator('.view-line > span > span').filter({ hasText: `${root}/external` }).first()).toBeVisible();
		await workbench.page.keyboard.press('ControlOrMeta+Home');
		await workbench.quickaccess.runCommand('editor.action.openLink');
		await expect.poll(() => electron.evaluate(() => (globalThis as URLRuleSmokeGlobal).urlRuleSmoke.urls)).toEqual([`${root}/external`]);
		await expect(workbench.page.locator('.ash-browser-editor')).toHaveCount(0);
		await group.editor.input.press('ControlOrMeta+A');
		await workbench.page.keyboard.insertText(`${root}/internal?source=editor#topic`);
		await expect(group.content.locator('.view-line > span > span').filter({ hasText: `${root}/internal?source=editor#topic` }).first()).toBeVisible();
		await workbench.page.keyboard.press('ControlOrMeta+Home');
		await workbench.quickaccess.runCommand('editor.action.openLink');
		const browser = workbench.page.locator('.ash-browser-editor:visible');
		await expect(browser.getByRole('status')).toHaveText('Configured URL page');
		const views = () => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).filter(child => 'webContents' in child).map(child => ({ url: (child as Electron.WebContentsView).webContents.getURL(), visible: child.getVisible() })));
		await expect.poll(views).toEqual([{ url: `${root}/internal?source=editor#topic`, visible: true }]);
		await workbench.page.getByRole('button', { name: 'Close Configured URL page', exact: true }).click();
		await expect.poll(views).toEqual([]);
		await expect.poll(() => electron.evaluate(() => (globalThis as URLRuleSmokeGlobal).urlRuleSmoke.urls)).toEqual([`${root}/external`]);

		await workbench.page.evaluate(url => { window.open(url, '_blank', 'noopener,noreferrer'); }, `${root}/internal?source=window`);
		await expect(browser.getByRole('status')).toHaveText('Configured URL page');
		await expect.poll(views).toEqual([{ url: `${root}/internal?source=window`, visible: true }]);
		await workbench.page.getByRole('button', { name: 'Close Configured URL page', exact: true }).click();
		await expect.poll(views).toEqual([]);

		// The dedicated Agents window loads the same desktop provider and browser editor.
		const agents = await workbench.openAgentsWindow(target.kind);
		await agents.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await agents.evaluate(url => { window.open(url, '_blank', 'noopener,noreferrer'); }, `${root}/internal?source=agents`);
		const agentBrowser = agents.locator('.ash-browser-editor:visible');
		await expect(agentBrowser).toBeVisible();
		await expect(agentBrowser.getByRole('status')).toHaveText('Configured URL page');
		await expect.poll(views).toEqual([{ url: `${root}/internal?source=agents`, visible: true }]);
		await new Workbench(agents).quickaccess.runCommand('workbench.action.browser.closeAll');
		await expect.poll(views).toEqual([]);
	} finally {
		await electron.evaluate(() => (globalThis as URLRuleSmokeGlobal).urlRuleSmoke.restore());
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

test('terminal URL rules support mouse, keyboard selection and Chinese command text', { tag: ['@electron-app-server'] }, async ({ application, target, workbench, restartWorkbench }) => {
	const server = createServer((_request, response) => { response.end('<title>Terminal URL page</title>'); });
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') { throw new Error('Missing fixture endpoint'); }
	const url = `http://127.0.0.1:${address.port}/terminal`;
	try {
		await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
		const group = workbench.editors.groupAt(0);
		await group.editor.input.press('ControlOrMeta+A');
		await group.editor.input.evaluate((element, source) => {
			const clipboardData = new DataTransfer();
			clipboardData.setData('text/plain', source);
			element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
		}, JSON.stringify({ 'workbench.externalUriOpeners': { '127.0.0.1:*': 'ash.browser.open', '*': 'default' } }));
		await group.editor.waitForEditorContents(source => JSON.parse(source)['workbench.externalUriOpeners']['*'] === 'default');
		await workbench.quickaccess.runCommand('workbench.action.files.save');
		await expect(group.tabs.filter({ hasText: 'User Settings (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
		await workbench.terminal.show();
		await workbench.terminal.runCommand(`node -e "console.log('${url}')"`);
		const rows = workbench.terminal.activeInstance.locator('.xterm-rows');
		await expect(rows).toContainText(url);
		const linkBounds = await rows.locator('span').filter({ hasText: url }).last().boundingBox();
		if (!linkBounds) { throw new Error('Terminal URL is not visible'); }
		// Xterm handles pointer input on its screen above the text rows.
		const linkX = linkBounds.x + linkBounds.width / 2;
		const linkY = linkBounds.y + linkBounds.height / 2;
		await workbench.page.mouse.move(linkX, linkY);
		await workbench.page.mouse.click(linkX, linkY);
		await expect(workbench.page.locator('.ash-browser-editor:visible').getByRole('status')).toHaveText('Terminal URL page');
		await workbench.page.getByRole('button', { name: 'Close Terminal URL page', exact: true }).click();
		await workbench.quickaccess.runCommand('workbench.action.configureLocale');
		await workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox').fill('简体中文');
		await workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox').press('Enter');
		({ workbench, application } = await restartWorkbench());
		await expect(workbench.terminal.activeInstance).toBeVisible();
		await workbench.terminal.runCommand(`node -e "console.log('${url}')"`);
		await expect(workbench.terminal.activeInstance.locator('.xterm-rows')).toContainText(url);
		await workbench.quickaccess.open('>workbench.action.terminal.openDetectedLink');
		await expect(workbench.quickaccess.items.filter({ hasText: 'workbench.action.terminal.openDetectedLink' })).toContainText('终端：打开检测到的链接');
		await workbench.quickaccess.items.filter({ hasText: 'workbench.action.terminal.openDetectedLink' }).click();
		const picker = workbench.page.getByRole('dialog', { name: '打开终端链接', exact: true });
		await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', '选择要打开的终端文件或网址');
		await picker.getByRole('combobox').press('Escape');
		await expect(workbench.terminal.activeInstance.locator('.xterm-helper-textarea')).toBeFocused();
		await workbench.quickaccess.runCommand('workbench.action.terminal.openDetectedLink');
		await workbench.quickaccess.select(url);
		const browser = workbench.page.locator('.ash-browser-editor:visible');
		await expect(browser.getByRole('status')).toHaveText('Terminal URL page');
		await browser.getByRole('textbox', { name: '浏览器地址', exact: true }).press('Alt+F1');
		await expect(workbench.page.locator('.ash-accessible-view-content')).toHaveValue(/将 workbench.externalUriOpeners.*ash.browser.open/u);
		await workbench.page.keyboard.press('Escape');
		await workbench.page.getByRole('button', { name: '关闭 Terminal URL page', exact: true }).click();
		await expect.poll(() => (application as ElectronApplication).evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).filter(child => 'webContents' in child).length)).toBe(0);
	} finally {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});
