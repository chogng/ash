import { expect, test } from '../../../automation/test.js';
import { createServer } from 'node:http';
import type { ElectronApplication } from '@playwright/test';

interface URLRuleSmokeState { readonly urls: string[]; restore(): void; }
type URLRuleSmokeGlobal = typeof globalThis & { urlRuleSmoke: URLRuleSmokeState };

test('Graphical URL opening rules support suggestions, validation, persistence and Chinese labels', async ({ target, workbench, restartWorkbench }) => {
	test.skip(target.workbenchMode !== 'code', 'Requires Code Settings.');
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
	await workbench.settingsEditor.selectCategory('general');
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

test('URL opener settings suggest built-in IDs and their names', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'required', 'Requires the product JSON language declarations.');
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

test('URL rules open editor links in the Ash browser and default links in the system browser', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'Requires the desktop browser provider.');
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
		await workbench.settingsEditor.selectCategory('general');
		const rules = workbench.page.locator('[data-configuration-key="workbench.externalUriOpeners"]');
		for (const [pattern, id] of [[`${root}/internal`, 'ash.browser.open'], ['*', 'default']]) {
			await rules.getByRole('button', { name: 'Add rule', exact: true }).click();
			const row = rules.locator('.ash-string-map-row').last();
			await row.getByRole('textbox').fill(pattern);
			await row.getByRole('textbox').press('Tab');
			await workbench.page.getByRole('option', { name: new RegExp(`^${id.replaceAll('.', '\\.') } `, 'u') }).click();
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
		await agents.evaluate(url => { window.open(url, '_blank', 'noopener,noreferrer'); }, `${root}/internal?source=agents`);
		const agentBrowser = agents.locator('.ash-browser-editor:visible');
		await expect(agentBrowser).toBeVisible();
		await expect(agentBrowser.getByRole('status')).toHaveText('Configured URL page');
		await expect.poll(views).toEqual([{ url: `${root}/internal?source=agents`, visible: true }]);
		await agents.getByRole('button', { name: 'Close Configured URL page', exact: true }).click();
		await expect.poll(views).toEqual([]);
	} finally {
		await electron.evaluate(() => (globalThis as URLRuleSmokeGlobal).urlRuleSmoke.restore());
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

test('terminal URL rules support mouse, keyboard selection and Chinese command text', async ({ application, target, workbench, restartWorkbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'Requires a running desktop terminal.');
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
		await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', '选择要打开的终端网址');
		await picker.getByRole('combobox').press('Escape');
		await expect(workbench.terminal.activeInstance.locator('.xterm-helper-textarea')).toBeFocused();
		await workbench.quickaccess.runCommand('workbench.action.terminal.openDetectedLink');
		await workbench.quickaccess.select(url);
		const browser = workbench.page.locator('.ash-browser-editor:visible');
		await expect(browser.getByRole('status')).toHaveText('Terminal URL page');
		await browser.getByRole('textbox', { name: 'Browser address' }).press('Alt+F1');
		await expect(workbench.page.locator('.ash-accessible-view-content')).toHaveValue(/将 workbench.externalUriOpeners.*ash.browser.open/u);
		await workbench.page.keyboard.press('Escape');
		await workbench.page.getByRole('button', { name: 'Close Terminal URL page', exact: true }).click();
		await expect.poll(() => (application as ElectronApplication).evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).filter(child => 'webContents' in child).length)).toBe(0);
	} finally {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});
