import { expect, test } from '../../../automation/test.js';
import { createServer } from 'node:http';
import type { ElectronApplication } from '@playwright/test';

interface URLRuleSmokeState { readonly urls: string[]; restore(): void; }
type URLRuleSmokeGlobal = typeof globalThis & { urlRuleSmoke: URLRuleSmokeState };

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
		await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
		const group = workbench.editors.groupAt(0);
		await group.editor.input.press('ControlOrMeta+A');
		await group.editor.input.evaluate((element, source) => {
			const clipboardData = new DataTransfer();
			clipboardData.setData('text/plain', source);
			element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
		}, JSON.stringify({ 'workbench.externalUriOpeners': { [`${root}/internal`]: 'ash.browser.open', '*': 'default' } }));
		await group.editor.waitForEditorContents(source => JSON.parse(source)['workbench.externalUriOpeners']['*'] === 'default');
		await workbench.quickaccess.runCommand('workbench.action.files.save');
		await expect(group.tabs.filter({ hasText: 'User Settings (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
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

		// The dedicated Agents window loads the same desktop provider and browser editor.
		const agents = await workbench.openAgentsWindow(target.kind);
		await agents.keyboard.press('F1');
		await agents.locator('.ash-quick-pick').getByRole('combobox').fill('>ash.browser.open');
		await agents.getByRole('option').filter({ hasText: 'ash.browser.open' }).click();
		const agentBrowser = agents.locator('.ash-browser-editor:visible');
		await expect(agentBrowser).toBeVisible();
		await agentBrowser.getByRole('textbox', { name: 'Browser address' }).fill(`${root}/internal`);
		await agentBrowser.getByRole('textbox', { name: 'Browser address' }).press('Enter');
		await expect(agentBrowser.getByRole('status')).toHaveText('Configured URL page');
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
