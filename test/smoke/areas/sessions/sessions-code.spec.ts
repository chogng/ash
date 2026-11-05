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
	await content.locator('.stanza-editor-completion-option').filter({ has: page.locator('.stanza-editor-completion-label').getByText('editor.fontSize', { exact: true }) }).click();
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


test.extend({ openWorkspace: false })('Code offers New Session from Pull Request in the Chinese sidebar and Command Palette', { tag: ['@electron-ui'] }, async ({ target, workbench, restartWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ workbench } = await restartWorkbench());
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: '代码', exact: true }).click();
	const more = page.locator('.ash-sessions-list-more').getByRole('button', { name: '更多会话操作', exact: true });
	await more.press('Enter');
	await expect(page.getByRole('menuitem', { name: '从拉取请求新建会话', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
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
		const blankPage = page.locator('[data-editor-tool="browser"] .ash-browser-welcome');
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
		const ids = (await readPages()).map(view => view.id).sort();
		expect(ids).toHaveLength(2);
		await page.reload();
		await expect(tabs).toHaveCount(2);
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
	const tab = editors.getByRole('tab', { name: /^Untitled-1(?:,|$)/u });
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
	let navigation = page.locator('.ash-sessions-activity-content');
	let editors = page.locator('[data-part="editor"]');
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await page.locator('[data-action-id="sessions.newSession"] button').click();
	const commands = new QuickAccess(page);
	await commands.runCommand('workbench.action.files.newUntitledFile');
	await expect(editors.getByRole('tab', { name: 'Untitled-1', exact: true })).toBeVisible();
	await page.locator('[data-action-id="sessions.newSession"] button').click();
	await editors.getByRole('tab', { name: 'Untitled-1', exact: true }).press('Delete');
	await commands.runCommand('workbench.action.files.newUntitledFile');
	await expect(editors.getByRole('tab', { name: 'Untitled-2', exact: true })).toBeVisible();
	const back = page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Back', exact: true });
	await back.focus();
	await back.press('Enter');
	await expect(editors.getByRole('tab', { name: 'Untitled-1', exact: true })).toBeVisible();
	await expect(editors.getByRole('tab', { name: 'Untitled-2', exact: true })).toHaveCount(0);
	await expect(back).toBeFocused();
	const forward = page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Forward', exact: true });
	await forward.focus();
	await forward.press('Enter');
	await expect(editors.getByRole('tab', { name: 'Untitled-2', exact: true })).toBeVisible();
	await expect(editors.locator(':focus')).toHaveCount(0);
	page = await workbench.reopenAgentsWindow(application, page);
	navigation = page.locator('.ash-sessions-activity-content');
	editors = page.locator('[data-part="editor"]');
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await expect(editors.getByRole('tab', { name: 'Untitled-2', exact: true })).toBeVisible();
});

test('Agent Window never reveals the legacy Output or Terminal Panel', async ({ application, target, workbench }) => {
	let page = await workbench.openAgentsWindow(target.kind);
	const commands = new QuickAccess(page);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await commands.runCommand('workbench.action.output.show');
	await expect(page.locator('[data-part="panel"]')).toHaveCount(0);
	await expect(page.locator('[data-part="panel"] [role="tab"]')).toHaveCount(0);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	await commands.runCommand('workbench.action.output.show');
	await expect(page.locator('[data-part="panel"]')).toHaveCount(0);
	page = await workbench.reopenAgentsWindow(application, page);
	await expect(page.locator('[data-part="panel"]')).toHaveCount(0);
});

focusTest('Code connects tool commands to the shared editor groups', async ({ application, target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	const editor = page.locator('[data-part="editor"]');
	const files = editor.locator('.ash-desktop-auxiliarybar');
	const commands = new QuickAccess(page);
	await expect(editor).toBeVisible();
	await expect(files).toBeVisible();
	await commands.runCommand('workbench.action.files.newUntitledFile');
	const group = editor.locator('.ash-editor-group').filter({ has: page.getByRole('tab', { name: 'Untitled-1', exact: true }) });
	const content = group.locator(':scope > .ash-editor-group-content');
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
		await expect(editor.locator('.ash-terminal-editor')).toBeVisible();
		await page.keyboard.press('Control+' + String.fromCharCode(96));
		await expect(editor.locator('.ash-terminal-editor')).toBeHidden();
	}
	await expect(page.locator('[data-part="panel"]')).toHaveCount(0);
});

test('Code retains group file navigation after closing the last document and reopening', async ({ application, target, workbench }, testInfo) => {
	let page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	const editor = () => page.locator('[data-part="editor"]');
	const files = () => editor().locator('.ash-desktop-auxiliarybar');
	await new QuickAccess(page).runCommand('workbench.action.agentSessions.newFileTab');
	const header = () => editor().locator('[data-editor-tool=files] .ash-editor-group-header:visible').first();
	await expect(files()).toBeVisible();
	await expect(header()).toBeVisible();
	await expect(files().locator('.ash-pane-view-header')).toBeHidden();
	await expect(editor().getByRole('tab')).toHaveCount(0);
	await new QuickAccess(page).runCommand('workbench.action.files.newUntitledFile');
	await expect(editor().getByRole('tab', { name: 'Untitled-1', exact: true })).toBeVisible();
	await expect(header()).toBeVisible();
	await new QuickAccess(page).runCommand('workbench.action.closeActiveEditor');
	await expect(editor().getByRole('tab', { name: 'Untitled-1', exact: true })).toHaveCount(0);
	await expect(files()).toBeVisible();
	await expect(header()).toBeVisible();
	await expect(editor().getByRole('tab')).toHaveCount(0);
	page = await workbench.reopenAgentsWindow(application, page);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await expect(files()).toBeVisible();
	await expect(editor()).toBeVisible();
	await expect(header()).toBeVisible();
	await expect(files().locator('.ash-pane-view-header')).toBeHidden();
	await expect(editor().getByRole('tab')).toHaveCount(0);
	await testInfo.attach('code-group-file-navigation', { body: await page.screenshot(), contentType: 'image/png' });
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
		await expect(auxiliary).toBeVisible();
		await expect(editors).toBeVisible();
		await expect(editors.getByRole('tab', { name: 'Files', exact: true })).toHaveCount(0);
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
			await new QuickAccess(page).runCommand('ash.sessions.toggleFiles');
			await expect(auxiliary).toBeHidden();
			await expect(editors).toBeVisible();
			await new QuickAccess(page).runCommand('ash.sessions.toggleFiles');
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
	const tabs = page.locator('[data-part="editor"] .ash-editor-title-control');
	await expect(auxiliary).toBeHidden();
	await expect(page.getByText('Session details', { exact: true })).toHaveCount(0);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await expect(page.locator('[data-part="editor"]')).toBeVisible();
	await expect(tabs.getByRole('tab', { name: 'Files', exact: true })).toHaveCount(0);
	await expect(auxiliary.getByRole('status')).toHaveText('Open a folder to browse files.');
	await expect(auxiliary.locator('[data-view-id="ash.explorer"]')).toBeVisible();
	const emptyMessage = auxiliary.getByRole('status');
	expect(parseFloat(await emptyMessage.evaluate(element => getComputedStyle(element).fontSize))).toBeGreaterThan(0);
	await page.keyboard.press('ControlOrMeta+Shift+E');
	await expect(auxiliary.getByRole('tree')).toBeFocused();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Files, Changes, Browser and Terminal have independent EditorParts/u);
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
		await expect(page.locator('#app')).toHaveAttribute('data-color-scheme', scheme);
		const colors = await emptyMessage.evaluate(element => ({
			text: getComputedStyle(element).color,
			background: getComputedStyle(element.closest('.ash-desktop-auxiliarybar')!).backgroundColor,
		}));
		expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
		expect(colors.text).not.toBe(colors.background);
	}
	await page.locator('[data-action-id="sessions.newSession"] button').click();
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
	await expect(auxiliary).toBeVisible();
	await page.reload();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await expect(tabs.getByRole('tab', { name: 'Changes', exact: true })).toHaveAttribute('aria-selected', 'true');
	expect(failures).toEqual([]);
});

test('Files and Changes use independent editor Parts and tool maximization restores their layout', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	const editor = page.locator('[data-part="editor"]');
	const files = editor.locator('.ash-desktop-auxiliarybar');
	await expect(files).toBeVisible();
	const commands = new QuickAccess(page);
	await commands.runCommand('workbench.agentSessions.action.viewChanges');
	const review = editor.locator('.ash-sessions-changes-editor');
	await expect(review).toBeVisible();
	const reviewGroup = editor.locator('.ash-editor-group').filter({ has: page.locator('.ash-sessions-changes-editor') });
	const retained = await review.elementHandle();
	await review.getByRole('tree', { name: 'Changes', exact: true }).focus();
	await commands.runCommand('ash.sessions.maximizeTool');
	await expect(editor.locator('.ash-editor-group:visible')).toHaveCount(1);
	await expect(reviewGroup).toBeVisible();
	await commands.runCommand('ash.sessions.maximizeTool');
	await expect(files).toBeVisible();
	await expect(editor.locator('.ash-editor-group:visible')).toHaveCount(2);
	expect(await review.evaluate((node, original) => node === original, retained)).toBe(true);
	await retained?.dispose();
	await expect(page.locator('[data-code-card], .ash-sessions-tool-card')).toHaveCount(0);
	await testInfo.attach('shared-editor-groups', { body: await page.screenshot(), contentType: 'image/png' });
});

test('Changes editor exposes diff view modes and review help in Chinese', async ({ target, application, workbench, restartWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ application, workbench } = await restartWorkbench());
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: '代码', exact: true }).click();
	await page.locator('[data-part="titlebar"]').getByRole('button', { name: '更改', exact: true }).click();
	const editor = page.locator('[data-editor-tool="changes"]');
	const changesPane = editor.locator('.ash-sessions-changes-editor');
	await changesPane.focus();
	const moreActions = editor.locator('.ash-editor-title-actions').getByRole('button', { name: '更多操作', exact: true });
	const menus = new Menus(page);
	await menus.select(application, () => moreActions.click(), ['差异视图', '行内']);
	await expect.poll(async () => (await menus.inspect(application, () => moreActions.click(), ['差异视图']))
		.filter(item => item.checked).map(item => item.label)).toEqual(['行内']);
	await changesPane.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/更改编辑器[\s\S]*“更改”是一张独立工具卡，每个编辑器组都有自己的标题工具栏[\s\S]*预览选中的更改[\s\S]*打开“差异视图”/u);
	await page.keyboard.press('Escape');
	await expect(changesPane).toBeFocused();
});
