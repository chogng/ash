import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test as browserTest } from '@playwright/test';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { Workbench } from '../../../automation/workbench.js';
import { Menus } from '../../../automation/menus.js';
import { installMainChannelTestClient } from '../../../automation/mainProcessIpc.js';
import { readUserSettings } from '../../../automation/settings.js';
import type { IBrowserViewInfo } from '../../../../src/ash/platform/browserView/common/browserView.js';

// Native application menus follow OS focus on macOS.
const focusTest = test.extend({ electronWindowMode: process.platform === 'darwin' ? 'active' : undefined });

focusTest('opens an SVG from Agent Window Files in the shared image preview', { tag: ['@electron-app-server'] }, async ({ target, workbench, testWorkspace }) => {
	await writeFile(join(testWorkspace.directory, 'preview.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="green"/></svg>');
	const page = await workbench.openAgentsWindow(target.kind);
	const code = page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true });
	await code.click();
	await new QuickAccess(page).runCommand('workbench.action.agentSessions.newFileTab');
	const files = page.locator('.ash-desktop-auxiliarybar:visible');
	const tree = files.getByRole('tree');
	const file = tree.getByRole('treeitem', { name: 'preview.svg', exact: true });
	await file.dblclick();
	const preview = page.getByRole('dialog', { name: 'Preview preview.svg', exact: true });
	await expect(preview).toHaveClass('ash-image-preview-popup');
	const image = preview.getByRole('img', { name: 'preview.svg', exact: true });
	await expect(image).toBeVisible();
	await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(80);
	await expect(code).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByRole('tab', { name: 'preview.svg', exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(preview).toHaveCount(0);
	await expect(tree).toBeFocused();
});

test('Code Sessions consumes the shared JSON extension for settings completion, hover, formatting and diagnostics', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await installMainChannelTestClient(page);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	const commands = new QuickAccess(page);
	await commands.runCommand('workbench.action.openSettingsJson');
	const content = page.locator('[data-part="editor"] .ash-editor-group:visible > .ash-editor-group-content');
	const editor = new Editor(content);
	const replace = async (text: string): Promise<void> => {
		await editor.input.press('ControlOrMeta+A');
		await editor.input.evaluate((element, text) => {
			const clipboardData = new DataTransfer();
			clipboardData.setData('text/plain', text);
			element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
		}, text);
	};
	await replace('{\n// shared JSON extension\n/* 💡 */ "editor.fo",\n}');
	await editor.input.press('ControlOrMeta+Home');
	await editor.input.press('ArrowDown');
	await editor.input.press('ArrowDown');
	await editor.input.press('End');
	await editor.input.press('ArrowLeft');
	await editor.input.press('ArrowLeft');
	await editor.input.press(process.platform === 'darwin' ? 'Control+Space' : 'ControlOrMeta+Space');
	await page.locator('.stanza-editor-completion-option').filter({ has: page.locator('.stanza-editor-completion-label').getByText('editor.fontSize', { exact: true }) }).click();
	await commands.runCommand('editor.action.formatDocument');
	await editor.input.press('ControlOrMeta+S');
	await expect.poll(async () => (await readUserSettings(page)).content).toMatch(/\n\s+(?:\/\* 💡 \*\/\s*)?"editor.fontSize"\s*:\s*\d+/u);
	expect((await readUserSettings(page)).content).toContain('// shared JSON extension');
	expect((await readUserSettings(page)).content).toContain('/* 💡 */');
	await replace('{ "editor.fontSize": "invalid" }');
	await expect(editor.element.locator('.squiggly-warning')).not.toHaveCount(0);
	await replace('{// shared JSON extension\n"editor.fontSize":19,}');
	await expect(editor.element.locator('.squiggly-warning, .squiggly-error')).toHaveCount(0);
	await editor.input.press('ControlOrMeta+S');
	await expect.poll(async () => (await readUserSettings(page)).content).toContain('"editor.fontSize":19');
	await editor.element.getByText('"editor.fontSize"', { exact: true }).hover();
	await expect(page.locator('.stanza-editor-hover:visible')).toContainText('Set the editor text size in pixels');
});


test.extend({ openWorkspace: false })('Code offers New Session from Pull Request in the Chinese Command Palette', { tag: ['@electron-app-server'] }, async ({ target, workbench, restartWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ workbench } = await restartWorkbench());
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: '代码', exact: true }).click();
	const commands = new QuickAccess(page);
	await commands.open('>sessions.newSessionFromPullRequest');
	await expect(commands.items.filter({ hasText: '从拉取请求新建会话' })).toHaveCount(1);
	await commands.close();
});

for (const locale of ['en', 'zh-CN']) {
	test(`Sessions browser tabs support keyboard selection, reload and Main cleanup in ${locale}`, { tag: ['@electron-ui', '@electron-app-server'] }, async ({ target, workbench, restartWorkbench }) => {
		if (locale === 'zh-CN') {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
			await language.fill('简体中文');
			await language.press('Enter');
			({ workbench } = await restartWorkbench());
		}
		const copy = locale === 'zh-CN'
			? { code: '代码', browser: '浏览器', tabs: '浏览器标签页', newTab: '打开新的浏览器标签页', openAddress: '打开地址…', history: '历史记录' }
			: { code: 'Code', browser: 'Browser', tabs: 'Browser tabs', newTab: 'Open new browser tab', openAddress: 'Open Address…', history: 'History' };
		const page = await workbench.openAgentsWindow(target.kind);
		await page.locator('.ash-window-mode-control').getByRole('button', { name: copy.code, exact: true }).click();
		await installMainChannelTestClient(page);
		const commands = new QuickAccess(page);
		const tabs = page.getByRole('tab', { name: copy.browser, exact: true });
		const readPages = () => page.evaluate(() => globalThis.ashTestMainProcess.call<readonly IBrowserViewInfo[]>('browserView', 'getBrowserViews', []));
		await commands.runCommand('workbench.action.browser.open');
		await expect(tabs).toHaveCount(1);
		const browser = page.locator('[data-editor-tool="browser"]');
		const titleTabs = page.locator('[data-part="titlebar"]').getByRole('tab', { name: copy.browser, exact: true });
		await expect(titleTabs).toHaveCount(1);
		await expect(browser.getByRole('tab', { name: copy.browser, exact: true })).toHaveCount(0);
		const toolbar = browser.locator('.ash-editor-group-header > .ash-editor-pane-toolbar-host .ash-browser-toolbar');
		const address = toolbar.getByRole('textbox', { name: locale === 'zh-CN' ? '浏览器地址' : 'Browser address', exact: true });
		await expect(address).toBeVisible();
		await expect(address).toHaveAccessibleDescription(locale === 'zh-CN' ? /打开浏览器帮助/ : /for browser help/);
		const firstAddress = (await address.elementHandle())!;
		await expect(browser.locator('.ash-browser-editor .ash-browser-toolbar:visible')).toHaveCount(0);
		const blankPage = browser.locator('.ash-browser-welcome');
		const historyButton = blankPage.getByRole('button', { name: copy.history, exact: true });
		await blankPage.getByRole('button', { name: copy.openAddress, exact: true }).focus();
		await page.keyboard.press('Tab');
		await expect(historyButton).toBeFocused();
		await page.keyboard.press('Enter');
		const history = page.getByRole('dialog', { name: copy.history, exact: true });
		await expect(history).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(historyButton).toBeFocused();
		await commands.runCommand('workbench.action.browser.quickOpen');
		const picker = page.getByRole('dialog', { name: copy.tabs, exact: true });
		const search = picker.getByRole('combobox');
		await search.fill(copy.newTab);
		await search.press('Enter');
		await expect(tabs).toHaveCount(2);
		await expect(titleTabs).toHaveCount(2);
		await expect(address).toHaveCount(1);
		await expect.poll(() => firstAddress.evaluate(element => ({
			hosted: !!element.closest('.ash-editor-pane-toolbar-host'),
			visible: element.getClientRects().length > 0,
		}))).toEqual({ hosted: true, visible: false });
		await firstAddress.dispose();
		const ids = (await readPages()).map(view => view.id).sort();
		expect(ids).toHaveLength(2);
		await page.reload();
		await expect(tabs).toHaveCount(2);
		await expect(titleTabs).toHaveCount(2);
		expect((await readPages()).map(view => view.id).sort()).toEqual(ids);
		await commands.runCommand('workbench.action.browser.quickOpen');
		await search.fill('about:blank');
		await expect(picker.getByRole('option')).toHaveCount(3);
		await search.press('Enter');
		await expect(picker).toBeHidden();
		await tabs.last().press('Delete');
		await expect.poll(async () => (await readPages()).length).toBe(1);
		await tabs.press('Delete');
		await expect.poll(async () => (await readPages()).length).toBe(0);
	});
}

test('Code Search runs from the editor group toolbar and restores query focus after help', { tag: ['@electron-app-server'] }, async ({ target, workbench, testWorkspace }) => {
	await writeFile(join(testWorkspace.directory, 'toolbar-search.txt'), 'line before\ncode_search_toolbar_fixture\nline after\n');
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await new QuickAccess(page).runCommand('search.action.openNewEditor');
	const search = page.locator('[data-editor-tool="search"]');
	const toolbar = search.locator('.ash-editor-group-header > .ash-editor-pane-toolbar-host');
	const query = toolbar.getByRole('textbox', { name: 'Search editor query', exact: true });
	await expect(query).toBeVisible();
	await expect(search.locator('.ash-search-editor .ash-search-editor-form:visible')).toHaveCount(0);
	const details = toolbar.getByRole('button', { name: 'Toggle Search Details', exact: true });
	await expect(details).toHaveAttribute('aria-expanded', 'false');
	await details.click();
	await expect(details).toHaveAttribute('aria-expanded', 'true');
	await toolbar.getByRole('spinbutton', { name: 'Context lines', exact: true }).fill('1');
	await toolbar.getByRole('textbox', { name: 'Files to include', exact: true }).fill('toolbar-search.txt');
	await query.fill('code_search_toolbar_fixture');
	await query.press('ControlOrMeta+Enter');
	await expect(search.locator('.ash-search-editor-status')).toHaveText(/1 result/);
	await expect(search.locator('.ash-search-editor-results')).toContainText('toolbar-search.txt');
	await expect(search.locator('.ash-search-editor-results')).toContainText('line before');
	await expect(search.locator('.ash-search-editor-results')).toContainText('line after');
	await expect(search.locator('.ash-search-editor-match')).toHaveText('code_search_toolbar_fixture');
	await expect(search.locator('.ash-search-editor-results')).not.toContainText('# Search:');
	await query.press('Alt+F1');
	await expect(page.getByRole('dialog').getByRole('textbox')).toHaveValue(/search editor[\s\S]*\.code-search/);
	await page.keyboard.press('Escape');
	await expect(query).toBeFocused();
});

test('Code Sessions runs Quick Diff commands through its editor services', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	const commands = new QuickAccess(page);
	await commands.runCommand('workbench.action.files.newUntitledFile');
	const content = page.locator('[data-part="editor"] .ash-editor-group:visible > .ash-editor-group-content');
	const editor = new Editor(content);
	const status = editor.element.locator('.stanza-editor-accessibility-status');
	const peek = content.locator('.ash-quick-diff-peek');
	await editor.waitForEditorFocus();
	await commands.runCommand('scm.quickDiff.next');
	await expect(status).toHaveText('No Quick Diff changes');
	await expect(peek).toHaveCount(0);
	await editor.waitForEditorFocus();
	await commands.runCommand('scm.quickDiff.previous');
	await expect(status).toHaveText('No Quick Diff changes');
	await commands.runCommand('scm.quickDiff.close');
	await expect(peek).toHaveCount(0);
});

test('Code Sessions starts with dialog dependencies and confirms closing a dirty editor', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	const commands = new QuickAccess(page);
	await commands.runCommand('workbench.action.files.newUntitledFile');
	const editors = page.locator('[data-part="editor"]');
	const input = editors.locator('.stanza-editor-input');
	await expect(input).toBeVisible();
	await input.focus();
	await input.pressSequentially('Keep this unsaved draft');
	const tab = page.getByRole('tab', { name: /^Untitled-1(?:,|$)/u });
	await tab.press('Delete');
	const dialog = page.getByRole('dialog', { name: 'Save Changes', exact: true });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(tab).toBeVisible();
	await expect(editors.locator('.stanza-editor-line-text').first()).toHaveText('Keep this unsaved draft');
	await tab.press('Delete');
	await dialog.getByRole('button', { name: "Don't Save", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(tab).toHaveCount(0);
});

test('Code sessions restore editor tabs through Back, Forward and reopening without focusing the editor', async ({ application, target, workbench }) => {
	let page = await workbench.openAgentsWindow(target.kind);
	const code = () => page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true });
	const draft = () => page.locator('[data-part="sessions"] .ash-sessions-chat-slot.active[data-conversation-kind="code"] [data-untitled-session-id]');
	const firstTab = () => page.getByRole('tab', { name: 'Untitled-1', exact: true });
	const secondTab = () => page.getByRole('tab', { name: 'Untitled-2', exact: true });
	const editorFocus = () => page.locator('[data-editor-tool="files"]:focus-within');
	await code().click();
	await expect(code()).toHaveAttribute('aria-pressed', 'true');
	await expect(draft().locator('.stanza-editor-input')).toBeFocused();
	const firstDraft = (await draft().getAttribute('data-untitled-session-id'))!;
	const commands = new QuickAccess(page);
	await commands.runCommand('workbench.action.files.newUntitledFile');
	await expect(firstTab()).toBeVisible();
	await page.locator('[data-action-id="sessions.newSession"] button').click();
	await expect(draft()).not.toHaveAttribute('data-untitled-session-id', firstDraft);
	await expect(draft().locator('.stanza-editor-input')).toBeFocused();
	const secondDraft = (await draft().getAttribute('data-untitled-session-id'))!;
	await firstTab().press('Delete');
	await expect(firstTab()).toHaveCount(0);
	await commands.runCommand('workbench.action.files.newUntitledFile');
	await expect(secondTab()).toBeVisible();
	const back = page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Back', exact: true });
	await back.press('Enter');
	await expect(draft()).toHaveAttribute('data-untitled-session-id', firstDraft);
	await expect(firstTab()).toBeVisible();
	await expect(secondTab()).toHaveCount(0);
	await expect(editorFocus()).toHaveCount(0);
	const forward = page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Forward', exact: true });
	await forward.press('Enter');
	await expect(draft()).toHaveAttribute('data-untitled-session-id', secondDraft);
	await expect(secondTab()).toBeVisible();
	await expect(firstTab()).toHaveCount(0);
	await expect(editorFocus()).toHaveCount(0);
	page = await workbench.reopenAgentsWindow(application, page);
	await expect(code()).toHaveAttribute('aria-pressed', 'true');
	await expect(draft()).toHaveAttribute('data-untitled-session-id', secondDraft);
	await expect(secondTab()).toBeVisible();
});

test('Output does not reveal the Agent Window terminal panel', async ({ application, target, workbench }) => {
	let page = await workbench.openAgentsWindow(target.kind);
	const commands = new QuickAccess(page);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await commands.runCommand('workbench.action.output.show');
	await expect(page.locator('[data-part="panel"]')).toBeHidden();
	await expect(page.locator('[data-part="panel"]').getByRole('tab', { name: 'Output', exact: true, includeHidden: true })).toHaveCount(0);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	await commands.runCommand('workbench.action.output.show');
	await expect(page.locator('[data-part="panel"]')).toBeHidden();
	page = await workbench.reopenAgentsWindow(application, page);
	await expect(page.locator('[data-part="panel"]')).toBeHidden();
});

focusTest('Code connects tool commands to the shared editor groups', async ({ application, target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	const editor = page.locator('[data-part="editor"]');
	const files = editor.locator('.ash-desktop-auxiliarybar');
	const commands = new QuickAccess(page);
	await page.getByRole('button', { name: 'Toggle Side Panel', exact: true, pressed: false }).click();
	await expect(editor).toBeVisible();
	await editor.getByRole('button', { name: 'Open Files', exact: true }).click();
	await expect(files).toBeVisible();
	await commands.runCommand('workbench.action.files.newUntitledFile');
	await expect(page.getByRole('tab', { name: 'Untitled-1', exact: true })).toBeVisible();
	const content = editor.locator('[data-editor-tool="files"] .ash-editor-group:not(.ash-editor-group-locked) > .ash-editor-group-content');
	await expect(content).toBeVisible();
	await commands.runCommand('ash.sessions.toggleDetails');
	await expect(files).toBeHidden();
	await expect(content).toBeVisible();
	await commands.runCommand('ash.sessions.hideEditor');
	await expect(files).toBeVisible();
	await expect(content).toBeHidden();
	await commands.runCommand('ash.sessions.showEditor');
	await expect(content).toBeVisible();
	await commands.runCommand('workbench.agentSessions.action.viewChanges');
	await expect(editor.locator('.ash-sessions-changes-editor')).toBeVisible();
	await expect(editor.locator('.ash-editor-group:visible')).toHaveCount(2);
	await expect(page.locator('[data-code-card], .ash-code-editor-card')).toHaveCount(0);
	if (target.appServerMode === 'required') {
		await commands.runCommand('ash.sessions.togglePanel');
		await expect(page.locator('[data-part="panel"] .xterm')).toBeVisible();
		await page.keyboard.press('Control+' + String.fromCharCode(96));
	}
	await expect(page.locator('[data-part="panel"]')).toBeHidden();
});

test('Code keeps Files open until its tab closes', async ({ application, target, workbench }, testInfo) => {
	let page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	const editor = () => page.locator('[data-part="editor"]');
	const files = () => editor().locator('.ash-desktop-auxiliarybar');
	await new QuickAccess(page).runCommand('workbench.action.agentSessions.newFileTab');
	const header = () => editor().locator('[data-editor-tool=files] .ash-editor-group-header:visible').first();
	await expect(files()).toBeVisible();
	await expect(header()).toHaveCount(0);
	await expect(files().locator('.ash-pane-view-header')).toBeHidden();
	await expect(page.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute('aria-selected', 'true');
	await new QuickAccess(page).runCommand('workbench.action.files.newUntitledFile');
	await expect(page.getByRole('tab', { name: 'Untitled-1', exact: true })).toBeVisible();
	await expect(header()).toBeVisible();
	await new QuickAccess(page).runCommand('workbench.action.closeActiveEditor');
	await expect(page.getByRole('tab', { name: 'Untitled-1', exact: true })).toHaveCount(0);
	await expect(files()).toBeVisible();
	await expect(header()).toHaveCount(0);
	await expect(page.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute('aria-selected', 'true');
	page = await workbench.reopenAgentsWindow(application, page);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await expect(files()).toBeVisible();
	await expect(editor()).toBeVisible();
	await expect(header()).toHaveCount(0);
	await expect(files().locator('.ash-pane-view-header')).toBeHidden();
	await expect(page.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute('aria-selected', 'true');
	await testInfo.attach('code-group-file-navigation', { body: await page.screenshot(), contentType: 'image/png' });
	await new QuickAccess(page).runCommand('workbench.action.closeActiveEditor');
	await expect(editor()).toBeHidden();
	await expect(files()).toBeHidden();
	const toggle = page.getByRole('button', { name: 'Toggle Side Panel', exact: true, pressed: false });
	await toggle.click();
	await expect(page.locator('.ash-sessions-new-tab')).toBeVisible();
	await expect(page.getByRole('tab', { name: 'Files', exact: true })).toHaveCount(0);
	await expect(files()).toBeHidden();
});

test.describe('Sessions from an Electron Workbench', () => {
	test.skip(({ target }) => target.kind === 'browser', 'The browser Sessions page has its own launch test below.');

	test('Sessions Code reuses Files and retains its Workbench editor across pages', async ({ application, target, workbench, testWorkspace }) => {
		if (target.appServerMode === 'required') {
			await mkdir(join(testWorkspace.directory, 'nested'), { recursive: true });
			await writeFile(join(testWorkspace.directory, 'nested', 'child.ts'), 'export const child = 1;\n');
		}
		const page = await workbench.openAgentsWindow(target.kind);
		const failures: string[] = [];
		page.on('pageerror', error => failures.push(error.message));
		const auxiliary = page.locator('.ash-desktop-auxiliarybar');
		const editors = page.locator('[data-part="editor"]');
		const mode = page.locator('.ash-window-mode-control');
		await expect(auxiliary).toBeHidden();
		await expect(page.getByText('Session details', { exact: true })).toHaveCount(0);
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await new QuickAccess(page).runCommand('workbench.action.agentSessions.newFileTab');
		await expect(auxiliary).toBeVisible();
		await expect(editors).toBeVisible();
		await expect(page.getByRole('tab', { name: 'Files', exact: true })).toBeVisible();
		if (target.appServerMode === 'required' && target.kind === 'electron') {
			const nested = auxiliary.getByRole('treeitem', { name: 'nested', exact: true });
			await nested.click();
			await expect(auxiliary.getByRole('treeitem', { name: /child\.ts$/u })).toBeVisible();
			await new QuickAccess(page).runCommand('sessions.files.action.collapseExplorerFolders');
			await expect(nested).toHaveAttribute('aria-expanded', 'false');
			await expect(auxiliary.getByRole('treeitem', { name: /child\.ts$/u })).toBeHidden();
			await auxiliary.getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
			await expect(editors).toBeVisible();
			const editor = new Editor(editors);
			await editor.waitForEditorFocus();
			await editor.waitForEditorContents(text => text === 'const value = 1;\n');
			await page.keyboard.press('ControlOrMeta+A');
			await page.keyboard.insertText('const value = 42;\n');
			await page.keyboard.press('ControlOrMeta+S');
			await expect.poll(() => readFile(testWorkspace.file, 'utf8')).toBe('const value = 42;\n');
			const input = await editor.input.elementHandle();
			await new QuickAccess(page).runCommand('ash.sessions.toggleDetails');
			await expect(auxiliary).toBeHidden();
			await expect(editors).toBeVisible();
			await new QuickAccess(page).runCommand('ash.sessions.toggleDetails');
			await expect(auxiliary).toBeVisible();
			expect(await editor.input.evaluate((element, original) => element === original, input)).toBe(true);
			await mode.getByRole('button', { name: /^Chat/u }).click();
			await expect(auxiliary).toBeHidden();
			await expect(page.locator('.ash-chatgpt-widget')).toBeVisible();
			await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
			await expect(editors).toBeVisible();
			await editor.waitForEditorContents(text => text === 'const value = 42;\n');
			expect(await editor.input.evaluate((element, original) => element === original, input)).toBe(true);
			await input?.dispose();
		} else {
			await mode.getByRole('button', { name: /^Chat/u }).click();
			await expect(auxiliary).toBeHidden();
			await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
			await expect(editors).toBeVisible();
			await expect(auxiliary).toBeVisible();
		}
		expect(failures).toEqual([]);
	});
});

browserTest('Browser Sessions production embedder owns its container and releases both ready and opening instances', { tag: ['@browser-ui'] }, async ({ page }) => {
	browserTest.skip(process.env.ASH_PLAYWRIGHT_SERVER === 'development', 'Exercises exported production assets; development uses the generated Vite host.');
	const failures: string[] = [];
	page.on('pageerror', error => failures.push((error.stack ?? error.message).slice(0, 5000)));
	await page.goto('/browser/sessions/sessions.html');
	await expect(page.locator('[data-action-id="sessions.newSession"] button')).toBeVisible();
	const moduleUrl = await page.evaluate(() => performance.getEntriesByType('resource').find(entry =>
		/\/sessions\.web\.main\.internal-[^/]+\.js$/u.test(entry.name),
	)?.name);
	expect(moduleUrl).toBeTruthy();
	// Production extracts imported CSS into entry stylesheets; the embedder must load them too.
	const stylesheets = await page.locator('link[rel="stylesheet"]').evaluateAll(links => links.map(link => `<link rel="stylesheet" href="${(link as HTMLLinkElement).href}">`).join(''));
	await page.route('**/browser/sessions/embedder.html', route => route.fulfill({
		contentType: 'text/html',
		body: `<!doctype html><html><head>${stylesheets}<style>body { margin: 0; } #sessions-host { position: fixed; inset: 0; }</style></head><body><main id="app">Host content</main><section id="sessions-host"></section></body></html>`,
	}));
	await page.goto('/browser/sessions/embedder.html');
	const mount = async (closeDuringStartup: boolean): Promise<void> => {
		await page.evaluate(async ({ moduleUrl, closeDuringStartup }) => {
			const { create } = await import(moduleUrl!);
			const container = document.getElementById('sessions-host')!;
			const lifetime = create(container, {
				id: 'code-sessions', label: 'Code Sessions', titlebarActionId: 'ash.code.open-sessions', workbenchRelativePath: '../workbench/workbench.html',
			});
			if (closeDuringStartup) {
				const observer = new MutationObserver(() => {
					if (!container.querySelector('.ash-sessions-window')) { return; }
					container.dataset.mounted = 'true';
					observer.disconnect();
				});
				observer.observe(container, { childList: true });
				lifetime.dispose();
			} else {
				document.addEventListener('close-sessions', () => { lifetime.dispose(); lifetime.dispose(); }, { once: true });
			}
		}, { moduleUrl, closeDuringStartup });
	};
	await mount(false);
	const container = page.locator('#sessions-host');
	await expect(container.locator('[data-action-id="sessions.newSession"] button')).toBeVisible();
	await expect(page.locator('#app')).toHaveText('Host content');
	await page.evaluate(() => document.dispatchEvent(new Event('close-sessions')));
	await expect(container).toBeEmpty();
	await mount(true);
	await expect(container).toHaveAttribute('data-mounted', 'true');
	await expect(container).toBeEmpty();
	await expect(page.locator('#app')).toHaveText('Host content');
	expect(failures).toEqual([]);
});

browserTest('Browser Sessions Code shows Files and Changes and retains the selected view across pages and reload', { tag: ['@browser-ui'] }, async ({ page }) => {
	const failures: string[] = [];
	page.on('pageerror', error => failures.push(error.message));
	await page.goto('/browser/sessions/sessions.html');
	const auxiliary = page.locator('.ash-desktop-auxiliarybar');
	const tabs = page.getByRole('tablist').filter({ has: page.getByRole('tab', { name: 'Files', exact: true }) });
	await expect(auxiliary).toBeHidden();
	await expect(page.getByText('Session details', { exact: true })).toHaveCount(0);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await new QuickAccess(page).runCommand('workbench.action.agentSessions.newFileTab');
	await expect(page.locator('[data-part="editor"]')).toBeVisible();
	await expect(tabs.getByRole('tab', { name: 'Files', exact: true })).toBeVisible();
	await expect(auxiliary.getByRole('status')).toHaveText('Open a folder to browse files.');
	await expect(auxiliary.locator('[data-view-id="ash.explorer"]')).toBeVisible();
	const emptyMessage = auxiliary.getByRole('status');
	expect(parseFloat(await emptyMessage.evaluate(element => getComputedStyle(element).fontSize))).toBeGreaterThan(0);
	await page.keyboard.press('ControlOrMeta+Shift+E');
	await expect(auxiliary.getByRole('tree')).toBeFocused();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Files and Changes are separate tabs in the same editor group/u);
	await page.keyboard.press('Escape');
	await expect(auxiliary.getByRole('tree')).toBeFocused();
	// This empty, disconnected embedder uses the host's bootstrap palette.
	// Installed extension themes are covered by the connected theme scenarios.
	for (const [scheme, colorScheme, forcedColors] of [
		['light', 'light', 'none'], ['dark', 'dark', 'none'],
		['hcDark', 'dark', 'active'], ['hcLight', 'light', 'active'],
	] as const) {
		await page.emulateMedia({ colorScheme, forcedColors });
		await page.goto('/browser/workbench/workbench.html');
		await new Workbench(page).waitForReady();
		await expect(page.locator('#app')).toHaveAttribute('data-color-scheme', scheme);
		await page.goto('/browser/sessions/sessions.html');
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await new QuickAccess(page).runCommand('workbench.action.agentSessions.newFileTab');
		await expect(page.locator('#app')).toHaveAttribute('data-color-scheme', scheme);
		const colors = await emptyMessage.evaluate(element => ({
			text: getComputedStyle(element).color,
			background: getComputedStyle(element.closest('.ash-desktop-auxiliarybar')!).backgroundColor,
		}));
		expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
		expect(colors.text).not.toBe(colors.background);
	}
	await page.locator('[data-action-id="sessions.newSession"] button').click();
	await new QuickAccess(page).runCommand('workbench.action.agentSessions.newFileTab');
	await new QuickAccess(page).runCommand('workbench.agentSessions.action.viewChanges');
	const comparison = page.locator('.ash-sessions-changes-editor');
	await expect(comparison.getByRole('status')).toHaveText('Changes appear after the agent edits files.');
	await comparison.focus();
	await page.keyboard.press('Alt+F2');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Changes appear after the agent edits files\./u);
	await page.keyboard.press('Escape');
	await expect(comparison).toBeFocused();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	await expect(auxiliary).toBeHidden();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await expect(tabs.getByRole('tab', { name: 'Changes', exact: true })).toHaveAttribute('aria-selected', 'true');
	await page.setViewportSize({ width: 1_000, height: 760 });
	await expect(auxiliary).toBeHidden();
	await page.reload();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await expect(tabs.getByRole('tab', { name: 'Changes', exact: true })).toHaveAttribute('aria-selected', 'true');
	expect(failures).toEqual([]);
});

test('Dragging onto Add Tab moves an editor to the end of the Code tab strip', { tag: ['@browser-ui', '@electron-ui'] }, async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	const commands = new QuickAccess(page);
	await commands.runCommand('workbench.action.files.newUntitledFile');
	await commands.runCommand('workbench.action.files.newUntitledFile');
	const strip = page.locator('.ash-editor-tab-strip').filter({ has: page.getByRole('tab', { name: 'Untitled-1', exact: true }) });
	const tabs = strip.getByRole('tab');
	const addTab = strip.getByRole('button', { name: 'Add Tab', exact: true });
	const addTabToolbar = strip.getByRole('toolbar', { name: 'Add Tab', exact: true });
	await expect(tabs).toHaveText(['Untitled-1', 'Untitled-2']);
	await expect(addTab).toBeVisible();
	const source = await tabs.first().boundingBox();
	const destination = await addTab.boundingBox();
	if (!source || !destination) throw new Error('Editor tab and Add Tab button must be visible to drag');
	const startX = source.x + source.width / 2;
	const startY = source.y + source.height / 2;
	const endX = destination.x + destination.width / 2;
	const endY = destination.y + destination.height / 2;
	await page.mouse.move(startX, startY);
	await page.mouse.down();
	let marker = 'none';
	try {
		await page.mouse.move(endX, endY, { steps: 12 });
		await page.mouse.move(endX + 1, endY);
		marker = await addTabToolbar.evaluate(element => getComputedStyle(element, '::before').content);
	} finally {
		await page.mouse.up();
	}
	await expect(tabs).toHaveText(['Untitled-2', 'Untitled-1']);
	expect(marker).toBe('""');
	await expect(addTabToolbar).not.toHaveClass(/ash-dnd-drop-before/u);
	await addTab.click({ button: 'right' });
	await expect(page.getByRole('menuitem', { name: 'Open Files', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await addTab.drop({ files: { name: 'dropped.txt', mimeType: 'text/plain', buffer: Buffer.from('Dropped editor contents') } });
	await expect(tabs).toHaveText(['Untitled-2', 'Untitled-1', 'dropped.txt']);
	await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
});

test('The empty Code editor area opens a picked file or a URL', { tag: ['@electron-app-server'] }, async ({ target, workbench, testWorkspace }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	const toggle = page.getByRole('button', { name: 'Toggle Side Panel', exact: true });
	await toggle.press('Enter');
	const empty = page.locator('.ash-sessions-new-tab');
	const files = page.getByRole('tab', { name: 'Files', exact: true });
	const search = empty.getByRole('textbox', { name: 'Search files or enter a URL', exact: true });
	const newTab = page.getByRole('tab', { name: 'New Tab', exact: true });
	await expect(newTab).toHaveAttribute('aria-selected', 'true');
	await expect(files).toHaveCount(0);
	await expect(search).toBeFocused();
	await expect(page.getByRole('button', { name: 'Open Changes', exact: true })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('empty-editor-area.png') });
	await search.fill(testWorkspace.file);
	await search.press('Enter');
	const picker = new QuickAccess(page);
	const file = picker.element.locator('.ash-quick-pick-row-label', { hasText: /^main\.ts$/u });
	await expect(file).toBeVisible();
	await picker.close();
	await expect(newTab).toHaveAttribute('aria-selected', 'true');
	await search.press('Enter');
	await expect(file).toBeVisible();
	await picker.input.press('Enter');
	await expect(page.getByRole('tab', { name: 'main.ts', exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(empty).toBeHidden();
	await expect(files).toHaveCount(0);
	await new QuickAccess(page).runCommand('workbench.action.closeActiveEditor');
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await toggle.press('Enter');
	await search.fill('about:blank');
	await search.press('Enter');
	await expect(page.locator('[data-editor-tool="browser"] .ash-browser-welcome')).toBeVisible();
	await expect(files).toHaveCount(0);
});

test('Files, Changes and a document share one editor group', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	const editor = page.locator('[data-part="editor"]');
	const commands = new QuickAccess(page);
	await commands.runCommand('workbench.action.agentSessions.newFileTab');
	await commands.runCommand('workbench.action.files.newUntitledFile');
	const document = editor.getByRole('tabpanel', { name: 'Untitled-1', exact: true });
	await expect(document).toBeVisible();
	await commands.runCommand('workbench.agentSessions.action.viewChanges');
	const review = editor.locator('.ash-sessions-changes-editor');
	await expect(review).toBeVisible();
	await expect(document).toBeHidden();
	await expect(editor.locator('.ash-editor-group:visible')).toHaveCount(1);
	const tabList = page.getByRole('tablist').filter({ has: page.getByRole('tab', { name: /^Changes\b/u }) });
	await expect(tabList.getByRole('tab', { name: 'Files', exact: true })).toBeVisible();
	await tabList.getByRole('tab', { name: 'Untitled-1', exact: true }).click();
	await expect(document).toBeVisible();
	await expect(review).toBeHidden();
	await tabList.getByRole('tab', { name: /^Changes\b/u }).click();
	await expect(review).toBeVisible();
	await testInfo.attach('shared-editor-tabs', { body: await page.screenshot(), contentType: 'image/png' });
});

test('Changes editor exposes diff view modes and review help in Chinese', async ({ target, application, workbench, restartWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ application, workbench } = await restartWorkbench());
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: '代码', exact: true }).click();
	await new QuickAccess(page).runCommand('workbench.agentSessions.action.viewChanges');
	const editor = page.locator('[data-editor-tool="files"]');
	const changesPane = editor.locator('.ash-sessions-changes-editor');
	await expect(changesPane).toBeVisible();
	await expect(editor.getByRole('button', { name: /预览提交/u })).toHaveCount(0);
	await changesPane.focus();
	const moreActions = editor.locator('.ash-editor-title-actions').getByRole('button', { name: '更多操作', exact: true });
	const menus = new Menus(page);
	await menus.select(application, () => moreActions.click(), ['差异视图', '行内']);
	await expect.poll(async () => (await menus.inspect(application, () => moreActions.click(), ['差异视图']))
		.filter(item => item.checked).map(item => item.label)).toEqual(['行内']);
	await changesPane.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/如果“全部更改”或回合更改中有可提交的文件，可以使用“预览提交”/u);
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/更改编辑器[\s\S]*按空格预览并保留列表焦点[\s\S]*“更改”和“文件”是同一编辑器组中的两个标签页[\s\S]*打开“差异视图”/u);
	await page.keyboard.press('Escape');
	await expect(changesPane).toBeFocused();
});
