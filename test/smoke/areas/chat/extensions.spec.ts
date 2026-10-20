import { expect, test, writeEditorExtensionFixture } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

test.beforeEach(async ({ workbench }) => {
	// Fresh profiles restore Welcome after startup services; earlier input can be replaced during restoration.
	await expect(workbench.page.getByRole('tab', { name: 'Welcome', exact: true })).toBeVisible();
});

for (const window of ['Code', 'Agents']) {
	test(`Independent MCP configuration persists across reload and can be removed in ${window}`, { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench }) => {
		const page = window === 'Code' ? workbench.page : await workbench.openAgentsWindow(target.kind);
		const quickaccess = new QuickAccess(page);
		const command = window === 'Code' ? 'ash.extensions.open' : 'workbench.action.chat.configure.skills';
		await quickaccess.runCommand(command);
		let mcp = page.locator('[data-view-id="ash.extensions.mcp"]');
		await mcp.getByRole('button', { name: 'Connections', exact: true }).click();
		const search = mcp.getByRole('searchbox');
		await search.focus();
		await search.press('Alt+F1');
		await expect(page.getByRole('dialog', { name: 'Accessibility Help', exact: true }).getByRole('textbox')).toHaveValue(/Add MCP server/u);
		await page.keyboard.press('Escape');
		await expect(search).toBeFocused();
		await mcp.getByRole('button', { name: 'Add MCP server', exact: true }).click();
		const add = page.getByRole('dialog', { name: 'Add MCP server', exact: true });
		await add.getByRole('button', { name: 'HTTP server', exact: true }).click();
		await add.getByPlaceholder('Server ID', { exact: true }).fill('persistent-test');
		await add.getByPlaceholder('Display name', { exact: true }).fill('Persistent MCP test');
		await add.getByPlaceholder('HTTP or HTTPS server URL', { exact: true }).fill('http://127.0.0.1:9/mcp');
		await add.getByRole('button', { name: 'Save', exact: true }).click();
		let details = page.locator('.ash-extension-editor');
		await expect(details.getByRole('heading', { name: 'Persistent MCP test', exact: true })).toBeVisible();
		await expect(details.getByRole('status')).toHaveText('Disabled');
		await workbench.reloadWindow(page);
		await quickaccess.runCommand(command);
		mcp = page.locator('[data-view-id="ash.extensions.mcp"]');
		const header = mcp.getByRole('button', { name: 'Connections', exact: true });
		if (await header.getAttribute('aria-expanded') !== 'true') { await header.click(); }
		await mcp.getByRole('option').filter({ hasText: 'Persistent MCP test' }).click();
		details = page.locator('.ash-extension-editor');
		await expect(details.getByRole('status')).toHaveText('Disabled');
		await details.getByRole('button', { name: 'Edit MCP server', exact: true }).click();
		const edit = page.getByRole('dialog', { name: 'Edit MCP server', exact: true });
		await edit.getByRole('button', { name: 'HTTP server', exact: true }).click();
		await expect(edit.getByPlaceholder('HTTP or HTTPS server URL', { exact: true })).toHaveValue('http://127.0.0.1:9/mcp');
		await page.keyboard.press('Escape');
		await details.getByRole('button', { name: 'Remove MCP server', exact: true }).click();
		await page.getByRole('dialog', { name: 'Remove MCP server', exact: true }).getByRole('button', { name: 'Remove', exact: true }).click();
		await expect(mcp.getByRole('option').filter({ hasText: 'Persistent MCP test' })).toHaveCount(0);
	});
}

for (const window of ['Code', 'Agents']) {
	test(`Built-in extension details open in the registered Editor in ${window}`, { tag: ['@electron-app-server'] }, async ({ target, workbench }, testInfo) => {
		const page = window === 'Code' ? workbench.page : await workbench.openAgentsWindow(target.kind);
		await new QuickAccess(page).runCommand('ash.extensions.manageBuiltIn');
		const extensions = page.locator('[data-view-id="ash.extensions.view"]');
		for (const id of ['ash.markdown-language-features', 'ash.markdown-math']) {
			await extensions.getByRole('option').filter({ hasText: id }).click();
			// Details inputs retain their panes; only the selected extension is visible.
			const editor = page.locator('.ash-extension-editor:visible');
			await expect(editor.locator('.extension-detail-header h1')).toBeVisible();
			await editor.getByRole('tab', { name: 'Details', exact: true }).click();
			await expect(editor.getByRole('tab', { name: 'Details', exact: true })).toHaveAttribute('aria-selected', 'true');
			await expect(editor.getByRole('complementary', { name: 'Additional information', exact: true }).getByText(id, { exact: true })).toBeVisible();
			await expect(editor).not.toContainText(id.replace('ash.', 'vscode.'));
			await editor.getByRole('tab', { name: 'Features', exact: true }).click();
			await expect(editor.getByRole('tabpanel', { name: 'Features', exact: true })).toBeVisible();
			await expect(editor.getByRole('status')).toHaveText(/^Enabled · (running|starts on demand)$/u);
			if (id === 'ash.markdown-math') {
				await expect(editor.getByRole('tabpanel', { name: 'Features', exact: true })).toContainText('math.render.v2');
			}
			await expect(page.locator('.ash-settings-editor')).toHaveCount(0);
			const screenshot = testInfo.outputPath(`${window}-${id}.png`);
			await editor.screenshot({ path: screenshot });
			await testInfo.attach(`${window}-${id}`, { path: screenshot, contentType: 'image/png' });
		}
	});
}

for (const window of ['Code', 'Agents']) {
	test(`Skills command opens a readonly SKILL.md snapshot from the shared backend in ${window}`, { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench }) => {
		const page = window === 'Code' ? workbench.page : await workbench.openAgentsWindow(target.kind);
		await new QuickAccess(page).runCommand('workbench.action.chat.configure.skills');
		await page.locator('[data-view-id="ash.extensions.skills"]').getByRole('option').filter({ hasText: 'skill-creator' }).click();
		await page.locator('.ash-extension-editor').getByRole('button', { name: 'Open instructions', exact: true }).click();
		await expect(page.getByRole('tab', { name: 'skill-creator/SKILL.md', exact: true })).toBeVisible();
		const editor = page.getByRole('region', { name: 'skill-creator/SKILL.md', exact: true });
		const input = editor.locator('.stanza-editor-input');
		await expect(editor.locator('.view-lines')).toContainText('name: skill-creator');
		await expect(input).toHaveAttribute('aria-readonly', 'true');
		await input.focus();
		await page.keyboard.insertText('forbidden edit');
		await expect(editor.locator('.view-lines')).toContainText('name: skill-creator');
		await expect(editor.locator('.view-lines')).not.toContainText('forbidden edit');
	});
}

test('Skills command opens Extensions with keyboard help and no Settings management', async ({ workbench }) => {
	const page = workbench.page;
	await new QuickAccess(page).runCommand('workbench.action.chat.configure.skills');
	const skills = page.locator('[data-view-id="ash.extensions.skills"]');
	await expect(skills).toBeVisible();
	await expect(page.locator('.ash-settings-editor')).toHaveCount(0);
	await expect(skills.getByRole('button', { name: 'Skills', exact: true })).toHaveAttribute('aria-expanded', 'true');
	const recommended = page.locator('[data-view-id="ash.extensions.recommended"]');
	await recommended.getByRole('button', { name: 'Recommended', exact: true }).click();
	await expect(recommended.getByRole('status')).toContainText('0 items');
	const search = skills.getByRole('searchbox');
	await search.focus();
	await search.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/collapsible Extensions, Installed Extensions, Skills, Connections and Recommended panes/u);
	await page.keyboard.press('Escape');
	await expect(search).toBeFocused();
});

test('Skills configuration command opens Extensions in the Agents window', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await new QuickAccess(page).runCommand('workbench.action.chat.configure.skills');
	const skills = page.locator('[data-view-id="ash.extensions.skills"]');
	await expect(skills).toBeVisible();
	await expect(skills.getByRole('button', { name: 'Skills', exact: true })).toHaveAttribute('aria-expanded', 'true');
	await expect(page.locator('.ash-sessions-settings-dialog')).toHaveCount(0);
	const recommended = page.locator('[data-view-id="ash.extensions.recommended"]');
	await recommended.getByRole('button', { name: 'Recommended', exact: true }).click();
	await expect(recommended.getByRole('status')).toContainText('0 items');
});

test('Skill enablement updates Chat completion and survives a window reload', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench }) => {
	let page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.chat.configure.skills');
	let skills = page.locator('.ash-extension-editor');
	const list = page.locator('[data-view-id="ash.extensions.skills"]').getByRole('listbox');
	await list.getByRole('option').filter({ hasText: 'skill-creator' }).click();
	await skills.getByRole('button', { name: 'Disable skill', exact: true }).click();
	await expect(skills.getByRole('button', { name: 'Enable skill', exact: true })).toBeEnabled();
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	let editor = page.locator('.ash-chat-input-editor');
	await editor.locator('.stanza-editor-input').focus();
	await page.keyboard.insertText('$');
	await page.keyboard.press('Control+Space');
	await expect(editor.getByRole('option', { name: /^\$create-instructions /u })).toBeVisible();
	await expect(editor.getByRole('option', { name: /^\$skill-creator /u })).toHaveCount(0);
	await page.reload();
	await expect(page.getByRole('tab', { name: 'Welcome', exact: true })).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.chat.configure.skills');
	skills = page.locator('.ash-extension-editor');
	const restored = page.locator('[data-view-id="ash.extensions.skills"]').getByRole('listbox');
	await expect(restored.getByRole('option').filter({ hasText: 'skill-creator' })).toContainText('Disabled');
	await restored.getByRole('option').filter({ hasText: 'skill-creator' }).click();
	await skills.getByRole('button', { name: 'Enable skill', exact: true }).click();
	await expect(skills.getByRole('button', { name: 'Disable skill', exact: true })).toBeEnabled();
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	editor = page.locator('.ash-chat-input-editor');
	await editor.locator('.stanza-editor-input').focus();
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.insertText('$');
	await page.keyboard.press('Control+Space');
	await expect(editor.getByRole('option', { name: /^\$skill-creator /u })).toBeVisible();
});

test('Extensions view tab uses the extensions icon', async ({ workbench }) => {
	const page = workbench.page;
	if (!await page.getByRole('region', { name: 'Primary sidebar' }).isVisible()) {
		await page.getByRole('button', { name: 'Show Primary Side Bar', exact: true }).click();
	}
	const extensionManagementTab = page.getByRole('tab', { name: 'Extensions', exact: true });
	await expect(extensionManagementTab.locator('svg[data-ash-icon-id="extensions"]')).toBeVisible();
	await extensionManagementTab.click();
	const extensions = page.locator('[data-view-id="ash.extensions.view"] .ash-extensions');
	await expect(extensions).toBeVisible();
	await expect(extensionManagementTab).toHaveAttribute('aria-selected', 'true');
	const search = extensions.getByRole('searchbox', { name: 'Search Extensions', exact: true });
	await search.focus();
	await search.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/Enable or Disable.*whole editor extension.*scripts, themes, syntax and snippets/u);
	await expect(help.getByRole('textbox')).toHaveValue(/Execution authorization and permissions are reviewed separately in details/u);
	await expect(help.getByRole('textbox')).toHaveValue(/Install extension from Git repository.*repository revision and package directory/u);
	await page.keyboard.press('Escape');
	await expect(search).toBeFocused();
});

test('Local standard extension installs, runs only after grant, survives restart and retires on revoke', { tag: ['@electron-app-server', '@darwin'] }, async ({ target, testWorkspace, application, workbench, reloadWorkbench }) => {
	test.setTimeout(90_000);
	const root = join(testWorkspace.directory, 'standard-extension');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({
		schemaVersion: 1, id: 'acme/standard-smoke', version: '1.0.0', displayName: 'Standard extension smoke',
		compatibility: { ash: '>=0.1.0' },
		contributions: {
			editorExtensions: [{
				id: 'inspect', runtime: 'javascript', api: 'ash', entrypoint: 'extension.js', runtimeApiVersion: 1,
				activationEvents: [{ type: 'onCommand', id: 'acme.standardSmoke.inspect' }], capabilities: ['command']
			}]
		},
		permissions: [{ type: 'directory', access: 'read' }],
	}));
	await writeEditorExtensionFixture(root, `
const ash = require('@ash/sdk'); const { commands, window } = ash;
exports.activate = function(context) {
	context.subscriptions.push(commands.register('acme.standardSmoke.inspect', async () => {
		const text = new TextDecoder().decode(await ash.workspace.fs.readFile(ash.Uri.joinPath(ash.workspace.workspaceFolders[0].uri, 'main.ts')));
		await window.showInformationMessage('Standard disk: ' + text.trim() + '; globals: ' + [typeof process, typeof fetch, typeof WebAssembly].join(','));
		return text;
	}));
}`);
	let page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await installation.getByRole('textbox').fill('standard-extension');
	const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
	expect(installed.message).toContain('Installed acme/standard-smoke 1.0.0');

	const absent = async (): Promise<void> => {
		await workbench.quickaccess.open('>acme.standardSmoke.inspect');
		await expect(workbench.quickaccess.items.filter({ has: page.locator('.ash-quick-pick-row-description').getByText('acme.standardSmoke.inspect', { exact: true }) })).toHaveCount(0);
		await workbench.quickaccess.close();
	};
	const manage = async (button: string): Promise<void> => {
		const review = await workbench.dialogs.confirm(application, 'Standard extension smoke', button, async () => {
			await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
			await page.getByRole('option').filter({ has: page.getByText('Standard extension smoke', { exact: true }) }).click();
		});
		expect(review.detail).toContain('Read workspace files');
		expect(review.detail).toContain('Package digest: sha256:');
	};
	await absent();
	await manage('Enable');
	await absent();
	await manage('Grant permissions');
	await workbench.quickaccess.runCommand('acme.standardSmoke.inspect');
	await expect(page.locator('.ash-notification', { hasText: 'Standard disk: const value = 1;; globals: object,function,object' })).toBeVisible();

	({ workbench, application } = await reloadWorkbench());
	page = workbench.page;
	await expect(page.getByRole('tab', { name: 'Welcome', exact: true })).toBeVisible();
	await workbench.quickaccess.runCommand('acme.standardSmoke.inspect');
	await expect(page.locator('.ash-notification', { hasText: 'Standard disk: const value = 1;; globals: object,function,object' })).toBeVisible();
	await manage('Revoke permissions');
	await absent();
	await manage('Disable');
	await manage('Uninstall');
	const empty = await workbench.dialogs.expectMessage(application, 'Information', () => workbench.quickaccess.runCommand('ash.extensions.manageLocal'));
	expect(empty.message).toContain('No local editor extensions are installed.');
});

test('Extensions slash commands open their Workbench owners without sending a chat message', async ({ target, application, workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const input = page.locator('.ash-chat-input-editor .stanza-editor-input');
	const editor = new Editor(page.locator('.ash-chat-input-editor'));
	for (const [command, selector] of [['/extensions rust tools', '[data-view-id="ash.extensions.view"] .ash-extensions'], ['/plugins', '[data-view-id="ash.extensions.plugins"] .ash-extensions'], ...(target.appServerMode === 'required' ? [['/skills', '[data-view-id="ash.extensions.skills"]']] : []), ['/lsp rust', '.ash-language-server-settings'], ['/extensions', '[data-view-id="ash.extensions.view"] .ash-extensions'], ['/lsp', '.ash-language-server-settings']]) {
		await input.focus();
		await page.keyboard.press('ControlOrMeta+A');
		await page.keyboard.insertText(command);
		await page.keyboard.press('Escape');
		await expect(page.locator('[data-action-id="ash.chat.input.send"] button')).toBeEnabled();
		await page.keyboard.press('Enter');
		await expect(page.locator(selector)).toBeVisible();
		if (command === '/skills') { await expect(page.locator('.ash-settings-editor')).toHaveCount(0); }
		if (command === '/plugins') {
			await expect(page.locator(selector).getByRole('searchbox', { name: 'Search installed extensions', exact: true })).toBeFocused();
			await expect(page.locator(selector).getByRole('listbox', { name: 'Installed Extensions', exact: true })).toBeAttached();
		}
		if (command === '/extensions rust tools') { await expect(page.locator(selector).getByLabel('Search Extensions', { exact: true })).toHaveValue('rust tools'); }
		if (command === '/extensions') { await expect(page.locator(selector).getByLabel('Search Extensions', { exact: true })).toHaveValue(''); }
		if (command.startsWith('/lsp')) {
			await expect(page.locator('.ash-settings-editor')).toBeVisible();
			await expect(page.locator('[data-settings-container]')).toHaveAttribute('data-active-settings-category', 'editor-language');
			await expect(page.getByRole('tab', { name: 'Language servers', exact: true })).toHaveCount(0);
			if (command === '/lsp rust') {
				await expect(page.locator(selector).getByLabel('Language ID', { exact: true })).toHaveValue('rust');
				await page.locator('.ash-modal-editor-close').click();
			}
		}
		// Opening a command surface can finish after it first becomes visible.
		await editor.waitForEditorContents(text => text === '');
	}
	await expect(page.locator('.ash-chat-item-userMessage')).toHaveCount(0);
	const lsp = page.locator('.ash-language-server-settings');
	await expect(lsp).toHaveAttribute('aria-busy', 'false');
	await expect(lsp.getByLabel('Language ID', { exact: true })).toBeEnabled();
	await lsp.getByLabel('Language ID', { exact: true }).focus();
	await expect(lsp.getByLabel('Language ID', { exact: true })).toBeFocused();
	await page.keyboard.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/Language Servers[\s\S]*Logs and startup failures are in Output/);
	await help.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(lsp.getByLabel('Language ID', { exact: true })).toBeFocused();
	if (target.appServerMode === 'required') {
		await expect(lsp).toHaveAttribute('aria-busy', 'false');
		await lsp.getByLabel('Server ID', { exact: true }).fill('rust-analyzer');
		await lsp.getByLabel('Server ID', { exact: true }).press('Tab');
		await lsp.getByLabel('Enable server', { exact: true }).uncheck();
		await expect(lsp.getByRole('button', { name: 'Save server configuration', exact: true })).toBeEnabled();
		await lsp.getByRole('button', { name: 'Save server configuration', exact: true }).click();
		await expect(lsp.getByRole('combobox', { name: 'Language servers', exact: true })).toContainText('rust-analyzer');
		await expect(lsp.getByRole('button', { name: 'Use default configuration', exact: true })).toBeEnabled();
		await lsp.getByRole('button', { name: 'Refresh', exact: true }).click();
		await expect(lsp.getByLabel('Enable server', { exact: true })).not.toBeChecked();
		await lsp.getByRole('button', { name: 'Use default configuration', exact: true }).click();
		await expect(lsp).toHaveAttribute('aria-busy', 'false');
		await expect(lsp.getByRole('button', { name: 'Use default configuration', exact: true })).toBeDisabled();
	}
});

test('Language server Settings replaces the sidebar and saves backend configuration', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench, restartWorkbench }) => {
	let page = workbench.page;
	await workbench.quickaccess.runCommand('ash.languageServers.open');
	let settings = page.locator('.ash-settings-editor');
	let lsp = settings.locator('.ash-language-server-settings');
	await expect(lsp).toBeVisible();
	await expect(settings.locator('[data-settings-container]')).toHaveAttribute('data-active-settings-category', 'editor-language');
	await expect(page.getByRole('tab', { name: 'Language servers', exact: true })).toHaveCount(0);
	await expect(settings.getByRole('region', { name: /^Language Servers/u })).toBeInViewport();
	await expect(lsp).toHaveAttribute('aria-busy', 'false');
	if (target.appServerMode === 'required') {
		await expect(lsp.getByRole('status')).not.toContainText('Could not load');
		await lsp.getByLabel('Server ID', { exact: true }).fill('rust-analyzer');
		await lsp.getByLabel('Enable server', { exact: true }).uncheck();
		await lsp.getByRole('button', { name: 'Save server configuration', exact: true }).click();
		await expect(lsp.getByRole('button', { name: 'Use default configuration', exact: true })).toBeEnabled();
		await expect(lsp.getByRole('combobox', { name: 'Language servers', exact: true })).toContainText('rust-analyzer');
		await lsp.getByRole('button', { name: 'Refresh', exact: true }).click();
		await expect(lsp).toHaveAttribute('aria-busy', 'false');
		await expect(lsp.getByLabel('Enable server', { exact: true })).not.toBeChecked();
		await lsp.getByRole('button', { name: 'Use default configuration', exact: true }).click();
		await expect(lsp).toHaveAttribute('aria-busy', 'false');
		await expect(lsp.getByRole('button', { name: 'Use default configuration', exact: true })).toBeDisabled();
	}
	await workbench.settingsEditor.selectGroup('workbench');
	await workbench.settingsEditor.selectCategory('general');
	const locale = settings.locator('[data-settings-item-id="workbench.locale"]').getByRole('combobox');
	await locale.click();
	await page.getByRole('option', { name: '简体中文', exact: true }).click();
	({ workbench } = await restartWorkbench());
	page = workbench.page;
	settings = page.locator('.ash-settings-editor');
	lsp = settings.locator('.ash-language-server-settings');
	await workbench.quickaccess.runCommand('ash.languageServers.open');
	await expect(settings.getByRole('region', { name: /^语言服务器/u })).toBeInViewport();
	await expect(lsp).toHaveAttribute('aria-busy', 'false');
	await lsp.getByLabel('语言 ID', { exact: true }).fill('python');
	await lsp.getByRole('button', { name: '在 Extensions 中查找语言服务器', exact: true }).click();
	await expect(settings).toBeHidden();
	const extensions = page.locator('[data-view-id="ash.extensions.view"] .ash-extensions');
	await expect(extensions).toBeVisible();
	await expect(extensions.getByRole('searchbox', { name: '搜索扩展', exact: true })).toBeFocused();
});


test('Extensions sources persist and share the same authority between Code and Agents', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench, reloadWorkbench }) => {
	let page = workbench.page;
	await new QuickAccess(page).runCommand('ash.extensions.manageSources');
	const picker = page.getByRole('dialog', { name: 'Manage extension sources', exact: true });
	if (target.kind === 'electron') {
		await expect(picker).not.toContainText('open-vsx');
		await expect(picker).toContainText('ash');
	}
	await picker.getByRole('option').filter({ hasText: 'Add Ash open source…' }).click();
	const setup = page.getByRole('dialog', { name: 'Add Ash open source…', exact: true });
	const inputs = setup.getByRole('textbox');
	const root = await readFile(new URL('../../../../resources/product-services/extensions-root.json', import.meta.url), 'utf8');
	for (const [index, value] of ['community', 'https://extensions.example/metadata/', 'https://extensions.example/targets/', root].entries()) { await inputs.nth(index).fill(value); }
	await setup.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(setup).toHaveCount(0);
	page = await workbench.openAgentsWindow(target.kind);
	await new QuickAccess(page).runCommand('ash.extensions.manageSources');
	const shared = page.getByRole('dialog', { name: 'Manage extension sources', exact: true });
	const community = shared.getByRole('option').filter({ hasText: 'community' });
	await expect(community).toContainText('Enabled · select to pause');
	await community.click();
	await expect(shared).toHaveCount(0);
	if (target.kind === 'browser') {
		await workbench.reloadWindow(page);
		await page.locator('.ash-sessions-window').waitFor({ state: 'visible' });
	} else {
		({ workbench } = await reloadWorkbench());
		page = workbench.page;
	}
	await new QuickAccess(page).runCommand('ash.extensions.manageSources');
	const restored = page.getByRole('dialog', { name: 'Manage extension sources', exact: true });
	await expect(restored.getByRole('option').filter({ hasText: 'community' })).toContainText('Paused · select to resume');
	await page.keyboard.press('Escape');
});
